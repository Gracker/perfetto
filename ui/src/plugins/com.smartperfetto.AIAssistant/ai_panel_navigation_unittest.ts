// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {afterEach, beforeEach, describe, it, expect, vi} from 'vitest';
import type {Mock} from 'vitest';

import {AIPanel} from './ai_panel';
import {getAISharedState} from './ai_shared_state';
import {getFloatingState, updateFloatingState} from './ai_floating_state';
import {
  switchFloatingMode,
  toggleSidebarCollapsedWithTransientState,
} from './ai_transient_state';
import {sessionManager} from './session_manager';
import type {TracePairWorkspaceController} from './trace_pair_workspace_state';
import type {TracePairWorkspaceScope} from './trace_pair_workspace_state_model';
import type {AIPanelState} from './types';
import {uiText} from './ui_language';
import {saveAnalysisContext} from './analysis_context';
import {getSmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';

type TestAIPanel = {
  state: AIPanelState;
  trace: {
    traceInfo: {
      traceTitle: string;
      start: bigint;
      end: bigint;
      source?: {type: 'HTTP_RPC'};
    };
    notes?: {
      removeNote: () => void;
    };
  };
  ensureAgentSessionReady: () => Promise<void>;
  captureSelectionContext: (message?: string) => Promise<null>;
  listenToAgentSSE: (sessionId: string) => Promise<void>;
  saveCurrentSession: () => void;
  fetchBackend: (url: string, init?: RequestInit) => Promise<Response>;
  handleChatMessage: (message: string) => Promise<void>;
  renderTableSourceContext: (
    source: Parameters<AIPanel['renderTableSourceContext']>[0],
  ) => unknown;
};

type MutableTestAIPanel = TestAIPanel & {
  engine?: {mode: 'HTTP_RPC'};
  tracePairWorkspaceController: TracePairWorkspaceController;
  fetchAvailableTraces: Mock<() => Promise<void>>;
  renderHeaderActions: (
    isInRpcMode: boolean,
    hasBackendTrace: boolean,
    isConnected: boolean,
  ) => unknown;
  getTracePairWorkspaceScope: () => TracePairWorkspaceScope;
  loadSession: (
    sessionId: string,
    options?: {preserveLiveTracePair?: boolean},
  ) => boolean;
  verifyBackendTrace: Mock<() => Promise<void>>;
  buildTracePairContext: () => unknown;
  syncTracePairStateFromController: () => void;
  saveCurrentSession: Mock<() => void>;
  fetchBackend: Mock<(url: string, init?: RequestInit) => Promise<Response>>;
  cancelAnalysis: () => Promise<void>;
  handleStoryCancel: () => Promise<void>;
  exitComparisonMode: () => void;
  saveSettings: (settings: AIPanelState['settings']) => void;
  openSettings: () => void;
};

function createMutableTestPanel(): MutableTestAIPanel {
  return new AIPanel() as unknown as MutableTestAIPanel;
}

function collectVNodeText(node: any): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectVNodeText).join(' ');
  const parts = [node.text, node.children].filter((part) => part !== undefined);
  return parts.map(collectVNodeText).join(' ');
}

function findVNodeByTitle(node: any, title: string): any {
  if (node === null || node === undefined || node === false) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findVNodeByTitle(child, title);
      if (found) return found;
    }
    return undefined;
  }
  if (node.attrs?.title === title) return node;
  return findVNodeByTitle(node.children, title);
}

describe('AIPanel analysis mode menu', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('closes on Escape without changing other keys', () => {
    const panel = new AIPanel() as any;

    panel.state.showAnalysisModeMenu = true;
    panel.handleAnalysisModeMenuDocumentKeydown(
      new KeyboardEvent('keydown', {key: 'Enter'}),
    );
    expect(panel.state.showAnalysisModeMenu).toBe(true);

    panel.handleAnalysisModeMenuDocumentKeydown(
      new KeyboardEvent('keydown', {key: 'Escape'}),
    );

    expect(panel.state.showAnalysisModeMenu).toBe(false);
  });

  it('keeps inside clicks and closes on outside clicks', () => {
    const panel = new AIPanel() as any;
    const selector = document.createElement('div');
    selector.className = 'ai-mode-selector';
    const menuItem = document.createElement('button');
    selector.appendChild(menuItem);
    document.body.appendChild(selector);
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    panel.state.showAnalysisModeMenu = true;
    menuItem.addEventListener('click', (event) => {
      panel.handleAnalysisModeMenuDocumentClick(event);
    });
    menuItem.click();
    expect(panel.state.showAnalysisModeMenu).toBe(true);

    outside.addEventListener('click', (event) => {
      panel.handleAnalysisModeMenuDocumentClick(event);
    });
    outside.click();

    expect(panel.state.showAnalysisModeMenu).toBe(false);
  });
});

describe('AIPanel backend binding reset', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('loads the destination partition for a URL-only change', () => {
    const panel = createMutableTestPanel();
    const original = {
      ...panel.state.settings,
      backendUrl: 'http://old-backend',
      backendApiKey: 'same-key',
    };
    panel.state.settings = original;
    saveAnalysisContext('http://new-backend', getSmartPerfettoRequestContext(), {
      codeAwareMode: 'metadata_only',
      codebaseIds: ['new-backend-source'],
      knowledgeSourceIds: [],
    });

    panel.saveSettings({...original, backendUrl: 'http://new-backend'});

    expect(panel.state.analysisContext).toEqual({
      codeAwareMode: 'metadata_only',
      codebaseIds: ['new-backend-source'],
      knowledgeSourceIds: [],
    });
  });

  it.each([
    ['credential-only', 'http://old-backend'],
    ['URL and credential', 'http://new-backend'],
  ])('clears private selection for a %s change', (_label, nextUrl) => {
    const panel = createMutableTestPanel();
    const original = {
      ...panel.state.settings,
      backendUrl: 'http://old-backend',
      backendApiKey: 'old-key',
    };
    panel.state.settings = original;
    panel.state.analysisContext = {
      codeAwareMode: 'provider_send',
      codebaseIds: ['old-credential-source'],
      knowledgeSourceIds: ['old-credential-rag'],
    };
    saveAnalysisContext(nextUrl, getSmartPerfettoRequestContext(), {
      codeAwareMode: 'provider_send',
      codebaseIds: ['destination-old-credential-source'],
      knowledgeSourceIds: ['destination-old-credential-rag'],
    });

    panel.saveSettings({
      ...original,
      backendUrl: nextUrl,
      backendApiKey: 'new-key',
    });

    expect(panel.state.analysisContext).toEqual({
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: [],
    });
  });
});

