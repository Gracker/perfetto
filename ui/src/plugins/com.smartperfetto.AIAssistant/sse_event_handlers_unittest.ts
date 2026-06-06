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

/**
 * Unit tests for sse_event_handlers.ts
 *
 * Tests cover:
 * - Event type handling (progress, hypothesis_generated, round_start, etc.)
 * - State updates (status, progress message, findings accumulation)
 * - Error handling (malformed data, unknown events, recovery)
 * - Intervention event handling
 * - Strategy selection events
 * - Terminal events (analysis_completed, analysis_cancelled, error)
 */

import {describe, it, expect, beforeEach} from 'vitest';

import {
  SSEHandlerContext,
  handleProgressEvent,
  handleSqlExecutedEvent,
  handleSkillSectionEvent,
  handleSkillDiagnosticsEvent,
  handleSkillLayeredResultEvent,
  handleAnalysisCompletedEvent,
  handleHypothesisGeneratedEvent,
  handleRoundStartEvent,
  handleAgentTaskDispatchedEvent,
  handleSynthesisCompleteEvent,
  handleStrategyDecisionEvent,
  handleDataEvent,
  handleSkillErrorEvent,
  handleErrorEvent,
  handleInterventionRequiredEvent,
  handleInterventionResolvedEvent,
  handleInterventionTimeoutEvent,
  handleStrategySelectedEvent,
  handleStrategyFallbackEvent,
  handleFocusUpdatedEvent,
  handleSSEEvent,
  handleAnswerTokenEvent,
  handleConversationStepEvent,
} from './sse_event_handlers';

import {Message, InterventionState, createStreamingAnswerState, createStreamingFlowState} from './types';
import {getAISharedState, resetAISharedState} from './ai_shared_state';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock SSEHandlerContext for testing.
 */
function createMockContext(overrides?: Partial<SSEHandlerContext>): SSEHandlerContext & {
  messages: Message[];
  flowMessages: Message[];
  interventionState: InterventionState;
} {
  const messages: Message[] = [];
  const flowMessages: Message[] = [];
  let idCounter = 0;
  let completionHandled = false;
  let interventionState: InterventionState = {
    isActive: false,
    intervention: null,
    selectedOptionId: null,
    customInput: '',
    isSending: false,
    timeoutRemaining: null,
  };

  const ctxRef: SSEHandlerContext & {
    messages: Message[];
    flowMessages: Message[];
    interventionState: InterventionState;
  } = {
    messages,
    flowMessages,
    interventionState,
    addMessage: (msg: Message) => {
      if (msg.flowTag === 'streaming_flow') {
        flowMessages.push(msg);
        return;
      }
      messages.push(msg);
    },
    updateMessage: (messageId: string, updates: Partial<Message>) => {
      const allMessages = [messages, flowMessages];
      for (const list of allMessages) {
        const index = list.findIndex((msg) => msg.id === messageId);
        if (index !== -1) {
          list[index] = {
            ...list[index],
            ...updates,
          };
          return;
        }
      }
    },
    generateId: () => `test-msg-${++idCounter}`,
    getMessages: () => [...messages, ...flowMessages],
    removeLastMessageIf: (predicate: (msg: Message) => boolean) => {
      if (messages.length > 0 && predicate(messages[messages.length - 1])) {
        messages.pop();
        return true;
      }
      return false;
    },
    setLoading: () => {},
    displayedSkillProgress: new Set<string>(),
    collectedErrors: [],
    completionHandled,
    setCompletionHandled: (handled: boolean) => {
      completionHandled = handled;
      (ctxRef as any).completionHandled = handled;
    },
    backendUrl: 'http://localhost:3000',
    streamingFlow: createStreamingFlowState(),
    streamingAnswer: createStreamingAnswerState(),
    setInterventionState: (state: Partial<InterventionState>) => {
      interventionState = {...interventionState, ...state};
      // Keep exposed test field in sync with latest intervention state.
      (ctxRef as any).interventionState = interventionState;
    },
    getInterventionState: () => interventionState,
    ...overrides,
  };

  return ctxRef;
}

// =============================================================================
// Progress Event Tests
// =============================================================================

describe('handleProgressEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    resetAISharedState();
  });

  it('should add progress message with correct format', () => {
    const data = {data: {message: 'Analyzing frames...'}};

    const result = handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Analyzing frames...');
    expect(ctx.flowMessages[0].role).toBe('assistant');
    expect(result).toEqual({loadingPhase: 'Analyzing frames...'});
  });

  it('should keep existing messages and update streaming flow for new progress', () => {
    // Add initial progress message
    ctx.addMessage({
      id: 'prev',
      role: 'assistant',
      content: '⏳ Previous progress',
      timestamp: Date.now(),
    });

    const data = {data: {message: 'New progress'}};
    handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('⏳ Previous progress');
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('New progress');
  });

  it('should not remove non-progress messages', () => {
    ctx.addMessage({
      id: 'regular',
      role: 'assistant',
      content: 'Some analysis result',
      timestamp: Date.now(),
    });

    const data = {data: {message: 'Progress update'}};
    handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Progress update');
  });

  it('should handle null data gracefully', () => {
    const result = handleProgressEvent(null, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('should handle missing message field', () => {
    const data = {data: {}};

    const result = handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('should render persistent analysis_plan message', () => {
    const data = {
      data: {
        phase: 'analysis_plan',
        message: '已确认分析计划',
        plan: {
          mode: 'hypothesis',
          objective: '分析滑动性能',
          steps: [
            {order: 1, title: '证据采集', action: '先收集基线指标'},
            {order: 2, title: '形成假设', action: '基于证据形成待验证假设'},
          ],
          evidence: ['FPS/掉帧率', '主线程耗时分布'],
          hypothesisPolicy: 'after_first_evidence',
        },
      },
    };

    handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('🧭 分析计划已确认');
    expect(ctx.messages[0].content).toContain('证据采集');
    expect(ctx.messages[0].content).toContain('证据清单');
    expect(ctx.messages[0].content.startsWith('⏳')).toBe(false);
  });
});

// =============================================================================
// SQL Executed Event Tests
// =============================================================================

describe('handleSqlExecutedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    resetAISharedState();
  });

  it('should add message with SQL result data', () => {
    const data = {
      data: {
        sql: 'SELECT * FROM slices LIMIT 10',
        result: {
          columns: ['id', 'name', 'dur'],
          rows: [[1, 'frame', 16666667]],
          rowCount: 1,
        },
      },
    };

    handleSqlExecutedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('1');
    expect(ctx.messages[0].sqlResult).toBeDefined();
    expect(ctx.messages[0].sqlResult!.columns).toEqual(['id', 'name', 'dur']);
    expect(ctx.messages[0].sqlResult!.rowCount).toBe(1);
  });

  it('should handle zero row count', () => {
    const data = {
      data: {
        result: {
          columns: ['id'],
          rows: [],
          rowCount: 0,
        },
      },
    };

    handleSqlExecutedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('0');
  });

  it('should handle missing result', () => {
    const data = {data: {}};

    handleSqlExecutedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Skill Section Event Tests
// =============================================================================

describe('handleSkillSectionEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should add message with section data', () => {
    const data = {
      data: {
        sectionTitle: 'Frame Analysis',
        sectionIndex: 1,
        totalSections: 3,
        columns: ['frame_id', 'dur_ms'],
        rows: [[1, 16.67]],
        rowCount: 1,
      },
    };

    handleSkillSectionEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toBeDefined();
    expect(ctx.messages[0].sqlResult!.sectionTitle).toBe('Frame Analysis (1/3)');
  });

  it('should handle empty rows', () => {
    const data = {
      data: {
        sectionTitle: 'Empty Section',
        sectionIndex: 1,
        totalSections: 1,
        columns: ['col1'],
        rows: [],
        rowCount: 0,
      },
    };

    handleSkillSectionEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toBeDefined();
    expect(ctx.messages[0].sqlResult?.columns).toEqual(['col1']);
    expect(ctx.messages[0].sqlResult?.rows).toEqual([]);
    expect(ctx.messages[0].sqlResult?.rowCount).toBe(0);
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '表 1',
      source: 'skill_section',
      rowCount: 0,
      reason: 'Skill 返回的结构化证据，用来支撑后续筛选、下钻或结论判断。',
    });
  });

  it('shows a visible empty-state message when a section has no table shape', () => {
    const data = {
      data: {
        sectionTitle: 'No Columns Section',
        sectionIndex: 1,
        totalSections: 1,
        columns: [],
        rows: [],
        rowCount: 0,
      },
    };

    handleSkillSectionEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('No Columns Section');
    expect(ctx.messages[0].content).toContain('未返回可展示列');
    expect(ctx.messages[0].sqlResult).toBeUndefined();
  });
});

// =============================================================================
// Skill Diagnostics Event Tests
// =============================================================================

describe('handleSkillDiagnosticsEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should format diagnostics with severity levels', () => {
    const data = {
      data: {
        diagnostics: [
          {severity: 'critical', message: 'High frame drop rate'},
          {severity: 'warning', message: 'Elevated CPU usage'},
          {severity: 'info', message: 'Normal memory allocation'},
        ],
      },
    };

    handleSkillDiagnosticsEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('High frame drop rate');
    expect(ctx.messages[0].content).toContain('Elevated CPU usage');
    expect(ctx.messages[0].content).toContain('Normal memory allocation');
  });

  it('should include suggestions for critical issues', () => {
    const data = {
      data: {
        diagnostics: [
          {
            severity: 'critical',
            message: 'Main thread blocked',
            suggestions: ['Move work off main thread'],
          },
        ],
      },
    };

    handleSkillDiagnosticsEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('Move work off main thread');
  });

  it('should handle empty diagnostics', () => {
    const data = {data: {diagnostics: []}};

    handleSkillDiagnosticsEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Hypothesis Generated Event Tests
// =============================================================================

describe('handleHypothesisGeneratedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display generated hypotheses', () => {
    const data = {
      data: {
        hypotheses: [
          'Main thread is blocked by binder calls',
          'RenderThread is CPU throttled',
          'Memory pressure causing GC',
        ],
      },
    };

    handleHypothesisGeneratedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('3 个分析假设');
    expect(ctx.messages[0].content).toContain('Main thread is blocked');
    expect(ctx.messages[0].content).toContain('RenderThread is CPU');
  });

  it('should display evidence-based hypothesis message', () => {
    const data = {
      data: {
        hypotheses: [
          'Main thread blocked by long layout passes',
          'CPU scheduling delay on critical thread',
        ],
        evidenceBased: true,
        evidenceSummary: [
          '发现: Main thread long task',
          '任务反馈: 2/2 成功，2 个任务返回有效数据',
        ],
      },
    };

    handleHypothesisGeneratedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('基于证据形成了 2 个待验证假设');
    expect(ctx.messages[0].content).toContain('首轮证据摘要');
    expect(ctx.messages[0].content).toContain('Main thread blocked');
  });

  it('should handle empty hypotheses array', () => {
    const data = {data: {hypotheses: []}};

    handleHypothesisGeneratedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });

  it('should handle missing hypotheses field', () => {
    const data = {data: {}};

    handleHypothesisGeneratedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Round Start Event Tests
// =============================================================================

describe('handleRoundStartEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display round number and max rounds', () => {
    const data = {
      data: {
        round: 2,
        maxRounds: 5,
        message: 'Analyzing CPU scheduling',
      },
    };

    handleRoundStartEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('2/5');
    expect(ctx.messages[0].content).toContain('Analyzing CPU scheduling');
  });

  it('should ignore empty payloads', () => {
    const data = {data: {}};

    handleRoundStartEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Agent Task Dispatched Event Tests
// =============================================================================

describe('handleAgentTaskDispatchedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display task count and agents', () => {
    const data = {
      data: {
        taskCount: 3,
        agents: ['frameAgent', 'cpuAgent', 'memoryAgent'],
        message: 'Dispatching analysis tasks',
      },
    };

    handleAgentTaskDispatchedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('frameAgent');
    expect(ctx.messages[0].content).toContain('cpuAgent');
    expect(ctx.messages[0].content).toContain('memoryAgent');
  });

  it('should handle empty agents list', () => {
    const data = {
      data: {
        taskCount: 1,
        agents: [],
        message: 'Dispatching task',
      },
    };

    handleAgentTaskDispatchedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).not.toContain('派发给');
  });
});

// =============================================================================
// Synthesis Complete Event Tests
// =============================================================================

describe('handleSynthesisCompleteEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display findings and hypotheses counts', () => {
    const data = {
      data: {
        confirmedFindings: 5,
        updatedHypotheses: 2,
        message: 'Synthesis complete',
      },
    };

    handleSynthesisCompleteEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('5 个发现');
    expect(ctx.messages[0].content).toContain('2 个假设');
  });

  it('should ignore empty payloads', () => {
    const data = {data: {}};

    handleSynthesisCompleteEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Strategy Decision Event Tests
// =============================================================================

describe('handleStrategyDecisionEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display conclude strategy with checkmark emoji', () => {
    const data = {
      data: {
        strategy: 'conclude',
        confidence: 0.85,
        message: 'Ready to conclude',
      },
    };

    handleStrategyDecisionEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('✅');
    expect(ctx.messages[0].content).toContain('85%');
  });

  it('should display deep_dive strategy with magnifier emoji', () => {
    const data = {
      data: {
        strategy: 'deep_dive',
        confidence: 0.5,
        message: 'Need more analysis',
      },
    };

    handleStrategyDecisionEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('🔍');
  });

  it('should display pivot strategy with arrow emoji', () => {
    const data = {
      data: {
        strategy: 'pivot',
        confidence: 0.3,
        message: 'Changing direction',
      },
    };

    handleStrategyDecisionEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('↩️');
  });
});

// =============================================================================
// Analysis Completed Event Tests
// =============================================================================

describe('handleAnalysisCompletedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should add conclusion message', () => {
    const data = {
      data: {
        conclusion: 'Main thread is blocked by binder calls, causing jank.',
      },
    };

    const result = handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Main thread is blocked');
    expect(result.isTerminal).toBe(true);
    expect(result.stopLoading).toBe(true);
  });

  it('should support legacy answer field', () => {
    const data = {
      data: {
        answer: 'Legacy conclusion format.',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Legacy conclusion');
  });

  it('should add report URL if available', () => {
    const data = {
      data: {
        conclusion: 'Analysis complete.',
        reportUrl: '/reports/123.html',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].reportUrl).toBe('http://localhost:3000/reports/123.html');
  });

  it('should keep result snapshot reference out of the visible conclusion message', () => {
    const data = {
      data: {
        conclusion: 'Analysis complete.',
        resultSnapshotId: 'analysis-result-12345678-aaaa-bbbb-cccc-123456789abc',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toBe('Analysis complete.');
    expect(ctx.messages[0].content).not.toContain('Result ID');
    expect(ctx.messages[0].content).not.toContain('Snapshot');
  });

  it('should not add snapshot reference lines even when conclusion mentions the short ref', () => {
    const data = {
      data: {
        conclusion: 'Analysis complete. Mentioned AR-12345678 in narrative.',
        resultSnapshotId: 'analysis-result-12345678-aaaa-bbbb-cccc-123456789abc',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('Mentioned AR-12345678 in narrative.');
    expect(ctx.messages[0].content).not.toContain('Snapshot:');
  });

  it('should append code references and patch status without rendering raw diff text', () => {
    const data = {
      data: {
        conclusion: 'Analysis complete.',
        conclusionContract: {
          codeReferences: [
            {
              chunkId: 'chunk-main',
              codebaseId: 'cb_app',
              filePath: 'app/src/main/MainActivity.kt',
              lineRange: {start: 10, end: 18},
              symbol: 'MainActivity.onCreate',
            },
          ],
          patchProposals: [
            {
              id: 'patch-1',
              status: 'sketch',
              rationale: 'Needs manual rewrite.',
              diff: 'SECRET_RAW_DIFF_SHOULD_NOT_RENDER',
            },
          ],
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('## Code references');
    expect(ctx.messages[0].content).toContain('`chunk-main`');
    expect(ctx.messages[0].content).toContain('app/src/main/MainActivity.kt:L10-18');
    expect(ctx.messages[0].content).toContain('## Patch proposals');
    expect(ctx.messages[0].content).toContain('sketch only; no copyable diff');
    expect(ctx.messages[0].content).not.toContain('SECRET_RAW_DIFF_SHOULD_NOT_RENDER');
  });

  it('should attach report URL without appending snapshot reference when conclusion arrived earlier', () => {
    ctx.addMessage({
      id: 'existing-answer',
      role: 'assistant',
      content: 'Earlier conclusion.',
      timestamp: Date.now(),
    });
    ctx.setCompletionHandled(true);

    const data = {
      data: {
        resultSnapshotId: 'analysis-result-abcdef12-aaaa-bbbb-cccc-123456789abc',
        reportUrl: '/reports/123.html',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toBe('Earlier conclusion.');
    expect(ctx.messages[0].content).not.toContain('Result ID');
    expect(ctx.messages[0].reportUrl).toBe('http://localhost:3000/reports/123.html');
  });

  it('should backfill conversation timeline from analysis_completed payload', () => {
    const data = {
      data: {
        conclusion: '分析完成',
        conversationTimeline: [
          {
            eventId: 'evt-2',
            ordinal: 2,
            phase: 'tool',
            role: 'agent',
            text: '执行 SQL',
          },
          {
            eventId: 'evt-1',
            ordinal: 1,
            phase: 'progress',
            role: 'system',
            text: '进入 discovery',
          },
        ],
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.flowMessages).toHaveLength(1);
    const flowContent = ctx.flowMessages[0].content;
    expect(flowContent).toContain('🧵 对话时间线');
    expect(flowContent).toContain('#1');
    expect(flowContent).toContain('#2');
    expect(flowContent).toContain('进入 discovery');
    expect(flowContent).toContain('执行 SQL');
    expect(flowContent.indexOf('#1')).toBeLessThan(flowContent.indexOf('#2'));
  });

  it('should keep agent-driven metadata out of the visible conclusion', () => {
    const data = {
      architecture: 'v2-agent-driven',
      data: {
        conclusion: 'Analysis complete.',
        confidence: 0.9,
        rounds: 3,
        hypotheses: [
          {description: 'Main thread blocked', status: 'confirmed'},
        ],
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toBe('Analysis complete.');
    expect(ctx.messages[0].content).not.toContain('分析元数据');
    expect(ctx.messages[0].content).not.toContain('Main thread blocked');
  });

  it('should render conclusionContract when narrative text is absent', () => {
    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          schema_version: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusion: [
            {
              rank: 1,
              statement: '滑动过程存在明显卡顿',
              confidence: 88,
            },
          ],
          evidence_chain: [
            {conclusion_id: 'C1', evidence: ['逐帧根因显示主线程耗时占比65%（ev_111111111111）']},
          ],
          next_steps: ['对K1聚类下钻'],
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('## 结论（按可能性排序）');
    expect(ctx.messages[0].content).toContain('## 聚类（先看大头）');
    expect(ctx.messages[0].content).not.toContain('## 掉帧聚类（先看大头）');
    expect(ctx.messages[0].content).toContain('滑动过程存在明显卡顿');
    expect(ctx.messages[0].content).toContain('对K1聚类下钻');
  });

  it('should use jank cluster heading when scene id is jank', () => {
    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '存在掉帧'}],
          clusters: [{cluster: 'K1', description: '掉帧簇', frames: 5, percentage: 50}],
          metadata: {scene_id: 'jank'},
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('## 掉帧聚类（先看大头）');
  });

  it('should render cluster frame refs and omission hint from contract fields', () => {
    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '存在分组'}],
          clusters: [
            {
              cluster: 'K1',
              description: '主线程耗时',
              frames: 12,
              percentage: 60,
              frame_refs: ['1435500', '1435508', '1435517'],
              omitted_frame_refs: 9,
            },
          ],
          evidence_chain: [{conclusion_id: 'C1', text: '证据'}],
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('帧: 1435500 / 1435508 / 1435517');
    expect(ctx.messages[0].content).toContain('其余 9 帧省略');
  });

  it('should not hard-cap cluster rendering at five items', () => {
    const clusters = Array.from({length: 6}, (_, idx) => ({
      cluster: `K${idx + 1}`,
      description: `簇${idx + 1}`,
      frames: idx + 1,
      percentage: 10,
    }));

    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '存在多个簇'}],
          clusters,
          evidence_chain: [{conclusion_id: 'C1', text: '证据'}],
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('K6: 簇6');
  });

  it('should normalize camelCase aliases and apply cluster policy maxClusters', () => {
    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          conclusions: [
            {rank: 1, statement: '主结论', confidence: 0.9},
          ],
          clusters: [
            {
              cluster: 'K1',
              description: '主要簇',
              frames: 8,
              percentage: 0.5,
              frameRefs: ['111', '222'],
              omittedFrames: 6,
            },
            {
              cluster: 'K2',
              description: '次要簇',
              frames: 2,
              percentage: 0.2,
            },
          ],
          evidenceChain: [{conclusionId: 'C1', evidence: ['关键证据']}],
          nextSteps: ['继续下钻K1'],
          metadata: {
            sceneId: 'jank',
            confidencePercent: 0.9,
            rounds: 4,
            clusterPolicy: {maxClusters: 1},
          },
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('## 掉帧聚类（先看大头）');
    expect(ctx.messages[0].content).toContain('K1: 主要簇');
    expect(ctx.messages[0].content).not.toContain('K2: 次要簇');
    expect(ctx.messages[0].content).toContain('帧: 111 / 222');
    expect(ctx.messages[0].content).toContain('其余 6 帧省略');
    expect(ctx.messages[0].content).toContain('置信度: 90%');
    expect(ctx.messages[0].content).not.toContain('分析轮次: 4');
  });

  it('should apply snake_case cluster policy max_clusters', () => {
    const data = {
      architecture: 'agent-driven',
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主结论'}],
          clusters: [
            {cluster: 'K1', description: '保留簇', frames: 10, percentage: 80},
            {cluster: 'K2', description: '被裁剪簇', frames: 2, percentage: 20},
          ],
          evidence_chain: [{conclusion_id: 'C1', text: '证据'}],
          metadata: {
            cluster_policy: {max_clusters: 1},
          },
        },
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('K1: 保留簇');
    expect(ctx.messages[0].content).not.toContain('K2: 被裁剪簇');
  });

  it('should strip metadata sections from the visible conclusion', () => {
    const data = {
      architecture: 'v2-agent-driven',
      data: {
        conclusion: `## 结论（按可能性排序）\n1. 示例\n\n## 分析元数据\n- 置信度: 90%\n- 分析轮次: 3`,
        confidence: 0.9,
        rounds: 3,
        hypotheses: [
          {description: 'Main thread blocked', status: 'confirmed'},
        ],
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    expect(ctx.messages[0].content).toBe('## 结论（按可能性排序）\n1. 示例');
    expect(ctx.messages[0].content).not.toContain('分析元数据');
  });

  it('should not duplicate conclusion if already shown', () => {
    ctx.addMessage({
      id: 'existing',
      role: 'assistant',
      content: '🎯 分析结论: Already shown.',
      timestamp: Date.now(),
    });

    const data = {
      data: {
        conclusion: 'New conclusion.',
      },
    };

    handleAnalysisCompletedEvent(data, ctx);

    // Should still have only one message (the original)
    expect(ctx.messages).toHaveLength(1);
  });

  it('should prevent duplicate handling', () => {
    const data = {data: {conclusion: 'Test'}};

    handleAnalysisCompletedEvent(data, ctx);
    handleAnalysisCompletedEvent(data, ctx);

    // Should only add one message
    expect(ctx.messages).toHaveLength(1);
  });

  it('should show error summary if errors were collected', () => {
    ctx.collectedErrors.push({
      skillId: 'test_skill',
      error: 'SQL execution failed',
      timestamp: Date.now(),
    });

    const data = {data: {conclusion: 'Partial analysis complete.'}};

    handleAnalysisCompletedEvent(data, ctx);

    // Should have conclusion + error summary
    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[1].content).toContain('错误');
    expect(ctx.messages[1].content).toContain('test_skill');
  });

  it('should handle malformed analysis_completed payload gracefully', () => {
    const result = handleAnalysisCompletedEvent({
      architecture: 123,
      data: 'invalid-payload',
    }, ctx);

    expect(result).toEqual({isTerminal: true, stopLoading: true});
    expect(ctx.messages).toHaveLength(0);
  });
});

// =============================================================================
// Error Event Tests
// =============================================================================

describe('handleErrorEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display error message', () => {
    const data = {
      data: {
        error: 'Failed to connect to trace processor',
      },
    };

    const result = handleErrorEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Failed to connect');
    expect(result.isTerminal).toBe(true);
    expect(result.stopLoading).toBe(true);
  });

  it('should show error summary if errors were collected', () => {
    ctx.collectedErrors.push({
      skillId: 'skill1',
      error: 'Error 1',
      timestamp: Date.now(),
    });

    const data = {data: {error: 'Fatal error'}};

    handleErrorEvent(data, ctx);

    expect(ctx.messages).toHaveLength(2);
  });

  it('should handle missing error field', () => {
    const data = {data: {}};

    const result = handleErrorEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result.isTerminal).toBe(true);
  });
});

// =============================================================================
// Skill Error Event Tests
// =============================================================================

describe('handleSkillErrorEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should collect non-fatal errors', () => {
    const data = {
      skillId: 'frame_analysis',
      data: {
        stepId: 'step1',
        error: 'No data found for time range',
      },
    };

    handleSkillErrorEvent(data, ctx);

    expect(ctx.collectedErrors).toHaveLength(1);
    expect(ctx.collectedErrors[0].skillId).toBe('frame_analysis');
    expect(ctx.collectedErrors[0].stepId).toBe('step1');
    expect(ctx.collectedErrors[0].error).toBe('No data found for time range');
  });

  it('should handle missing fields gracefully', () => {
    const data = {data: {error: 'Unknown error'}};

    handleSkillErrorEvent(data, ctx);

    expect(ctx.collectedErrors).toHaveLength(1);
    expect(ctx.collectedErrors[0].skillId).toBe('unknown');
  });
});

// =============================================================================
// Intervention Event Tests
// =============================================================================

describe('handleInterventionRequiredEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should set intervention state when required', () => {
    const data = {
      data: {
        interventionId: 'int-123',
        type: 'low_confidence',
        options: [
          {id: 'opt1', label: 'Continue', action: 'continue', recommended: true},
          {id: 'opt2', label: 'Abort', action: 'abort'},
        ],
        context: {
          confidence: 0.3,
          elapsedTimeMs: 5000,
          roundsCompleted: 2,
          progressSummary: 'Found 3 potential issues',
          triggerReason: 'Low confidence in findings',
          findingsCount: 3,
        },
        timeout: 60000,
      },
    };

    handleInterventionRequiredEvent(data, ctx);

    expect(ctx.interventionState.isActive).toBe(true);
    expect(ctx.interventionState.intervention).not.toBe(null);
    expect(ctx.interventionState.intervention!.interventionId).toBe('int-123');
    expect(ctx.interventionState.intervention!.type).toBe('low_confidence');
    expect(ctx.interventionState.intervention!.options).toHaveLength(2);
    expect(ctx.interventionState.timeoutRemaining).toBe(60000);
  });

  it('should add system message for intervention', () => {
    const data = {
      data: {
        interventionId: 'int-456',
        type: 'ambiguity',
        options: [],
        context: {
          triggerReason: 'Multiple possible causes detected',
        },
        timeout: 30000,
      },
    };

    handleInterventionRequiredEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].role).toBe('system');
    expect(ctx.messages[0].content).toContain('需要您的决定');
  });

  it('should use correct emoji for different intervention types', () => {
    const types = ['low_confidence', 'ambiguity', 'timeout', 'circuit_breaker', 'agent_request'];
    const emojis = ['🤔', '🔀', '⏰', '⚠️', '❓'];

    types.forEach((type, index) => {
      const testCtx = createMockContext();
      const data = {
        data: {
          interventionId: `int-${index}`,
          type,
          options: [],
          context: {},
          timeout: 30000,
        },
      };

      handleInterventionRequiredEvent(data, testCtx);

      expect(testCtx.messages[0].content).toContain(emojis[index]);
    });
  });

  it('should handle missing setInterventionState gracefully', () => {
    const ctxWithoutIntervention = createMockContext();
    ctxWithoutIntervention.setInterventionState = undefined;

    const data = {
      data: {
        interventionId: 'int-789',
        type: 'low_confidence',
        options: [],
        context: {},
        timeout: 30000,
      },
    };

    // Should not throw
    const result = handleInterventionRequiredEvent(data, ctxWithoutIntervention);
    expect(result).toEqual({});
  });

  it('should sanitize malformed intervention type and options', () => {
    const data = {
      data: {
        interventionId: 'int-sanitize',
        type: 'unknown_type',
        options: [
          {id: 'opt-1', label: 'Keep going', action: 'not_valid'},
          {label: 'Abort now', action: 'abort', recommended: true},
          'invalid-option',
        ],
        context: {
          triggerReason: 'Need user decision',
        },
        timeout: 15000,
      },
    };

    expect(() => handleInterventionRequiredEvent(data, ctx)).not.toThrow();
    expect(ctx.interventionState.intervention).not.toBe(null);
    const intervention = ctx.interventionState.intervention!;
    expect(intervention.type).toBe('agent_request');
    expect(intervention.options).toHaveLength(3);
    expect(intervention.options[0]).toEqual(
      expect.objectContaining({id: 'opt-1', action: 'continue'})
    );
    expect(intervention.options[1]).toEqual(
      expect.objectContaining({action: 'abort', recommended: true})
    );
    expect(intervention.options[2]).toEqual(
      expect.objectContaining({id: 'option_3', label: '选项 3'})
    );
  });
});

describe('handleInterventionResolvedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    // Set up active intervention
    ctx.interventionState = {
      isActive: true,
      intervention: {
        interventionId: 'int-123',
        type: 'low_confidence',
        options: [],
        context: {
          confidence: 0.3,
          elapsedTimeMs: 5000,
          roundsCompleted: 2,
          progressSummary: '',
          triggerReason: '',
          findingsCount: 0,
        },
        timeout: 60000,
      },
      selectedOptionId: null,
      customInput: '',
      isSending: false,
      timeoutRemaining: 50000,
    };
  });

  it('should clear intervention state', () => {
    const data = {
      data: {
        action: 'continue',
      },
    };

    handleInterventionResolvedEvent(data, ctx);

    expect(ctx.interventionState.isActive).toBe(false);
    expect(ctx.interventionState.intervention).toBe(null);
  });

  it('should add confirmation message with correct emoji', () => {
    const actions = ['continue', 'focus', 'abort', 'other'];
    const emojis = ['▶️', '🎯', '🛑', '✅'];

    actions.forEach((action, index) => {
      const testCtx = createMockContext();
      const data = {data: {action}};

      handleInterventionResolvedEvent(data, testCtx);

      expect(testCtx.messages[0].content).toContain(emojis[index]);
      expect(testCtx.messages[0].content).toContain(action);
    });
  });
});

