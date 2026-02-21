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
 * - Terminal events (analysis_completed, error)
 */

import {describe, it, expect, beforeEach} from '@jest/globals';

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
  });

  it('should add progress message with correct format', () => {
    const data = {data: {message: 'Analyzing frames...'}};

    const result = handleProgressEvent(data, ctx);

    expect(ctx.messages).toHaveLength(0);
    expect(ctx.flowMessages).toHaveLength(1);
    expect(ctx.flowMessages[0].content).toContain('Analyzing frames...');
    expect(ctx.flowMessages[0].role).toBe('assistant');
    expect(result).toEqual({});
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

  it('should use default values when not provided', () => {
    const data = {data: {}};

    handleRoundStartEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('1/5');
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

  it('should use defaults when counts not provided', () => {
    const data = {data: {}};

    handleSynthesisCompleteEvent(data, ctx);

    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0].content).toContain('0 个发现');
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

  it('should add agent-driven metadata when available', () => {
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

    expect(ctx.messages[0].content).toContain('90%');
    expect(ctx.messages[0].content).toContain('3');
    expect(ctx.messages[0].content).toContain('Main thread blocked');
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
    expect(ctx.messages[0].content).toContain('分析轮次: 4');
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

  it('should not append metadata twice when conclusion already contains metadata section', () => {
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

    const metadataCount = (ctx.messages[0].content.match(/分析元数据/g) || []).length;
    expect(metadataCount).toBe(1);
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
    const data = {};

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

  it('should use default reason if not provided', () => {
    const data = {data: {}};

    handleStrategyFallbackEvent(data, ctx);

    expect(ctx.messages[0].content).toContain('未匹配到预设策略');
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

  it('should skip conclusion events (handled in analysis_completed)', () => {
    handleSSEEvent('conclusion', {data: {conclusion: 'Final conclusion'}}, ctx);

    expect(ctx.messages).toHaveLength(0);
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