describe('AIPanel header tool panels', () => {
  it('opens the dual-trace shell before a history trace is selected', () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.currentTraceFingerprint = 'fingerprint-current';
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
    };
    panel.fetchAvailableTraces = vi.fn(async () => {});

    const header = panel.renderHeaderActions(true, true, true);
    findVNodeByTitle(
      header,
      uiText('打开双 Trace 工作区', 'Open dual-trace workspace'),
    ).attrs.onclick();

    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      open: true,
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
      referenceTrace: null,
    });
    expect(panel.fetchAvailableTraces).toHaveBeenCalledTimes(1);
    expect(panel.state.showTracePicker).toBe(false);
  });

  it('does not open a new trace pair while a single-trace analysis is running', () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.isLoading = true;

    const header = panel.renderHeaderActions(true, true, true);
    const button = findVNodeByTitle(
      header,
      uiText('打开双 Trace 工作区', 'Open dual-trace workspace'),
    );
    const newChatButton = findVNodeByTitle(header, 'New Chat');
    const settingsButton = findVNodeByTitle(
      header,
      uiText(
        '分析运行中，设置保持只读',
        'Settings are read-only while analysis is running',
      ),
    );

    expect(button.attrs.disabled).toBe(true);
    expect(button.attrs.onclick).toBeUndefined();
    expect(newChatButton.attrs.disabled).toBe(true);
    expect(newChatButton.attrs.onclick).toBeUndefined();
    expect(settingsButton.attrs.disabled).toBe(true);
    expect(settingsButton.attrs.onclick).toBeUndefined();
    expect(panel.tracePairWorkspaceController.getState().open).toBe(false);
  });

  it('hard-blocks settings writes while analysis identity is locked', () => {
    const panel = createMutableTestPanel();
    const originalSettings = panel.state.settings;
    const saveSettings = vi.spyOn(sessionManager, 'saveSettings');
    panel.state.isLoading = true;

    panel.openSettings();
    panel.saveSettings({...originalSettings, backendUrl: 'http://other'});

    expect(panel.state.showSettings).toBe(false);
    expect(panel.state.settings).toBe(originalSettings);
    expect(saveSettings).not.toHaveBeenCalled();
    saveSettings.mockRestore();
  });

  it('does not silently rebind an HTTP RPC-only trace to a new backend', () => {
    const panel = createMutableTestPanel();
    const originalSettings = panel.state.settings;
    const saveSettings = vi.spyOn(sessionManager, 'saveSettings');
    panel.engine = {mode: 'HTTP_RPC'};
    panel.trace = {
      traceInfo: {
        traceTitle: 'rpc-only.trace',
        start: 0n,
        end: 10n,
        source: {type: 'HTTP_RPC'},
      },
    };

    panel.saveSettings({...originalSettings, backendUrl: 'http://other-backend'});

    expect(panel.state.settings).toBe(originalSettings);
    expect(panel.state.retryError).toContain('cannot be migrated safely');
    expect(saveSettings).not.toHaveBeenCalled();
    saveSettings.mockRestore();
  });

  it('does not load another conversation while analysis is running', () => {
    const panel = createMutableTestPanel();
    panel.state.isLoading = true;
    const loadSession = vi.spyOn(sessionManager, 'loadSession');

    expect(panel.loadSession('history-session')).toBe(false);
    expect(loadSession).not.toHaveBeenCalled();

    loadSession.mockRestore();
  });

  it('reopens an existing locked pair while analysis is running', () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.referenceTraceId = 'history-a';
    panel.state.referenceTraceName = 'history-a.pftrace';
    panel.state.isLoading = true;
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
    };
    panel.fetchAvailableTraces = vi.fn(async () => {});
    panel.tracePairWorkspaceController.open({
      scope: panel.getTracePairWorkspaceScope(),
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });
    panel.tracePairWorkspaceController.setSelectionLocked(true);
    panel.tracePairWorkspaceController.close();

    const header = panel.renderHeaderActions(true, true, true);
    const button = findVNodeByTitle(
      header,
      uiText('打开双 Trace 工作区', 'Open dual-trace workspace'),
    );
    expect(button.attrs.disabled).not.toBe(true);
    button.attrs.onclick();

    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      open: true,
      selectionLocked: true,
      referenceTrace: {id: 'history-a'},
    });
  });

  it('keeps capture config mutually exclusive with Story and history panels', () => {
    const panel = new AIPanel() as any;
    panel.fetchAvailableTraces = vi.fn();

    panel.state.captureConfigSuggestion.visible = true;
    const header = panel.renderHeaderActions(true, true, true);
    findVNodeByTitle(header, 'Story').attrs.onclick();

    expect(panel.state.showStorySidebar).toBe(true);
    expect(panel.state.captureConfigSuggestion.visible).toBe(false);

    panel.toggleCaptureConfigSuggestion();
    expect(panel.state.captureConfigSuggestion.visible).toBe(true);
    expect(panel.state.showStorySidebar).toBe(false);

    const headerWithCapture = panel.renderHeaderActions(true, true, true);
    findVNodeByTitle(headerWithCapture, '历史对话').attrs.onclick();

    expect(panel.state.showSessionSidebar).toBe(true);
    expect(panel.state.captureConfigSuggestion.visible).toBe(false);
  });
});