describe('handleInterventionTimeoutEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should clear intervention state on timeout', () => {
    ctx.interventionState.isActive = true;

    const data = {
      data: {
        defaultAction: 'abort',
      },
    };

    handleInterventionTimeoutEvent(data, ctx);

    expect(ctx.interventionState.isActive).toBe(false);
  });

  it('should add timeout message', () => {
    const data = {
      data: {
        defaultAction: 'continue',
      },
    };

    handleInterventionTimeoutEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('响应超时');
    expect(ctx.messages[0].content).toContain('continue');
  });
});

// =============================================================================
// Strategy Selection Event Tests
// =============================================================================

describe('handleStrategySelectedEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display selected strategy with LLM method', () => {
    const data = {
      data: {
        strategyName: 'scrolling_analysis',
        selectionMethod: 'llm',
        confidence: 0.9,
        reasoning: 'User query matches scrolling pattern',
      },
    };

    handleStrategySelectedEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('🧠');
    expect(ctx.messages[0].content).toContain('scrolling_analysis');
    expect(ctx.messages[0].content).toContain('90%');
  });

  it('should display selected strategy with keyword method', () => {
    const data = {
      data: {
        strategyName: 'startup_analysis',
        selectionMethod: 'keyword',
        confidence: 1.0,
        reasoning: 'Keyword match: startup',
      },
    };

    handleStrategySelectedEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('🔑');
  });
});

