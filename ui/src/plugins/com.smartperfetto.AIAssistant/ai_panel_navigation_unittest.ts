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

import {describe, it, expect, vi} from 'vitest';

import {AIPanel} from './ai_panel';

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

describe('AIPanel /goto navigation', () => {
  it('renders all table source metadata chips', () => {
    const panel = new AIPanel() as any;

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