describe('AIPanel /goto navigation', () => {
  it('renders all table source metadata chips', () => {
    const panel = new AIPanel() as unknown as TestAIPanel;

    const view = panel.renderTableSourceContext({
      ref: '表 9',
      title: 'Detailed Table',
      source: 'execute_sql',
      reason: 'why this table exists',
      meaning: 'what this table means',
      kind: 'table',
      rowCount: 42,
      phase: 'DataEnvelope.list',
      traceSide: 'reference',
      planPhaseId: 'phase-2',
      planPhaseTitle: 'Validate contention',
      planPhaseAttribution: 'inferred',
      sourceToolCallId: 'execute_sql_on:12:abcdef1234567890',
      evidenceRefId: 'data:sql_table:reference:trace:query:params',
    });

    const text = collectVNodeText(view);

    expect(text).toContain('表 9');
    expect(text).toContain('表格');
    expect(text).toContain('参考 Trace');
    expect(text).toContain('阶段 phase-2 · Validate contention');
    expect(text).toContain('阶段归因 inferred');
    expect(text).toContain('42 行');
    expect(text).toContain('工具');
    expect(text).toContain('证据');
    expect(text).toContain('execute_sql');
  });

  it('keeps rendered assistant content stable across unrelated redraws', () => {
    const panel = new AIPanel() as any;
    panel.renderMermaidInElement = vi.fn();
    const dom = document.createElement('div');
    const msg = {
      id: 'msg-1',
      role: 'assistant',
      content: '## 结论\n\n可以复制的分析结果。',
      timestamp: Date.now(),
    };

    panel.renderMessageContent(dom, msg, false);
    const heading = dom.querySelector('h2') as HTMLElement;
    heading.setAttribute('data-selection-anchor', 'kept');

    panel.renderMessageContent(dom, msg, false);

    expect(dom.querySelector('h2')?.getAttribute('data-selection-anchor')).toBe(
      'kept',
    );
  });

  it('copies any normal conversation message content', async () => {
    vi.useFakeTimers();
    const panel = new AIPanel() as any;
    panel.copyTextToClipboard = vi.fn(async () => true);
    const msg = {
      id: 'user-msg-1',
      role: 'user',
      content: '用户输入也应该可以复制',
      timestamp: Date.now(),
    };

    await panel.copyMessageContent(msg);

    expect(panel.copyTextToClipboard).toHaveBeenCalledWith(
      '用户输入也应该可以复制',
    );
    expect(panel.copiedMessageIds.has('user-msg-1')).toBe(true);

    vi.runOnlyPendingTimers();
    expect(panel.copiedMessageIds.has('user-msg-1')).toBe(false);
    vi.useRealTimers();
  });

  it('returns an error when jumpToTimestamp is called without trace context', () => {
    const panel = new AIPanel() as any;
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = panel.jumpToTimestamp(123n);

    expect(result).toEqual({
      ok: false,
      error: 'trace context is not available',
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('scrolls timeline window when jumpToTimestamp succeeds', () => {
    const panel = new AIPanel() as any;
    const scrollTo = vi.fn();
    panel.trace = {
      scrollTo,
      traceInfo: {
        start: 0n,
        end: 10000000n,
      },
    };

    const result = panel.jumpToTimestamp(1n);

    expect(result).toEqual({ok: true});
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const arg = scrollTo.mock.calls[0][0] as any;
    expect(arg.time.start).toBe(0n);
    expect(arg.time.end).toBe(5000001n);
  });

  it('returns failure when timestamp is outside trace range', () => {
    const panel = new AIPanel() as any;
    const scrollTo = vi.fn();
    panel.trace = {
      scrollTo,
      traceInfo: {
        start: 100n,
        end: 200n,
      },
    };

    const result = panel.jumpToTimestamp(300n);

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('outside trace range');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reports failure message when goto navigation fails', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = vi.fn(() => 'msg-id');
    panel.addMessage = vi.fn();
    panel.jumpToTimestamp = vi.fn(() => ({ok: false, error: 'boom'}));

    await panel.handleGotoCommand('123ns');

    expect(panel.jumpToTimestamp).toHaveBeenCalledWith(123n);
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.role).toBe('assistant');
    expect(message.content).toContain('Failed to navigate to timestamp 123ns');
    expect(message.content).toContain('boom');
  });

  it('reports success message when goto navigation succeeds', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = vi.fn(() => 'msg-id');
    panel.addMessage = vi.fn();
    panel.jumpToTimestamp = vi.fn(() => ({ok: true}));

    await panel.handleGotoCommand('456');

    expect(panel.jumpToTimestamp).toHaveBeenCalledWith(456n);
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('Navigated to timestamp 456ns.');
  });

  it('rejects invalid goto timestamp input', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = vi.fn(() => 'msg-id');
    panel.addMessage = vi.fn();
    panel.jumpToTimestamp = vi.fn();

    await panel.handleGotoCommand('abc');

    expect(panel.jumpToTimestamp).not.toHaveBeenCalled();
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.content).toBe('Invalid timestamp: abc');
  });
});

