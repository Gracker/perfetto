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

import {AIPanel} from './ai_panel';
import {sessionManager} from './session_manager';
import type {AIPanelState, TracePairTraceSide} from './types';

type TestAIPanel = {
  state: AIPanelState;
  trace: {
    traceInfo: {
      traceTitle: string;
      start: bigint;
      end: bigint;
    };
    notes: {
      removeNote: () => void;
    };
  };
  ensureAgentSessionReady: () => Promise<void>;
  captureSelectionContext: (message?: string) => Promise<null>;
  listenToAgentSSE: (sessionId: string) => Promise<void>;
  saveCurrentSession: () => void;
  fetchBackend: (url: string, init?: RequestInit) => Promise<Response>;
  handleChatMessage: (message: string) => Promise<void>;
  renderTableSourceContext: (source: Parameters<AIPanel['renderTableSourceContext']>[0]) => unknown;
};

function collectVNodeText(node: any): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectVNodeText).join(' ');
  const parts = [
    node.text,
    node.children,
  ].filter((part) => part !== undefined);
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

describe('AIPanel header tool panels', () => {
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
          candidates: [{id: 'android_hwui', confidence: 0.91}],
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
    expect(markdown).toContain('未命中的 pattern: ^RenderThread$');
    expect(markdown).toContain('已 pin 的 track: com.example.app > main');
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

  it('sends live dual-trace workspace context with analysis requests', async () => {
    const panel = new AIPanel() as any;
    panel.state.backendTraceId = 'backend-current';
    panel.state.currentTraceFingerprint = 'fingerprint-current';
    panel.state.referenceTraceId = 'backend-reference';
    panel.state.referenceTraceName = 'reference.trace';
    panel.state.tracePairWorkspaceOpen = true;
    panel.state.tracePairLayout = 'vertical';
    panel.state.tracePairSplitPercent = 66;
    panel.state.tracePairMaximizedTraceSide = 'reference';
    panel.state.tracePairMinimizedTraceSides =
      new Set<TracePairTraceSide>(['current']);
    panel.state.isReferenceActive = true;
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
    const fetchBackend = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      success: true,
      sessionId: 'agent-session',
      isNewSession: true,
    }), {
      status: 200,
      headers: {'x-request-id': 'request-1'},
    }));
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
          primarySide: 'top',
          referenceSide: 'bottom',
          activeSide: 'bottom',
          workspaceOpen: true,
          splitPercent: 66,
          maximizedTraceSide: 'reference',
          minimizedTraceSides: ['current'],
          panes: [
            {
              side: 'top',
              traceSide: 'current',
              traceId: 'backend-current',
              traceName: 'current.trace',
              traceFingerprint: 'fingerprint-current',
              active: false,
              visualState: 'context_only',
            },
            {
              side: 'bottom',
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
      '上方': 'current',
      '上边': 'current',
      '下方': 'reference',
      '下边': 'reference',
      top: 'current',
      bottom: 'reference',
    });
    expect(panel.listenToAgentSSE).toHaveBeenCalledWith('agent-session');
  });
});