describe('handleStrategyFallbackEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should display fallback message', () => {
    const data = {
      data: {
        reason: 'No matching strategy found for query',
      },
    };

    handleStrategyFallbackEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('假设驱动分析');
    expect(ctx.messages[0].content).toContain('No matching strategy');
  });

  it('should use default reason if payload is present without a reason', () => {
    const data = {data: {fallback: true}};

    handleStrategyFallbackEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('未命中预设策略');
  });
});

describe('handleFocusUpdatedEvent', () => {
  it('should silently process focus updates', () => {
    const ctx = createMockContext();
    const data = {
      data: {
        focusType: 'time_range',
        startTs: 1000000,
        endTs: 2000000,
      },
    };

    const result = handleFocusUpdatedEvent(data, ctx);

    // Should not add any messages
    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });
});

// =============================================================================
// Skill Layered Result Event Tests
// =============================================================================

describe('handleSkillLayeredResultEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should handle overview layer data', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          overview: {
            performance_summary: {
              data: [{fps: 58.5, jank_rate: 5.2, total_frames: 100}],
              display: {title: 'Performance Summary'},
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages.length).toBeGreaterThan(0);
  });

  it('indexes parsed summary tables as data sources', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          overview: {},
        },
        summary: 'FPS: 60, Jank Rate: 5%',
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '摘要 1',
      title: '分析摘要',
      kind: 'summary',
      rowCount: 1,
    });

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '摘要已生成。',
      },
    }, ctx);

    expect(ctx.messages[1].content).toBe('摘要已生成。');
    expect(ctx.messages[1].content).not.toContain('数据来源索引');
    expect(ctx.messages[1].content).not.toContain('摘要 1: 分析摘要');
  });

  it('should deduplicate repeated skill results', () => {
    const data = {
      data: {
        skillId: 'test_skill',
        layers: {
          overview: {
            summary: {
              data: [{value: 1}],
              display: {title: 'Summary'},
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);
    handleSkillLayeredResultEvent(data, ctx);

    // Second call should be skipped due to deduplication
    expect(ctx.displayedSkillProgress.has('skill_layered_result:test_skill')).toBe(true);
  });

  it('should handle missing layers gracefully', () => {
    const data = {data: {}};

    const result = handleSkillLayeredResultEvent(data, ctx);

    expect(result).toEqual({});
  });

  it('should preserve raw numeric values in overview table rows', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          overview: {
            frame_metrics: {
              data: [{
                start_ts: '123',
                dur_ns: 16666667,
                dur_ms: 16.67,
                frame_count: 10,
              }],
              display: {title: 'Frame Metrics'},
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    const sqlResult = ctx.messages[0].sqlResult!;
    expect(sqlResult.columns).toEqual(['start_ts', 'dur_ns', 'dur_ms', 'frame_count']);
    expect(sqlResult.rows[0]).toEqual(['123', 16666667, 16.67, 10]);
  });

  it('should preserve raw DataPayload rows after hidden-column filtering', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          list: {
            app_jank_frames: {
              data: {
                columns: ['start_ts', 'dur_ms', 'hidden_metric'],
                rows: [['123', 16.67, 42]],
              },
              display: {
                title: 'Jank Frames',
                hidden_columns: ['hidden_metric'],
              },
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    const sqlResult = ctx.messages[0].sqlResult!;
    expect(sqlResult.columns).toEqual(['start_ts', 'dur_ms']);
    expect(sqlResult.rows[0]).toEqual(['123', 16.67]);
  });

  it('should pass display column definitions to sqlResult for unit/click rendering', () => {
    const data = {
      data: {
        skillId: 'startup_analysis',
        layers: {
          overview: {
            startups: {
              data: [{
                start_ts: '1000',
                dur_ns: '2000',
                dur_ms: 2.0,
              }],
              display: {
                title: '启动事件',
                columns: [
                  {name: 'start_ts', type: 'timestamp', unit: 'ns', clickAction: 'navigate_range', durationColumn: 'dur_ns'},
                  {name: 'dur_ns', type: 'duration', format: 'duration_ms', unit: 'ns'},
                  {name: 'dur_ms', type: 'duration', format: 'duration_ms', unit: 'ms', hidden: true},
                ],
              },
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    const sqlResult = ctx.messages[0].sqlResult!;
    expect(sqlResult.columns).toEqual(['start_ts', 'dur_ns', 'dur_ms']);
    expect(sqlResult.columnDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'start_ts',
          clickAction: 'navigate_range',
          durationColumn: 'dur_ns',
          unit: 'ns',
        }),
      ])
    );
  });

  it('should keep duration dependency column for navigate_range even when hidden', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          list: {
            sessions: {
              data: {
                columns: ['start_ts', 'dur_ns', 'session_id'],
                rows: [['1000', '2000', 1]],
              },
              display: {
                title: '会话列表',
                columns: [
                  {name: 'start_ts', type: 'timestamp', unit: 'ns', clickAction: 'navigate_range', durationColumn: 'dur_ns'},
                  {name: 'dur_ns', type: 'duration', format: 'duration_ms', unit: 'ns', hidden: true},
                  {name: 'session_id', type: 'number'},
                ],
              },
            },
          },
        },
      },
    };

    handleSkillLayeredResultEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    const sqlResult = ctx.messages[0].sqlResult!;
    // dur_ns must be preserved for click range calculation.
    expect(sqlResult.columns).toContain('dur_ns');
    expect(sqlResult.columnDefinitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({name: 'dur_ns', unit: 'ns'}),
      ])
    );
  });

  it('should ignore malformed expandable frame identifiers without throwing', () => {
    const data = {
      data: {
        skillId: 'scrolling_analysis',
        layers: {
          list: {
            sessions: {
              data: [
                {frame_id: {bad: true}, session_id: 1, label: 'bad frame id'},
                {frame_id: '42', session_id: 1, label: 'valid frame id'},
              ],
              display: {
                title: '会话列表',
                expandable: true,
              },
            },
          },
          deep: {
            '1': {
              frame_42: {
                item: {frame_id: '42', label: 'valid frame id'},
                data: {
                  ui_thread: {
                    rows: [['RenderThread', 16.7]],
                  },
                },
              },
            },
          },
        },
      },
    };

    expect(() => handleSkillLayeredResultEvent(data, ctx)).not.toThrow();
    expect(ctx.messages).toHaveLength(1);
    const sqlResult = ctx.messages[0].sqlResult!;
    expect(sqlResult.expandableData).toHaveLength(1);
    expect(sqlResult.expandableData?.[0].item).toEqual(
      expect.objectContaining({frame_id: '42'})
    );
  });
});

// =============================================================================
// Data Event Tests (v2.0 DataEnvelope)
// =============================================================================