describe('AIPanel teaching pipeline compatibility view', () => {
  it('passes visible window and selected slice context to backend request', () => {
    const panel = new AIPanel() as any;
    panel.trace = {
      timeline: {
        visibleWindow: {
          toTimeSpan: () => ({start: 100n, end: 500n}),
        },
      },
      selection: {
        selection: {
          kind: 'track_event',
          eventId: 42,
          ts: 120n,
          dur: 16n,
        },
      },
    };
    panel.state.sliceCardInfo = {
      ts: 123,
      dur: 17,
      name: 'Choreographer#doFrame',
      threadName: 'main',
      processName: 'com.example.app',
    };

    expect(panel.buildTeachingPipelineRequestContext()).toEqual({
      packageName: 'com.example.app',
      visibleWindow: {startTs: 100, endTs: 500},
      selectionContext: {
        kind: 'track_event',
        eventId: 42,
        ts: 123,
        dur: 17,
        name: 'Choreographer#doFrame',
        threadName: 'main',
        processName: 'com.example.app',
      },
    });
  });

  it('keeps structured teaching results copyable as markdown evidence', () => {
    const panel = new AIPanel() as any;
    const markdown = panel.buildTeachingPipelineMarkdown(
      {
        success: true,
        detection: {
          primaryPipelineId: 'android_hwui',
          primaryConfidence: 0.91,
          candidates: [
            {id: 'android_hwui', confidence: 0.91},
            {id: 'compose', confidence: 0.67},
          ],
          features: [{name: 'webview', confidence: 0.74}],
        },
        observedFlow: {
          schemaVersion: 'v2',
          context: {
            packageName: 'com.example.app',
            timeRange: {startTs: 100, endTs: 900, source: 'selection'},
          },
          lanes: [
            {
              id: 'main',
              role: 'app',
              title: 'App main',
              threadName: 'main',
              confidence: 0.95,
              evidenceSource: 'slice',
            },
          ],
          events: [
            {
              id: 'evt-1',
              stage: 'app',
              name: 'Choreographer#doFrame',
              ts: 120,
              dur: 16000000,
              durMs: 16,
              threadName: 'main',
              processName: 'com.example.app',
            },
          ],
          dependencies: [
            {
              fromLaneId: 'main',
              toLaneId: 'render',
              relation: 'wakes_to',
              evidenceSource: 'thread_state_waker_id',
            },
          ],
          criticalTasks: [
            {
              id: 'task-1',
              kind: 'direct_wakeup',
              rootEventId: 'evt-1',
              rootLaneId: 'main',
              name: 'direct waker: Binder',
              ts: 110,
              dur: 1000000,
              durMs: 1,
              threadName: 'main',
              processName: 'com.example.app',
              waker: {
                threadName: 'Binder:123',
                processName: 'system_server',
                kind: 'thread',
              },
              evidenceSource: 'thread_state_waker_id',
            },
          ],
          completeness: {
            level: 'medium',
            missingSignals: ['present fence not available'],
          },
        },
        teaching: {
          title: 'HWUI 教学',
          summary: '基于已观测 slice 解释。',
          keySlices: ['Choreographer#doFrame'],
        },
      },
      {
        count: 1,
        skipped: 0,
        failed: 1,
        attempted: 2,
        missingPatterns: ['^RenderThread$'],
        pinnedTrackNames: ['com.example.app > main'],
      },
    );

    expect(markdown).toContain('当前 Trace 实际链路');
    expect(markdown).toContain('App main');
    expect(markdown).toContain('Choreographer#doFrame');
    expect(markdown).toContain('wakes_to');
    expect(markdown).toContain('Binder:123 / system_server');
    expect(markdown).toContain('present fence not available');
    expect(markdown).toContain('**候选类型**:');
    expect(markdown).not.toContain('**候选子路径**:');
    expect(markdown).toContain('未命中的 pattern: ^RenderThread$');
    expect(markdown).toContain('已 pin 的 track: com.example.app > main');
  });

  it('shows the Android 17 rendering type separately from the detected subpath', () => {
    const panel = new AIPanel() as any;
    const result = {
      success: true,
      detection: {
        primaryPipelineId: 'FLUTTER_SURFACEVIEW_IMPELLER',
        primaryRenderingTypeId: 'S10_FLUTTER',
        primaryConfidence: 0.93,
        renderingType: {
          id: 'S10_FLUTTER',
          docPath: 'rendering_pipelines/S10_flutter_type.md',
        },
        renderingTypeCandidates: [{id: 'S10_FLUTTER', confidence: 0.93}],
        relatedRenderingTypes: [
          {
            id: 'S06_MULTI_WINDOW',
            confidence: 0.72,
            docPath: 'rendering_pipelines/S06_multi_window_type.md',
          },
        ],
        candidates: [
          {id: 'FLUTTER_SURFACEVIEW_IMPELLER', confidence: 0.93},
        ],
      },
      teaching: {
        title: 'Android Perfetto 系列 - App 出图类型 - Flutter 类型',
        summary: 'Flutter rendering.',
      },
    };
    const markdown = panel.buildTeachingPipelineMarkdown(result);
    const renderedSummary = JSON.stringify(
      panel.renderTeachingPipelineSummary(result),
    );

    expect(markdown).toContain('**出图类型**: `S10_FLUTTER`');
    expect(markdown).toContain('**检测子路径**: `FLUTTER_SURFACEVIEW_IMPELLER`');
    expect(markdown).toContain('**伴随出图类型**: S06_MULTI_WINDOW');
    expect(markdown).toContain('rendering_pipelines/S06_multi_window_type.md');
    expect(markdown).not.toContain('**管线类型**: `FLUTTER_SURFACEVIEW_IMPELLER`');
    expect(renderedSummary).toContain('出图类型');
    expect(renderedSummary).toContain('S10_FLUTTER');
    expect(renderedSummary).toContain('检测子路径');
    expect(renderedSummary).toContain('伴随出图类型');
  });

  it('returns explicit pin execution failure when trace context is absent', async () => {
    const panel = new AIPanel() as any;

    await expect(
      panel.pinTracksFromInstructions([
        {
          pattern: '^main$',
          matchBy: 'name',
          priority: 1,
          reason: 'test',
        },
      ]),
    ).resolves.toEqual({
      count: 0,
      skipped: 0,
      failed: 0,
      attempted: 1,
      missingPatterns: [],
      pinnedTrackNames: [],
      reason: 'trace context is not available',
    });
  });

  it('merges observed lane track hints into executable teaching pin instructions', () => {
    const panel = new AIPanel() as any;

    const instructions = panel.buildTeachingPinInstructions({
      success: true,
      detection: {
        primaryPipelineId: 'android_hwui',
        primaryConfidence: 0.9,
      },
      pinInstructions: [
        {
          pattern: '^RenderThread$',
          matchBy: 'name',
          priority: 1,
          reason: 'static render thread',
        },
      ],
      pinPlan: {
        status: 'planned',
        expectedTrackHints: [
          {
            matchBy: 'thread',
            pattern: 'main',
            processName: 'com.example.app',
            threadName: 'main',
            mainThreadOnly: true,
          },
          {
            matchBy: 'process',
            pattern: 'surfaceflinger',
            processName: 'surfaceflinger',
          },
        ],
      },
    });

    expect(instructions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pattern: '^RenderThread$',
          matchBy: 'name',
          priority: 1,
        }),
        expect.objectContaining({
          pattern: '^main$',
          matchBy: 'name',
          mainThreadOnly: true,
          smartPin: true,
          activeProcessNames: ['com.example.app'],
        }),
        expect.objectContaining({
          pattern: 'surfaceflinger',
          matchBy: 'path',
          smartPin: true,
          activeProcessNames: ['surfaceflinger'],
        }),
      ]),
    );
  });
});