describe('handleDataEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should handle valid DataEnvelope', () => {
    const data = {
      id: 'data-1',
      envelope: {
        meta: {
          type: 'table',
          version: '2.0',
          source: 'test_skill:step1',
          evidenceRefId: 'data:skill:test_skill:step1:current:trace-a:hash',
          traceSide: 'current',
          traceId: 'trace-a',
          queryHash: 'hash',
        },
        data: {
          columns: ['col1', 'col2'],
          rows: [['a', 'b']],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: 'Test Data',
        },
      },
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toBeDefined();
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '表 1',
      title: 'Test Data',
      source: 'test_skill:step1',
      rowCount: 1,
      evidenceRefId: 'data:skill:test_skill:step1:current:trace-a:hash',
      traceSide: 'current',
      traceId: 'trace-a',
    });
  });

  it('renders DataEnvelope object rows using display columns when data columns are absent', () => {
    const data = {
      id: 'data-object-rows',
      envelope: {
        meta: {
          type: 'skill_result',
          version: '2.0',
          source: 'skill:object_rows',
          evidenceRefId: 'data:skill:object_rows',
        },
        data: {
          rows: [
            {frame_id: 1435508, dur_ms: 45.6},
          ],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: 'Object Row Data',
          columns: [
            {name: 'frame_id', label: '帧 ID', type: 'number'},
            {name: 'dur_ms', label: '帧耗时', type: 'duration', unit: 'ms'},
          ],
        },
      },
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toMatchObject({
      columns: ['frame_id', 'dur_ms'],
      rows: [[1435508, 45.6]],
      rowCount: 1,
    });
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '表 1',
      title: 'Object Row Data',
      evidenceRefId: 'data:skill:object_rows',
    });
  });

  it('should handle array of envelopes', () => {
    const data = {
      id: 'data-batch',
      envelope: [
        {
          meta: {type: 'table', version: '2.0', source: 'skill:step1'},
          data: {columns: ['a'], rows: [['1']]},
          display: {layer: 'list', format: 'table', title: 'Table 1'},
        },
        {
          meta: {type: 'table', version: '2.0', source: 'skill:step2'},
          data: {columns: ['b'], rows: [['2']]},
          display: {layer: 'list', format: 'table', title: 'Table 2'},
        },
      ],
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(2);
  });

  it('should deduplicate data envelopes', () => {
    const data = {
      id: 'data-1',
      envelope: {
        meta: {type: 'table', version: '2.0', source: 'unique_source'},
        data: {columns: ['x'], rows: [['y']]},
        display: {layer: 'list', format: 'table', title: 'Test'},
      },
    };

    handleDataEvent(data, ctx);
    handleDataEvent(data, ctx);

    // Should only render once
    expect(ctx.messages).toHaveLength(1);
  });

  it('should keep executable SQL from execute_sql envelopes', () => {
    const sql = 'INCLUDE PERFETTO MODULE slices.self_dur; SELECT * FROM _slice_self_dur;';
    const data = {
      id: 'sql-data-1',
      envelope: {
        meta: {type: 'sql_result', version: '2.0', source: 'execute_sql'},
        sql,
        data: {columns: ['id'], rows: [[1]]},
        display: {layer: 'list', format: 'table', title: 'SQL Query (1 rows)'},
      },
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult?.query).toBe(sql);
    expect(ctx.messages[0].sqlResult?.hideQuery).toBe(true);
    expect(ctx.messages[0].sqlResult?.sectionTitle).toBe('SQL 结果 · 数据验证');
  });

  it('should deduplicate execute_sql envelopes by SQL text', () => {
    const makeData = (sql: string) => ({
      id: sql,
      envelope: {
        meta: {type: 'sql_result', version: '2.0', source: 'execute_sql'},
        sql,
        data: {columns: ['id'], rows: [[1]]},
        display: {layer: 'list', format: 'table', title: 'SQL Query'},
      },
    });

    handleDataEvent(makeData('SELECT 1;'), ctx);
    handleDataEvent(makeData('SELECT 2;'), ctx);
    handleDataEvent(makeData('SELECT 1;'), ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].sqlResult?.query).toBe('SELECT 1;');
    expect(ctx.messages[1].sqlResult?.query).toBe('SELECT 2;');
  });

  it('should handle null data gracefully', () => {
    const result = handleDataEvent(null, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('should handle text format', () => {
    const data = {
      id: 'text-1',
      envelope: {
        meta: {type: 'text', version: '2.0', source: 'text_source'},
        data: {text: 'This is a text message'},
        display: {layer: 'overview', format: 'text', title: 'Text Output'},
      },
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('This is a text message');
  });

  it('renders diagnostic text envelopes as non-evidence diagnostics', () => {
    handleDataEvent({
      id: 'sql-diagnostic',
      envelope: {
        meta: {
          type: 'diagnostic',
          version: '2.0',
          source: 'execute_sql',
          sourceToolCallId: 'execute_sql:7:params',
          evidenceRefId: 'data:sql_diagnostic:current:trace:query:tool',
        },
        sql: 'SELECT name FROM slice s JOIN thread t ON 1=1',
        data: {
          text: [
            'SQL 执行未产出可用表格。',
            '这是一条失败诊断，不是可引用的性能证据；需要修正 SQL 后重试。',
            'Error: ambiguous column name: name',
          ].join('\n'),
        },
        display: {
          layer: 'diagnosis',
          format: 'text',
          title: 'SQL 执行诊断',
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('失败诊断');
    expect(ctx.messages[0].sourceContext).toMatchObject({
      ref: '诊断 1',
      kind: 'diagnostic',
      reason: expect.stringContaining('不能作为结论证据'),
      meaning: expect.stringContaining('不证明性能结论'),
      sourceToolCallId: 'execute_sql:7:params',
    });
    expect(ctx.streamingFlow.dataSourceRefs[0].ref).toBe('诊断 1');
  });

  it('should ignore malformed envelopes in a mixed envelope batch', () => {
    const data = {
      id: 'mixed-batch',
      envelope: [
        null,
        {bad: 'shape'},
        {
          meta: {type: 'table', version: '2.0', source: 'valid_source'},
          data: {columns: ['k'], rows: [['v']]},
          display: {layer: 'list', format: 'table', title: 'Valid Table'},
        },
      ],
    };

    expect(() => handleDataEvent(data, ctx)).not.toThrow();
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult?.columns).toEqual(['k']);
  });

  it('should normalize excessive blank lines in summary format', () => {
    const data = {
      id: 'summary-1',
      envelope: {
        meta: {
          type: 'summary',
          version: '2.0',
          source: 'summary_source',
          evidenceRefId: 'data:sql_summary:current:trace-a:query-a:tool-a',
          traceSide: 'current',
          traceId: 'trace-a',
          queryHash: 'query-a',
          sourceToolCallId: 'execute_sql:1:params_hash',
          paramsHash: 'params_hash',
          planPhaseId: 'p1',
          planPhaseTitle: '概览采集',
          planPhaseGoal: '获取帧统计',
          producerReason: '执行当前 Trace SQL，验证本阶段的具体数据点。',
        },
        data: {
          summary: {
            title: '洞见摘要',
            content: '\n\n（无显式洞见，见指标）\n \n \n',
            metrics: [
              {label: '总帧数', value: 642, severity: 'normal'},
              {label: '掉帧数', value: 39, severity: 'normal', unit: ' (6.07%)'},
            ],
          },
        },
        display: {
          layer: 'overview',
          format: 'summary',
          title: '洞见摘要',
        },
      },
    };

    handleDataEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('## 📊 洞见摘要');
    expect(ctx.messages[0].content).toContain('（无显式洞见，见指标）\n\n### 关键指标');
    expect(ctx.messages[0].content).not.toMatch(/\n{3,}/);
    expect(ctx.messages[0].sourceContext).toMatchObject({
      ref: '摘要 1',
      kind: 'summary',
      evidenceRefId: 'data:sql_summary:current:trace-a:query-a:tool-a',
      traceSide: 'current',
      traceId: 'trace-a',
      queryHash: 'query-a',
      sourceToolCallId: 'execute_sql:1:params_hash',
      paramsHash: 'params_hash',
      planPhaseId: 'p1',
      planPhaseTitle: '概览采集',
      planPhaseGoal: '获取帧统计',
      reason: '压缩本轮启动的关键指标、异常提示和候选方向，用来决定后续优先下钻哪些问题。',
    });
  });

  it('should keep table-level data source index out of visible conclusions', () => {
    handleDataEvent({
      id: 'data-1',
      envelope: {
        meta: {
          type: 'skill_result',
          version: '2.0',
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
          stepId: 'jank_frames',
        },
        data: {
          columns: ['frame_id', 'dur_ms'],
          rows: [[123, 45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '掉帧帧列表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '最终结论引用了 45.6ms 的帧耗时。',
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[1].content).toBe('最终结论引用了 45.6ms 的帧耗时。');
    expect(ctx.messages[1].content).not.toContain('## 数据来源索引');
    expect(ctx.messages[1].content).not.toContain('表 1: 掉帧帧列表');
  });

  it('numbers data source refs per kind so summaries do not shift table refs', () => {
    handleDataEvent({
      id: 'summary-first',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_summary:current:trace-a:query-a:summary',
        },
        data: {
          summary: {
            title: '概览摘要',
            metrics: [{label: 'total_rows', value: 1}],
          },
        },
        display: {
          layer: 'overview',
          format: 'summary',
          title: '概览摘要',
        },
      },
    }, ctx);
    handleDataEvent({
      id: 'table-after-summary',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:table',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '最终结论引用帧耗时表。',
      },
    }, ctx);

    expect(ctx.messages[0].sourceContext?.ref).toBe('摘要 1');
    expect(ctx.messages[1].sqlResult?.sourceContext?.ref).toBe('表 1');
    expect(ctx.messages[2].content).toBe('最终结论引用帧耗时表。');
    expect(ctx.messages[2].content).not.toContain('摘要 1: 概览摘要');
    expect(ctx.messages[2].content).not.toContain('表 1: 帧耗时表');
    expect(ctx.messages[2].content).not.toContain('表 2: 帧耗时表');
  });

  it('keeps all registered data source appendix details out of the visible conclusion', () => {
    for (let i = 1; i <= 85; i++) {
      handleDataEvent({
        id: `data-${i}`,
        envelope: {
          meta: {
            type: 'skill_result',
            version: '2.0',
            source: `skill:step_${i}`,
            evidenceRefId: `data:skill:test:step_${i}:current:trace-a:hash_${i}`,
          },
          data: {
            columns: ['value'],
            rows: [[i]],
          },
          display: {
            layer: 'list',
            format: 'table',
            title: `证据表 ${i}`,
          },
        },
      }, ctx);
    }

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '最终结论需要核对全部证据表。',
      },
    }, ctx);

    const conclusion = ctx.messages[85].content;
    expect(conclusion).toBe('最终结论需要核对全部证据表。');
    expect(conclusion).not.toContain('表 1: 证据表 1');
    expect(conclusion).not.toContain('表 85: 证据表 85');
    expect(conclusion).not.toContain('另有');
  });

  it('keeps bounded data source appendix details out of the visible conclusion', () => {
    for (let i = 1; i <= 125; i++) {
      handleDataEvent({
        id: `data-${i}`,
        envelope: {
          meta: {
            type: 'skill_result',
            version: '2.0',
            source: `skill:step_${i}`,
            evidenceRefId: `data:skill:test:step_${i}:current:trace-a:hash_${i}`,
          },
          data: {
            columns: ['value'],
            rows: [[i]],
          },
          display: {
            layer: 'list',
            format: 'table',
            title: `证据表 ${i}`,
          },
        },
      }, ctx);
    }

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '最终结论需要核对大量证据表。',
      },
    }, ctx);

    const conclusion = ctx.messages[125].content;
    expect(conclusion).toBe('最终结论需要核对大量证据表。');
    expect(conclusion).not.toContain('本轮共有 125 个数据来源');
    expect(conclusion).not.toContain('省略中间 5 个');
    expect(conclusion).not.toContain('表 1: 证据表 1');
    expect(conclusion).not.toContain('表 125: 证据表 125');
    expect(conclusion).not.toContain('表 101: 证据表 101');
  });

  it('renders zero-row table envelopes as auditable sources', () => {
    handleDataEvent({
      id: 'empty-table',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:empty',
          planPhaseAttribution: 'active',
        },
        data: {
          columns: ['id', 'name'],
          rows: [],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '空结果 SQL',
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toMatchObject({
      columns: ['id', 'name'],
      rows: [],
      rowCount: 0,
    });
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '表 1',
      title: '空结果 SQL',
      rowCount: 0,
      evidenceRefId: 'data:sql_table:current:trace-a:empty',
    });
  });

  it('renders non-tabular chart data instead of registering an orphan source', () => {
    handleDataEvent({
      id: 'chart-primitive',
      envelope: {
        meta: {
          type: 'chart',
          version: '2.0',
          source: 'chart_skill',
          evidenceRefId: 'data:chart:current:trace-a:primitive',
        },
        data: {
          chart: {
            type: 'bar',
            data: [1, 2, 3],
          },
        },
        display: {
          layer: 'overview',
          format: 'chart',
          title: 'Primitive Chart',
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Primitive Chart');
    expect(ctx.messages[0].sourceContext).toMatchObject({
      ref: '图 1',
      evidenceRefId: 'data:chart:current:trace-a:primitive',
    });
  });

  it('keeps repeated stable evidence separate by tool-call occurrence', () => {
    const envelope = (sourceToolCallId: string) => ({
      meta: {
        type: 'sql_result',
        version: '2.0',
        source: 'execute_sql',
        evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        sourceToolCallId,
      },
      data: {
        columns: ['value'],
        rows: [[1]],
      },
      display: {
        layer: 'list',
        format: 'table',
        title: 'Same SQL',
      },
    });

    handleDataEvent({id: 'same-1', envelope: envelope('execute_sql_on:1:params-a')}, ctx);
    handleDataEvent({id: 'same-2', envelope: envelope('execute_sql_on:2:params-a')}, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].sqlResult?.sourceContext?.sourceToolCallId).toBe('execute_sql_on:1:params-a');
    expect(ctx.messages[1].sqlResult?.sourceContext?.sourceToolCallId).toBe('execute_sql_on:2:params-a');
  });

  it('renders claim-level row and column references from conclusion contracts', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          schemaVersion: 'conclusion_contract_v1',
          mode: 'initial_report',
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          clusters: [],
          evidence_chain: [{conclusion_id: 'C1', text: '帧耗时 45.6ms'}],
          claims: [{
            id: 'Q1',
            conclusion_id: 'C1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
          uncertainties: [],
          next_steps: [],
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[1].content).not.toContain('## 逐句数据引用');
    expect(ctx.messages[1].content).not.toContain('Q1 / C1: 帧耗时 45.6ms');
    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 dur_ms，已核对');
  });

  it('accepts common source_ref formatting variants without losing source binding', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表1: 帧耗时表',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('表1: 帧耗时表，row 0，列 dur_ms，已核对');
  });

  it('resolves claim columns by displayed column label when available', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
          columns: [{name: 'dur_ms', label: '帧耗时(ms)', type: 'number'}],
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: '帧耗时(ms)',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 帧耗时(ms)，已核对');
  });

  it('verifies claim values with units and explicit approximate status for rounded numbers', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.64]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时约 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: '45.6ms',
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 dur_ms，已核对（含近似匹配）');
  });

  it('marks claim references that do not match the sourced table value', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 99ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 99,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('未通过: 值不匹配，实际 45.6');
  });

  it('does not mark column-only claim references as value-verified', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时异常',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 dur_ms，未核验: 未提供期望值');
    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 dur_ms，已核对');
  });

  it('uses exact evidence_ref over stale source_ref labels and reports the mismatch', () => {
    const envelope = (id: string, evidenceRefId: string, value: number) => ({
      meta: {
        type: 'sql_result',
        version: '2.0',
        source: 'execute_sql',
        evidenceRefId,
      },
      data: {
        columns: ['dur_ms'],
        rows: [[value]],
      },
      display: {
        layer: 'list',
        format: 'table',
        title: id,
      },
    });

    handleDataEvent({id: 'table-a', envelope: envelope('表A', 'data:sql_table:current:trace-a:query-a:params-a', 45.6)}, ctx);
    handleDataEvent({id: 'table-b', envelope: envelope('表B', 'data:sql_table:current:trace-a:query-b:params-b', 99)}, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              source_ref: '表 2',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[2].content).not.toContain('表 1，row 0，列 dur_ms，已核对');
    expect(ctx.messages[2].content).not.toContain('source_ref 已按系统来源校正');
    expect(ctx.messages[2].content).not.toContain('表 2，row 0，列 dur_ms，已核对');
  });

  it('rejects fractional or negative claim row indexes instead of rounding them', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: -0.4,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('row -0.4，列 dur_ms，未通过: 行号无效');
  });

  it('marks duplicate evidence refs as ambiguous unless tool call id disambiguates them', () => {
    const envelope = (sourceToolCallId: string, value: number) => ({
      meta: {
        type: 'sql_result',
        version: '2.0',
        source: 'execute_sql',
        evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        sourceToolCallId,
      },
      data: {
        columns: ['dur_ms'],
        rows: [[value]],
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '重复 SQL',
      },
    });

    handleDataEvent({id: 'same-1', envelope: envelope('execute_sql:1:params-a', 45.6)}, ctx);
    handleDataEvent({id: 'same-2', envelope: envelope('execute_sql:2:params-a', 99)}, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [
            {
              id: 'Q1',
              text: '帧耗时 45.6ms',
              references: [{
                evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
                row_index: 0,
                column: 'dur_ms',
                value: 45.6,
              }],
            },
            {
              id: 'Q2',
              text: '第二次帧耗时 99ms',
              references: [{
                evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
                source_tool_call_id: 'execute_sql:2:params-a',
                row_index: 0,
                column: 'dur_ms',
                value: 99,
              }],
            },
          ],
        },
      },
    }, ctx);

    expect(ctx.messages[2].content).not.toContain('Q1: 帧耗时 45.6ms');
    expect(ctx.messages[2].content).not.toContain('未核验: 来源不唯一');
    expect(ctx.messages[2].content).not.toContain('Q2: 第二次帧耗时 99ms');
    expect(ctx.messages[2].content).not.toContain('表 2，row 0，列 dur_ms，已核对');
  });

  it('keeps duplicate evidence refs without tool call ids visible so claims become ambiguous', () => {
    const envelope = (value: number) => ({
      meta: {
        type: 'sql_result',
        version: '2.0',
        source: 'execute_sql',
        evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
      },
      data: {
        columns: ['dur_ms'],
        rows: [[value]],
      },
      display: {
        layer: 'list',
        format: 'table',
        title: '重复 SQL',
      },
    });

    handleDataEvent({id: 'same-1', envelope: envelope(45.6)}, ctx);
    handleDataEvent({id: 'same-2', envelope: envelope(99)}, ctx);

    expect(ctx.messages).toHaveLength(2);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[2].content).not.toContain('未核验: 来源不唯一');
    expect(ctx.messages[2].content).not.toContain('值 45.6，已核对');
  });

  it('verifies claim rows by rowSelector when no row_index is provided', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['frame_id', 'dur_ms'],
          rows: [[123, 45.6], [456, 16.7]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧 123 耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_selector: {frame_id: 123},
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('rowSelector frame_id=123 -> row 0，列 dur_ms，已核对');
  });

  it('parses prompt-style row_selector strings for claim verification', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['frame_id', 'thread', 'dur_ms'],
          rows: [[123, 'main', 45.6], [456, 'render', 16.7]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧 123 耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_selector: 'frame_id=123, thread=main',
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('rowSelector frame_id=123, thread=main -> row 0，列 dur_ms，已核对');
  });

  it('keeps claim-referenced middle data sources visible when the source index is truncated', () => {
    for (let i = 1; i <= 125; i++) {
      handleDataEvent({
        id: `source-${i}`,
        envelope: {
          meta: {
            type: 'sql_result',
            version: '2.0',
            source: 'execute_sql',
            evidenceRefId: `data:sql_table:current:trace-a:query-${i}:params-a`,
          },
          data: {
            columns: ['value'],
            rows: [[i]],
          },
          display: {
            layer: 'list',
            format: 'table',
            title: i === 105 ? 'Middle pinned table' : `Table ${i}`,
          },
        },
      }, ctx);
    }

    handleSSEEvent('conclusion', {
      data: {
        conclusion: '已有结论',
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '中间表数据被引用'}],
          claims: [{
            id: 'Q1',
            text: '第 105 张表的值是 105',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-105:params-a',
              source_ref: '表 105',
              row_index: 0,
              column: 'value',
              value: 105,
            }],
          }],
        },
      },
    }, ctx);

    const conclusion = ctx.messages[125].content;
    expect(conclusion).toContain('已有结论');
    expect(conclusion).not.toContain('并额外保留 1 个被逐句引用命中的来源');
    expect(conclusion).not.toContain('表 105: Middle pinned table');
    expect(conclusion).not.toContain('表 105，row 0，列 value，已核对');
  });

  it('discloses claim and per-claim reference truncation instead of silently dropping them', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['value'],
          rows: [[1]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '裁剪测试表',
        },
      },
    }, ctx);

    const reference = {
      evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
      row_index: 0,
      column: 'value',
      value: 1,
      source_ref: '表 1',
    };

    handleAnalysisCompletedEvent({
      data: {
        resultSnapshotId: 'analysis-result-abcdef12-aaaa-bbbb-cccc-123456789abc',
        conclusionContract: {
          conclusion: [{rank: 1, statement: '多 claim 结论'}],
          claims: Array.from({length: 21}, (_, index) => ({
            id: `Q${index + 1}`,
            text: `claim ${index + 1}`,
            references: Array.from({length: index === 0 ? 6 : 1}, () => reference),
          })),
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('Q1: claim 1（表 1，row 0，列 value，已核对）');
    expect(ctx.messages[1].content).not.toContain('其余 1 条 claim 未展开；完整结构化引用仍保留在结果快照中。');
  });

  it('keeps system-generated evidence sections out of the visible conclusion', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '已有结论\n\n## 数据来源索引\n模型写的来源\n\n## 逐句数据引用\n模型写的引用',
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('## 数据来源索引（系统生成）');
    expect(ctx.messages[1].content).not.toContain('## 逐句数据引用（系统核对结果）');
    expect(ctx.messages[1].content).not.toContain('已核对');
  });

  it('does not fall back to showing appendix content when no visible conclusion remains', () => {
    handleAnalysisCompletedEvent({
      data: {
        conclusion: [
          '## 证据索引（系统生成）',
          '关键数据来源：SQL Query (1 rows)',
          '',
          '## 断言验证结果',
          'Verifier: passed',
          '',
          'Result ID: AR-hidden',
          'Snapshot: analysis-result-hidden',
        ].join('\n'),
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('');
    expect(ctx.messages[0].content).not.toContain('关键数据来源');
    expect(ctx.messages[0].content).not.toContain('Verifier');
    expect(ctx.messages[0].content).not.toContain('Result ID');
  });

  it('does not let appendix subheadings or bold lines leak hidden details', () => {
    handleAnalysisCompletedEvent({
      data: {
        conclusion: [
          '## 综合结论',
          '真实结论正文。',
          '',
          '---',
          '## 证据来源索引（系统生成）',
          '**关键数据来源**',
          '关键数据来源：SQL Query (1 rows)',
          '### 逐句明细',
          'Q1 / C1: 隐藏引用',
          '',
          '## 后续行动',
          '这段仍然应该展示。',
        ].join('\n'),
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('真实结论正文。');
    expect(ctx.messages[0].content).toContain('## 后续行动');
    expect(ctx.messages[0].content).toContain('这段仍然应该展示。');
    expect(ctx.messages[0].content).not.toContain('关键数据来源');
    expect(ctx.messages[0].content).not.toContain('逐句明细');
    expect(ctx.messages[0].content).not.toContain('隐藏引用');
  });

  it('removes snapshot reference lines with full-width colons and localized labels', () => {
    handleAnalysisCompletedEvent({
      data: {
        conclusion: [
          '最终结论正文。',
          '',
          '---',
          'Result ID：AR-hidden',
          'Snapshot：analysis-result-hidden',
          '- 结果 ID：AR-hidden-cn',
          '- 快照：analysis-result-hidden-cn',
        ].join('\n'),
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('最终结论正文。');
    expect(ctx.messages[0].content).not.toContain('AR-hidden');
    expect(ctx.messages[0].content).not.toContain('analysis-result-hidden');
    expect(ctx.messages[0].content).not.toContain('快照');
  });

  it('keeps late conclusionContract claim refs when conclusion arrived first', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleSSEEvent('conclusion', {
      data: {
        conclusion: '已有结论',
      },
    }, ctx);
    expect(ctx.completionHandled).toBe(true);
    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[1].content).toContain('已有结论');
    expect(ctx.messages[1].content).not.toContain('## 逐句数据引用');
    expect(ctx.messages[1].content).not.toContain('已核对');
  });

  it('keeps verifier metadata out of the visible analysis_completed message', () => {
    handleAnalysisCompletedEvent({
      architecture: 'agent-driven',
      data: {
        conclusion: '最终结论',
        claimSupport: [{
          claimId: 'Q1',
          kind: 'numeric',
          text: 'blocked_ms 为 120',
          anchors: [{
            evidenceRefId: 'evidence:blocked',
            context: {
              traceSide: 'current',
              artifactId: 'artifact:blocked',
              sourceToolCallId: 'tool:sql-1',
            },
            cells: [{
              rowIndex: 2,
              column: 'blocked_ms',
              value: 120,
              actualValue: 90,
            }],
            identity: {
              identityRefId: 'identity:test',
              status: 'weak',
            },
          }],
          supportLevel: 'unsupported',
        }],
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'failed',
          policy: 'record_only',
          passed: false,
          checkedClaimCount: 1,
          unsupportedClaimCount: 1,
          claimResults: [],
          issues: [{
            claimId: 'Q1',
            severity: 'error',
            code: 'claim_reference_value_mismatch',
            message: 'value mismatch for blocked_ms',
          }],
        },
        identityResolutions: [{
          version: 'identity_contract@1',
          identityRefId: 'identity:test',
          status: 'weak',
          target: {traceId: 'trace-a', source: 'derived'},
          processes: [],
          threads: [],
          warnings: [],
        }],
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('最终结论');
    expect(ctx.messages[0].content).not.toContain('## 断言验证结果');
    expect(ctx.messages[0].content).not.toContain('Verifier: failed');
    expect(ctx.messages[0].content).not.toContain('claim_reference_value_mismatch');
    expect(ctx.messages[0].content).not.toContain('Q1: unsupported (numeric)');
  });

  it('removes structured claim refs from the visible conclusion while preserving later sections', () => {
    handleDataEvent({
      id: 'claim-source',
      envelope: {
        meta: {
          type: 'sql_result',
          version: '2.0',
          source: 'execute_sql',
          evidenceRefId: 'data:sql_table:current:trace-a:query-a:params-a',
        },
        data: {
          columns: ['dur_ms'],
          rows: [[45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '帧耗时表',
        },
      },
    }, ctx);

    handleSSEEvent('conclusion', {
      data: {
        conclusion: [
          '已有结论',
          '',
          '## 逐句数据引用（结构化来源）',
          '- Q1 / C1: 帧耗时 45.6ms',
          '  - evidence_ref_id=data:sql_table:current:trace-a:query-a:params-a; source_ref=表 1; row_index=0; column=dur_ms; value=45.6',
          '',
          '## 不确定性与反例',
          '- 暂无',
        ].join('\n'),
      },
    }, ctx);

    handleAnalysisCompletedEvent({
      data: {
        conclusionContract: {
          conclusion: [{rank: 1, statement: '主线程帧耗时异常'}],
          claims: [{
            id: 'Q1',
            conclusion_id: 'C1',
            text: '帧耗时 45.6ms',
            references: [{
              evidence_ref_id: 'data:sql_table:current:trace-a:query-a:params-a',
              row_index: 0,
              column: 'dur_ms',
              value: 45.6,
              source_ref: '表 1',
            }],
          }],
        },
      },
    }, ctx);

    expect(ctx.messages[1].content).not.toContain('## 逐句数据引用（结构化来源）');
    expect(ctx.messages[1].content).not.toContain('## 逐句数据引用（系统核对结果）');
    expect(ctx.messages[1].content).not.toContain('表 1，row 0，列 dur_ms，已核对');
    expect(ctx.messages[1].content).toContain('## 不确定性与反例');
  });

  it('keeps current/reference DataEnvelope tables separate by evidence ref and trace side', () => {
    handleDataEvent({
      id: 'data-compare',
      envelope: [
        {
          meta: {
            type: 'skill_result',
            version: '2.0',
            source: 'scrolling_analysis:jank_frames',
            skillId: 'scrolling_analysis',
            stepId: 'jank_frames',
            evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:trace-a:hash',
            traceSide: 'current',
            traceId: 'trace-a',
          },
          data: {
            columns: ['frame_id', 'dur_ms'],
            rows: [[123, 45.6]],
          },
          display: {
            layer: 'list',
            format: 'table',
            title: '掉帧帧列表',
          },
        },
        {
          meta: {
            type: 'skill_result',
            version: '2.0',
            source: 'scrolling_analysis:jank_frames',
            skillId: 'scrolling_analysis',
            stepId: 'jank_frames',
            evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:reference:trace-b:hash',
            traceSide: 'reference',
            traceId: 'trace-b',
          },
          data: {
            columns: ['frame_id', 'dur_ms'],
            rows: [[456, 22.1]],
          },
          display: {
            layer: 'list',
            format: 'table',
            title: '掉帧帧列表',
          },
        },
      ],
    }, ctx);

    expect(ctx.messages).toHaveLength(2);
    expect(ctx.messages[0].sqlResult?.sourceContext).toMatchObject({
      ref: '表 1',
      traceSide: 'current',
      evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:trace-a:hash',
    });
    expect(ctx.messages[1].sqlResult?.sourceContext).toMatchObject({
      ref: '表 2',
      traceSide: 'reference',
      evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:reference:trace-b:hash',
    });

    handleAnalysisCompletedEvent({
      data: {
        conclusion: '当前 Trace 掉帧更重。',
      },
    }, ctx);

    const conclusion = ctx.messages[2].content;
    expect(conclusion).toBe('当前 Trace 掉帧更重。');
    expect(conclusion).not.toContain('数据来源索引');
    expect(conclusion).not.toContain('表 1: 当前 Trace · 掉帧帧列表');
    expect(conclusion).not.toContain('表 2: 参考 Trace · 掉帧帧列表');
    expect(conclusion).not.toContain('...current:trace-a:hash');
    expect(conclusion).not.toContain('...reference:trace-b:hash');
  });

  it('does not mutate the latest table when an empty conclusion precedes report metadata', () => {
    handleDataEvent({
      id: 'data-1',
      envelope: {
        meta: {
          type: 'skill_result',
          version: '2.0',
          source: 'scrolling_analysis',
          skillId: 'scrolling_analysis',
          stepId: 'jank_frames',
          evidenceRefId: 'data:skill:scrolling_analysis:jank_frames:current:trace-a:hash',
        },
        data: {
          columns: ['frame_id', 'dur_ms'],
          rows: [[123, 45.6]],
        },
        display: {
          layer: 'list',
          format: 'table',
          title: '掉帧帧列表',
        },
      },
    }, ctx);

    handleSSEEvent('conclusion', {data: {conclusion: ''}}, ctx);
    handleAnalysisCompletedEvent({
      data: {
        reportUrl: '/reports/123.html',
        resultSnapshotId: 'analysis-result-abcdef12-aaaa-bbbb-cccc-123456789abc',
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].sqlResult).toBeDefined();
    expect(ctx.messages[0].content).toBe('');
    expect(ctx.messages[0].reportUrl).toBeUndefined();
  });
});

// =============================================================================
// Answer Token Stream Tests
// =============================================================================

describe('handleAnswerTokenEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should append streamed answer tokens into one assistant message', () => {
    handleAnswerTokenEvent({data: {token: '你好'}}, ctx);
    handleAnswerTokenEvent({data: {token: '，世界'}}, ctx);
    handleAnswerTokenEvent({data: {done: true}}, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].flowTag).toBe('answer_stream');
    expect(ctx.messages[0].content).toBe('你好，世界');
    expect(ctx.streamingAnswer.status).toBe('completed');
  });

  it('should mirror streamed answer checkpoints into the conversation timeline', () => {
    handleAnswerTokenEvent({
      data: {
        token: 'Phase 1 发现冷启动 dur=1338ms，TTID=1912ms，需要进入 Phase 2。',
      },
    }, ctx);
    handleAnswerTokenEvent({
      data: {
        token: '\n主线程 Running=63%，Q4b Sleeping=35.1%，需要深挖阻塞原因。',
      },
    }, ctx);
    handleAnswerTokenEvent({data: {done: true}}, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].flowTag).toBe('answer_stream');
    expect(ctx.flowMessages).toHaveLength(1);
    const timeline = ctx.flowMessages[0].content;
    expect(timeline).toContain('🧵 对话时间线');
    expect(timeline).toContain('#A1');
    expect(timeline).toContain('开始流式输出分析结果');
    expect(timeline).toContain('流式更新');
    expect(timeline).toContain('最终更新');
    expect(timeline).toContain('最终回答已输出');
    expect(ctx.streamingFlow.conversationLastOrdinal).toBe(0);
  });

  it('should keep answer checkpoints separate from backend conversation ordinals', () => {
    handleConversationStepEvent({
      id: 'evt-1',
      data: {
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        content: {text: '开始分析'},
      },
    }, ctx);

    handleAnswerTokenEvent({
      data: {
        token: '关键发现：主线程 Running=63%，Q4b Sleeping=35.1%，需要继续定位。',
      },
    }, ctx);
    handleAnswerTokenEvent({data: {done: true}}, ctx);

    const timeline = ctx.flowMessages[0].content;
    expect(timeline).toContain('#1');
    expect(timeline).toContain('#A1');
    expect(ctx.streamingFlow.conversationLastOrdinal).toBe(1);
  });
});

// =============================================================================
// Conversation Step Timeline Tests
// =============================================================================

describe('handleConversationStepEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should flush conversation steps strictly by ordinal', () => {
    handleConversationStepEvent({
      id: 'evt-2',
      data: {
        ordinal: 2,
        phase: 'tool',
        role: 'agent',
        content: {text: '第二步'},
      },
    }, ctx);

    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).not.toContain('#2');

    handleConversationStepEvent({
      id: 'evt-1',
      data: {
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        content: {text: '第一步'},
      },
    }, ctx);

    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('#1');
    expect(ctx.flowMessages[0].content).not.toContain('#2');
    expect(ctx.streamingFlow.conversationLastOrdinal).toBe(1);

    // End event forces timeline flush, including buffered out-of-order step #2.
    handleSSEEvent('end', {}, ctx);

    const content = ctx.flowMessages[0].content;
    expect(content).toContain('#1');
    expect(content).toContain('#2');
    expect(content.indexOf('#1')).toBeLessThan(content.indexOf('#2'));
    expect(ctx.streamingFlow.conversationLastOrdinal).toBe(2);
  });

  it('should deduplicate repeated events by event id', () => {
    const step = {
      id: 'evt-1',
      data: {
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        content: {text: '唯一步骤'},
      },
    };

    handleConversationStepEvent(step, ctx);
    handleConversationStepEvent(step, ctx);

    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content.match(/#1/g)?.length || 0).toBe(1);
    expect(ctx.streamingFlow.conversationLastOrdinal).toBe(1);
  });
});

// =============================================================================
// Main Event Dispatcher Tests
// =============================================================================

describe('handleSSEEvent', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
    resetAISharedState();
  });

  it('should route progress events correctly', () => {
    handleSSEEvent('progress', {data: {message: 'Testing'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Testing');
  });

  it('should route error events and return terminal result', () => {
    const result = handleSSEEvent('error', {data: {error: 'Test error'}}, ctx);

    expect(result.isTerminal).toBe(true);
    expect(result.stopLoading).toBe(true);
  });

  it('should handle connected event silently', () => {
    const result = handleSSEEvent('connected', {}, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('should handle unknown event types gracefully', () => {
    const result = handleSSEEvent('unknown_event_type', {data: {}}, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(result).toEqual({});
  });

  it('should handle end event with stopLoading', () => {
    const result = handleSSEEvent('end', {}, ctx);

    expect(result.stopLoading).toBe(true);
  });

  it('should skip thought events', () => {
    handleSSEEvent('thought', {data: {content: 'AI thinking...'}}, ctx);
    handleSSEEvent('worker_thought', {data: {content: 'Worker thinking...'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
  });

  it('should handle stage_start events', () => {
    handleSSEEvent('stage_start', {data: {message: 'Starting stage 1'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Starting stage 1');
  });

  it('should route intervention events correctly', () => {
    handleSSEEvent('intervention_required', {
      data: {
        interventionId: 'test',
        type: 'low_confidence',
        options: [],
        context: {},
        timeout: 30000,
      },
    }, ctx);

    expect(ctx.interventionState.isActive).toBe(true);
  });

  it('should skip finding events', () => {
    handleSSEEvent('finding', {data: {finding: 'Something found'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
  });

  it('should show conclusion events before analysis_completed metadata arrives', () => {
    handleSSEEvent('conclusion', {data: {conclusion: 'Final conclusion'}}, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toBe('Final conclusion');
  });

  it('should replace early streamed answer tokens with canonical conclusion text', () => {
    handleSSEEvent('answer_token', {data: {token: 'Interim pre-plan text'}}, ctx);

    handleSSEEvent('conclusion', {
      data: {
        conclusion: '## 综合结论\n\nFinal report body.',
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].flowTag).toBe('answer_stream');
    expect(ctx.messages[0].content).toContain('## 综合结论');
    expect(ctx.messages[0].content).not.toContain('Interim pre-plan text');

    handleSSEEvent('analysis_completed', {
      data: {
        conclusion: '## 综合结论\n\nFinal report body with snapshot.',
        reportUrl: '/reports/123.html',
        resultSnapshotId: 'analysis-result-12345678-aaaa-bbbb-cccc-123456789abc',
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('Final report body with snapshot.');
    expect(ctx.messages[0].content).not.toContain('Result ID');
    expect(ctx.messages[0].content).not.toContain('Snapshot:');
    expect(ctx.messages[0].reportUrl).toBe('http://localhost:3000/reports/123.html');
  });

  it('preserves quota_exceeded terminal status from analysis_completed payload', () => {
    handleSSEEvent('analysis_completed', {
      data: {
        conclusion: 'Partial conclusion',
        terminalRunStatus: 'quota_exceeded',
      },
    }, ctx);

    expect(getAISharedState().status).toBe('quota_exceeded');
    expect(getAISharedState().lastAnalysisTime).not.toBeNull();
  });

  it('routes analysis_cancelled as a non-error terminal event', () => {
    handleSSEEvent('answer_token', {data: {token: 'Partial answer'}}, ctx);

    const result = handleSSEEvent('analysis_cancelled', {
      data: {
        reason: 'Analysis cancelled by user',
        terminalRunStatus: 'cancelled',
      },
    }, ctx);

    expect(result.isTerminal).toBe(true);
    expect(result.stopLoading).toBe(true);
    expect(getAISharedState().status).toBe('cancelled');
    expect(getAISharedState().lastAnalysisTime).not.toBeNull();
    expect(ctx.messages.some((message) => message.content.includes('Analysis cancelled by user'))).toBe(true);
  });

  it('preserves structured smart scene preview payload on analysis_completed messages', () => {
    handleSSEEvent('analysis_completed', {
      data: {
        conclusion: '# 智能分析报告：场景盘点\n\n## 下一步',
        smartScenePreview: {
          reportId: 'report-smart-1',
          eligibleSceneCount: 1,
          scenes: [
            {
              id: 'scroll-1',
              sceneType: 'scroll',
              startTs: '1000000000',
              endTs: '2000000000',
              durationMs: 1000,
              sceneRole: 'action',
            },
            {
              id: 'scroll-start-1',
              sceneType: 'scroll_start',
              startTs: '1000000000',
              endTs: '1000000000',
              durationMs: 0,
              sceneRole: 'marker',
              analysisEligible: false,
            },
          ],
          sceneVerification: {
            status: 'passed',
            summary: '场景还原复核通过。',
          },
        },
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].smartScenePreview?.reportId).toBe('report-smart-1');
    expect(ctx.messages[0].smartScenePreview?.scenes).toHaveLength(2);
    expect(ctx.messages[0].smartScenePreview?.eligibleSceneCount).toBe(1);
  });

  it('surfaces partial analysis_completed warning and shared partial status', () => {
    handleSSEEvent('analysis_completed', {
      data: {
        conclusion: '## 综合结论\n\n降级结论',
        partial: true,
        terminationMessage: '最终结果质量闸门发现 provider 没有产出可独立交付的完整结论',
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('结果完整性提示');
    expect(ctx.messages[0].content).toContain('最终结果质量闸门');
    expect(getAISharedState().status).toBe('partial');
    expect(getAISharedState().lastAnalysisTime).not.toBeNull();
  });

  it('does not silently ignore degraded events', () => {
    const result = handleSSEEvent('degraded', {
      content: {
        message: '结果已标记 partial',
        partial: true,
        code: 'plan_summary_fallback',
      },
    }, ctx);

    expect(result.loadingPhase).toBe('结果已标记为部分完成');
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('结果完整性提示');
    expect(ctx.flowMessages[0].content).toContain('结果已标记 partial');
  });

  it('should route answer_token events to incremental answer stream', () => {
    handleSSEEvent('answer_token', {data: {token: 'A'}}, ctx);
    handleSSEEvent('answer_token', {data: {token: 'B'}}, ctx);
    handleSSEEvent('answer_token', {data: {done: true}}, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].flowTag).toBe('answer_stream');
    expect(ctx.messages[0].content).toBe('AB');
  });

  it('should route conversation_step events to ordered timeline flow', () => {
    handleSSEEvent('conversation_step', {
      id: 'evt-1',
      data: {
        ordinal: 1,
        phase: 'progress',
        role: 'system',
        content: {text: '开始分析'},
      },
    }, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('🧵 对话时间线');
    expect(ctx.flowMessages[0].content).toContain('#1');
  });
});

// =============================================================================
// Error Handling and Edge Cases
// =============================================================================

describe('Error Handling', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should handle malformed event data without crashing', () => {
    // These should not throw
    expect(() => handleProgressEvent({}, ctx)).not.toThrow();
    expect(() => handleProgressEvent({data: null}, ctx)).not.toThrow();
    expect(() => handleProgressEvent({data: {message: null}}, ctx)).not.toThrow();
  });

  it('should handle undefined ctx properties gracefully', () => {
    const minimalCtx = createMockContext();

    // Should not throw when displayedSkillProgress operations occur
    handleSkillLayeredResultEvent({
      data: {
        skillId: 'test',
        layers: {overview: {}},
      },
    }, minimalCtx);
  });

  it('should recover from errors in individual handlers', () => {
    // Test that one bad event doesn't break subsequent handling
    handleSSEEvent('unknown', {bad: 'data'}, ctx);
    handleSSEEvent('progress', {data: {message: 'Valid'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Valid');
  });
});

// =============================================================================
// State Accumulation Tests
// =============================================================================

describe('State Accumulation', () => {
  let ctx: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    ctx = createMockContext();
  });

  it('should accumulate errors across multiple skill_error events', () => {
    handleSkillErrorEvent({skillId: 'skill1', data: {error: 'Error 1'}}, ctx);
    handleSkillErrorEvent({skillId: 'skill2', data: {error: 'Error 2'}}, ctx);
    handleSkillErrorEvent({skillId: 'skill3', data: {error: 'Error 3'}}, ctx);

    expect(ctx.collectedErrors).toHaveLength(3);
    expect(ctx.collectedErrors.map(e => e.skillId)).toEqual(['skill1', 'skill2', 'skill3']);
  });

  it('should track displayed skill progress for deduplication', () => {
    const data1 = {
      data: {skillId: 'skill_A', layers: {overview: {summary: {data: [], display: {}}}}},
    };
    const data2 = {
      data: {skillId: 'skill_B', layers: {overview: {summary: {data: [], display: {}}}}},
    };

    handleSkillLayeredResultEvent(data1, ctx);
    handleSkillLayeredResultEvent(data2, ctx);

    expect(ctx.displayedSkillProgress.has('skill_layered_result:skill_A')).toBe(true);
    expect(ctx.displayedSkillProgress.has('skill_layered_result:skill_B')).toBe(true);
  });

  it('should clear collected errors after showing summary', () => {
    ctx.collectedErrors.push({
      skillId: 'test',
      error: 'Test error',
      timestamp: Date.now(),
    });

    // Trigger error summary via analysis_completed
    handleAnalysisCompletedEvent({data: {conclusion: 'Done'}}, ctx);

    // Errors should be cleared after summary is shown
    expect(ctx.collectedErrors).toHaveLength(0);
  });
});