describe('AIPanel trace-pair session restore', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('restores explicit raw trace comparison identity from local session metadata', () => {
    const session = sessionManager.createSession(
      'trace-a',
      'current.trace',
      'backend-current',
    );
    sessionManager.updateSession('trace-a', session.sessionId, {
      agentSessionId: 'agent-compare',
      type: 'comparison',
      referenceBackendTraceId: 'backend-reference',
      referenceTraceName: 'reference.trace',
      tracePairLayout: 'vertical',
      tracePairSplitPercent: 64,
      tracePairActiveTraceSide: 'reference',
    });

    const panel = new AIPanel() as any;
    panel.engine = {mode: 'HTTP_RPC'};
    panel.verifyBackendTrace = vi.fn();

    expect(panel.loadSession(session.sessionId)).toBe(true);

    expect(panel.state.referenceTraceId).toBe('backend-reference');
    expect(panel.state.referenceTraceName).toBe('reference.trace');
    expect(panel.state.tracePairWorkspaceOpen).toBe(false);
    expect(panel.state.tracePairLayout).toBe('vertical');
    expect(panel.state.tracePairSplitPercent).toBe(64);
    expect(panel.state.isReferenceActive).toBe(true);
    expect(panel.state.agentSessionId).toBe('agent-compare');
    expect(panel.buildTracePairContext()).toMatchObject({
      layout: 'vertical',
      activeSide: 'bottom',
      workspaceOpen: false,
      panes: [
        expect.objectContaining({
          traceSide: 'current',
          traceId: 'backend-current',
        }),
        expect.objectContaining({
          traceSide: 'reference',
          traceId: 'backend-reference',
        }),
      ],
    });
  });

  it('drops agent continuation when comparison identity cannot be restored', () => {
    const session = sessionManager.createSession(
      'trace-a',
      'current.trace',
      'backend-current',
    );
    sessionManager.updateSession('trace-a', session.sessionId, {
      agentSessionId: 'agent-stale-compare',
      type: 'comparison',
      referenceBackendTraceId: undefined,
    });

    const panel = new AIPanel() as any;
    panel.engine = {mode: 'HTTP_RPC'};
    panel.verifyBackendTrace = vi.fn();

    expect(panel.loadSession(session.sessionId)).toBe(true);

    expect(panel.state.referenceTraceId).toBeNull();
    expect(panel.state.tracePairWorkspaceOpen).toBe(false);
    expect(panel.state.agentSessionId).toBeNull();
  });

  it('applies an explicitly loaded comparison session over the live pair', () => {
    const session = sessionManager.createSession(
      'trace-a',
      'current.trace',
      'backend-current',
    );
    sessionManager.updateSession('trace-a', session.sessionId, {
      agentSessionId: 'agent-b',
      type: 'comparison',
      referenceBackendTraceId: 'history-b',
      referenceTraceName: 'history-b.pftrace',
      tracePairLayout: 'vertical',
      tracePairSplitPercent: 64,
      tracePairCurrentPane: 'second',
    });

    const panel = createMutableTestPanel();
    panel.engine = {mode: 'HTTP_RPC'};
    panel.verifyBackendTrace = vi.fn();
    panel.state.backendTraceId = 'backend-current';
    panel.tracePairWorkspaceController.open({
      scope: panel.getTracePairWorkspaceScope(),
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });

    expect(panel.loadSession(session.sessionId)).toBe(true);

    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      referenceTrace: {id: 'history-b', filename: 'history-b.pftrace'},
      currentPane: 'second',
      layout: 'vertical',
      splitPercent: 64,
    });
    expect(panel.state.agentSessionId).toBe('agent-b');
  });

  it('keeps the live pair when the panel auto-restores an older session', () => {
    const session = sessionManager.createSession(
      'trace-a',
      'current.trace',
      'backend-current',
    );
    sessionManager.updateSession('trace-a', session.sessionId, {
      agentSessionId: 'agent-a',
      type: 'comparison',
      referenceBackendTraceId: 'history-a',
      referenceTraceName: 'history-a.pftrace',
    });

    const panel = createMutableTestPanel();
    panel.engine = {mode: 'HTTP_RPC'};
    panel.verifyBackendTrace = vi.fn();
    panel.state.backendTraceId = 'backend-current';
    panel.tracePairWorkspaceController.open({
      scope: panel.getTracePairWorkspaceScope(),
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-b', filename: 'history-b.pftrace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-b',
    });

    expect(
      panel.loadSession(session.sessionId, {
        preserveLiveTracePair: true,
      }),
    ).toBe(true);

    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      open: true,
      referenceTrace: {id: 'history-b', filename: 'history-b.pftrace'},
    });
    expect(panel.state.referenceTraceId).toBe('history-b');
    expect(panel.state.agentSessionId).toBeNull();
  });

  it('atomically loads a single session over the live comparison pair', () => {
    const session = sessionManager.createSession(
      'trace-a',
      'current.trace',
      'backend-current',
    );
    sessionManager.updateSession('trace-a', session.sessionId, {
      agentSessionId: 'agent-single',
      type: 'single',
    });

    const panel = createMutableTestPanel();
    panel.engine = {mode: 'HTTP_RPC'};
    panel.verifyBackendTrace = vi.fn();
    panel.state.backendTraceId = 'backend-current';
    panel.tracePairWorkspaceController.open({
      scope: panel.getTracePairWorkspaceScope(),
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });

    expect(panel.loadSession(session.sessionId)).toBe(true);

    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      open: false,
      referenceTrace: null,
    });
    expect(panel.state.referenceTraceId).toBeNull();
    expect(panel.buildTracePairContext()).toBeUndefined();
    expect(panel.state.agentSessionId).toBe('agent-single');
  });

  it('persists a canonical reference name without invalidating continuation', () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.referenceTraceId = 'history-a';
    panel.state.referenceTraceName = 'history-a';
    panel.state.agentSessionId = 'agent-a';
    panel.saveCurrentSession = vi.fn();
    panel.tracePairWorkspaceController.open({
      scope: {key: 'workspace/current', backendUrl: 'http://localhost:3000'},
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });
    panel.syncTracePairStateFromController();
    panel.state.agentSessionId = 'agent-a';
    panel.saveCurrentSession.mockClear();

    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace'},
    ]);
    panel.syncTracePairStateFromController();

    expect(panel.state.referenceTraceName).toBe('history-a.pftrace');
    expect(panel.state.agentSessionId).toBe('agent-a');
    expect(panel.saveCurrentSession).toHaveBeenCalledTimes(1);
  });

  it('invalidates continuation only when the semantic pair changes', () => {
    const panel = createMutableTestPanel();
    const pendingDataset = {label: 'pending', columns: [], rows: []};
    panel.state.backendTraceId = 'backend-current';
    panel.state.referenceTraceId = 'history-a';
    panel.state.referenceTraceName = 'history-a.trace';
    panel.state.agentSessionId = 'agent-a';
    panel.state.agentRunId = 'run-a';
    panel.state.agentRequestId = 'request-a';
    panel.state.agentRunSequence = 4;
    panel.state.pendingTraceContext = [pendingDataset];
    panel.state.sseLastEventId = 27;
    panel.saveCurrentSession = vi.fn();
    panel.tracePairWorkspaceController.open({
      scope: {key: 'workspace/current', backendUrl: 'http://localhost:3000'},
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.trace'},
      {id: 'history-b', filename: 'history-b.trace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });
    panel.syncTracePairStateFromController();
    panel.state.agentSessionId = 'agent-a';
    panel.state.agentRunId = 'run-a';
    panel.state.agentRequestId = 'request-a';
    panel.state.agentRunSequence = 4;
    panel.state.pendingTraceContext = [pendingDataset];
    panel.state.sseLastEventId = 27;

    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'backend-current',
    });
    panel.syncTracePairStateFromController();
    expect(panel.state.agentSessionId).toBe('agent-a');
    expect(panel.state.pendingTraceContext).toEqual([pendingDataset]);

    panel.tracePairWorkspaceController.selectTrace({
      pane: 'first',
      traceId: 'history-b',
    });
    panel.syncTracePairStateFromController();
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.agentRunId).toBeNull();
    expect(panel.state.agentRequestId).toBeNull();
    expect(panel.state.agentRunSequence).toBe(0);
    expect(panel.state.pendingTraceContext).toBeNull();
    expect(panel.state.sseLastEventId).toBeNull();
  });

  it('sends live dual-trace workspace context with analysis requests', async () => {
    const panel = new AIPanel() as any;
    panel.state.backendTraceId = 'backend-current';
    panel.state.currentTraceFingerprint = 'fingerprint-current';
    panel.state.referenceTraceId = 'backend-reference';
    panel.state.referenceTraceName = 'reference.trace';
    panel.tracePairWorkspaceController.open({
      scope: {key: 'workspace/current', backendUrl: 'http://localhost:3000'},
      currentTrace: {
        id: 'backend-current',
        filename: 'current.trace',
        fingerprint: 'fingerprint-current',
      },
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'backend-reference', filename: 'reference.trace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'first',
      traceId: 'backend-reference',
    });
    panel.tracePairWorkspaceController.setLayout('vertical');
    panel.tracePairWorkspaceController.setSplitPercent(66);
    panel.tracePairWorkspaceController.toggleMaximized('reference');
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
      notes: {
        removeNote: vi.fn(),
      },
    };
    panel.ensureAgentSessionReady = vi.fn(async () => {});
    panel.captureSelectionContext = vi.fn(async () => null);
    panel.listenToAgentSSE = vi.fn(async () => {});
    panel.saveCurrentSession = vi.fn();
    const fetchBackend = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            success: true,
            sessionId: 'agent-session',
            isNewSession: true,
          }),
          {
            status: 200,
            headers: {'x-request-id': 'request-1'},
          },
        ),
    );
    panel.fetchBackend = fetchBackend;

    await panel.handleChatMessage('对比上方和下方 Trace 的启动速度差异');

    expect(fetchBackend).toHaveBeenCalledTimes(1);
    const init = fetchBackend.mock.calls[0][1];
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody).toMatchObject({
      query: '对比上方和下方 Trace 的启动速度差异',
      traceId: 'backend-current',
      referenceTraceId: 'backend-reference',
      options: {
        tracePairContext: {
          schemaVersion: 1,
          layout: 'vertical',
          primarySide: 'bottom',
          referenceSide: 'top',
          activeSide: 'top',
          workspaceOpen: true,
          splitPercent: 66,
          maximizedTraceSide: 'reference',
          panes: [
            {
              side: 'bottom',
              traceSide: 'current',
              traceId: 'backend-current',
              traceName: 'current.trace',
              traceFingerprint: 'fingerprint-current',
              active: false,
              visualState: 'context_only',
            },
            {
              side: 'top',
              traceSide: 'reference',
              traceId: 'backend-reference',
              traceName: 'reference.trace',
              active: true,
              visualState: 'live',
            },
          ],
        },
      },
    });
    expect(requestBody.options.tracePairContext.aliases).toMatchObject({
      上方: 'reference',
      上边: 'reference',
      下方: 'current',
      下边: 'current',
      top: 'reference',
      bottom: 'current',
    });
    expect(panel.listenToAgentSSE).toHaveBeenCalledWith('agent-session');
  });

  it('cancels a session that arrives after stop was requested', async () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
      notes: {
        removeNote: vi.fn(),
      },
    };
    panel.ensureAgentSessionReady = vi.fn(async () => {});
    panel.captureSelectionContext = vi.fn(async () => null);
    panel.listenToAgentSSE = vi.fn(async () => {});
    panel.saveCurrentSession = vi.fn();
    let resolveAnalyze: ((response: Response) => void) | undefined;
    const analyzeResponse = new Promise<Response>((resolve) => {
      resolveAnalyze = resolve;
    });
    const fetchBackend = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/analyze')) return analyzeResponse;
      return new Response(
        JSON.stringify({
          success: true,
          sessionId: 'agent-late',
          runId: 'run-late',
          status: 'cancelled',
          outcome: 'cancelled',
          reason: 'Analysis cancelled by user',
        }),
        {status: 200},
      );
    });
    panel.fetchBackend = fetchBackend;

    const analysisPromise = panel.handleChatMessage('compare traces');
    await vi.waitFor(() => expect(fetchBackend).toHaveBeenCalledTimes(1));
    updateFloatingState({
      mode: 'sidebar',
      sidebar: {collapsed: false},
    });
    switchFloatingMode('tab');
    expect(getFloatingState().mode).toBe('sidebar');
    expect(getFloatingState().sidebar.collapsed).toBe(true);
    toggleSidebarCollapsedWithTransientState();
    expect(getFloatingState().sidebar.collapsed).toBe(false);
    const cancellationPromise = panel.cancelAnalysis();
    resolveAnalyze?.(
      new Response(
        JSON.stringify({
          success: true,
          sessionId: 'agent-late',
          runId: 'run-late',
          isNewSession: true,
        }),
        {status: 200},
      ),
    );

    await Promise.all([analysisPromise, cancellationPromise]);

    expect(fetchBackend).toHaveBeenCalledTimes(3);
    expect(fetchBackend.mock.calls[1][0]).toContain('/agent-late/cancel');
    expect(JSON.parse(String(fetchBackend.mock.calls[1][1]?.body))).toEqual({
      runId: 'run-late',
    });
    expect(fetchBackend.mock.calls[2][0]).toContain('/agent-late');
    expect(fetchBackend.mock.calls[2][1]?.method).toBe('DELETE');
    expect(panel.listenToAgentSSE).not.toHaveBeenCalled();
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.isLoading).toBe(false);
    expect(getAISharedState().status).toBe('cancelled');
    expect(
      panel.state.messages.filter(
        (message: {content: string}) => message.content === '分析已取消。',
      ),
    ).toHaveLength(1);
  });

  it('waits for the new run identity before stopping a continued session', async () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.agentSessionId = 'agent-existing';
    panel.state.agentRunId = 'run-completed';
    panel.state.messages.push({
      id: 'prior-progress',
      role: 'assistant',
      content: '上一轮有效进度证据',
      timestamp: 1,
      flowTag: 'streaming_flow',
    });
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
      notes: {
        removeNote: vi.fn(),
      },
    };
    panel.ensureAgentSessionReady = vi.fn(async () => {});
    panel.captureSelectionContext = vi.fn(async () => null);
    panel.listenToAgentSSE = vi.fn(async () => {});
    panel.saveCurrentSession = vi.fn();
    let resolveAnalyze: ((response: Response) => void) | undefined;
    const analyzeResponse = new Promise<Response>((resolve) => {
      resolveAnalyze = resolve;
    });
    const fetchBackend = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/analyze')) return analyzeResponse;
      return new Response(
        JSON.stringify({
          success: true,
          sessionId: 'agent-existing',
          runId: 'run-current',
          status: 'cancelled',
          outcome: 'cancelled',
          reason: 'Analysis cancelled by user',
        }),
        {status: 200},
      );
    });
    panel.fetchBackend = fetchBackend;

    const analysisPromise = panel.handleChatMessage('continued analysis');
    await vi.waitFor(() => expect(fetchBackend).toHaveBeenCalledTimes(1));

    const cancellationPromise = panel.cancelAnalysis();
    expect(fetchBackend).toHaveBeenCalledTimes(1);
    expect(panel.state.isLoading).toBe(true);

    resolveAnalyze?.(
      new Response(
        JSON.stringify({
          success: true,
          sessionId: 'agent-existing',
          runId: 'run-current',
          isNewSession: false,
        }),
        {status: 200},
      ),
    );
    await Promise.all([analysisPromise, cancellationPromise]);

    expect(fetchBackend).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchBackend.mock.calls[1][1]?.body))).toEqual({
      runId: 'run-current',
    });
    expect(fetchBackend.mock.calls[2][0]).toContain('/agent-existing');
    expect(fetchBackend.mock.calls[2][1]?.method).toBe('DELETE');
    expect(
      panel.state.messages.find(
        (message: {id: string}) => message.id === 'prior-progress',
      )?.content,
    ).toBe('上一轮有效进度证据');
    expect(
      panel.state.messages.filter(
        (message: {content: string}) => message.content === '分析已取消。',
      ),
    ).toHaveLength(1);
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.agentRunId).toBeNull();
  });

  it('sends the established run identity when stopping an active SSE run', async () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
      notes: {
        removeNote: vi.fn(),
      },
    };
    panel.ensureAgentSessionReady = vi.fn(async () => {});
    panel.captureSelectionContext = vi.fn(async () => null);
    panel.saveCurrentSession = vi.fn();
    let finishSse: (() => void) | undefined;
    panel.listenToAgentSSE = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSse = resolve;
        }),
    );
    const fetchBackend = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/analyze')) {
        return new Response(
          JSON.stringify({
            success: true,
            sessionId: 'agent-running',
            runId: 'run-running',
            isNewSession: true,
          }),
          {status: 200},
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          sessionId: 'agent-running',
          runId: 'run-running',
          status: 'cancelled',
          outcome: 'cancelled',
          reason: 'Analysis cancelled by user',
        }),
        {status: 200},
      );
    });
    panel.fetchBackend = fetchBackend;

    const analysisPromise = panel.handleChatMessage('active analysis');
    await vi.waitFor(() =>
      expect(panel.listenToAgentSSE).toHaveBeenCalledOnce(),
    );

    const cancellationPromise = panel.cancelAnalysis();
    await vi.waitFor(() => expect(fetchBackend).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchBackend.mock.calls[1][1]?.body))).toEqual({
      runId: 'run-running',
    });

    finishSse?.();
    await Promise.all([analysisPromise, cancellationPromise]);
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.agentRunId).toBeNull();
  });

  it('sends the established run identity when Story cancels an agent analysis', async () => {
    const panel = createMutableTestPanel();
    panel.state.agentSessionId = 'agent-story';
    panel.state.agentRunId = 'run-story';
    panel.state.storyState.status = 'running';
    panel.state.storyState.analysisId = 'agent-story';
    panel.state.isLoading = true;
    panel.saveCurrentSession = vi.fn();
    panel.fetchBackend = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            sessionId: 'agent-story',
            runId: 'run-story',
            status: 'cancelled',
            outcome: 'cancelled',
            reason: 'Analysis cancelled by user',
          }),
          {status: 200},
        ),
    );

    await panel.handleStoryCancel();

    expect(panel.fetchBackend).toHaveBeenCalledTimes(2);
    expect(panel.fetchBackend.mock.calls[0][0]).toContain(
      '/agent-story/cancel',
    );
    expect(
      JSON.parse(String(panel.fetchBackend.mock.calls[0][1]?.body)),
    ).toEqual({
      runId: 'run-story',
    });
    expect(panel.fetchBackend.mock.calls[1][0]).toContain('/agent-story');
    expect(panel.fetchBackend.mock.calls[1][1]?.method).toBe('DELETE');
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.agentRunId).toBeNull();
    expect(getAISharedState().status).toBe('cancelled');
  });

  it('does not reconnect an empty session when a pre-session stop fails', async () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.agentSessionId = '';
    panel.trace = {
      traceInfo: {
        traceTitle: 'current.trace',
        start: 0n,
        end: 10n,
      },
      notes: {
        removeNote: vi.fn(),
      },
    };
    panel.ensureAgentSessionReady = vi.fn(async () => {});
    panel.captureSelectionContext = vi.fn(async () => null);
    panel.listenToAgentSSE = vi.fn(async () => {});
    panel.saveCurrentSession = vi.fn();
    let rejectAnalyze: ((error: Error) => void) | undefined;
    panel.fetchBackend = vi.fn(
      async () =>
        new Promise<Response>((_resolve, reject) => {
          rejectAnalyze = reject;
        }),
    );

    const analysisPromise = panel.handleChatMessage('compare traces');
    await vi.waitFor(() => expect(panel.fetchBackend).toHaveBeenCalledTimes(1));
    await panel.cancelAnalysis();
    rejectAnalyze?.(new Error('network unavailable'));
    await analysisPromise;

    expect(panel.listenToAgentSSE).not.toHaveBeenCalled();
    expect(panel.state.agentSessionId).toBeNull();
    expect(panel.state.isLoading).toBe(false);
    expect(getAISharedState().status).toBe('error');
  });

  it('keeps a running comparison intact when semantic exit is requested', () => {
    const panel = createMutableTestPanel();
    panel.state.backendTraceId = 'backend-current';
    panel.state.referenceTraceId = 'history-a';
    panel.state.referenceTraceName = 'history-a.pftrace';
    panel.state.agentSessionId = 'agent-running';
    panel.state.agentRunId = 'run-running';
    panel.state.agentRequestId = 'request-running';
    panel.state.agentRunSequence = 3;
    panel.state.isLoading = true;
    panel.saveCurrentSession = vi.fn();
    panel.tracePairWorkspaceController.open({
      scope: {key: 'workspace/current', backendUrl: 'http://localhost:3000'},
      currentTrace: {id: 'backend-current', filename: 'current.trace'},
    });
    panel.tracePairWorkspaceController.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace'},
    ]);
    panel.tracePairWorkspaceController.selectTrace({
      pane: 'second',
      traceId: 'history-a',
    });
    panel.tracePairWorkspaceController.setSelectionLocked(true);
    const messageCount = panel.state.messages.length;

    panel.exitComparisonMode();

    expect(panel.state.referenceTraceId).toBe('history-a');
    expect(panel.state.agentSessionId).toBe('agent-running');
    expect(panel.state.agentRunId).toBe('run-running');
    expect(panel.state.agentRequestId).toBe('request-running');
    expect(panel.state.agentRunSequence).toBe(3);
    expect(panel.state.messages).toHaveLength(messageCount);
    expect(panel.tracePairWorkspaceController.getState()).toMatchObject({
      open: true,
      selectionLocked: true,
      referenceTrace: {id: 'history-a'},
    });
    expect(panel.saveCurrentSession).not.toHaveBeenCalled();
  });
});
