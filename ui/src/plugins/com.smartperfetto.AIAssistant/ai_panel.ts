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

import m from 'mithril';
import {SettingsModal} from './settings_modal';
import {ProviderQuickSwitcher} from './provider_switcher';
import {SqlResultTable} from './sql_result_table';
import type {UserInteraction} from './sql_result_table';
import {ChartVisualizer} from './chart_visualizer';
import {NavigationBookmarkBar} from './navigation_bookmark_bar';
import type {NavigationBookmark} from './navigation_bookmark_bar';
import {SceneNavigationBar} from './scene_navigation_bar';
import {
  getActivityHintFromBufferTxTrackName,
  getMaxPinsForPattern,
  needsActiveDisambiguation,
} from './auto_pin_utils';
import type {Engine} from '../../trace_processor/engine';
import {LONG, NUM_NULL, STR_NULL} from '../../trace_processor/query_result';
import type {Trace} from '../../public/trace';
import type {Track} from '../../public/track';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AppImpl} from '../../core/app_impl';
import {getBackendUploader} from '../../core/backend_uploader';
import {
  buildSmartPerfettoContextHeaders,
  buildSmartPerfettoWorkspaceApiUrl,
  getSmartPerfettoRequestContext,
  setSmartPerfettoWorkspaceId,
} from '../../core/smartperfetto_request_context';
import {
  getBackendUploadState,
  subscribeBackendUploadState,
  type BackendUploadSnapshot,
} from '../../core/backend_upload_state';
import type {TraceSource} from '../../core/trace_source';
import {Time} from '../../base/time';
// Note: generated types are used by SSE event handlers module
// import {FullAnalysis, ExpandableSections, isFrameDetailData} from './generated';

// Refactored modules - centralized types and utilities
import type {
  Message,
  SqlQueryResult,
  AIPanelState,
  PinnedResult,
  AISettings,
  AISession,
  ServerStatus,
  StreamingFlowState,
  SelectionContext,
  SelectionTrackInfo,
  SliceCardInfo,
  AreaCardInfo,
  TraceDataset,
  DataSourceContext,
  LatestAnalysisSnapshot,
  AnalysisResultPickerItem,
  AnalysisResultWindowState,
  AnalysisResultComparisonCell,
  AnalysisResultComparisonDelta,
  AnalysisResultComparisonMatrixRow,
  AnalysisResultComparisonRun,
  TeachingActiveRenderingProcess,
  TeachingContent,
  TeachingObservedCriticalTask,
  TeachingObservedEvent,
  TeachingObservedFlow,
  TeachingObservedLane,
  TeachingPinExecutionResult,
  TeachingPinInstruction,
  TeachingPipelineResult,
  TeachingTrackHint,
  TeachingWarning,
} from './types';
import {
  createStreamingFlowState,
  createStreamingAnswerState,
  createStoryPanelState,
  DEFAULT_SETTINGS,
  PRESET_QUESTIONS,
  COMPARISON_PRESET_QUESTIONS,
} from './types';
import {
  decodeBase64Unicode,
  encodeBase64Unicode,
  formatMessage,
} from './data_formatter';
import {sessionManager} from './session_manager';
import {mermaidRenderer} from './mermaid_renderer';
import {buildAssistantApiV1Url} from './assistant_api_v1';
import {
  formatAnalysisResultRef,
  isAnalysisResultComparisonRequest,
  resolveAnalysisResultComparisonRequest,
} from './analysis_result_references';
import {latestSnapshotFromAnalysisCompletedEvent} from './analysis_result_snapshot_state';
import {
  buildAgentSseStreamInit,
  buildAgentSseStreamUrl,
} from './agent_sse_transport';
import {formatPerfettoSql} from './sql_formatter';
import {clearComparisonState} from './comparison_state_manager';
import {
  handleSSEEvent as handleSSEEventExternal,
} from './sse_event_handlers';
import type {SSEHandlerContext} from './sse_event_handlers';
import {orderMessagesForDisplay} from './message_order';
import {STEP_TO_OVERLAY, createOverlayTrack} from './track_overlay';
import {
  subscribeClearChat,
  subscribeOpenSettings,
} from './assistant_command_bus';
// Scene reconstruction logic lives in story_controller.ts; shared constants in scene_constants.ts.
import {SCENE_DISPLAY_NAMES} from './scene_constants';
import {StoryController} from './story_controller';
import type {StoryControllerContext} from './story_controller';
// AI Everywhere: cross-component shared state + timeline notes
import {
  updateAISharedState,
  resetAISharedState,
  getAISharedState,
} from './ai_shared_state';
import {addBookmarkNotes, clearAIFindingNotes} from './ai_timeline_notes';
import {
  consumeTransientState,
  registerTransientSaver,
  switchFloatingMode,
  unregisterTransientSaver,
} from './ai_transient_state';
import type {TransientState} from './ai_transient_state';
import {
  clampSidebarHeight,
  clampSidebarWidth,
  getFloatingState,
  updateFloatingState,
} from './ai_floating_state';
import {providerRuntimeLabel} from './provider_types';
import type {
  SmartDisplayedScene,
  SmartScenePreviewPayload,
  SmartSceneVerificationPayload,
} from './types';

const DEBUG_AI_PANEL = false;

interface AreaQueryScope {
  startNs: number;
  endNs: number;
  durationNs: number;
  source: SelectionContext['source'];
  utids: number[];
  upids: number[];
  cpus: number[];
}

const RANGE_REFERENCE_PATTERNS = [
  /这[一]?段/,
  /这个?区间/,
  /当前(范围|区间|窗口|时间段|视图)/,
  /可见(范围|区间|窗口)/,
  /选中(范围|区间|时间段|这一段|这段)/,
  /选区/,
  /\b(current|visible)\s+(range|window|viewport)\b/i,
  /\b(selected|marked)\s+(range|area|window)\b/i,
  /\bthis\s+(range|window|selection)\b/i,
] as const;

// Metric card palette keyed by status. Extracted from a triple-ternary that
// repeated the four intent mappings three times (bg / fg / icon name). The
// `info` entry doubles as the default for unknown status values.
const METRIC_STATUS_STYLES: Record<
  string,
  {bg: string; fg: string; icon: string}
> = {
  good: {
    bg: 'var(--chat-metric-bg-good)',
    fg: 'var(--chat-success)',
    icon: 'check_circle',
  },
  warning: {
    bg: 'var(--chat-metric-bg-warning)',
    fg: 'var(--chat-warning)',
    icon: 'warning',
  },
  critical: {
    bg: 'var(--chat-metric-bg-critical)',
    fg: 'var(--chat-error)',
    icon: 'error',
  },
  info: {
    bg: 'var(--chat-metric-bg-info)',
    fg: 'var(--pf-color-accent)',
    icon: 'analytics',
  },
};

function metricStatusStyle(status: string | undefined): {
  bg: string;
  fg: string;
  icon: string;
} {
  return (
    (status ? METRIC_STATUS_STYLES[status] : undefined) ??
    METRIC_STATUS_STYLES.info
  );
}

function formatTeachingConfidence(confidence: number | undefined): string {
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return '-';
  return `${Math.round(confidence * 100)}%`;
}

function formatTeachingNs(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return value.toLocaleString('en-US');
}

function formatTeachingMs(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value >= 1) return `${value.toFixed(2)}ms`;
  return `${(value * 1000).toFixed(0)}µs`;
}

function teachingPrimaryPipelineId(result: TeachingPipelineResult): string {
  return (
    result.detection?.primary_pipeline?.id ||
    result.detection?.primaryPipelineId ||
    'UNKNOWN_PIPELINE'
  );
}

function teachingPrimaryConfidence(result: TeachingPipelineResult): number | undefined {
  return (
    result.detection?.primary_pipeline?.confidence ??
    result.detection?.primaryConfidence
  );
}

function teachingContent(result: TeachingPipelineResult): TeachingContent | null {
  return result.teaching || result.teachingContent || null;
}

function teachingFeatureName(feature: {
  id?: string;
  name?: string;
  feature?: string;
}): string {
  return feature.id || feature.name || feature.feature || 'unknown';
}

function escapeTeachingRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface AIPanelAttrs {
  engine: Engine;
  trace: Trace;
}

// Re-export types for backward compatibility with external consumers
export type {
  Message,
  SqlQueryResult,
  AISettings,
  AISession,
  PinnedResult,
  ServerStatus,
} from './types';

// Inline style objects cannot resolve CSS custom properties for dark mode;
// all visual tokens live in styles.scss so the --chat-* cascade handles theming.

/** Detect system dark mode preference. Updates reactively when user toggles OS theme. */
function detectDarkMode(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  );
}

interface CachedSqlFormat {
  raw: string;
  text: string;
  status: 'pending' | 'formatted' | 'failed';
  error?: string;
}

interface SmartSceneSelectionRequest {
  scope: 'all' | 'scene_types' | 'scene_ids';
  sceneTypes?: string[];
  sceneIds?: string[];
  label?: string;
  reportId?: string;
  sceneSnapshotId?: string;
}

const SMART_SCENE_SELECTION_GROUPS: Array<{
  label: string;
  sceneTypes: string[];
}> = [
  {label: '启动', sceneTypes: ['cold_start', 'warm_start', 'hot_start']},
  {label: '滑动', sceneTypes: ['scroll', 'inertial_scroll']},
  {label: '点击', sceneTypes: ['tap', 'long_press', 'screen_unlock']},
  {label: '导航', sceneTypes: ['back_key', 'home_key', 'recents_key', 'navigation', 'window_transition', 'app_switch']},
  {label: '设备', sceneTypes: ['screen_on', 'screen_off', 'screen_sleep', 'idle']},
  {label: 'ANR', sceneTypes: ['anr', 'jank_region']},
];

export class AIPanel implements m.ClassComponent<AIPanelAttrs> {
  private engine?: Engine;
  private trace?: Trace;
  private isDarkMode = detectDarkMode();
  private darkModeListener?: () => void;
  private state: AIPanelState = {
    messages: [],
    input: '',
    isLoading: false,
    loadingPhase: '',
    showSettings: false,
    settings: {...DEFAULT_SETTINGS},
    commandHistory: [],
    historyIndex: -1,
    lastQuery: '',
    pinnedResults: [],
    backendTraceId: null,
    bookmarks: [], // 初始化为空数组
    currentTraceFingerprint: null, // 当前 Trace 指纹
    currentSessionId: null, // 当前 Session ID
    isRetryingBackend: false, // 正在重试连接后端
    retryError: null, // 重试连接的错误信息
    agentSessionId: null, // Agent 多轮对话 Session ID
    agentRunId: null,
    agentRequestId: null,
    agentRunSequence: 0,
    displayedSkillProgress: new Set(), // 已显示的 skill 进度
    completionHandled: false, // 分析完成事件是否已处理
    // SSE Connection State Initialization
    sseConnectionState: 'disconnected',
    sseRetryCount: 0,
    sseMaxRetries: 5,
    sseLastEventTime: null,
    sseLastEventId: null,
    // Error Aggregation Initialization
    collectedErrors: [],
    // Output structure optimization
    collapsedTables: new Set(),
    // Scene Navigation Bar
    detectedScenes: [],
    scenesLoading: false,
    scenesError: null,
    // Progressive streaming transcript state
    streamingFlow: createStreamingFlowState(),
    // Incremental final answer stream state
    streamingAnswer: createStreamingAnswerState(),
    // Comparison mode state
    referenceTraceId: null,
    referenceTraceName: null,
    isReferenceActive: false,
    showTracePicker: false,
    comparisonTraceLoading: false,
    latestAnalysisSnapshot: null,
    showResultPicker: false,
    resultPickerLoading: false,
    resultPickerError: null,
    resultComparisonLoading: false,
    resultComparisonError: null,
    selectedResultBaselineId: null,
    selectedResultCandidateIds: new Set(),
    // Story Panel
    storyState: createStoryPanelState(),
    // Analysis mode is workspace-scoped so different workspaces keep separate
    // quick/full/auto preferences.
    analysisMode: sessionManager.loadAnalysisMode(),
    showAnalysisModeMenu: false,
    showSessionSidebar: false,
    showStorySidebar: false,
    // Slice Selected card
    sliceCardInfo: null,
    areaCardInfo: null,
    sliceCardPrevSelId: '',
    sliceCardDismissed: false,
    pendingTraceContext: null,
  };

  private unsubscribeClearChat?: () => void;
  private unsubscribeOpenSettings?: () => void;
  private unsubscribeBackendUpload?: () => void;
  private lastBackendUploadState: BackendUploadSnapshot =
    getBackendUploadState();
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;
  private scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private availableTraces: Array<{
    id: string;
    originalName?: string;
    uploadedAt?: string;
    size?: number;
  }> = [];
  private availableAnalysisResults: AnalysisResultPickerItem[] = [];
  private activeResultWindowStates: AnalysisResultWindowState[] = [];
  private resultVisibilityUpdatingIds = new Set<string>();
  private windowHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  // Debounced session save (P1-8): coalesce rapid addMessage() calls
  private saveSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private beforeUnloadHandler: (() => void) | null = null;
  // SSE Connection Management
  private sseAbortController: AbortController | null = null;
  // Paragraph-level progressive reveal: tracks how many children have been animated per message
  private revealedBlockCounts = new Map<string, number>();
  private renderedMessageContent = new WeakMap<HTMLElement, string>();
  private copiedMessageIds = new Set<string>();
  private formattedSqlCache = new Map<string, CachedSqlFormat>();
  // Transient state saver — bound closure registered in oncreate, cleared in onremove.
  // Captures input draft, collapsed tables, and active SSE analysis when the
  // user switches between tab and floating window mode.
  private transientSaverRef: (() => TransientState) | null = null;

  // Delegate to mermaidRenderer module
  private async renderMermaidInElement(container: HTMLElement): Promise<void> {
    await mermaidRenderer.renderMermaidInElement(container);
  }

  /**
   * Apply paragraph-level progressive reveal animation to message content.
   * Only animates block-level children that haven't been revealed yet,
   * enabling incremental streaming: already-revealed blocks appear instantly
   * while new blocks fade in with a staggered delay.
   */
  private applyBlockReveal(dom: HTMLElement, msgId: string): void {
    const children = Array.from(dom.children) as HTMLElement[];
    const alreadyRevealed = this.revealedBlockCounts.get(msgId) ?? 0;

    for (let i = alreadyRevealed; i < children.length; i++) {
      const child = children[i];
      child.classList.add('ai-reveal-block');
      child.style.animationDelay = `${(i - alreadyRevealed) * 60}ms`;
    }

    this.revealedBlockCounts.set(msgId, children.length);
  }

  private renderMessageContent(
    dom: HTMLElement,
    msg: Message,
    isProgressMessage: boolean,
  ): void {
    const lastRenderedContent = this.renderedMessageContent.get(dom);
    if (lastRenderedContent === msg.content) return;

    dom.innerHTML = formatMessage(msg.content);
    this.renderedMessageContent.set(dom, msg.content);
    void this.renderMermaidInElement(dom);
    if (msg.role === 'assistant' && !isProgressMessage) {
      this.applyBlockReveal(dom, msg.id);
    }
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  private async copyMessageContent(msg: Message): Promise<void> {
    const ok = await this.copyTextToClipboard(msg.content);
    if (!ok) return;

    this.copiedMessageIds.add(msg.id);
    m.redraw();
    window.setTimeout(() => {
      this.copiedMessageIds.delete(msg.id);
      m.redraw();
    }, 1200);
  }

  private renderTableSourceContext(
    context: DataSourceContext | undefined,
  ): m.Children {
    if (!context) return null;
    const traceLabel = context.traceSide === 'current'
      ? '当前 Trace'
      : context.traceSide === 'reference'
        ? '参考 Trace'
        : '';
    const kindLabel = (kind: DataSourceContext['kind']) => {
      switch (kind) {
        case 'summary':
          return '摘要';
        case 'metric':
          return '指标';
        case 'chart':
          return '图表';
        case 'text':
          return '文本';
        case 'timeline':
          return '时间线';
        case 'table':
          return '表格';
        default:
          return '';
      }
    };
    const compactId = (value: string) =>
      value.length > 36 ? `${value.slice(0, 33)}...` : value;
    const chips: string[] = [];
    const kind = kindLabel(context.kind);
    if (kind) chips.push(kind);
    if (traceLabel) chips.push(traceLabel);
    if (context.phase) chips.push(context.phase);
    const planPhase = [context.planPhaseId, context.planPhaseTitle]
      .filter(Boolean)
      .join(' · ');
    if (planPhase) chips.push(`阶段 ${planPhase}`);
    if (context.planPhaseAttribution) {
      chips.push(`阶段归因 ${context.planPhaseAttribution}`);
    }
    if (typeof context.rowCount === 'number') {
      chips.push(`${context.rowCount.toLocaleString()} 行`);
    }
    if (context.sourceToolCallId) {
      chips.push(`工具 ${compactId(context.sourceToolCallId)}`);
    }
    if (context.evidenceRefId) {
      chips.push(`证据 ${compactId(context.evidenceRefId)}`);
    }
    if (context.source) chips.push(context.source);

    return m('div.ai-table-context', [
      m('div.ai-table-context-main', [
        m('span.ai-table-ref', context.ref),
        m('span.ai-table-context-reason', context.reason),
      ]),
      m('div.ai-table-context-meaning', context.meaning),
      chips.length > 0
        ? m(
            'div.ai-table-context-meta',
            chips.map((chip) =>
              m('span.ai-table-context-chip', chip),
            ),
          )
        : null,
    ]);
  }

  private trackFullPathToString(trackNode: any): string {
    const fullPath = trackNode?.fullPath as string[] | undefined;
    return Array.isArray(fullPath) ? fullPath.join(' > ') : '';
  }

  private shouldIgnoreAutoPinTrackName(trackName: string): boolean {
    // Avoid noisy or misleading pins in teaching mode.
    if (/^VSYNC-appsf$/i.test(trackName)) return true;
    if (/^AChoreographer/i.test(trackName)) return true;
    return false;
  }

  private renderTeachingPipelineView(
    result: TeachingPipelineResult,
    pinExecution?: TeachingPinExecutionResult,
  ): m.Children {
    const content = teachingContent(result);
    const observedFlow = result.observedFlow;
    const warnings = result.warnings || [];
    const pipelineId = teachingPrimaryPipelineId(result);

    return m(
      'div.sp-teaching-result',
      {
        onclick: (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          const copyBtn = target.closest?.(
            '.ai-mermaid-copy',
          ) as HTMLElement | null;
          const b64 = copyBtn?.getAttribute('data-mermaid-b64');
          if (!b64) return;
          try {
            void this.copyTextToClipboard(decodeBase64Unicode(b64));
          } catch (err) {
            console.warn('[AIPanel] Failed to copy mermaid code:', err);
          }
        },
        oncreate: (vnode: m.VnodeDOM) => {
          void this.renderMermaidInElement(vnode.dom as HTMLElement);
        },
        onupdate: (vnode: m.VnodeDOM) => {
          void this.renderMermaidInElement(vnode.dom as HTMLElement);
        },
      },
      [
        m('div.sp-teaching-header', [
          m('div', [
            m('div.sp-teaching-eyebrow', '出图教学'),
            m('h3', content?.title || pipelineId),
          ]),
          m('div.sp-teaching-actions', [
            m(
              'button.sp-teaching-copy',
              {
                title: '复制诊断摘要',
                onclick: () => {
                  void this.copyTextToClipboard(
                    this.buildTeachingPipelineMarkdown(result, pinExecution),
                  );
                },
              },
              [m('i.pf-icon', 'content_copy'), m('span', '复制摘要')],
            ),
          ]),
        ]),
        this.renderTeachingPipelineSummary(result),
        warnings.length > 0 ? this.renderTeachingWarnings(warnings) : null,
        observedFlow ? this.renderTeachingObservedFlow(observedFlow) : null,
        this.renderTeachingExecutionState(result, pinExecution),
        content ? this.renderTeachingKnowledge(content) : null,
      ],
    );
  }

  private renderTeachingPipelineSummary(result: TeachingPipelineResult): m.Children {
    const detection = result.detection;
    const subvariants = detection.subvariants || {};
    const chips: Array<{label: string; value: string | undefined}> = [
      {label: 'Pipeline', value: teachingPrimaryPipelineId(result)},
      {
        label: 'Confidence',
        value: formatTeachingConfidence(teachingPrimaryConfidence(result)),
      },
      {label: 'Buffer', value: subvariants.buffer_mode},
      {label: 'Flutter', value: subvariants.flutter_engine},
      {label: 'WebView', value: subvariants.webview_mode},
      {label: 'Game', value: subvariants.game_engine},
    ];
    const visibleChips = chips.filter(
      (chip) => chip.value && chip.value !== 'UNKNOWN' && chip.value !== 'N/A',
    );

    return m('div.sp-teaching-summary', [
      m(
        'div.sp-teaching-chip-row',
        visibleChips.map((chip) =>
          m('span.sp-teaching-chip', [
            m('span.sp-teaching-chip-label', chip.label),
            m('span.sp-teaching-chip-value', chip.value),
          ]),
        ),
      ),
      detection.candidates && detection.candidates.length > 1
        ? m('div.sp-teaching-inline-list', [
            m('span', '候选类型'),
            ...detection.candidates.slice(0, 5).map((candidate) =>
              m(
                'code',
                `${candidate.id} ${formatTeachingConfidence(candidate.confidence)}`,
              ),
            ),
          ])
        : null,
      detection.features && detection.features.length > 0
        ? m('div.sp-teaching-inline-list', [
            m('span', '伴随特性'),
            ...detection.features
              .slice(0, 8)
              .map((feature) => m('code', teachingFeatureName(feature))),
          ])
        : null,
    ]);
  }

  private renderTeachingWarnings(warnings: TeachingWarning[]): m.Children {
    return m('div.sp-teaching-warning-list', [
      m('div.sp-teaching-section-title', 'Warnings'),
      ...warnings.slice(0, 8).map((warning) =>
        m('div.sp-teaching-warning', [
          m('span.sp-teaching-warning-severity', warning.severity || 'info'),
          m('span', warning.message || warning.code || 'warning'),
        ]),
      ),
      warnings.length > 8
        ? m('div.sp-teaching-more', `还有 ${warnings.length - 8} 条提示未展开`)
        : null,
    ]);
  }

  private renderTeachingObservedFlow(flow: TeachingObservedFlow): m.Children {
    return m('div.sp-teaching-observed', [
      m('div.sp-teaching-section-title', '当前 Trace 实际链路'),
      this.renderTeachingContext(flow),
      this.renderTeachingLanes(flow.lanes || []),
      this.renderTeachingDependencies(flow),
      this.renderTeachingCriticalTasks(flow.criticalTasks || []),
      this.renderTeachingEvents(flow.events || []),
      flow.completeness?.missingSignals?.length
        ? m('div.sp-teaching-missing', [
            m('div.sp-teaching-subtitle', '采集/观测缺口'),
            m(
              'ul',
              flow.completeness.missingSignals.map((signal) => m('li', signal)),
            ),
          ])
        : null,
    ]);
  }

  private renderTeachingContext(flow: TeachingObservedFlow): m.Children {
    const range = flow.context?.timeRange;
    return m('div.sp-teaching-context', [
      range
        ? m('span', [
            m('b', '时间窗 '),
            `${formatTeachingNs(range.startTs)} - ${formatTeachingNs(range.endTs)} ns (${range.source})`,
          ])
        : null,
      flow.context?.packageName
        ? m('span', [m('b', 'Package '), flow.context.packageName])
        : null,
      flow.context?.processName
        ? m('span', [m('b', 'Process '), flow.context.processName])
        : null,
      flow.context?.fallbackUsed
        ? m('span', [m('b', 'Fallback '), flow.context.fallbackUsed])
        : null,
      flow.completeness?.level
        ? m('span', [m('b', 'Completeness '), flow.completeness.level])
        : null,
    ]);
  }

  private renderTeachingLanes(lanes: TeachingObservedLane[]): m.Children {
    if (lanes.length === 0) {
      return m('div.sp-teaching-empty', '当前上下文没有观测到可展示泳道。');
    }
    return m(
      'div.sp-teaching-lanes',
      lanes.slice(0, 12).map((lane) =>
        m('div.sp-teaching-lane', [
          m('div.sp-teaching-lane-role', lane.role),
          m('div.sp-teaching-lane-title', lane.title || lane.id),
          m(
            'div.sp-teaching-lane-meta',
            lane.threadName || lane.processName || lane.layerName || '-',
          ),
          m('div.sp-teaching-lane-foot', [
            m('span', formatTeachingConfidence(lane.confidence)),
            m('span', lane.evidenceSource || '-'),
          ]),
        ]),
      ),
    );
  }

  private renderTeachingDependencies(flow: TeachingObservedFlow): m.Children {
    const dependencies = flow.dependencies || [];
    if (dependencies.length === 0) return null;
    const lanesById = new Map((flow.lanes || []).map((lane) => [lane.id, lane]));
    return m('div.sp-teaching-dependencies', [
      m('div.sp-teaching-subtitle', `调度/链路依赖 (${dependencies.length})`),
      m('table.sp-teaching-table', [
        m('thead', [
          m('tr', [
            m('th', 'From'),
            m('th', 'Relation'),
            m('th', 'To'),
            m('th', 'Evidence'),
          ]),
        ]),
        m(
          'tbody',
          dependencies.slice(0, 16).map((dependency) => {
            const from = lanesById.get(dependency.fromLaneId);
            const to = lanesById.get(dependency.toLaneId);
            return m('tr', [
              m('td', from?.title || dependency.fromLaneId),
              m('td', dependency.relation),
              m('td', to?.title || dependency.toLaneId),
              m('td', dependency.evidenceSource || dependency.detail || '-'),
            ]);
          }),
        ),
      ]),
      dependencies.length > 16
        ? m('div.sp-teaching-more', `还有 ${dependencies.length - 16} 条依赖未展开`)
        : null,
    ]);
  }

  private renderTeachingCriticalTasks(
    criticalTasks: TeachingObservedCriticalTask[],
  ): m.Children {
    if (criticalTasks.length === 0) return null;
    return m('div.sp-teaching-critical-tasks', [
      m('div.sp-teaching-subtitle', `Critical task / Wakeup (${criticalTasks.length})`),
      m('table.sp-teaching-table', [
        m('thead', [
          m('tr', [
            m('th', 'Kind'),
            m('th', 'Task'),
            m('th', 'Waker'),
            m('th', 'ts'),
            m('th', 'dur'),
          ]),
        ]),
        m(
          'tbody',
          criticalTasks.slice(0, 16).map((task) => {
            const owner =
              [task.threadName, task.processName].filter(Boolean).join(' / ') ||
              task.name ||
              '-';
            const waker =
              task.waker
                ? [task.waker.threadName, task.waker.processName]
                    .filter(Boolean)
                    .join(' / ') || task.waker.kind || '-'
                : '-';
            return m('tr', [
              m('td', task.kind),
              m('td', [
                m('div', owner),
                task.state ? m('code', task.state) : null,
                task.evidenceSource ? m('div.sp-teaching-muted', task.evidenceSource) : null,
              ]),
              m('td', waker),
              m('td', formatTeachingNs(task.ts)),
              m('td', formatTeachingMs(task.durMs)),
            ]);
          }),
        ),
      ]),
      criticalTasks.length > 16
        ? m('div.sp-teaching-more', `还有 ${criticalTasks.length - 16} 个 task 未展开`)
        : null,
    ]);
  }

  private renderTeachingEvents(events: TeachingObservedEvent[]): m.Children {
    if (events.length === 0) {
      return m('div.sp-teaching-empty', '当前上下文没有观测到关键出图事件。');
    }
    return m('div.sp-teaching-events', [
      m('div.sp-teaching-subtitle', `实际事件 (${events.length})`),
      m('table.sp-teaching-table', [
        m('thead', [
          m('tr', [
            m('th', 'Stage'),
            m('th', 'Slice'),
            m('th', 'Thread / Process'),
            m('th', 'ts'),
            m('th', 'dur'),
          ]),
        ]),
        m(
          'tbody',
          events.slice(0, 16).map((event) => {
            const owner =
              [event.threadName, event.processName].filter(Boolean).join(' / ') ||
              '-';
            return m('tr', [
              m('td', event.stage),
              m('td', event.name),
              m('td', owner),
              m('td', [
                m(
                  'button.sp-teaching-ts',
                  {
                    title: '跳转到该事件',
                    onclick: () => {
                      const navigation = this.jumpToTimestamp(BigInt(event.ts));
                      if (!navigation.ok) {
                        this.addMessage({
                          id: this.generateId(),
                          role: 'assistant',
                          content: `Failed to navigate to timestamp ${event.ts}ns: ${navigation.error}`,
                          timestamp: Date.now(),
                        });
                      }
                    },
                  },
                  formatTeachingNs(event.ts),
                ),
              ]),
              m('td', formatTeachingMs(event.durMs)),
            ]);
          }),
        ),
      ]),
      events.length > 16
        ? m('div.sp-teaching-more', `还有 ${events.length - 16} 个事件未展开`)
        : null,
    ]);
  }

  private renderTeachingExecutionState(
    result: TeachingPipelineResult,
    pinExecution?: TeachingPinExecutionResult,
  ): m.Children {
    return m('div.sp-teaching-execution', [
      result.pinPlan
        ? m('div.sp-teaching-plan-state', [
            m('span.sp-teaching-state-label', 'Pin plan'),
            m('span.sp-teaching-state-value', result.pinPlan.status),
            result.pinPlan.summary ? m('span', result.pinPlan.summary) : null,
          ])
        : null,
      result.overlayPlan
        ? m('div.sp-teaching-plan-state', [
            m('span.sp-teaching-state-label', 'Overlay plan'),
            m('span.sp-teaching-state-value', result.overlayPlan.status),
            result.overlayPlan.summary
              ? m('span', result.overlayPlan.summary)
              : null,
          ])
        : null,
      pinExecution
        ? [
            m('div.sp-teaching-plan-state', [
              m('span.sp-teaching-state-label', 'Pin result'),
              m(
                'span.sp-teaching-state-value',
                `${pinExecution.count} pinned`,
              ),
              m(
                'span',
                `${pinExecution.skipped} skipped / ${pinExecution.failed} failed`,
              ),
            ]),
            pinExecution.pinnedTrackNames?.length > 0
              ? m('div.sp-teaching-inline-list', [
                  m('span', '已 pin'),
                  ...pinExecution.pinnedTrackNames
                    .slice(0, 8)
                    .map((trackName) => m('code', trackName)),
                ])
              : null,
            pinExecution.missingPatterns?.length > 0
              ? m('div.sp-teaching-inline-list', [
                  m('span', '未命中'),
                  ...pinExecution.missingPatterns
                    .slice(0, 8)
                    .map((pattern) => m('code', pattern)),
                ])
              : null,
          ]
        : null,
    ]);
  }

  private renderTeachingKnowledge(content: TeachingContent): m.Children {
    const mermaid = content.mermaidBlocks?.[0];
    return m('div.sp-teaching-knowledge', [
      m('div.sp-teaching-section-title', '知识点'),
      content.summary ? m('p', content.summary) : null,
      content.threadRoles?.length
        ? m('div', [
            m('div.sp-teaching-subtitle', '关键线程角色'),
            m('table.sp-teaching-table', [
              m('thead', [
                m('tr', [m('th', '线程'), m('th', '职责'), m('th', 'Trace 标签')]),
              ]),
              m(
                'tbody',
                content.threadRoles.map((role) =>
                  m('tr', [
                    m('td', role.thread),
                    m('td', role.responsibility),
                    m('td', role.traceTag || '-'),
                  ]),
                ),
              ),
            ]),
          ])
        : null,
      content.keySlices?.length
        ? m('div.sp-teaching-inline-list', [
            m('span', '关键 Slice'),
            ...content.keySlices.map((sliceName) => m('code', sliceName)),
          ])
        : null,
      mermaid
        ? m('div.ai-mermaid-block', [
            m('div.ai-mermaid-diagram', {
              'data-mermaid-b64': encodeBase64Unicode(mermaid),
            }),
            m('details.ai-mermaid-details', [
              m('summary', '查看 Mermaid 源码'),
              m('div.ai-mermaid-actions', [
                m(
                  'button.ai-mermaid-copy',
                  {
                    type: 'button',
                    'data-mermaid-b64': encodeBase64Unicode(mermaid),
                  },
                  '复制代码',
                ),
              ]),
              m('pre.ai-mermaid-source', {
                'data-mermaid-b64': encodeBase64Unicode(mermaid),
              }),
            ]),
          ])
        : null,
    ]);
  }

  // oninit is called before view(), so backend status is initialized before first render
  oninit(vnode: m.Vnode<AIPanelAttrs>) {
    this.engine = vnode.attrs.engine;
    this.trace = vnode.attrs.trace;

    // Load settings from localStorage
    this.loadSettings();

    // Initialize backend status - must happen before first render
    this.initBackendStatus();

    // 检测 Trace 变化并加载对应的历史
    this.handleTraceChange();
  }

  /**
   * 生成 Trace 指纹，用于识别唯一的 Trace
   * 基于 traceInfo 的 start/end 和 traceTitle
   */
  private getTraceFingerprint(): string | null {
    if (!this.trace) return null;
    const info = this.trace.traceInfo;
    // 使用 start + end + title 生成指纹
    return `${info.start}_${info.end}_${info.traceTitle || 'untitled'}`;
  }

  /**
   * 检测 Trace 变化，如果变化则重置状态
   */
  private handleTraceChange(): void {
    const newFingerprint = this.getTraceFingerprint();
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    const backendUploadState = getBackendUploadState();

    // Auto-RPC: Try to get backendTraceId from shared backend upload state.
    const appBackendTraceId = backendUploadState.traceId;
    const appBackendUploadState = backendUploadState.state;
    const appBackendUploadError = backendUploadState.error;

    if (DEBUG_AI_PANEL)
      console.log('[AIPanel] Trace fingerprint check:', {
        new: newFingerprint,
        current: this.state.currentTraceFingerprint,
        backendTraceId: this.state.backendTraceId,
        appBackendTraceId,
        appBackendUploadState,
        appBackendUploadError,
        engineMode: this.engine?.mode,
        engineInRpcMode,
      });

    // If upload already completed, reuse the backend trace id.
    if (appBackendTraceId && !this.state.backendTraceId) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Using backendTraceId from auto-upload:',
          appBackendTraceId,
        );
      this.state.backendTraceId = appBackendTraceId;
      // Don't call detectScenesQuick() here — defer to after welcome message below
    }

    // 如果指纹没变且已经有 session，不需要重新加载
    if (
      newFingerprint &&
      newFingerprint === this.state.currentTraceFingerprint &&
      this.state.currentSessionId
    ) {
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Same trace, keeping current session');
      // 如果在 RPC 模式但没有 backendTraceId，尝试自动注册
      if (engineInRpcMode && !this.state.backendTraceId) {
        this.autoRegisterWithBackend();
      }
      return;
    }

    // 更新当前指纹
    this.state.currentTraceFingerprint = newFingerprint;

    if (!newFingerprint) {
      // 没有 trace，重置状态
      this.resetStateForNewTrace();
      return;
    }

    // 尝试迁移旧格式数据
    this.migrateOldHistoryToSession();

    // Auto-restore a recent session (<30 min old with messages) for this trace,
    // otherwise create a new session.
    const recentSessions = sessionManager.getSessionsForTrace(newFingerprint);
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const now = Date.now();
    const restorable = recentSessions
      .filter(
        (s) =>
          s.messages.length > 0 &&
          now - (s.lastActiveAt || s.createdAt) < THIRTY_MINUTES,
      )
      .sort(
        (a, b) =>
          (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt),
      );

    if (restorable.length > 0) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Auto-restoring recent session:',
          restorable[0].sessionId,
        );
      // Preserve backendTraceId from upload state — loadSession may clear it
      const savedBackendTraceId = this.state.backendTraceId;
      this.loadSession(restorable[0].sessionId);
      if (savedBackendTraceId && !this.state.backendTraceId) {
        this.state.backendTraceId = savedBackendTraceId;
        this.saveCurrentSession();
      }
      if (this.state.backendTraceId) {
        // Scene navigation bar now populates only after explicit /scene command.
        // detectScenesQuick() quality is too low for navigation (0ms entries, inaccurate types).
      } else if (appBackendUploadState === 'uploading') {
        // Background upload still in progress — listen for completion
        // Without this, restored sessions get stuck in disconnected state
        this.listenForBackendUpload();
      } else if (engineInRpcMode) {
        // In RPC mode but no backendTraceId — try to register
        this.autoRegisterWithBackend();
      }
      m.redraw();
      return;
    }

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Creating new session for trace');
    this.createNewSession();

    // 显示欢迎消息 — handle three states:
    // 1. backendTraceId already available (upload completed before panel init)
    // 2. Upload still in progress (show connecting message, listen for completion)
    // 3. Manual RPC mode (trace_processor_shell -D)
    // 4. No backend at all
    if (this.state.backendTraceId) {
      // Backend already available — show welcome (scene detection deferred to /scene command)
      this.addRpcModeWelcomeMessage();
    } else if (appBackendUploadState === 'uploading') {
      // Background upload in progress — show connecting state, listen for completion
      this.addBackendConnectingMessage();
      this.listenForBackendUpload();
    } else if (appBackendUploadState === 'failed') {
      // Background upload failed — show unavailable state immediately
      this.addBackendUnavailableMessage(appBackendUploadError);
    } else if (engineInRpcMode) {
      // Manual RPC mode (trace_processor_shell -D) — try to register
      this.autoRegisterWithBackend();
    } else {
      // No backend connection at all
      this.addBackendUnavailableMessage(appBackendUploadError);
    }
  }

  /**
   * 当已经在 HTTP RPC 模式时，自动向后端注册当前 trace
   * 这样后端可以执行 SQL 查询
   */
  private async autoRegisterWithBackend(): Promise<void> {
    const rpcTarget = HttpRpcEngine.getCurrentTarget();
    const rpcPort = rpcTarget.port ?? HttpRpcEngine.rpcPort;
    if (DEBUG_AI_PANEL)
      console.log(
        '[AIPanel] Auto-registering with backend, RPC target:',
        rpcTarget,
      );

    // First, check if there's a pending backendTraceId from a recent upload
    const pendingTraceId = this.recoverPendingBackendTrace(
      rpcTarget.port ? parseInt(rpcTarget.port, 10) : undefined,
      rpcTarget.leaseId,
    );
    if (pendingTraceId) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Recovered pending backend traceId:',
          pendingTraceId,
        );
      this.state.backendTraceId = pendingTraceId;

      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `✅ **已进入 RPC 模式**\n\nTrace 已成功上传并通过 ${this.rpcModeDescription()} 加载。\nAI 助手已就绪，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
        timestamp: Date.now(),
      });

      this.saveCurrentSession();
      m.redraw();
      return;
    }

    if (rpcTarget.mode === 'backend-lease-proxy') {
      this.addRpcModeWelcomeMessage();
      return;
    }

    try {
      // 调用后端 API 注册当前 RPC 连接
      const response = await this.fetchBackend(
        buildSmartPerfettoWorkspaceApiUrl(
          this.state.settings.backendUrl,
          'traces',
          '/register-rpc',
        ),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            port: parseInt(rpcPort, 10),
            traceName:
              this.trace?.traceInfo?.traceTitle || 'External RPC Trace',
          }),
        },
      );

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.traceId) {
          this.state.backendTraceId = data.traceId;
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Auto-registered with backend, traceId:',
              data.traceId,
            );

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `✅ **已连接到 RPC 模式**\n\n检测到当前 Trace 已通过 ${this.rpcModeDescription()} 加载。\nAI 助手现在可以分析这份 Trace 数据了。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
            timestamp: Date.now(),
          });

          this.saveCurrentSession();

          m.redraw();
          return;
        }
      }

      // 注册失败时，显示基本欢迎消息
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Auto-registration failed, showing welcome message',
        );
      this.addRpcModeWelcomeMessage();
    } catch (error) {
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Auto-registration error:', error);
      this.addRpcModeWelcomeMessage();
    }
  }

  /**
   * 手动重试连接后端 - 用于从 cache 加载的 Trace
   * 当后端启动后，用户可以点击"重试连接"按钮来上传 Trace 并切换到 RPC 模式
   */
  private async retryBackendConnection(): Promise<void> {
    if (!this.trace || this.state.isRetryingBackend) {
      return;
    }

    if (DEBUG_AI_PANEL)
      console.log('[AIPanel] Manually retrying backend connection...');
    this.state.isRetryingBackend = true;
    this.state.retryError = null;
    m.redraw();

    try {
      const uploader = getBackendUploader(this.state.settings.backendUrl);

      // 首先检查后端是否可用
      const backendAvailable = await uploader.checkAvailable();
      if (!backendAvailable) {
        throw new Error(
          'AI 后端服务未启动。请先运行 `cd backend && npm run dev` 启动后端服务。',
        );
      }

      // 获取当前 Trace 的 source
      const traceInfo = this.trace.traceInfo as unknown as {
        source: TraceSource;
      };
      const traceSource = traceInfo.source;
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Retrying with trace source type:',
          traceSource.type,
        );

      // 尝试上传 Trace
      const uploadResult = await uploader.upload(traceSource);

      if (!uploadResult.success || (!uploadResult.rpcTarget && !uploadResult.port)) {
        throw new Error(uploadResult.error || '上传 Trace 失败');
      }

      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Upload successful:', uploadResult);

      // 上传成功，需要重新加载 Trace 以使用新的 RPC 端口
      // 显示提示信息
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '🔄 正在切换到 RPC 模式...',
        timestamp: Date.now(),
      });

      // 设置 RPC 端口并重新加载 Trace
      if (uploadResult.rpcTarget) {
        HttpRpcEngine.setRpcTarget(uploadResult.rpcTarget);
      } else if (uploadResult.port) {
        HttpRpcEngine.useDirectPort(String(uploadResult.port));
      }

      // 存储 traceId 用于后续注册
      if (uploadResult.traceId) {
        this.state.backendTraceId = uploadResult.traceId;
        sessionManager.storePendingBackendTrace(
          uploadResult.traceId,
          uploadResult.port,
          uploadResult.leaseId,
        );
      }

      // The backend has already loaded the trace into trace_processor_shell.
      // Reopen as HTTP_RPC so URL traces do not trigger another browser fetch.
      AppImpl.instance.openTraceFromHttpRpc();

      // 重置重试状态
      this.state.isRetryingBackend = false;
      m.redraw();
    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[AIPanel] Retry backend connection failed:', errorMsg);
      this.state.retryError = errorMsg;
      this.state.isRetryingBackend = false;
      m.redraw();
    }
  }

  /**
   * 从临时存储中恢复 pending backendTraceId
   * 用于在 trace reload 后恢复上传时设置的 traceId
   */
  private recoverPendingBackendTrace(currentPort?: number, currentLeaseId?: string): string | null {
    return sessionManager.recoverPendingBackendTrace(currentPort, currentLeaseId);
  }

  /**
   * RPC 模式欢迎消息（无需上传）
   */
  private addRpcModeWelcomeMessage(): void {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `✅ **AI 助手已就绪**\n\nTrace 已通过 ${this.rpcModeDescription()} 加载。\n前后端共享同一个 trace_processor，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  private rpcModeDescription(): string {
    const target = HttpRpcEngine.getCurrentTarget();
    if (target.mode === 'backend-lease-proxy') {
      const modeText =
        target.leaseMode === 'isolated'
          ? '独立'
          : target.leaseMode === 'shared'
            ? '共享'
            : '未知';
      const queueText = typeof target.leaseQueueLength === 'number'
        ? `，队列 ${target.leaseQueueLength}`
        : '';
      return `后端 ${modeText} Lease 代理 (${target.leaseId ?? 'unknown'}${queueText})`;
    }
    return `HTTP RPC (端口 ${target.port ?? HttpRpcEngine.rpcPort})`;
  }

  /**
   * 后端不可用时的提示消息
   */
  private addBackendUnavailableMessage(errorDetail?: string): void {
    const errorSection = errorDetail
      ? `\n\n**错误详情：**\n- ${errorDetail}`
      : '';
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `⚠️ **AI 后端未连接**\n\n无法连接到 AI 分析后端 (${this.state.settings.backendUrl})。\n\n**可能的原因：**\n- 后端服务未启动\n- 网络连接问题${errorSection}\n\n**解决方法：**\n1. 确保后端服务正在运行：\n   \`\`\`bash\n   cd backend && npm run dev\n   \`\`\`\n2. 重新打开 Trace 文件\n\nTrace 已加载到 WASM 引擎，但 AI 分析功能不可用。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * 后端正在连接中的提示消息（非阻塞上传进行中）
   */
  private addBackendConnectingMessage(): void {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `⏳ **正在连接 AI 后端...**\n\nTrace 已加载到 WASM 引擎，AI 分析后端正在后台准备中。\n连接成功后将自动启用 AI 分析功能。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * 监听后台上传完成事件
   * 上传完成/失败后更新状态
   */
  private listenForBackendUpload(): void {
    if (this.unsubscribeBackendUpload) {
      this.unsubscribeBackendUpload();
      this.unsubscribeBackendUpload = undefined;
    }

    const handleSnapshot = (snapshot: BackendUploadSnapshot): void => {
      const previous = this.lastBackendUploadState;
      this.lastBackendUploadState = snapshot;

      if (snapshot.state === 'ready' && snapshot.traceId) {
        const isNewReadyState =
          previous.state !== 'ready' || previous.traceId !== snapshot.traceId;
        if (!isNewReadyState) return;

        this.state.backendTraceId = snapshot.traceId;
        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Backend upload complete, traceId:',
            snapshot.traceId,
          );
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `✅ **AI 后端已连接**\n\nTrace 已通过 ${this.rpcModeDescription()} 加载，AI 分析后端已就绪。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
          timestamp: Date.now(),
        });
        this.saveCurrentSession();
        m.redraw();
        void this.postWindowHeartbeat();

        if (this.unsubscribeBackendUpload) {
          this.unsubscribeBackendUpload();
          this.unsubscribeBackendUpload = undefined;
        }
        return;
      }

      if (snapshot.state === 'failed') {
        const isNewFailedState =
          previous.state !== 'failed' || previous.error !== snapshot.error;
        if (!isNewFailedState) return;

        console.warn(
          '[AIPanel] Backend upload failed:',
          snapshot.error ?? 'unknown error',
        );
        this.addBackendUnavailableMessage(snapshot.error);
        if (this.unsubscribeBackendUpload) {
          this.unsubscribeBackendUpload();
          this.unsubscribeBackendUpload = undefined;
        }
      }
    };

    const current = getBackendUploadState();
    this.lastBackendUploadState = current;
    if (current.state === 'ready' || current.state === 'failed') {
      handleSnapshot(current);
      return;
    }

    this.unsubscribeBackendUpload = subscribeBackendUploadState(handleSnapshot);
  }

  /**
   * 重置状态，准备迎接新 Trace
   */
  private resetStateForNewTrace(): void {
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.state.backendTraceId = null;
    this.state.pinnedResults = [];
    this.state.bookmarks = [];
    this.state.lastQuery = '';
    this.state.currentSessionId = null;
    this.state.agentSessionId = null; // Reset Agent session for multi-turn dialogue
    this.state.latestAnalysisSnapshot = null;
    this.state.showResultPicker = false;
    this.state.resultPickerLoading = false;
    this.state.resultPickerError = null;
    this.state.resultComparisonLoading = false;
    this.state.resultComparisonError = null;
    this.state.selectedResultBaselineId = null;
    this.state.selectedResultCandidateIds = new Set();
    this.availableAnalysisResults = [];
    this.activeResultWindowStates = [];
    this.resultVisibilityUpdatingIds.clear();
    this.clearAgentObservability();

    // 如果有有效的 trace 指纹，创建新 session
    if (this.state.currentTraceFingerprint) {
      this.createNewSession();
    }

    // 保存到旧的 history 存储（向后兼容）
    this.saveHistory();
    // 显示欢迎消息（进入 RPC 模式界面）
    this.addWelcomeMessage();
  }

  oncreate(_vnode: m.VnodeDOM<AIPanelAttrs>) {
    // Subscribe to assistant command bus.
    this.unsubscribeClearChat = subscribeClearChat(() => {
      void this.clearChat();
    });
    this.unsubscribeOpenSettings = subscribeOpenSettings(() => {
      this.openSettings();
    });

    // Listen for OS dark mode changes
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (mql) {
      this.darkModeListener = () => {
        this.isDarkMode = mql.matches;
        m.redraw();
      };
      mql.addEventListener('change', this.darkModeListener);
    }

    // Flush pending session save on page unload
    this.beforeUnloadHandler = () => this.flushSessionSave();
    window.addEventListener('beforeunload', this.beforeUnloadHandler);

    // Register transient state saver. The saver encapsulates the full
    // handoff protocol so both Pop Out and Dock Back get identical treatment
    // (Codex HIGH 1: symmetric handoff):
    //   1. Cancel SSE — stops event processing so the snapshot is stable
    //      and the next instance can replay cleanly from lastEventId.
    //   2. Save session — persists messages + bookmarks + agent session IDs
    //      so the new AIPanel's auto-restore brings the conversation back.
    //   3. Capture in-memory state — fields that don't live in sessions
    //      (input draft, collapsed tables, streaming state, dedup sets).
    this.transientSaverRef = () => {
      this.cancelSSEConnection();
      this.saveCurrentSession();
      if (this.saveSessionTimer) {
        clearTimeout(this.saveSessionTimer);
        this.saveSessionTimer = null;
      }
      return this.snapshotTransientState();
    };
    registerTransientSaver(this.transientSaverRef);

    // Consume any transient state left over from a mode switch — restores
    // input draft, collapsed tables, and any in-flight SSE analysis.
    this.restoreTransientState(consumeTransientState());

    // Focus input (requires DOM)
    setTimeout(() => {
      const textarea = document.getElementById(
        'ai-input',
      ) as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);
    this.startWindowHeartbeat();
    // Animation keyframes are now defined in styles.scss
  }

  onremove() {
    // Unregister transient saver first so any in-flight switchFloatingMode()
    // that hasn't captured yet won't try to call into a torn-down instance.
    if (this.transientSaverRef) {
      unregisterTransientSaver(this.transientSaverRef);
      this.transientSaverRef = null;
    }
    this.cancelSSEConnection();
    // Clear any pending conversation flush timer — otherwise its delayed
    // callback fires on the torn-down instance (Codex MEDIUM 2).
    if (this.state.streamingFlow.conversationFlushTimer !== undefined) {
      clearTimeout(this.state.streamingFlow.conversationFlushTimer);
      this.state.streamingFlow.conversationFlushTimer = undefined;
    }
    // Clear pending debounced session save timer. The saver (for mode
    // switches) already does this, but onremove from trace unload needs
    // the same treatment to avoid stale callbacks.
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
      this.saveSessionTimer = null;
    }
    // Clear throttled scroll-to-bottom timer to prevent firing on
    // torn-down instance after mode switch or trace unload.
    if (this.scrollThrottleTimer) {
      clearTimeout(this.scrollThrottleTimer);
      this.scrollThrottleTimer = null;
    }
    if (this.windowHeartbeatTimer) {
      clearInterval(this.windowHeartbeatTimer);
      this.windowHeartbeatTimer = null;
    }
    if (this.unsubscribeClearChat) {
      this.unsubscribeClearChat();
      this.unsubscribeClearChat = undefined;
    }
    if (this.unsubscribeOpenSettings) {
      this.unsubscribeOpenSettings();
      this.unsubscribeOpenSettings = undefined;
    }
    // Clean up dark mode listener
    if (this.darkModeListener) {
      window
        .matchMedia?.('(prefers-color-scheme: dark)')
        ?.removeEventListener('change', this.darkModeListener);
      this.darkModeListener = undefined;
    }
    if (this.unsubscribeBackendUpload) {
      this.unsubscribeBackendUpload();
      this.unsubscribeBackendUpload = undefined;
    }
    // Flush pending session save and remove beforeunload listener
    this.flushSessionSave();
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }

  private renderHeaderActions(
    isInRpcMode: boolean,
    hasBackendTrace: boolean,
  ): m.Children {
    const floatingState = getFloatingState();
    const isDockedSidebar = floatingState.mode === 'sidebar';

    return m('div.ai-header-actions', [
      m('div.ai-header-action-group.ai-header-action-group--analysis', [
        m('span.ai-header-action-group-label', '分析'),
        isInRpcMode && hasBackendTrace
          ? this.renderHeaderIconButton({
              icon: 'compare_arrows',
              title: this.state.referenceTraceId
                ? `对比模式: ${this.state.referenceTraceName || 'Reference Trace'}`
                : '对比...',
              active: !!this.state.referenceTraceId || this.state.showTracePicker,
              onclick: () => {
                this.state.showTracePicker = true;
                this.state.showResultPicker = false;
                this.state.showSessionSidebar = false;
                this.state.showStorySidebar = false;
                this.fetchAvailableTraces();
                m.redraw();
              },
            })
          : null,
        isInRpcMode
          ? this.renderHeaderIconButton({
              icon: 'fact_check',
              title: '分析结果对比...',
              active: this.state.showResultPicker,
              onclick: () => {
                this.state.showResultPicker = true;
                this.state.resultComparisonError = null;
                this.state.showTracePicker = false;
                this.state.showSessionSidebar = false;
                this.state.showStorySidebar = false;
                void (async () => {
                  await this.postWindowHeartbeat();
                  await this.fetchAnalysisResults();
                })();
                m.redraw();
              },
            })
          : null,
        // Connection status indicator (read-only, no upload button in auto-RPC mode).
        m(
          'span.ai-header-icon-btn.ai-header-icon-btn--readonly',
          {
            title: isInRpcMode
              ? 'Connected to AI backend'
              : 'AI backend not connected',
          },
          m('i.pf-icon', isInRpcMode ? 'cloud_done' : 'cloud_off'),
        ),
        this.renderHeaderIconButton({
          icon: 'movie',
          title: this.state.showStorySidebar ? '隐藏 Story' : 'Story',
          active: this.state.showStorySidebar,
          onclick: () => {
            this.state.showStorySidebar = !this.state.showStorySidebar;
            if (this.state.showStorySidebar) {
              this.state.showSessionSidebar = false;
              this.state.showTracePicker = false;
              this.state.showResultPicker = false;
            }
            m.redraw();
          },
        }),
      ]),
      m('div.ai-header-action-group.ai-header-action-group--session', [
        m('span.ai-header-action-group-label', '会话'),
        this.renderHeaderIconButton({
          icon: 'add_comment',
          title: 'New Chat',
          onclick: () => this.clearChat(),
        }),
        this.renderHeaderIconButton({
          icon: 'forum',
          title: this.state.showSessionSidebar ? '隐藏历史对话' : '历史对话',
          active: this.state.showSessionSidebar,
          onclick: () => {
            this.state.showSessionSidebar = !this.state.showSessionSidebar;
            if (this.state.showSessionSidebar) {
              this.state.showStorySidebar = false;
              this.state.showTracePicker = false;
              this.state.showResultPicker = false;
            }
            m.redraw();
          },
        }),
      ]),
      m('div.ai-header-action-group.ai-header-action-group--window', [
        m('span.ai-header-action-group-label', '窗口'),
        isDockedSidebar ? this.renderSidebarLayoutSwitch(floatingState.sidebar.layout) : null,
        isDockedSidebar
          ? this.renderHeaderIconButton({
              icon: 'open_in_new',
              title: '弹出为浮动窗口（可拖动、可调整大小、跨标签页保持可见）',
              onclick: () => this.popOutToFloatingWindow(),
            })
          : null,
        this.renderHeaderIconButton({
          icon: 'settings',
          title: 'Settings',
          onclick: () => this.openSettings(),
        }),
      ]),
    ]);
  }

  private renderHeaderIconButton(attrs: {
    icon: string;
    title: string;
    onclick: () => void;
    active?: boolean;
    label?: string;
  }): m.Children {
    return m(
      'button.ai-header-icon-btn',
      {
        title: attrs.title,
        onclick: attrs.onclick,
        class: attrs.active ? 'active' : '',
      },
      [
        m('i.pf-icon', attrs.icon),
        attrs.label ? m('span', attrs.label) : null,
      ],
    );
  }

  private renderSidebarLayoutSwitch(layout: 'right' | 'bottom'): m.Children {
    const setLayout = (next: 'right' | 'bottom') => {
      const s = getFloatingState();
      updateFloatingState({
        sidebar: {
          ...s.sidebar,
          layout: next,
          collapsed: false,
        },
      });
      if (next === 'bottom') {
        clampSidebarHeight();
      } else {
        clampSidebarWidth();
      }
      m.redraw();
    };

    return m('div.ai-header-layout-switch', [
      m(
        'button',
        {
          class: layout === 'right' ? 'active' : '',
          title: 'Right: AI Assistant 显示在 Timeline 右侧',
          onclick: () => setLayout('right'),
        },
        'Right',
      ),
      m(
        'button',
        {
          class: layout === 'bottom' ? 'active' : '',
          title: 'Bottom: AI Assistant 显示在 Timeline 底部',
          onclick: () => setLayout('bottom'),
        },
        'Bottom',
      ),
    ]);
  }

  view(vnode: m.Vnode<AIPanelAttrs>) {
    // Detect selection changes and update slice card state.
    this.updateSliceCard();

    // AI Everywhere: consume pending selection analysis (one-shot, Codex #4).
    // Read + clear atomically to prevent re-trigger on the next redraw.
    const pending = getAISharedState().pendingSelectionAnalysis;
    if (pending && !this.state.isLoading) {
      updateAISharedState({pendingSelectionAnalysis: null});
      const durMs = ((pending.endNs - pending.startNs) / 1e6).toFixed(1);
      this.state.input = `分析当前时间/轨道选区的性能（${durMs}ms），包括关键线程的 CPU 调度、大小核分布和频率、主要耗时 Slice 诊断`;
      // Defer to avoid triggering async work inside view()
      setTimeout(() => this.sendMessage(), 0);
    }

    const providerLabel = this.serverStatus.connected
      ? this.serverStatus.runtime
        ? providerRuntimeLabel(this.serverStatus.runtime)
        : 'AI Agent'
      : 'Backend';
    const workspaceContext = getSmartPerfettoRequestContext();
    const isConnected = this.serverStatus.connected;
    // Check backend availability: engine in HTTP_RPC mode, OR backend upload completed/in-progress
    // With non-blocking upload, WASM engine is used for UI while backend runs separately
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    const hasBackendTrace = !!this.state.backendTraceId;
    const backendUploadState = getBackendUploadState();
    const hasUploadInProgress = backendUploadState.state === 'uploading';
    const isInRpcMode =
      engineInRpcMode || hasBackendTrace || hasUploadInProgress;

    // 获取当前 trace 的所有 sessions（只在 RPC 模式下有意义）
    const sessions = isInRpcMode ? this.getCurrentTraceSessions() : [];
    const currentIndex = sessions.findIndex(
      (s) => s.sessionId === this.state.currentSessionId,
    );

    return m(
      'div.ai-panel',
      {'data-theme': this.isDarkMode ? 'dark' : 'light'},
      [
        // Settings Modal
        this.state.showSettings
          ? m(SettingsModal, {
              settings: this.state.settings,
              workspaceContext,
              onClose: () => this.closeSettings(),
              onSave: (newSettings: AISettings) =>
                this.saveSettings(newSettings),
              onWorkspaceChange: (workspaceId: string) =>
                this.onWorkspaceSelectionChange(workspaceId),
              onCheckStatus: (url: string, key: string) =>
                this.checkServerStatus(url, key),
              initialStatus: this.serverStatus.connected
                ? this.serverStatus
                : undefined,
            })
          : null,

        // Header - compact
        m('div.ai-header', [
          m('div.ai-header-left', [
            m('i.pf-icon.ai-header-icon', 'auto_awesome'),
            m('span.ai-header-title', 'AI Assistant'),
            this.serverStatus.version
              ? m(
                  'span.ai-version-chip',
                  {
                    title: `SmartPerfetto backend version: ${this.serverStatus.version}`,
                  },
                  `v${this.serverStatus.version}`,
                )
              : null,
            m('span.ai-status-dot', {
              class: isConnected ? 'connected' : 'disconnected',
            }),
            m('span.ai-status-text', providerLabel),
            m(
              'button.ai-workspace-chip',
              {
                title: `Workspace: ${workspaceContext.workspaceId}\nTenant: ${workspaceContext.tenantId}\nUser: ${workspaceContext.userId}\nWindow: ${workspaceContext.windowId}`,
                onclick: () => this.openSettings(),
              },
              [
                m('i.pf-icon', 'workspaces'),
                m('span', workspaceContext.workspaceId),
              ],
            ),
            // SSE streaming status (visible during analysis)
            this.state.sseConnectionState !== 'disconnected'
              ? m('span.ai-status-dot', {
                  class: `sse-${this.state.sseConnectionState}`,
                  title:
                    {
                      connecting: 'Connecting to analysis stream...',
                      connected: 'Streaming analysis results',
                      reconnecting: `Reconnecting (${this.state.sseRetryCount}/${this.state.sseMaxRetries})...`,
                    }[this.state.sseConnectionState] || '',
                })
              : null,
            this.state.sseConnectionState !== 'disconnected'
              ? m(
                  'span.ai-status-text',
                  {
                    connecting: 'Connecting...',
                    connected: 'Streaming',
                    reconnecting: `Retry ${this.state.sseRetryCount}/${this.state.sseMaxRetries}`,
                  }[this.state.sseConnectionState] || '',
                )
              : null,
            // Backend trace status
            isInRpcMode
              ? m('span.ai-status-dot.backend', {
                  title: `Trace uploaded: ${this.state.backendTraceId}`,
                })
              : null,
            isInRpcMode ? m('span.ai-status-text.backend', 'RPC') : null,
            this.state.latestAnalysisSnapshot
              ? m(
                  'span.ai-status-text.snapshot',
                  {title: this.formatLatestSnapshotTitle()},
                  [
                    m('i.pf-icon', 'fact_check'),
                    this.formatLatestSnapshotLabel(),
                  ],
                )
              : null,
          ]),
          this.renderHeaderActions(isInRpcMode, hasBackendTrace),
        ]),

        // Comparison mode indicator bar
        this.state.referenceTraceId
          ? m('div.ai-comparison-bar', [
              m('div.ai-comparison-info', [
                m('span.ai-comparison-label', [
                  m(
                    'i.pf-icon',
                    {style: 'font-size: 14px; margin-right: 4px;'},
                    'compare_arrows',
                  ),
                  `对比: ${this.state.referenceTraceName || '参考 Trace'}`,
                ]),
              ]),
              m('div.ai-comparison-actions', [
                m(
                  'button.ai-comparison-switch',
                  {
                    onclick: () => this.switchComparisonTrace(),
                    title: '在新标签页中打开参考 Trace 进行视觉验证',
                  },
                  '验证',
                ),
                m(
                  'button.ai-comparison-close',
                  {
                    onclick: () => this.exitComparisonMode(),
                    title: '退出对比模式',
                  },
                  '\u00D7',
                ),
              ]),
            ])
          : null,

        // Main content area with optional right-side drawers.
        m(
          'div.ai-content-wrapper',
          {
            class:
              isInRpcMode &&
              (this.state.showTracePicker ||
                this.state.showResultPicker ||
                this.state.showSessionSidebar ||
                this.state.showStorySidebar)
                ? 'with-sidebar'
                : '',
          },
          [
            // Left: Main content area
            m('div.ai-main-content', [
              // Scene Navigation Bar (场景导航 - 自动检测 Trace 中的操作场景)
              isInRpcMode && this.trace
                ? m(SceneNavigationBar, {
                    scenes: this.state.detectedScenes,
                    trace: this.trace,
                    isLoading: this.state.scenesLoading,
                    onSceneClick: (scene, index) => {
                      if (DEBUG_AI_PANEL)
                        console.log(
                          `[AIPanel] Jumped to scene ${index}: ${scene.type}`,
                        );
                      this.analyzeScene(scene);
                    },
                    onRefresh: () => this.detectScenesQuick(),
                  })
                : null,

              // Navigation Bookmark Bar (显示AI识别的关键时间点)
              this.state.bookmarks.length > 0 && this.trace
                ? m(NavigationBookmarkBar, {
                    bookmarks: this.state.bookmarks,
                    trace: this.trace,
                    onBookmarkClick: (bookmark, index) => {
                      if (DEBUG_AI_PANEL)
                        console.log(
                          `Jumped to bookmark ${index}: ${bookmark.label}`,
                        );
                    },
                  })
                : null,

              // Backend Unavailable Dialog - full overlay only when no existing messages
              // When messages exist, an inline banner is shown inside the messages area instead
              !isInRpcMode && this.state.messages.length === 0
                ? m('div.ai-rpc-dialog', [
                    this.state.isRetryingBackend
                      ? m(
                          'div.ai-rpc-dialog-icon.uploading',
                          m('i.pf-icon', 'cloud_upload'),
                        )
                      : m(
                          'div.ai-rpc-dialog-icon',
                          m('i.pf-icon', 'cloud_off'),
                        ),
                    m(
                      'h3.ai-rpc-dialog-title',
                      this.state.isRetryingBackend
                        ? '正在连接后端...'
                        : 'AI 后端未连接',
                    ),
                    m('p.ai-rpc-dialog-desc', [
                      'Trace 已加载到 WASM 引擎，但无法连接到 AI 后端。',
                      m('br'),
                      'AI 分析功能需要后端服务支持。',
                    ]),
                    this.state.retryError
                      ? m(
                          'p.ai-rpc-dialog-desc',
                          {style: 'color: var(--chat-error);'},
                          [
                            m('i.pf-icon', 'error'),
                            ' ' + this.state.retryError,
                          ],
                        )
                      : null,
                    m('p.ai-rpc-dialog-hint', [
                      '请确保后端服务正在运行：',
                      m('br'),
                      m('code', 'cd backend && npm run dev'),
                      m('br'),
                      m('br'),
                      '然后点击下方按钮重试连接。',
                    ]),
                    this.state.isRetryingBackend
                      ? m('div.ai-upload-progress')
                      : m('div.ai-rpc-dialog-actions', [
                          m(
                            'button.ai-rpc-dialog-btn.primary',
                            {
                              onclick: () => this.retryBackendConnection(),
                            },
                            [m('i.pf-icon', 'refresh'), '重试连接'],
                          ),
                        ]),
                  ])
                : null,

              // Messages with auto-scroll - show when connected OR when messages exist
              isInRpcMode || this.state.messages.length > 0
                ? m(
                    'div.ai-messages',
                    {
                      'role': 'log',
                      'aria-live': 'polite',
                      'oncreate': (vnode) => {
                        this.messagesContainer = vnode.dom as HTMLElement;
                        this.scrollToBottom(true);
                      },
                      'onupdate': () => {
                        if (
                          this.state.messages.length !== this.lastMessageCount
                        ) {
                          this.lastMessageCount = this.state.messages.length;
                          this.scrollToBottom();
                        } else if (this.state.isLoading) {
                          // During streaming, content updates within existing messages
                          // (answer_token appending) don't change message count.
                          // Throttle to avoid forced reflow on every m.redraw().
                          this.throttledScrollToBottom();
                        }
                      },
                    },
                    (() => {
                      let reportLinkSequence = 0;
                      const sortedMessages = orderMessagesForDisplay(
                        this.state.messages,
                      );
                      // Build a map of msg.id → previous user message's model for change-badge
                      const prevUserModelMap = new Map<
                        string,
                        string | undefined
                      >();
                      let lastUserModel: string | undefined;
                      for (const msg of sortedMessages) {
                        if (msg.role === 'user') {
                          prevUserModelMap.set(msg.id, lastUserModel);
                          lastUserModel = msg.model;
                        }
                      }

                      return sortedMessages.map((msg) => {
                        // Round separator — visual divider between conversation rounds
                        if (msg.flowTag === 'round_separator') {
                          return m('div.ai-round-separator', {key: msg.id}, [
                            m('div.ai-round-separator-line'),
                            m('span.ai-round-separator-label', msg.content),
                            m('div.ai-round-separator-line'),
                          ]);
                        }

                        const reportLinkLabel = msg.reportUrl
                          ? `查看详细分析报告 #${++reportLinkSequence} (${new Date(msg.timestamp).toLocaleTimeString('zh-CN', {hour12: false})})`
                          : '';
                        const isProgressMessage =
                          msg.flowTag === 'streaming_flow' ||
                          msg.flowTag === 'progress_note';
                        const messageClass = [
                          msg.role === 'user'
                            ? 'ai-message-user'
                            : 'ai-message-assistant',
                          msg.flowTag ? `ai-message-${msg.flowTag}` : '',
                          isProgressMessage ? 'ai-message-progress' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        const bubbleClass = [
                          msg.role === 'user'
                            ? 'ai-bubble-user'
                            : 'ai-bubble-assistant',
                          isProgressMessage ? 'ai-bubble-progress' : '',
                        ]
                          .filter(Boolean)
                          .join(' ');
                        const contentClass = isProgressMessage
                          ? 'ai-message-content-progress'
                          : '';

                        return m(
                          'div.ai-message',
                          {
                            key: msg.id,
                            class: messageClass,
                          },
                          [
                            // Avatar
                            m(
                              'div.ai-avatar',
                              {
                                class:
                                  msg.role === 'user'
                                    ? 'ai-avatar-user'
                                    : 'ai-avatar-assistant',
                              },
                              msg.role === 'user'
                                ? 'U' // User initial
                                : m('i.pf-icon', 'auto_awesome'),
                            ),

                            // Message Content (wrapper so badge sits below bubble)
                            m('div.ai-bubble-wrapper', {}, [
                              m(
                                'div.ai-bubble',
                                {
                                  class: bubbleClass,
                                },
                                [
                                  msg.teachingPipeline
                                    ? this.renderTeachingPipelineView(
                                        msg.teachingPipeline,
                                        msg.teachingPinExecution,
                                      )
                                    : // Use oncreate/onupdate to directly set innerHTML, bypassing Mithril's
                                      // reconciliation for m.trust() content. This avoids removeChild errors
                                      // that occur when multiple SSE events trigger rapid redraws.
                                      m('div.ai-message-content', {
                                        class: contentClass,
                                        onclick: (e: MouseEvent) => {
                                          const selection =
                                            window.getSelection();
                                          if (
                                            selection &&
                                            !selection.isCollapsed
                                          ) {
                                            // Don't trigger click actions while user is selecting text to copy.
                                            return;
                                          }
                                          const target =
                                            e.target as HTMLElement;
                                          const copyBtn = target.closest?.(
                                            '.ai-mermaid-copy',
                                          ) as HTMLElement | null;
                                          if (copyBtn) {
                                            const b64 =
                                              copyBtn.getAttribute(
                                                'data-mermaid-b64',
                                              );
                                            if (b64) {
                                              try {
                                                const code =
                                                  decodeBase64Unicode(b64);
                                                void this.copyTextToClipboard(
                                                  code,
                                                );
                                              } catch (err) {
                                                console.warn(
                                                  '[AIPanel] Failed to copy mermaid code:',
                                                  err,
                                                );
                                              }
                                            }
                                            return;
                                          }
                                          if (
                                            target.classList.contains(
                                              'ai-clickable-timestamp',
                                            )
                                          ) {
                                            const tsNs =
                                              target.getAttribute('data-ts');
                                            if (tsNs) {
                                              const timestampNs = BigInt(tsNs);
                                              const navigation =
                                                this.jumpToTimestamp(
                                                  timestampNs,
                                                );
                                              if (!navigation.ok) {
                                                this.addMessage({
                                                  id: this.generateId(),
                                                  role: 'assistant',
                                                  content: `Failed to navigate to timestamp ${timestampNs.toString()}ns: ${navigation.error}`,
                                                  timestamp: Date.now(),
                                                });
                                              }
                                            }
                                          }
                                        },
                                        oncreate: (vnode: m.VnodeDOM) => {
                                          const dom = vnode.dom as HTMLElement;
                                          this.renderMessageContent(
                                            dom,
                                            msg,
                                            isProgressMessage,
                                          );
                                        },
                                        onupdate: (vnode: m.VnodeDOM) => {
                                          const dom = vnode.dom as HTMLElement;
                                          this.renderMessageContent(
                                            dom,
                                            msg,
                                            isProgressMessage,
                                          );
                                        },
                                      }),

                                  this.renderTableSourceContext(
                                    msg.sourceContext,
                                  ),

                                  // HTML Report Link (问题1修复)
                                  msg.reportUrl
                                    ? m('div.ai-report-link', [
                                        m('i.pf-icon', 'description'),
                                        m(
                                          'a',
                                          {
                                            href: msg.reportUrl,
                                            target: '_blank',
                                            rel: 'noopener noreferrer',
                                          },
                                          reportLinkLabel,
                                        ),
                                      ])
                                    : null,

                                  this.renderSmartScenePreviewCard(msg),
                                  this.renderSmartSelectionInlineActions(msg),

                                  // SQL Result
                                  (() => {
                                    const sqlResult = msg.sqlResult;
                                    if (!sqlResult) return null;
                                    const rawQuery =
                                      sqlResult.query || msg.query || '';
                                    const query = sqlResult.hideQuery
                                      ? ''
                                      : rawQuery;
                                    const formattedSql = query
                                      ? this.sqlFormatForMessage(msg.id, query)
                                      : null;

                                    // For skill_section messages with sectionTitle, render compact table only
                                    if (sqlResult.sectionTitle && !query) {
                                      // Auto-collapse tables marked as defaultCollapsed on first render
                                      if (
                                        sqlResult.defaultCollapsed &&
                                        !this.state.collapsedTables.has(
                                          msg.id,
                                        ) &&
                                        !this.state.collapsedTables.has(
                                          `_init_${msg.id}`,
                                        )
                                      ) {
                                        this.state.collapsedTables.add(msg.id);
                                        this.state.collapsedTables.add(
                                          `_init_${msg.id}`,
                                        ); // Mark as initialized
                                      }

                                      const isCollapsed =
                                        sqlResult.collapsible &&
                                        this.state.collapsedTables.has(msg.id);

                                      if (isCollapsed) {
                                        // Render collapsed: just a clickable title bar
                                        return m('div', [
                                          this.renderTableSourceContext(
                                            sqlResult.sourceContext,
                                          ),
                                          m(
                                            'div.ai-collapsed-table',
                                            {
                                              style: {
                                                padding: '8px 12px',
                                                background:
                                                  'var(--chat-bg-secondary)',
                                                border:
                                                  '1px solid var(--chat-border)',
                                                borderRadius: '6px',
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '8px',
                                                opacity: '0.7',
                                              },
                                              onclick: () => {
                                                this.state.collapsedTables.delete(
                                                  msg.id,
                                                );
                                                m.redraw();
                                              },
                                            },
                                            [
                                              m(
                                                'i.pf-icon',
                                                {style: {fontSize: '14px'}},
                                                'chevron_right',
                                              ),
                                              m(
                                                'span',
                                                {
                                                  style: {
                                                    fontSize: '13px',
                                                    fontWeight: '500',
                                                  },
                                                },
                                                `${sqlResult.sectionTitle} (${sqlResult.rowCount} 条)`,
                                              ),
                                            ],
                                          ),
                                        ]);
                                      }

                                      // Render expanded table with optional collapse toggle
                                      return m('div', [
                                        this.renderTableSourceContext(
                                          sqlResult.sourceContext,
                                        ),
                                        sqlResult.collapsible
                                          ? m(
                                              'div.ai-table-collapse-toggle',
                                              {
                                                style: {
                                                  padding: '4px 8px',
                                                  cursor: 'pointer',
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: '4px',
                                                  fontSize: '12px',
                                                  color:
                                                    'var(--chat-text-secondary)',
                                                },
                                                onclick: () => {
                                                  this.state.collapsedTables.add(
                                                    msg.id,
                                                  );
                                                  m.redraw();
                                                },
                                              },
                                              [
                                                m(
                                                  'i.pf-icon',
                                                  {style: {fontSize: '12px'}},
                                                  'expand_less',
                                                ),
                                                m('span', '收起'),
                                              ],
                                            )
                                          : null,
                                        m(SqlResultTable, {
                                          columns: sqlResult.columns,
                                          rows: sqlResult.maxVisibleRows
                                            ? sqlResult.rows.slice(
                                                0,
                                                sqlResult.maxVisibleRows,
                                              )
                                            : sqlResult.rows,
                                          rowCount: sqlResult.maxVisibleRows
                                            ? Math.min(
                                                sqlResult.rowCount,
                                                sqlResult.maxVisibleRows,
                                              )
                                            : sqlResult.rowCount,
                                          query: '', // No SQL display
                                          title: sqlResult.sectionTitle, // Pass title to table
                                          trace: vnode.attrs.trace,
                                          onPin: (data) => this.handlePin(data),
                                          onInteraction: (interaction) =>
                                            this.handleInteraction(interaction), // v2.0 Focus Tracking
                                          expandableData:
                                            sqlResult.expandableData,
                                          summary: sqlResult.summary,
                                          metadata: sqlResult.metadata, // Pass metadata for header display
                                        }),
                                      ]);
                                    }

                                    // Regular SQL result with outer header
                                    return m('div', [
                                      this.renderTableSourceContext(
                                        sqlResult.sourceContext,
                                      ),
                                      m('div.ai-sql-card', [
                                        m('div.ai-sql-header', [
                                          m('div.ai-sql-title', [
                                            m('i.pf-icon', 'table_chart'),
                                            m(
                                              'span',
                                              `${sqlResult.rowCount.toLocaleString()} rows`,
                                            ),
                                          ]),
                                          m('div.ai-sql-actions', [
                                            m(
                                              'button.ai-sql-action-btn',
                                              {
                                                onclick: () =>
                                                  this.copyToClipboard(
                                                    formattedSql?.text || query,
                                                  ),
                                                title:
                                                  formattedSql?.status ===
                                                  'failed'
                                                    ? 'Copy SQL (formatter unavailable)'
                                                    : 'Copy formatted SQL',
                                              },
                                              [
                                                m('i.pf-icon', 'content_copy'),
                                                m('span', 'Copy'),
                                              ],
                                            ),
                                            query
                                              ? m(
                                                  'button.ai-sql-action-btn',
                                                  {
                                                    onclick: () =>
                                                      this.handlePin({
                                                        query:
                                                          formattedSql?.text ||
                                                          query,
                                                        columns:
                                                          sqlResult.columns,
                                                        rows: sqlResult.rows.slice(
                                                          0,
                                                          100,
                                                        ),
                                                        timestamp: Date.now(),
                                                      }),
                                                    title: 'Pin result',
                                                  },
                                                  [
                                                    m('i.pf-icon', 'push_pin'),
                                                    m('span', 'Pin'),
                                                  ],
                                                )
                                              : null,
                                          ]),
                                        ]),
                                        query
                                          ? m(
                                              'div.ai-sql-query',
                                              formattedSql?.text || query.trim(),
                                            )
                                          : null,
                                        m(SqlResultTable, {
                                          columns: sqlResult.columns,
                                          rows: sqlResult.rows,
                                          rowCount: sqlResult.rowCount,
                                          query: formattedSql?.text || query,
                                          trace: vnode.attrs.trace, // 传入 trace 对象以支持时间戳跳转
                                          onPin: (data) => this.handlePin(data),
                                          onExport: (format) =>
                                            this.exportResult(sqlResult, format),
                                          onInteraction: (interaction) =>
                                            this.handleInteraction(interaction), // v2.0 Focus Tracking
                                          expandableData:
                                            sqlResult.expandableData,
                                          summary: sqlResult.summary,
                                          metadata: sqlResult.metadata, // Pass metadata for header display
                                        }),
                                      ]),
                                    ]);
                                  })(),

                                  // Chart Data Visualization
                                  msg.chartData
                                    ? m(
                                        'div.ai-chart-card',
                                        {
                                          style: {
                                            marginTop: '12px',
                                            borderRadius: '8px',
                                            border:
                                              '1px solid var(--chat-border)',
                                            overflow: 'hidden',
                                          },
                                        },
                                        [
                                          m(ChartVisualizer, {
                                            chartData: msg.chartData,
                                            width: 400,
                                            height: 280,
                                          }),
                                        ],
                                      )
                                    : null,

                                  // Metric Card Visualization
                                  msg.metricData
                                    ? m(
                                        'div.ai-metric-card',
                                        {
                                          style: {
                                            marginTop: '12px',
                                            padding: '16px 20px',
                                            borderRadius: '8px',
                                            border:
                                              '1px solid var(--chat-border)',
                                            background: 'var(--chat-bg)',
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '16px',
                                          },
                                        },
                                        (() => {
                                          const metricStyle = metricStatusStyle(
                                            msg.metricData.status,
                                          );
                                          return [
                                            m(
                                              'div',
                                              {
                                                style: {
                                                  width: '48px',
                                                  height: '48px',
                                                  borderRadius: '50%',
                                                  background: metricStyle.bg,
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  justifyContent: 'center',
                                                },
                                              },
                                              [
                                                m(
                                                  'i.pf-icon',
                                                  {
                                                    style: {
                                                      fontSize: '24px',
                                                      color: metricStyle.fg,
                                                    },
                                                  },
                                                  metricStyle.icon,
                                                ),
                                              ],
                                            ),
                                            m('div', {style: {flex: 1}}, [
                                              m(
                                                'div',
                                                {
                                                  style: {
                                                    fontSize: '12px',
                                                    color:
                                                      'var(--chat-text-secondary)',
                                                    marginBottom: '4px',
                                                  },
                                                },
                                                msg.metricData.title,
                                              ),
                                              m(
                                                'div',
                                                {
                                                  style: {
                                                    fontSize: '28px',
                                                    fontWeight: '600',
                                                    color: 'var(--chat-text)',
                                                    lineHeight: '1.2',
                                                  },
                                                },
                                                [
                                                  String(msg.metricData.value),
                                                  msg.metricData.unit
                                                    ? m(
                                                        'span',
                                                        {
                                                          style: {
                                                            fontSize: '14px',
                                                            fontWeight: '400',
                                                            color:
                                                              'var(--chat-text-secondary)',
                                                            marginLeft: '4px',
                                                          },
                                                        },
                                                        msg.metricData.unit,
                                                      )
                                                    : null,
                                                ],
                                              ),
                                              msg.metricData.delta
                                                ? m(
                                                    'div',
                                                    {
                                                      style: {
                                                        fontSize: '12px',
                                                        color:
                                                          msg.metricData.delta.startsWith(
                                                            '+',
                                                          )
                                                            ? 'var(--chat-success)'
                                                            : msg.metricData.delta.startsWith(
                                                                  '-',
                                                                )
                                                              ? 'var(--chat-error)'
                                                              : 'var(--chat-text-secondary)',
                                                        marginTop: '4px',
                                                      },
                                                    },
                                                    msg.metricData.delta,
                                                  )
                                                : null,
                                            ]),
                                          ];
                                        })(),
                                      )
                                    : null,
                                ],
                              ),

                              // Model-change badge — below bubble, inside wrapper so it stacks vertically
                              msg.role === 'user' &&
                              msg.model &&
                              msg.model !== prevUserModelMap.get(msg.id)
                                ? m(
                                    'div.ai-model-badge',
                                    {
                                      title: `Switched to: ${msg.model}`,
                                    },
                                    [
                                      m(
                                        'i.pf-icon',
                                        {
                                          style: {
                                            fontSize: '11px',
                                            verticalAlign: 'middle',
                                          },
                                        },
                                        'swap_horiz',
                                      ),
                                      m('span', ` ${msg.model}`),
                                    ],
                                  )
                                : null,
                            ]), // end ai-bubble-wrapper

                            // Message actions — available during normal input,
                            // answer streaming, and report generation.
                            !isProgressMessage &&
                            msg.content.trim().length > 0
                              ? m('div.ai-feedback-bar', [
                                  m(
                                    'button.ai-feedback-btn',
                                    {
                                      class: this.copiedMessageIds.has(msg.id)
                                        ? 'active'
                                        : '',
                                      title: this.copiedMessageIds.has(msg.id)
                                        ? '已复制'
                                        : '复制回复',
                                      onclick: () => {
                                        void this.copyMessageContent(msg);
                                      },
                                    },
                                    m(
                                      'i.pf-icon',
                                      this.copiedMessageIds.has(msg.id)
                                        ? 'check'
                                        : 'content_copy',
                                    ),
                                  ),
                                  msg.role === 'assistant' &&
                                  msg.content.length > 50
                                    ? m(
                                        'button.ai-feedback-btn',
                                        {
                                          class:
                                            (this.state as any)[
                                              `feedback_${msg.id}`
                                            ] === 'positive'
                                              ? 'active'
                                              : '',
                                          title: '有用',
                                          onclick: () => {
                                            (this.state as any)[
                                              `feedback_${msg.id}`
                                            ] = 'positive';
                                            this.submitFeedback(
                                              msg.id,
                                              'positive',
                                            );
                                          },
                                        },
                                        m('i.pf-icon', 'thumb_up'),
                                      )
                                    : null,
                                  msg.role === 'assistant' &&
                                  msg.content.length > 50
                                    ? m(
                                        'button.ai-feedback-btn',
                                        {
                                          class:
                                            (this.state as any)[
                                              `feedback_${msg.id}`
                                            ] === 'negative'
                                              ? 'active'
                                              : '',
                                          title: '不准确',
                                          onclick: () => {
                                            (this.state as any)[
                                              `feedback_${msg.id}`
                                            ] = 'negative';
                                            this.submitFeedback(
                                              msg.id,
                                              'negative',
                                            );
                                          },
                                        },
                                        m('i.pf-icon', 'thumb_down'),
                                      )
                                    : null,
                                ])
                              : null,
                          ],
                        );
                      });
                    })(),
                    // Loading Indicator with phase context
                    this.state.isLoading
                      ? m('div.ai-message.ai-message-assistant', [
                          m('div.ai-avatar.ai-avatar-assistant', [
                            m('i.pf-icon', 'auto_awesome'),
                          ]),
                          m('div.ai-bubble.ai-bubble-assistant', [
                            m('div.ai-typing-indicator', [
                              m('span.ai-typing-dot'),
                              m('span.ai-typing-dot'),
                              m('span.ai-typing-dot'),
                              this.state.loadingPhase
                                ? m(
                                    'span.ai-typing-phase',
                                    this.state.loadingPhase,
                                  )
                                : null,
                            ]),
                          ]),
                        ])
                      : null,

                    // Backend connecting indicator — animated progress during background upload
                    hasUploadInProgress &&
                      !hasBackendTrace &&
                      !this.state.isLoading
                      ? m('div.ai-connecting-indicator', [
                          m('i.pf-icon', 'cloud_upload'),
                          m('span', '正在连接 AI 后端...'),
                          m('div.ai-upload-progress'),
                        ])
                      : null,

                    // Inline disconnection banner — shown when backend drops mid-conversation
                    !isInRpcMode && this.state.messages.length > 0
                      ? m('div.ai-disconnect-banner', [
                          m('i.pf-icon', 'cloud_off'),
                          m('span', 'AI 后端连接已断开'),
                          this.state.isRetryingBackend
                            ? m('span.ai-disconnect-retrying', '重试中...')
                            : m(
                                'button.ai-disconnect-retry-btn',
                                {
                                  onclick: () => this.retryBackendConnection(),
                                },
                                '重试连接',
                              ),
                        ])
                      : null,
                  )
                : null,

              // Input Area - always show (disabled when disconnected)
              isInRpcMode || this.state.messages.length > 0
                ? m('div.ai-input-area', [
                    // Conversation context indicator
                    this.state.messages.length > 0 && this.state.agentSessionId
                      ? m(
                          'div.ai-context-indicator',
                          `第 ${this.state.messages.filter((msg) => msg.role === 'user').length} 轮对话 | 会话 ${this.state.agentSessionId.substring(0, 8)}...`,
                        )
                      : null,
                    this.renderSliceCard(),
                    this.renderAreaCard(),
                    m('div.ai-input-wrapper', [
                      m('textarea#ai-input.ai-input', {
                        'class':
                          this.state.isLoading || !isInRpcMode
                            ? 'disabled'
                            : '',
                        'aria-label': '\u8F93\u5165\u5206\u6790\u95EE\u9898',
                        'placeholder': !isInRpcMode
                          ? 'AI 后端未连接...'
                          : 'Ask anything about your trace...',
                        'value': this.state.input,
                        'oninput': (e: Event) => {
                          this.state.input = (
                            e.target as HTMLTextAreaElement
                          ).value;
                          this.state.historyIndex = -1;
                        },
                        'onkeydown': (e: KeyboardEvent) =>
                          this.handleKeyDown(e),
                        'disabled':
                          this.state.isLoading || !isInRpcMode,
                      }),
                      m('div.ai-input-controls', [
                        this.renderPresetQuestionButtons(isInRpcMode),
                        m('div.ai-input-control-spacer'),
                        this.renderAnalysisModeSelector(),
                        m(ProviderQuickSwitcher, {
                          backendUrl: this.state.settings.backendUrl,
                          apiKey:
                            this.state.settings.backendApiKey || undefined,
                          compact: true,
                          onActivate: () => this.onProviderSelectionChange(),
                        }),
                        m('div.ai-input-divider'),
                        this.state.isLoading
                          ? m(
                              'button.ai-send-btn.ai-stop-btn',
                              {
                                onclick: () => this.cancelAnalysis(),
                                title: 'Stop analysis',
                              },
                              m('i.pf-icon', 'stop_circle'),
                            )
                          : m(
                              'button.ai-send-btn',
                              {
                                'class': !isInRpcMode ? 'disabled' : '',
                                'onclick': () => this.sendMessage(),
                                'disabled': !isInRpcMode,
                                'title': 'Send (Enter)',
                                'aria-label': '\u53D1\u9001',
                              },
                              m('i.pf-icon', 'send'),
                            ),
                      ]),
                    ]),
                    m(
                      'div.ai-input-hint',
                      'Press Enter to send, Shift+Enter for new line',
                    ),
                  ])
                : null,
            ]), // End of ai-main-content

            // Right: Session History Sidebar (visible on demand in RPC mode)
            isInRpcMode && this.state.showSessionSidebar
              ? this.renderSessionSidebar(sessions, currentIndex)
              : null,
            isInRpcMode && this.state.showStorySidebar
              ? this.renderStorySidebar()
              : null,
            isInRpcMode && this.state.showTracePicker
              ? this.renderTracePicker()
              : null,
            isInRpcMode && this.state.showResultPicker
              ? this.renderResultPicker()
              : null,
          ],
        ), // End of ai-content-wrapper
      ],
    );
  }

  /** Render the preset question buttons inside the input bar controls. */
  private renderPresetQuestionButtons(isInRpcMode: boolean): m.Children {
    if (!isInRpcMode || this.state.isLoading) {
      return null;
    }

    return m('div.ai-preset-questions', [
      ...(this.state.referenceTraceId
        ? COMPARISON_PRESET_QUESTIONS
        : PRESET_QUESTIONS
      ).map((preset) =>
        m(
          `button.ai-preset-btn${preset.isTeaching ? '.ai-teaching-btn' : ''}${preset.isSmart ? '.ai-smart-btn' : ''}`,
          {
            onclick: () => this.sendPresetQuestion(preset.question),
            title: preset.isTeaching
              ? '检测当前 Trace 的渲染管线类型，自动 Pin 关键泳道'
              : preset.isSmart
                ? '自动识别混合 Trace 中的启动、滑动、点击、导航、ANR 和设备状态'
                : preset.question,
            disabled: this.state.isLoading,
          },
          [m('i.pf-icon', preset.icon), preset.label],
        ),
      ),
      this.renderSmartSelectionButtons('preset'),
      this.hasActiveSelection()
        ? m(
            'button.ai-preset-btn.ai-selection-btn',
            {
              onclick: () => this.analyzeCurrentSelection(),
              title: this.getSelectionButtonTitle(),
              disabled: this.state.isLoading,
            },
            [m('i.pf-icon', 'my_location'), '选区分析'],
          )
        : null,
    ]);
  }

  private renderSmartSelectionButtons(
    surface: 'preset' | 'story' | 'inline',
  ): m.Children {
    if (!this.hasSmartSceneSelectionReady() || this.state.isLoading) {
      return null;
    }

    const payload = this.getSmartPreviewPayload();
    const scenes = this.getSmartPreviewScenes().filter((scene) =>
      this.isSmartSceneAnalysisEligible(scene));
    const sceneTypeCounts = this.countSceneTypes(scenes);
    const buttonClass = surface === 'story'
      ? 'button.ai-story-btn-secondary'
      : surface === 'inline'
        ? 'button.ai-smart-inline-btn'
        : 'button.ai-preset-btn.ai-smart-btn';

    const buttons: m.Children[] = [
      m(
        buttonClass,
        {
          onclick: () => this.handleSmartAnalysisCommand({
            scope: 'all',
            label: '全部场景',
            ...(payload?.reportId ? {reportId: payload.reportId} : {}),
          }),
          title: `深钻全部 ${scenes.length} 个可分析场景`,
        },
        [
          m('i.pf-icon', 'select_all'),
          surface === 'preset' ? '全部' : `全部 (${scenes.length})`,
        ],
      ),
    ];

    for (const group of SMART_SCENE_SELECTION_GROUPS) {
      const count = group.sceneTypes.reduce(
        (sum, type) => sum + (sceneTypeCounts[type] || 0),
        0,
      );
      if (count === 0) continue;
      buttons.push(m(
        buttonClass,
        {
          onclick: () => this.handleSmartAnalysisCommand({
            scope: 'scene_types',
            sceneTypes: group.sceneTypes,
            label: group.label,
            ...(payload?.reportId ? {reportId: payload.reportId} : {}),
          }),
          title: `只深钻 ${group.label} 相关的 ${count} 个场景`,
        },
        [
          m('i.pf-icon', this.smartSelectionIcon(group.label)),
          surface === 'preset' ? group.label : `${group.label} (${count})`,
        ],
      ));
    }

    if (buttons.length <= 1) return buttons;
    return surface === 'story'
      ? m('div.ai-story-cold-preview-actions', buttons)
      : surface === 'inline'
        ? m('div.ai-smart-inline-button-row', buttons)
      : buttons;
  }

  private renderSmartSelectionInlineActions(msg: Message): m.Children {
    if (!this.isSmartSelectionMessage(msg)) return null;
    const actions = this.renderSmartSelectionButtons('inline');
    if (!actions) return null;
    return m('div.ai-smart-inline-actions', [
      m('div.ai-smart-inline-actions-title', [
        m('i.pf-icon', 'account_tree'),
        m('span', '选择深钻范围'),
      ]),
      actions,
    ]);
  }

  private renderSmartScenePreviewCard(msg: Message): m.Children {
    if (!this.isSmartSelectionMessage(msg)) return null;
    const payload = msg.smartScenePreview || this.getSmartPreviewPayload();
    const scenes = payload?.scenes || [];
    if (scenes.length === 0) return null;

    const eligibleCount = payload?.eligibleSceneCount ??
      scenes.filter((scene) => this.isSmartSceneAnalysisEligible(scene)).length;
    const verification = payload?.sceneVerification;
    const previewRows = scenes.slice(0, 18);

    return m('div.ai-smart-scene-preview', [
      m('div.ai-smart-scene-preview-header', [
        m('div.ai-smart-scene-preview-title', [
          m('i.pf-icon', 'account_tree'),
          m('span', '场景时间线'),
        ]),
        m('div.ai-smart-scene-preview-counts', [
          m('span', `${scenes.length} 个场景`),
          m('span', `${eligibleCount} 个可深钻`),
          verification?.status
            ? m(
                `span.ai-smart-scene-preview-status.ai-smart-scene-preview-status--${verification.status}`,
                this.formatSmartVerificationStatus(verification),
              )
            : null,
        ]),
      ]),
      verification?.summary
        ? m('div.ai-smart-scene-preview-summary', verification.summary)
        : null,
      m('div.ai-smart-scene-preview-table', [
        m('table', [
          m('thead',
            m('tr', ['#', '类型', '时间', '时长', '进程', '角色', '置信度'].map((title) =>
              m('th', title),
            )),
          ),
          m('tbody', previewRows.map((scene, index) =>
            m('tr', {
              key: scene.id || `${scene.sceneType}-${index}`,
              class: this.isSmartSceneAnalysisEligible(scene)
                ? 'ai-smart-scene-row--eligible'
                : 'ai-smart-scene-row--context',
            }, [
              m('td.col-index', `${index + 1}`),
              m('td.col-type', [
                m('span.ai-smart-scene-dot', {
                  class: `ai-smart-scene-dot--${scene.severity || 'unknown'}`,
                }),
                SCENE_DISPLAY_NAMES[scene.sceneType] ?? scene.sceneType,
              ]),
              m('td.col-range', this.formatSmartSceneRange(scene)),
              m('td.col-duration', this.formatSmartSceneDuration(scene.durationMs)),
              m('td.col-process', scene.processName || '-'),
              m('td.col-role', this.smartSceneRoleLabel(scene)),
              m('td.col-confidence', this.formatSmartSceneConfidence(scene)),
            ]),
          )),
        ]),
      ]),
      scenes.length > previewRows.length
        ? m('div.ai-smart-scene-preview-more', `另有 ${scenes.length - previewRows.length} 个场景在 Story 面板中展示。`)
        : null,
    ]);
  }

  private isSmartSelectionMessage(msg: Message): boolean {
    return msg.role === 'assistant' && (
      !!msg.smartScenePreview ||
      msg.content.includes('# 智能分析报告：场景盘点') &&
      msg.content.includes('## 下一步')
    );
  }

  private hasSmartSceneSelectionReady(): boolean {
    return this.state.storyState.status === 'selection_ready' &&
      this.getSmartPreviewScenes().some((scene) => this.isSmartSceneAnalysisEligible(scene));
  }

  private getSmartPreviewPayload(): SmartScenePreviewPayload | undefined {
    for (let i = this.state.messages.length - 1; i >= 0; i--) {
      const payload = this.state.messages[i].smartScenePreview;
      if (payload && Array.isArray(payload.scenes)) return payload;
    }
    const report = this.state.storyState.cachedReport;
    const scenes = Array.isArray(report?.displayedScenes) ? report.displayedScenes : [];
    if (scenes.length === 0) return undefined;
    return {
      reportId: typeof report?.reportId === 'string' ? report.reportId : undefined,
      scenes,
      sceneVerification: report?.sceneVerification,
      eligibleSceneCount: scenes.filter((scene: any) =>
        this.isSmartSceneAnalysisEligible(scene)).length,
      sceneTypeCounts: this.countSceneTypes(scenes),
    };
  }

  private getSmartPreviewScenes(): SmartDisplayedScene[] {
    return this.getSmartPreviewPayload()?.scenes || [];
  }

  private isSmartSceneAnalysisEligible(scene: SmartDisplayedScene | any): boolean {
    return scene?.analysisEligible !== false &&
      scene?.sceneRole !== 'marker' &&
      scene?.sceneRole !== 'context';
  }

  private formatSmartVerificationStatus(
    verification: SmartSceneVerificationPayload,
  ): string {
    switch (verification.status) {
      case 'passed': return '复核通过';
      case 'needs_review': return '需复核';
      case 'failed': return '复核失败';
      case 'skipped': return '已跳过复核';
      default: return verification.status || '未复核';
    }
  }

  private formatSmartSceneRange(scene: SmartDisplayedScene): string {
    return `${this.formatSmartSceneNs(scene.startTs)} - ${this.formatSmartSceneNs(scene.endTs)}`;
  }

  private formatSmartSceneNs(value: string | undefined): string {
    if (!value) return '-';
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return value;
    return `${(parsed / 1_000_000_000).toFixed(3)}s`;
  }

  private formatSmartSceneDuration(value: number | undefined): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
    if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
    return `${Math.round(value)}ms`;
  }

  private formatSmartSceneConfidence(scene: SmartDisplayedScene): string {
    if (typeof scene.confidenceScore === 'number' && Number.isFinite(scene.confidenceScore)) {
      return `${Math.round(scene.confidenceScore * 100)}%`;
    }
    return scene.confidenceLevel || '-';
  }

  private smartSceneRoleLabel(scene: SmartDisplayedScene): string {
    if (scene.sceneRole === 'marker') return '标记';
    if (scene.sceneRole === 'context') return '上下文';
    return scene.analysisEligible === false ? '上下文' : '动作';
  }

  private countSceneTypes(scenes: any[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const scene of scenes) {
      const type = typeof scene?.sceneType === 'string' ? scene.sceneType : '';
      if (!type) continue;
      counts[type] = (counts[type] || 0) + 1;
    }
    return counts;
  }

  private smartSelectionIcon(label: string): string {
    switch (label) {
      case '启动': return 'rocket_launch';
      case '滑动': return 'swipe';
      case '点击': return 'touch_app';
      case '导航': return 'navigation';
      case '设备': return 'power_settings_new';
      case 'ANR': return 'warning';
      default: return 'filter_alt';
    }
  }

  /** Render the analysis mode selector inside the input bar.
   *  Disables 'fast' when comparison mode is active because the lightweight
   *  MCP registration skips comparison tools. Selection context is supported
   *  by the quick prompt and should remain fast by default. */
  private renderAnalysisModeSelector(): m.Vnode {
    const current = this.state.analysisMode;
    const fastDisabled = !!this.state.referenceTraceId;
    const modes = [
      {
        id: 'fast',
        icon: '⚡',
        label: '快速',
        title: '5 轮内精简答复，适合简单事实查询',
      },
      {
        id: 'full',
        icon: '🔍',
        label: '完整',
        title: '完整多轮分析流水线',
      },
      {
        id: 'auto',
        icon: '🤖',
        label: '智能',
        title: '按查询复杂度自动选择',
      },
    ] as const;
    const currentMode = modes.find((mode) => mode.id === current) ?? modes[2];
    return m(
      'div.ai-mode-selector',
      [
        m(
          'button.ai-mode-trigger',
          {
            title: '选择分析模式',
            onclick: (e: MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              this.state.showAnalysisModeMenu =
                !this.state.showAnalysisModeMenu;
            },
          },
          [
            m('span.ai-mode-trigger-icon', currentMode.icon),
            m('span', currentMode.label),
            m('i.pf-icon', 'keyboard_arrow_down'),
          ],
        ),
        this.state.showAnalysisModeMenu
          ? m(
              'div.ai-mode-menu',
              modes.map((mode) => {
                const disabled = mode.id === 'fast' && fastDisabled;
                const active = current === mode.id;
                return m(
                  'button.ai-mode-menu-item',
                  {
                    class: [
                      active ? 'active' : '',
                      disabled ? 'disabled' : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                    title: disabled
                      ? '对比模式下需完整分析才能利用参考 Trace 上下文'
                      : mode.title,
                    disabled,
                    onclick: (e: MouseEvent) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!disabled) {
                        this.state.showAnalysisModeMenu = false;
                        this.onAnalysisModeChange(mode.id);
                      }
                    },
                  },
                  [
                    m('span.ai-mode-menu-icon', mode.icon),
                    m('span.ai-mode-menu-label', mode.label),
                    active ? m('i.pf-icon', 'check') : null,
                  ],
                );
              }),
            )
          : null,
      ],
    );
  }

  /** Switch analysis mode. Changing mode mid-session clears agentSessionId so the backend
   *  starts a fresh SDK session — avoids context mix between the 5-turn quick path and
   *  30-turn full pipeline (see plan §3, "SDK resume strategy"). */
  private onAnalysisModeChange(newMode: 'fast' | 'full' | 'auto'): void {
    if (newMode === this.state.analysisMode) return;
    const hadSession = !!this.state.agentSessionId;
    this.state.analysisMode = newMode;
    sessionManager.saveAnalysisMode(newMode);
    if (hadSession) {
      this.state.agentSessionId = null;
      this.clearAgentObservability();
      const label = {fast: '快速', full: '完整', auto: '智能'}[newMode];
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `已切换到「${label}」模式，将开始新会话。`,
        timestamp: Date.now(),
      });
    }
    m.redraw();
  }

  private onProviderSelectionChange(): void {
    const hadSession = !!this.state.agentSessionId;
    if (hadSession) {
      this.state.agentSessionId = null;
      this.state.agentRunId = null;
      this.clearAgentObservability();
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '已切换 AI Provider / SDK Runtime，将开始新会话。',
        timestamp: Date.now(),
      });
    }
    this.refreshServerStatus();
    m.redraw();
  }

  private onWorkspaceSelectionChange(workspaceId: string): void {
    const previousContext = getSmartPerfettoRequestContext();
    const nextWorkspaceId = setSmartPerfettoWorkspaceId(
      workspaceId,
      previousContext.tenantId,
      previousContext.userId,
    );
    if (nextWorkspaceId === previousContext.workspaceId) return;

    this.cancelSSEConnection();
    this.availableTraces = [];
    this.state.showTracePicker = false;
    this.state.referenceTraceId = null;
    this.state.referenceTraceName = null;
    this.state.isReferenceActive = false;
    this.state.comparisonTraceLoading = false;
    clearComparisonState();
    this.state.analysisMode = sessionManager.loadAnalysisMode();

    this.resetStateForNewTrace();
    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: `已切换到 Workspace: ${nextWorkspaceId}。当前窗口的 Trace、AI 会话和临时运行状态已按新 Workspace 隔离。`,
      timestamp: Date.now(),
    });
    this.saveCurrentSession();
    this.refreshServerStatus();
    m.redraw();
  }

  private submitFeedback(
    _messageId: string,
    rating: 'positive' | 'negative',
  ): void {
    if (!this.state.agentSessionId || !this.state.settings.backendUrl) return;
    const url = buildAssistantApiV1Url(
      this.state.settings.backendUrl,
      `/${this.state.agentSessionId}/feedback`,
    );
    const turnIndex = this.state.messages.filter(
      (msg) => msg.role === 'user',
    ).length;
    this.fetchBackend(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({rating, turnIndex}),
    }).catch(() => {
      /* non-blocking */
    });
    m.redraw();
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore
    }
  }

  private sqlFormatForMessage(messageId: string, rawSql: string): CachedSqlFormat {
    const raw = rawSql.trim();
    if (!raw) {
      return {raw, text: '', status: 'formatted'};
    }

    const cached = this.formattedSqlCache.get(messageId);
    if (cached && cached.raw === raw) return cached;

    const pending: CachedSqlFormat = {raw, text: raw, status: 'pending'};
    this.formattedSqlCache.set(messageId, pending);
    formatPerfettoSql(raw).then((result) => {
      const current = this.formattedSqlCache.get(messageId);
      if (!current || current.raw !== raw) return;
      this.formattedSqlCache.set(messageId, {
        raw,
        text: result.text || raw,
        status: result.ok ? 'formatted' : 'failed',
        error: result.error,
      });
      m.redraw();
    });
    return pending;
  }

  private saveSettings(newSettings: AISettings) {
    this.state.settings = newSettings;
    sessionManager.saveSettings(newSettings);
    this.initBackendStatus();
    m.redraw();
  }

  private loadSettings() {
    this.state.settings = sessionManager.loadSettings();
  }

  private buildBackendHeaders(headers?: HeadersInit): Record<string, string> {
    const normalized = buildSmartPerfettoContextHeaders(headers);
    const apiKey = (this.state.settings.backendApiKey || '').trim();
    if (!apiKey) return normalized;
    const authorization = Object.entries(normalized).find(
      ([key]) => key.toLowerCase() === 'authorization',
    )?.[1];
    const apiKeyHeader = Object.entries(normalized).find(
      ([key]) => key.toLowerCase() === 'x-api-key',
    )?.[1];

    return {
      ...normalized,
      'x-api-key': apiKeyHeader || apiKey,
      'Authorization': authorization || `Bearer ${apiKey}`,
    };
  }

  private clearAgentObservability(): void {
    this.state.agentRunId = null;
    this.state.agentRequestId = null;
    this.state.agentRunSequence = 0;
  }

  private applyAgentObservability(payload: any): boolean {
    const candidates: any[] = [];
    if (payload && typeof payload === 'object') {
      candidates.push(payload);
      if (payload.observability && typeof payload.observability === 'object') {
        candidates.push(payload.observability);
      }
      if (payload.data && typeof payload.data === 'object') {
        candidates.push(payload.data);
        if (
          payload.data.observability &&
          typeof payload.data.observability === 'object'
        ) {
          candidates.push(payload.data.observability);
        }
      }
    }

    let changed = false;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;

      const runId =
        typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
      if (runId && runId !== this.state.agentRunId) {
        this.state.agentRunId = runId;
        changed = true;
      }

      const requestId =
        typeof candidate.requestId === 'string'
          ? candidate.requestId.trim()
          : '';
      if (requestId && requestId !== this.state.agentRequestId) {
        this.state.agentRequestId = requestId;
        changed = true;
      }

      if (
        typeof candidate.runSequence === 'number' &&
        Number.isFinite(candidate.runSequence)
      ) {
        const runSequence = Math.max(0, Math.floor(candidate.runSequence));
        if (runSequence !== this.state.agentRunSequence) {
          this.state.agentRunSequence = runSequence;
          changed = true;
        }
      }
    }

    return changed;
  }

  private fetchBackend(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: this.buildBackendHeaders(init.headers),
    });
  }

  private isSseStatusMessage(message: Message | undefined): boolean {
    if (!message || message.role !== 'assistant') return false;
    return (
      message.content.startsWith('🔄') ||
      message.content.startsWith('连接中断') ||
      message.content.startsWith('正在恢复会话') ||
      message.content.startsWith('后端已重启') ||
      message.content.startsWith('后端连接') ||
      message.content.startsWith('**Connection Error:**')
    );
  }

  private upsertSseStatusMessage(content: string): void {
    const lastMsg = this.state.messages[this.state.messages.length - 1];
    if (this.isSseStatusMessage(lastMsg)) {
      lastMsg!.content = content;
      this.saveHistory();
      this.saveCurrentSession();
      this.scrollToBottom(true);
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * 从旧的 HISTORY_KEY 迁移数据到新的 Session 格式
   * 仅在首次加载时调用，用于向后兼容
   * Delegates to sessionManager for the actual migration
   */
  private migrateOldHistoryToSession(): boolean {
    const fingerprint = this.state.currentTraceFingerprint || 'unknown';
    const traceName = this.trace?.traceInfo?.traceTitle || 'Migrated Trace';
    return sessionManager.migrateOldHistoryToSession(fingerprint, traceName);
  }

  private addWelcomeMessage() {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: this.getWelcomeMessage(),
      timestamp: Date.now(),
    });
  }

  private async verifyBackendTrace() {
    if (!this.state.backendTraceId) return;

    try {
      const response = await this.fetchBackend(
        buildSmartPerfettoWorkspaceApiUrl(
          this.state.settings.backendUrl,
          'traces',
          `/${this.state.backendTraceId}`,
        ),
      );
      if (!response.ok) {
        if (DEBUG_AI_PANEL)
          console.log(
            `[AIPanel] Backend trace ${this.state.backendTraceId} no longer valid, clearing`,
          );
        this.state.backendTraceId = null;
        this.saveHistory();
        m.redraw();
      }
    } catch (error) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Failed to verify backend trace, clearing:',
          error,
        );
      this.state.backendTraceId = null;
      this.saveHistory();
      m.redraw();
    }
  }

  private saveHistory() {
    sessionManager.saveHistory(
      this.state.messages,
      this.state.backendTraceId,
      this.state.currentTraceFingerprint,
    );
  }

  // loadPinnedResults 已移至 Session 中管理

  private savePinnedResults() {
    sessionManager.savePinnedResults(this.state.pinnedResults);
  }

  // ============ Session 管理方法 ============
  // Storage operations delegated to sessionManager module

  /**
   * 获取指定 Trace 的所有 Sessions
   */
  getSessionsForTrace(fingerprint: string): AISession[] {
    return sessionManager.getSessionsForTrace(fingerprint);
  }

  /**
   * 获取当前 Trace 的所有 Sessions
   */
  getCurrentTraceSessions(): AISession[] {
    if (!this.state.currentTraceFingerprint) return [];
    return this.getSessionsForTrace(this.state.currentTraceFingerprint);
  }

  /**
   * 创建新 Session
   */
  private createNewSession(): AISession {
    const fingerprint = this.state.currentTraceFingerprint || 'unknown';
    const traceName = this.trace?.traceInfo?.traceTitle || 'Untitled Trace';

    const session = sessionManager.createSession(fingerprint, traceName);

    // 更新当前 session ID
    this.state.currentSessionId = session.sessionId;

    return session;
  }

  /**
   * 保存当前 Session
   */
  saveCurrentSession(): void {
    if (!this.state.currentSessionId || !this.state.currentTraceFingerprint) {
      return;
    }

    sessionManager.updateSession(
      this.state.currentTraceFingerprint,
      this.state.currentSessionId,
      {
        messages: this.state.messages,
        pinnedResults: this.state.pinnedResults,
        bookmarks: this.state.bookmarks,
        backendTraceId: this.state.backendTraceId || undefined,
        agentSessionId: this.state.agentSessionId || undefined,
        agentRunId: this.state.agentRunId || undefined,
        agentRequestId: this.state.agentRequestId || undefined,
        agentRunSequence: this.state.agentRunSequence || undefined,
        latestAnalysisSnapshot: this.state.latestAnalysisSnapshot || undefined,
      },
    );
  }

  /**
   * Schedule a debounced session save (500ms trailing).
   * Coalesces rapid addMessage() calls during streaming.
   */
  private debouncedSaveSession(): void {
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
    }
    this.saveSessionTimer = setTimeout(() => {
      this.saveSessionTimer = null;
      this.saveCurrentSession();
    }, 500);
  }

  /**
   * Immediately flush any pending debounced session save.
   */
  private flushSessionSave(): void {
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
      this.saveSessionTimer = null;
      this.saveCurrentSession();
    }
  }

  /**
   * 加载指定 Session
   */
  loadSession(sessionId: string): boolean {
    const session = sessionManager.loadSession(sessionId);
    if (!session) return false;

    this.cancelSSEConnection();

    this.state.currentSessionId = session.sessionId;
    this.state.currentTraceFingerprint = session.traceFingerprint;
    this.state.messages = session.messages;
    this.rebuildDataSourceRefsFromMessages();
    this.state.pinnedResults = session.pinnedResults || [];
    this.state.bookmarks = session.bookmarks || [];
    this.state.agentSessionId = session.agentSessionId || null;
    this.state.agentRunId = session.agentRunId || null;
    this.state.agentRequestId = session.agentRequestId || null;
    this.state.agentRunSequence = Number.isFinite(session.agentRunSequence)
      ? Math.max(0, Math.floor(session.agentRunSequence as number))
      : 0;
    this.state.latestAnalysisSnapshot = session.latestAnalysisSnapshot || null;

    // Only restore backendTraceId if we're currently in RPC mode
    // If not in RPC mode, the old backendTraceId is stale and invalid
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    if (engineInRpcMode && session.backendTraceId) {
      this.state.backendTraceId = session.backendTraceId;
      // 验证 backend trace 是否仍然有效
      this.verifyBackendTrace();
    } else {
      // Not in RPC mode or no backendTraceId - clear it
      this.state.backendTraceId = null;
    }

    // If the session's backendTraceId differs from current, agentSessionId belongs to a
    // different trace — clear it to prevent traceId mismatch errors on the next request.
    if (
      session.backendTraceId &&
      this.state.backendTraceId !== session.backendTraceId
    ) {
      this.state.agentSessionId = null;
    }

    // 恢复命令历史
    this.state.commandHistory = this.state.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content);

    if (DEBUG_AI_PANEL)
      console.log('[AIPanel] Loaded session:', sessionId, {
        engineInRpcMode,
        backendTraceId: this.state.backendTraceId,
      });
    m.redraw();
    return true;
  }

  /**
   * 获取当前 Session
   */
  getCurrentSession(): AISession | null {
    if (!this.state.currentSessionId || !this.state.currentTraceFingerprint) {
      return null;
    }

    const sessions = this.getSessionsForTrace(
      this.state.currentTraceFingerprint,
    );
    return (
      sessions.find((s) => s.sessionId === this.state.currentSessionId) || null
    );
  }

  /**
   * 删除指定 Session
   */
  deleteSession(sessionId: string): boolean {
    const deleted = sessionManager.deleteSession(sessionId);
    if (deleted) {
      // 如果删除的是当前 session，重置状态
      if (sessionId === this.state.currentSessionId) {
        this.state.currentSessionId = null;
        this.resetStateForNewTrace();
      }
      // IMPORTANT: Trigger UI update after session deletion
      // This is needed because confirm() dialog breaks Mithril's auto-redraw
      m.redraw();
    }
    return deleted;
  }

  // ============ Session 管理方法结束 ============

  private handlePin(data: {
    query: string;
    columns: string[];
    rows: any[][];
    timestamp: number;
  }) {
    const pinnedResult: PinnedResult = {
      id: this.generateId(),
      query: data.query,
      columns: data.columns,
      rows: data.rows,
      timestamp: data.timestamp,
    };

    // Add to pinned results (keep max 20)
    this.state.pinnedResults = [
      pinnedResult,
      ...this.state.pinnedResults,
    ].slice(0, 20);
    this.savePinnedResults();

    // Show notification
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `📌 **Result Pinned!**\n\nYour query result has been saved. Use \`/pins\` to view all pinned results.`,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle user interaction from SqlResultTable (Agent-Driven Architecture v2.0).
   *
   * This sends the interaction to the backend FocusStore for tracking user focus
   * across conversation turns, enabling incremental analysis.
   */
  private handleInteraction(interaction: UserInteraction): void {
    const sessionId = this.state.agentSessionId;
    const backendUrl = this.state.settings.backendUrl;

    // Only send if we have an active session
    if (!sessionId) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] No active session, skipping interaction capture',
        );
      return;
    }

    // Fire and forget - don't block UI for interaction tracking
    this.fetchBackend(
      buildAssistantApiV1Url(backendUrl, `/${sessionId}/interaction`),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: interaction.type,
          target: interaction.target,
          source: interaction.source,
          timestamp: interaction.timestamp,
          context: interaction.context,
        }),
      },
    )
      .then((response) => {
        if (!response.ok) {
          console.warn(
            '[AIPanel] Failed to send interaction:',
            response.status,
          );
        } else {
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Interaction captured:',
              interaction.type,
              interaction.target,
            );
        }
      })
      .catch((error) => {
        console.warn('[AIPanel] Error sending interaction:', error);
      });
  }

  private initBackendStatus() {
    // Refresh server status on init (non-blocking)
    this.refreshServerStatus();
  }

  /** Server status cache — shared by header, settings modal, and welcome message. */
  private serverStatus: ServerStatus = {connected: false};

  /**
   * Check backend server status by calling /health with optional auth headers.
   * Used by SettingsModal to test with potentially unsaved URL/key values.
   */
  private async checkServerStatus(
    backendUrl: string,
    apiKey: string,
  ): Promise<ServerStatus> {
    try {
      const headers: Record<string, string> = {};
      const trimmedKey = (apiKey || '').trim();
      if (trimmedKey) {
        headers['x-api-key'] = trimmedKey;
        headers['Authorization'] = `Bearer ${trimmedKey}`;
      }
      const response = await fetch(
        `${backendUrl.replace(/\/+$/, '')}/health`,
        {headers: buildSmartPerfettoContextHeaders(headers)},
      );
      if (!response.ok) return {connected: false};
      const data = await response.json();
      const aiEngine = data.aiEngine || {};
      return {
        connected: true,
        version: typeof data.version === 'string' ? data.version : undefined,
        runtime: aiEngine.runtime,
        model: aiEngine.model,
        providerMode: aiEngine.providerMode,
        configured: aiEngine.configured,
        environment: data.environment,
        source: aiEngine.source,
        credentialSource: aiEngine.credentialSource,
        envCredentialSources: Array.isArray(aiEngine.envCredentialSources)
          ? aiEngine.envCredentialSources
          : [],
        providerOverridesEnv: aiEngine.providerOverridesEnv,
        activeProvider: aiEngine.activeProvider,
        authRequired: aiEngine.authRequired,
        diagnostics: aiEngine.diagnostics,
      };
    } catch {
      return {connected: false};
    }
  }

  /**
   * Refresh the cached server status using current saved settings.
   * Non-blocking — called on init and after settings save.
   */
  private refreshServerStatus(): void {
    const {backendUrl, backendApiKey} = this.state.settings;
    this.checkServerStatus(backendUrl, backendApiKey || '').then((status) => {
      this.serverStatus = status;
      m.redraw();
    });
  }

  private getWelcomeMessage(): string {
    return `**Welcome to AI Assistant!** 🤖

I can help you analyze Perfetto traces. Here are some things you can ask:

* "What are the main threads in this trace?"
* "Find all ANRs (Application Not Responding)"
* "Show me the janky frames"
* "Why is my app slow?"

**Commands:**
* \`/sql <query>\` - Execute a SQL query
* \`/goto <timestamp>\` - Jump to a timestamp
* \`/analyze\` - Analyze current selection
* \`/anr\` - Find ANRs
* \`/jank\` - Find janky frames
* \`/slow\` - Analyze slow operations (backend)
* \`/memory\` - Analyze memory usage (backend)
* \`/pins\` - View pinned query results
* \`/clear\` - Clear chat history
* \`/help\` - Show this help

**Backend:** ${this.state.settings.backendUrl}

Click ⚙️ to configure backend connection.`;
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.navigateHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.navigateHistory(1);
    }
  }

  private navigateHistory(direction: number) {
    const history = this.state.commandHistory;
    if (history.length === 0) return;

    if (this.state.historyIndex === -1 && direction === -1) {
      this.state.historyIndex = history.length - 1;
    } else {
      this.state.historyIndex = Math.max(
        -1,
        Math.min(history.length, this.state.historyIndex + direction),
      );
    }

    if (this.state.historyIndex >= 0) {
      this.state.input = history[this.state.historyIndex];
    } else {
      this.state.input = '';
    }
  }

  private async sendMessage() {
    const input = this.state.input.trim();
    if (DEBUG_AI_PANEL)
      console.log(
        '[AIPanel] sendMessage called, input:',
        input,
        'isLoading:',
        this.state.isLoading,
      );

    if (!input || this.state.isLoading) return;

    // Clear skill progress tracking and errors for new analysis session
    this.state.displayedSkillProgress.clear();
    this.state.collectedErrors = [];

    // Add round separator when this is a follow-up round (prior analysis results exist).
    // P2-1: Exclude welcome/system-generated assistant messages — only count as
    // prior results when there has been at least one user message (i.e., an analysis
    // round actually ran, not just a welcome message).
    const hasUserMessages = this.state.messages.some(
      (msg) => msg.role === 'user',
    );
    const hasPriorResults =
      hasUserMessages &&
      this.state.messages.some(
        (msg) => msg.role === 'assistant' && msg.flowTag !== 'round_separator',
      );
    if (hasPriorResults) {
      const roundNumber =
        this.state.messages.filter((m) => m.role === 'user').length + 1;
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `Round #${roundNumber}`,
        timestamp: Date.now(),
        flowTag: 'round_separator',
      });
    }

    // Add user message — stamp current model for change-detection badge
    this.addMessage({
      id: this.generateId(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
      model: this.serverStatus.model,
    });

    this.state.input = '';
    this.state.commandHistory.push(input);
    this.state.historyIndex = -1;

    // Check if it's a command
    if (input.startsWith('/')) {
      await this.handleCommand(input);
    } else {
      if (await this.tryStartNaturalLanguageResultComparison(input)) {
        return;
      }
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Calling handleChatMessage with:', input);
      await this.handleChatMessage(input);
      if (DEBUG_AI_PANEL) console.log('[AIPanel] handleChatMessage completed');
    }
  }

  private resetStreamingFlow() {
    this.state.streamingFlow = createStreamingFlowState();
  }

  private dataSourceKindOrdinalsFromRefs(refs: DataSourceContext[]): Record<string, number> {
    const ordinals: Record<string, number> = {};
    for (const ref of refs) {
      const kind = ref.kind || 'table';
      const ordinal = Number(ref.ref.match(/(\d+)$/)?.[1]);
      if (Number.isFinite(ordinal)) {
        ordinals[kind] = Math.max(ordinals[kind] || 0, ordinal);
      }
    }
    return ordinals;
  }

  private rebuildDataSourceRefsFromMessages() {
    const refs: DataSourceContext[] = [];
    const seen = new Set<string>();
    let maxOrdinal = 0;

    for (const msg of this.state.messages) {
      const context = msg.sqlResult?.sourceContext || msg.sourceContext;
      if (!context?.ref) continue;
      const key = [
        context.ref,
        context.evidenceRefId || '',
        context.sourceToolCallId || '',
        context.title,
      ].join('\0');
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({...context});
      const ordinal = Number(context.ref.match(/(\d+)$/)?.[1]);
      if (Number.isFinite(ordinal)) {
        maxOrdinal = Math.max(maxOrdinal, ordinal);
      }
    }

    this.state.streamingFlow = {
      ...createStreamingFlowState(),
      dataSourceRefs: refs,
      dataSourceOrdinal: Math.max(maxOrdinal, refs.length),
      dataSourceKindOrdinals: this.dataSourceKindOrdinalsFromRefs(refs),
    };
  }

  private resetStreamingAnswer() {
    this.state.streamingAnswer = createStreamingAnswerState();
  }

  /**
   * Send a preset question - triggered by quick action buttons
   */
  private sendPresetQuestion(question: string) {
    if (this.state.isLoading) return;
    this.state.input = question;
    this.sendMessage();
  }

  private async tryStartNaturalLanguageResultComparison(
    message: string,
  ): Promise<boolean> {
    if (this.state.referenceTraceId) return false;
    if (!isAnalysisResultComparisonRequest(message)) return false;

    await this.postWindowHeartbeat();
    await this.fetchAnalysisResults({silent: true});

    if (this.state.resultPickerError) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `加载分析结果失败，无法创建结果对比: ${this.state.resultPickerError}`,
        timestamp: Date.now(),
      });
      return true;
    }

    const context = getSmartPerfettoRequestContext();
    const currentSnapshotId = this.resolveCurrentAnalysisResultSnapshotId();
    const resolved = resolveAnalysisResultComparisonRequest({
      query: message,
      results: this.availableAnalysisResults,
      currentSnapshotId,
      activeWindowStates: this.activeResultWindowStates,
      currentWindowId: context.windowId,
    });
    if (resolved.kind === 'not_comparison') {
      return false;
    }

    if (resolved.kind === 'resolved') {
      const baseline = this.availableAnalysisResults.find(
        (item) => item.id === resolved.resolution.baselineId,
      );
      const candidates = this.availableAnalysisResults.filter((item) =>
        resolved.resolution.candidateIds.includes(item.id),
      );
      if (baseline && candidates.length > 0) {
        await this.createAnalysisResultComparison({
          baseline,
          candidates,
          query: message,
          closePicker: true,
        });
        return true;
      }
    }

    const selection =
      resolved.kind === 'needs_selection'
        ? resolved.selection
        : {
            baselineId: currentSnapshotId,
            candidateIds: [] as string[],
            reason: 'no_candidate' as const,
          };
    this.state.selectedResultBaselineId =
      selection.baselineId ?? currentSnapshotId ?? null;
    this.state.selectedResultCandidateIds = new Set(selection.candidateIds);
    this.state.showResultPicker = true;
    this.state.resultComparisonError = null;
    this.syncResultPickerSelection();
    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: [
        '这条请求需要选择要对比的分析结果。',
        '我已经打开“分析结果对比”面板，并优先选中当前窗口结果。',
        '每份结果标题旁都有 Result ID（如 AR-1234abcd），之后可以直接说“对比 AR-1234abcd”。',
      ].join('\n'),
      timestamp: Date.now(),
    });
    m.redraw();
    return true;
  }

  /** Check if the user has an active Perfetto selection (area or slice). */
  private hasActiveSelection(): boolean {
    if (!this.trace) return false;
    const kind = this.trace.selection.selection.kind;
    return kind === 'area' || kind === 'track_event';
  }

  /** Build a descriptive tooltip for the selection analysis button. */
  private getSelectionButtonTitle(): string {
    if (!this.trace) return '分析当前选区';
    const sel = this.trace.selection.selection;
    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      if (timeSpan) {
        const durMs = (Number(timeSpan.duration) / 1e6).toFixed(1);
        return `分析选中区间 (${durMs}ms, ${sel.trackUris.length} tracks)`;
      }
      return `分析选中区间 (${sel.trackUris.length} tracks)`;
    }
    if (sel.kind === 'track_event') {
      return '分析选中的 Slice';
    }
    return '分析当前选区';
  }

  /**
   * One-click analysis of the current Perfetto selection.
   * Builds a smart query and sends it through the normal agent flow.
   * The selectionContext is auto-injected by handleChatMessage().
   */
  private buildCurrentSelectionAnalysisQuery(): string | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;

    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      const durMs = timeSpan
        ? (Number(timeSpan.duration) / 1e6).toFixed(1)
        : '?';
      return `分析当前时间/轨道选区的性能（${durMs}ms），包括关键线程的 CPU 调度、大小核分布和频率、主要耗时 Slice 诊断`;
    }
    if (sel.kind === 'track_event') {
      return '快速分析用户选中的这个 Slice：它是什么、关键时间、子调用耗时概况，以及是否明显异常';
    }
    return null;
  }

  private async analyzeCurrentSelection() {
    if (this.state.isLoading || !this.trace) return;
    const query = this.buildCurrentSelectionAnalysisQuery();
    if (!query) return;

    this.state.input = query;
    const datasets = await this.querySelectionData();
    this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
    this.sendMessage();
  }

  /**
   * Analyze a detected scene - triggered by clicking a scene chip in the navigation bar.
   * Builds a context-rich query from the scene metadata and sends it for analysis.
   */
  private analyzeScene(scene: import('./scene_navigation_bar').DetectedScene) {
    if (this.state.isLoading) return;
    const typeNames: Record<string, string> = {
      cold_start: '冷启动',
      warm_start: '温启动',
      hot_start: '热启动',
      scroll: '滑动',
      inertial_scroll: '惯性滑动',
      scroll_start: '滑动',
      app_switch: '应用切换',
      home_screen: '桌面',
      app_foreground: '应用内',
      navigation: '页面跳转',
      tap: '点击响应',
      long_press: '长按响应',
      screen_on: '亮屏',
      screen_unlock: '解锁',
      back_key: '返回键',
      home_key: 'Home键',
      recents_key: '最近任务键',
      anr: 'ANR',
      ime_show: '键盘弹出',
      ime_hide: '键盘收起',
      window_transition: '窗口转场',
    };
    const typeName = typeNames[scene.type] || scene.type;
    const appHint = scene.appPackage ? ` (${scene.appPackage})` : '';
    const durHint =
      scene.durationMs > 0 ? `，耗时 ${scene.durationMs.toFixed(0)}ms` : '';
    const query = `分析${typeName}性能${appHint}${durHint}`;
    this.state.input = query;
    this.sendMessage();
  }

  private addMessage(msg: Message) {
    this.state.messages.push(msg);
    this.saveHistory();
    // Debounced session save — coalesces rapid streaming messages
    this.debouncedSaveSession();
    this.scrollToBottom(true);
  }

  /**
   * Create the context object for SSE event handlers.
   * This encapsulates the AIPanel state and methods needed by the handlers.
   */
  private createSSEHandlerContext(): SSEHandlerContext {
    return {
      addMessage: (msg: Message) => this.addMessage(msg),
      updateMessage: (
        messageId: string,
        updates: Partial<Message>,
        options?: {persist?: boolean},
      ) => this.updateMessage(messageId, updates, options),
      generateId: () => this.generateId(),
      getMessages: () => this.state.messages,
      removeLastMessageIf: (predicate: (msg: Message) => boolean) => {
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg && predicate(lastMsg)) {
          this.state.messages.pop();
          this.saveHistory();
          this.saveCurrentSession();
          return true;
        }
        return false;
      },
      setLoading: (loading: boolean) => {
        this.setLoadingState(loading);
      },
      displayedSkillProgress: this.state.displayedSkillProgress,
      collectedErrors: this.state.collectedErrors,
      completionHandled: this.state.completionHandled,
      setCompletionHandled: (handled: boolean) => {
        this.state.completionHandled = handled;
      },
      backendUrl: this.state.settings.backendUrl,
      streamingFlow: this.state.streamingFlow,
      streamingAnswer: this.state.streamingAnswer,
      // Track overlay — create timeline tracks when overlay-eligible data arrives
      onOverlayDataReceived: (overlayId, columns, rows) => {
        if (this.trace) {
          createOverlayTrack(this.trace, overlayId, columns, rows).catch((e) =>
            console.error(`[AIPanel] Overlay ${overlayId} failed:`, e),
          );
        }
      },
    };
  }

  /**
   * Handle SSE events from backend - delegates to sse_event_handlers module.
   *
   * Note: State synchronization strategy:
   * - displayedSkillProgress, collectedErrors: Passed by reference, changes reflect automatically
   * - completionHandled: Updated via setCompletionHandled() which directly modifies this.state
   * - No manual sync needed as all state changes go directly to this.state
   */
  private handleSSEEvent(eventType: string, data?: any): void {
    if (eventType === 'snapshot_created') {
      this.applySnapshotCreatedEvent(data);
    } else if (eventType === 'analysis_completed') {
      this.applyAnalysisCompletedSnapshotFallback(data);
    } else if (eventType === 'track_data' || eventType.startsWith('scene_story_')) {
      this.applySmartStoryEvent(eventType, data);
    }

    const ctx = this.createSSEHandlerContext();
    const result = handleSSEEventExternal(eventType, data, ctx);

    // Update loading phase from handler result
    if (result.loadingPhase !== undefined) {
      this.state.loadingPhase = result.loadingPhase;
    }

    // Handle terminal events
    if (result.stopLoading) {
      this.setLoadingState(false);
    }

    // Note: completionHandled is updated via setCompletionHandled() directly on this.state
    // Do NOT sync ctx.completionHandled back - it's the original value before handler ran

    // Trigger redraw after handling each event
    m.redraw();
  }

  private applySmartStoryEvent(eventType: string, data?: any): void {
    const payload =
      data && typeof data === 'object' && data.data && typeof data.data === 'object'
        ? data.data
        : data;
    if (!payload || typeof payload !== 'object') return;

    if (eventType === 'scene_story_smart_eta_refined') {
      const expectedDeepDives =
        typeof payload.expectedDeepDives === 'number' ? payload.expectedDeepDives : 0;
      const etaSec = typeof payload.etaSec === 'number' ? payload.etaSec : 0;
      this.state.loadingPhase =
        payload.selectionMode === 'selection_required'
          ? `智能分析已识别 ${expectedDeepDives} 个可深钻场景`
          : expectedDeepDives > 0
          ? `智能分析预计深钻 ${expectedDeepDives} 个场景，约 ${etaSec}s`
          : '智能分析正在生成报告';
      this.state.storyState = {
        ...this.state.storyState,
        preview: {
          traceDurationSec: this.state.storyState.preview?.traceDurationSec ?? 0,
          cached: null,
          estimate: {
            expectedScenes: expectedDeepDives,
            etaSec,
            estimatedUsd: this.state.storyState.preview?.estimate.estimatedUsd ?? 0,
            confidence: payload.etaConfidence === 'high' ? 'high' : 'medium',
          },
        },
      };
      return;
    }

    if (eventType === 'scene_story_detected') {
      const scenes = Array.isArray(payload.scenes) ? payload.scenes : [];
      if (payload.previewOnly !== true) {
        this.state.showStorySidebar = true;
      }
      this.state.storyState = {
        ...this.state.storyState,
        status: 'running',
        analysisId: this.state.agentSessionId,
        cachedReport: {
          ...(this.state.storyState.cachedReport || {}),
          displayedScenes: scenes,
          sceneVerification: payload.sceneVerification,
          jobs: [],
          summary: null,
        },
      };
      return;
    }

    if (eventType === 'scene_story_selection_ready') {
      const sceneCount =
        typeof payload.sceneCount === 'number'
          ? payload.sceneCount
          : this.getSmartPreviewScenes().length;
      this.state.loadingPhase = `智能分析已识别 ${sceneCount} 个场景，等待选择范围`;
      this.state.storyState = {
        ...this.state.storyState,
        status: 'selection_ready',
        analysisId: this.state.agentSessionId,
        cachedReport: {
          ...(this.state.storyState.cachedReport || {}),
          reportId: typeof payload.reportId === 'string' ? payload.reportId : undefined,
          sceneVerification: payload.sceneVerification,
          sceneTypeCounts: payload.sceneTypeCounts,
        },
      };
      return;
    }

    if (eventType === 'scene_story_report_ready') {
      const reportId =
        typeof payload.reportId === 'string' ? payload.reportId : '';
      this.state.showStorySidebar = true;
      this.state.storyState = {
        ...this.state.storyState,
        status: 'completed',
        analysisId: this.state.agentSessionId,
      };
      if (reportId) {
        void this.getOrCreateStoryController()
          .loadReport(reportId)
          .then((report) => {
            this.state.storyState = {
              ...this.state.storyState,
              status: 'completed',
              cachedReport: report,
            };
            m.redraw();
          })
          .catch(() => {
            this.state.storyState = {
              ...this.state.storyState,
              status: 'completed',
              cachedReport: {
                ...(this.state.storyState.cachedReport || {}),
                reportId,
                summary:
                  typeof payload.summary === 'string' ? payload.summary : null,
              },
            };
            m.redraw();
          });
      }
      return;
    }

    if (eventType === 'scene_story_failed' || eventType === 'scene_story_dropped') {
      this.state.storyState = {
        ...this.state.storyState,
        status: 'running',
      };
      return;
    }

    if (eventType === 'scene_story_cancelled') {
      this.state.storyState = {
        ...this.state.storyState,
        status: payload.scope === 'session' ? 'failed' : this.state.storyState.status,
        lastError: payload.scope === 'session' ? '智能分析已取消' : this.state.storyState.lastError,
      };
    }
  }

  private applySnapshotCreatedEvent(data?: any): void {
    const payload = data && typeof data === 'object' ? data.data : null;
    if (!payload || typeof payload !== 'object') return;
    const snapshotId =
      typeof payload.snapshotId === 'string' ? payload.snapshotId : '';
    if (!snapshotId) return;

    this.state.latestAnalysisSnapshot = {
      snapshotId,
      status:
        typeof payload.status === 'string' ? payload.status : 'partial',
      sceneType:
        typeof payload.sceneType === 'string' ? payload.sceneType : 'general',
      metricCount:
        typeof payload.metricCount === 'number' ? payload.metricCount : 0,
      evidenceRefCount:
        typeof payload.evidenceRefCount === 'number'
          ? payload.evidenceRefCount
          : 0,
      traceId:
        typeof payload.traceId === 'string' ? payload.traceId : undefined,
      sessionId:
        typeof payload.sessionId === 'string' ? payload.sessionId : undefined,
      runId: typeof payload.runId === 'string' ? payload.runId : undefined,
      reportId:
        typeof payload.reportId === 'string' ? payload.reportId : undefined,
      visibility:
        typeof payload.visibility === 'string' ? payload.visibility : 'private',
      createdAt:
        typeof payload.createdAt === 'number' ? payload.createdAt : Date.now(),
    };
    if (this.state.showResultPicker) {
      void this.fetchAnalysisResults();
    }
    void this.postWindowHeartbeat();
  }

  private applyAnalysisCompletedSnapshotFallback(data?: any): void {
    const snapshot = latestSnapshotFromAnalysisCompletedEvent({
      eventData: data,
      current: this.state.latestAnalysisSnapshot,
      traceId: this.state.backendTraceId || undefined,
      sessionId: this.state.agentSessionId || undefined,
      runId: this.state.agentRunId || undefined,
    });
    if (!snapshot) return;
    this.state.latestAnalysisSnapshot = snapshot;
    void this.postWindowHeartbeat();
  }

  private formatLatestSnapshotLabel(): string {
    const snapshot = this.state.latestAnalysisSnapshot;
    if (!snapshot) return '';
    const status = snapshot.status === 'ready' ? 'Ready' : 'Partial';
    return `${status} result ${this.formatKnownAnalysisResultRef(snapshot.snapshotId)}`;
  }

  private formatLatestSnapshotTitle(): string {
    const snapshot = this.state.latestAnalysisSnapshot;
    if (!snapshot) return '';
    const ref = this.formatKnownAnalysisResultRef(snapshot.snapshotId);
    return [
      `Result ID: ${ref}`,
      `Snapshot: ${snapshot.snapshotId}`,
      `Scene: ${snapshot.sceneType}`,
      `Metrics: ${snapshot.metricCount}`,
      `Visibility: ${snapshot.visibility || 'private'}`,
      `Chat usage: 对比 ${ref}`,
    ].join('\n');
  }

  private knownAnalysisResultIds(): string[] {
    const ids = [
      ...this.availableAnalysisResults.map((item) => item.id),
      this.state.latestAnalysisSnapshot?.snapshotId,
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    return [...new Set(ids)];
  }

  private formatKnownAnalysisResultRef(snapshotId: string | undefined): string {
    return formatAnalysisResultRef(snapshotId, this.knownAnalysisResultIds());
  }

  private async handleCommand(input: string) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/sql':
        await this.handleSqlCommand(args.join(' '));
        break;
      case '/goto':
        await this.handleGotoCommand(args[0]);
        break;
      case '/analyze':
        await this.handleAnalyzeCommand();
        break;
      case '/anr':
        await this.handleAnrCommand();
        break;
      case '/jank':
        await this.handleJankCommand();
        break;
      case '/export':
        await this.handleExportCommand(args[0]);
        break;
      case '/clear':
        this.clearChat();
        break;
      case '/pins':
        this.handlePinsCommand();
        break;
      case '/help':
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: this.getHelpMessage(),
          timestamp: Date.now(),
        });
        break;
      case '/slow':
        await this.handleSlowCommand();
        break;
      case '/memory':
        await this.handleMemoryCommand();
        break;
      case '/settings':
        this.openSettings();
        break;
      case '/teaching-pipeline':
        await this.handleTeachingPipelineCommand();
        break;
      case '/scene':
        await this.handleSceneReconstructCommand();
        break;
      case '/smart':
        await this.handleSmartAnalysisCommand();
        break;
      default:
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `Unknown command: ${cmd}. Type \`/help\` for available commands.`,
          timestamp: Date.now(),
        });
    }
  }

  private handlePinsCommand() {
    if (this.state.pinnedResults.length === 0) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content:
          '**No pinned results yet.**\n\nUse the 📌 Pin button on SQL results to save them here.',
        timestamp: Date.now(),
      });
      return;
    }

    const pinsList = this.state.pinnedResults
      .map((pin, index) => {
        const date = new Date(pin.timestamp).toLocaleString();
        return `**${index + 1}.** ${pin.query.substring(0, 60)}${pin.query.length > 60 ? '...' : ''}\n   - ${pin.rows.length} rows • ${date}`;
      })
      .join('\n\n');

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**📌 Pinned Results (${this.state.pinnedResults.length})**\n\n${pinsList}\n\nClick on any result in the chat history to use the Pin button.`,
      timestamp: Date.now(),
    });
  }

  private async handleSqlCommand(query: string) {
    if (!query) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content:
          'Please provide a SQL query. Example: `/sql SELECT * FROM slice LIMIT 10`',
        timestamp: Date.now(),
      });
      return;
    }

    // Store the query for pinning
    this.state.lastQuery = query;

    this.setLoadingState(true);
    m.redraw();

    try {
      const result = await this.engine?.query(query);
      if (result) {
        // Get column names - columns() returns an array of column names (strings)
        const columns = result.columns();
        const rows: any[][] = [];

        // Use empty spec for dynamic queries, iterate through all rows
        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            // Use it.get() to retrieve values by column name
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `Query returned **${rows.length}** rows.`,
          timestamp: Date.now(),
          sqlResult: {columns, rows, rowCount: rows.length, query},
        });

        // 尝试从查询结果中提取导航书签
        this.extractBookmarksFromQueryResult(query, columns, rows);
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error executing query:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleGotoCommand(ts: string) {
    if (!ts) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: 'Please provide a timestamp. Example: `/goto 1234567890`',
        timestamp: Date.now(),
      });
      return;
    }

    const normalized = ts.trim().replace(/ns$/i, '').trim();
    if (!/^\d+$/.test(normalized)) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `Invalid timestamp: ${ts}`,
        timestamp: Date.now(),
      });
      return;
    }

    const timestampNs = BigInt(normalized);
    const navigation = this.jumpToTimestamp(timestampNs);
    if (!navigation.ok) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `Failed to navigate to timestamp ${timestampNs.toString()}ns: ${navigation.error}`,
        timestamp: Date.now(),
      });
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `Navigated to timestamp ${timestampNs.toString()}ns.`,
      timestamp: Date.now(),
    });
  }

  private async handleAnalyzeCommand() {
    // Check if we have a trace and selection
    if (!this.trace) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**Error:** Trace context not available.',
        timestamp: Date.now(),
      });
      return;
    }

    const selection = this.trace.selection.selection;

    // Check if there's a selection
    if (selection.kind === 'empty') {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content:
          '**No selection found.** Please click on a slice in the timeline to select it, then use `/analyze`.',
        timestamp: Date.now(),
      });
      return;
    }

    const query = this.buildCurrentSelectionAnalysisQuery();
    if (query) {
      const last = this.state.messages[this.state.messages.length - 1];
      if (last?.role === 'user' && last.content.trim() === '/analyze') {
        last.content = query;
      }
      const datasets = await this.querySelectionData();
      this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
      await this.handleChatMessage(query);
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Selection type:** ${selection.kind}\n\nAnalysis for this selection type is not yet implemented. Please try selecting a specific slice.`,
      timestamp: Date.now(),
    });
  }

  /**
   * Query slice metadata for the Slice Selected card.
   * Called when selection changes to a track_event.
   */
  private async querySliceCardInfo(
    eventId: number,
  ): Promise<SliceCardInfo | null> {
    if (!this.engine) return null;
    try {
      const result = await this.engine.query(`
        SELECT s.id, s.name, s.ts, s.dur,
          CAST(s.dur / 1e6 AS REAL) as dur_ms,
          COALESCE(t.name, '') as thread_name,
          COALESCE(p.name, '') as process_name,
          s.depth,
          (SELECT COUNT(*) FROM slice c WHERE c.parent_id = s.id) as child_count
        FROM slice s
        LEFT JOIN thread_track tt ON s.track_id = tt.id
        LEFT JOIN thread t ON tt.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE s.id = ${eventId}
      `);
      const it = result.iter({
        id: NUM_NULL,
        name: STR_NULL,
        ts: LONG,
        dur: LONG,
        dur_ms: NUM_NULL,
        thread_name: STR_NULL,
        process_name: STR_NULL,
        depth: NUM_NULL,
        child_count: NUM_NULL,
      });
      if (!it.valid()) return null;
      return {
        id: Number(it.id ?? 0),
        name: String(it.name ?? ''),
        ts: Number(it.ts),
        dur: Number(it.dur),
        durMs: Number(it.dur_ms ?? 0),
        threadName: String(it.thread_name ?? ''),
        processName: String(it.process_name ?? ''),
        depth: Number(it.depth ?? 0),
        childCount: Number(it.child_count ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Query area metadata for the Area Selected card.
   */
  private async queryAreaCardInfo(
    startNs: number,
    endNs: number,
  ): Promise<AreaCardInfo> {
    const durationMs = (endNs - startNs) / 1e6;
    let sliceCount = 0;
    let trackCount = 0;
    let jankCount = 0;
    const topSlices: Array<{name: string; durMs: number; count: number}> = [];

    if (!this.engine)
      return {
        startNs,
        endNs,
        durationMs,
        sliceCount,
        trackCount,
        topSlices,
        hasJank: false,
        jankCount,
      };

    try {
      const r = await this.engine.query(`
        SELECT COUNT(*) as cnt, COUNT(DISTINCT s.track_id) as tracks
        FROM slice s
        WHERE s.ts >= ${startNs} AND s.ts + s.dur <= ${endNs} AND s.dur > 0
      `);
      const it = r.iter({cnt: NUM_NULL, tracks: NUM_NULL});
      if (it.valid()) {
        sliceCount = Number(it.cnt ?? 0);
        trackCount = Number(it.tracks ?? 0);
      }
    } catch {
      /* ignore */
    }

    try {
      const r = await this.engine.query(`
        SELECT s.name, COUNT(*) as cnt, CAST(SUM(s.dur)/1e6 AS REAL) as total_ms
        FROM slice s
        WHERE s.ts >= ${startNs} AND s.ts + s.dur <= ${endNs} AND s.dur > 0
        GROUP BY s.name ORDER BY total_ms DESC LIMIT 5
      `);
      for (
        const it = r.iter({name: STR_NULL, cnt: NUM_NULL, total_ms: NUM_NULL});
        it.valid();
        it.next()
      ) {
        topSlices.push({
          name: String(it.name ?? ''),
          durMs: Number(it.total_ms ?? 0),
          count: Number(it.cnt ?? 0),
        });
      }
    } catch {
      /* ignore */
    }

    try {
      const r = await this.engine.query(`
        SELECT COUNT(*) as cnt FROM actual_frame_timeline_slice
        WHERE ts >= ${startNs} AND ts + dur <= ${endNs}
          AND jank_type IS NOT NULL AND jank_type != 'None'
      `);
      const it = r.iter({cnt: NUM_NULL});
      if (it.valid()) jankCount = Number(it.cnt ?? 0);
    } catch {
      /* ignore */
    }

    return {
      startNs,
      endNs,
      durationMs,
      sliceCount,
      trackCount,
      topSlices,
      hasJank: jankCount > 0,
      jankCount,
    };
  }

  /**
   * Detect selection changes (called from view()) and trigger async slice/area info query.
   */
  private uniqueFiniteNumbers(values: Array<number | undefined>): number[] {
    return Array.from(
      new Set(
        values.filter(
          (value): value is number =>
            typeof value === 'number' && Number.isFinite(value),
        ),
      ),
    ).sort((a, b) => a - b);
  }

  private sqlNumberList(values: number[]): string {
    return values.join(',');
  }

  private buildTrackScopeFromPerfettoTracks(
    tracks: ReadonlyArray<Track>,
  ): Pick<AreaQueryScope, 'utids' | 'upids' | 'cpus'> {
    return {
      utids: this.uniqueFiniteNumbers(
        tracks.map((track) => track.tags?.utid as number | undefined),
      ),
      upids: this.uniqueFiniteNumbers(
        tracks.map((track) => track.tags?.upid as number | undefined),
      ),
      cpus: this.uniqueFiniteNumbers(
        tracks.map((track) => track.tags?.cpu as number | undefined),
      ),
    };
  }

  private buildTrackScopeFromSelectionContext(
    context: SelectionContext,
  ): Pick<AreaQueryScope, 'utids' | 'upids' | 'cpus'> {
    return {
      utids: this.uniqueFiniteNumbers(
        context.tracks?.map((track) => track.utid) ?? [],
      ),
      upids: this.uniqueFiniteNumbers(
        context.tracks?.map((track) => track.upid) ?? [],
      ),
      cpus: this.uniqueFiniteNumbers(
        context.tracks?.map((track) => track.cpu) ?? [],
      ),
    };
  }

  private getAreaQueryScope(
    selectionContext?: SelectionContext,
  ): AreaQueryScope | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;

    if (sel.kind === 'area') {
      const startNs = Number(sel.start);
      const endNs = Number(sel.end);
      const trackScope = this.buildTrackScopeFromPerfettoTracks(sel.tracks);
      return {
        startNs,
        endNs,
        durationNs: endNs - startNs,
        source: 'area_selection',
        ...trackScope,
      };
    }

    if (
      selectionContext?.kind === 'area' &&
      selectionContext.startNs !== undefined &&
      selectionContext.endNs !== undefined
    ) {
      const trackScope = this.buildTrackScopeFromSelectionContext(
        selectionContext,
      );
      return {
        startNs: selectionContext.startNs,
        endNs: selectionContext.endNs,
        durationNs:
          selectionContext.durationNs ??
          selectionContext.endNs - selectionContext.startNs,
        source: selectionContext.source ?? 'area_selection',
        ...trackScope,
      };
    }

    return null;
  }

  private areaThreadPredicate(
    scope: AreaQueryScope,
    threadStateAlias = 'ts',
    threadAlias = 't',
  ): string {
    const clauses: string[] = [];
    if (scope.utids.length > 0) {
      clauses.push(
        `${threadStateAlias}.utid IN (${this.sqlNumberList(scope.utids)})`,
      );
    }
    if (scope.upids.length > 0) {
      clauses.push(
        `${threadAlias}.upid IN (${this.sqlNumberList(scope.upids)})`,
      );
    }
    if (scope.cpus.length > 0) {
      clauses.push(
        `${threadStateAlias}.cpu IN (${this.sqlNumberList(scope.cpus)})`,
      );
    }
    return clauses.length > 0 ? `AND (${clauses.join(' OR ')})` : '';
  }

  private areaSlicePredicate(scope: AreaQueryScope): string {
    const clauses: string[] = [];
    if (scope.utids.length > 0) {
      clauses.push(`tt.utid IN (${this.sqlNumberList(scope.utids)})`);
    }
    if (scope.upids.length > 0) {
      clauses.push(`t.upid IN (${this.sqlNumberList(scope.upids)})`);
    }
    return clauses.length > 0 ? `AND (${clauses.join(' OR ')})` : '';
  }

  private areaCpuPredicate(scope: AreaQueryScope, cpuAlias: string): string {
    return scope.cpus.length > 0
      ? `AND ${cpuAlias} IN (${this.sqlNumberList(scope.cpus)})`
      : '';
  }

  private cpuTopologyCte(): string {
    return `
      cpu_universe AS (
        SELECT cpu AS cpu_id FROM sched_slice WHERE cpu IS NOT NULL
        UNION
        SELECT cpu AS cpu_id FROM thread_state WHERE cpu IS NOT NULL
        UNION
        SELECT id AS cpu_id FROM cpu
      ),
      cpu_scale AS (
        SELECT
          u.cpu_id,
          COALESCE(NULLIF(cpu.capacity, 0), 0) AS scale_value
        FROM cpu_universe u
        LEFT JOIN cpu ON cpu.id = u.cpu_id
      ),
      scale_values AS (
        SELECT
          scale_value,
          ROW_NUMBER() OVER (ORDER BY scale_value ASC) AS cluster_rank,
          COUNT(*) OVER () AS cluster_count
        FROM (
          SELECT DISTINCT scale_value
          FROM cpu_scale
          WHERE scale_value > 0
        )
      ),
      cpu_topology AS (
        SELECT
          cs.cpu_id,
          CASE
            WHEN cs.scale_value <= 0 OR sv.scale_value IS NULL THEN 'unknown'
            WHEN sv.cluster_count = 1 AND (SELECT COUNT(*) FROM cpu_scale) <= 4 THEN 'little'
            WHEN sv.cluster_count = 1 THEN 'unknown'
            WHEN sv.cluster_rank = 1 THEN 'little'
            WHEN sv.cluster_rank = sv.cluster_count THEN 'big'
            ELSE 'medium'
          END AS core_type
        FROM cpu_scale cs
        LEFT JOIN scale_values sv ON sv.scale_value = cs.scale_value
      )
    `;
  }

  private cpuFrequencySpansCte(
    scope: AreaQueryScope,
    startNs: number,
    endNs: number,
  ): string {
    const freqCpuScope = this.areaCpuPredicate(scope, 't.cpu');
    return `
      ${this.cpuTopologyCte()},
      cpu_tracks AS (
        SELECT id, cpu
        FROM cpu_counter_track t
        WHERE t.name = 'cpufreq'
          AND t.cpu IS NOT NULL
          ${freqCpuScope}
      ),
      freq_points AS (
        SELECT
          t.cpu,
          ${startNs} AS ts,
          (
            SELECT c2.value
            FROM counter c2
            WHERE c2.track_id = t.id AND c2.ts <= ${startNs}
            ORDER BY c2.ts DESC
            LIMIT 1
          ) AS freq_khz,
          0 AS source_order
        FROM cpu_tracks t
        UNION ALL
        SELECT t.cpu, c.ts, c.value AS freq_khz, 1 AS source_order
        FROM counter c
        JOIN cpu_tracks t ON c.track_id = t.id
        WHERE c.ts >= ${startNs} AND c.ts < ${endNs}
      ),
      freq_spans AS (
        SELECT
          cpu,
          freq_khz,
          ts,
          LEAD(ts, 1, ${endNs}) OVER (PARTITION BY cpu ORDER BY ts, source_order) AS next_ts
        FROM freq_points
        WHERE freq_khz IS NOT NULL AND freq_khz > 0
      ),
      freq_clipped AS (
        SELECT
          cpu,
          freq_khz,
          MIN(next_ts, ${endNs}) - MAX(ts, ${startNs}) AS dur_ns
        FROM freq_spans
        WHERE ts < ${endNs} AND next_ts > ${startNs}
      )
    `;
  }

  /**
   * Pre-query trace data for the current selection, mirroring smartperfetto's querySelectionData.
   * Results are sent with the request so the AI doesn't need to spend turns fetching basics.
   */
  private async querySelectionData(
    selectionContext?: SelectionContext,
  ): Promise<TraceDataset[]> {
    if (!this.engine || !this.trace) return [];
    const sel = this.trace.selection.selection;
    const datasets: TraceDataset[] = [];

    const runQuery = async (
      label: string,
      sql: string,
      schema: Record<string, any>,
    ): Promise<void> => {
      try {
        const result = await this.engine!.query(sql);
        const columns = Object.keys(schema);
        const rows: unknown[][] = [];
        for (const it = result.iter(schema); it.valid(); it.next()) {
          rows.push(
            columns.map((c) => {
              const v = (it as any)[c];
              return typeof v === 'bigint' ? Number(v) : v ?? null;
            }),
          );
        }
        if (rows.length > 0) datasets.push({label, columns, rows});
      } catch {
        /* ignore — table may not exist */
      }
    };

    if (sel.kind === 'track_event') {
      const id = sel.eventId;
      const tsNs = Number(sel.ts);
      const durNs = sel.dur !== undefined ? Number(sel.dur) : 0;
      const endNs = tsNs + durNs;

      // 1) Slice details + thread/process
      await runQuery(
        `slice id=${id}`,
        `
        SELECT s.id, s.name, s.ts, s.dur, CAST(s.dur/1e6 AS REAL) as dur_ms,
          t.name as thread_name, p.name as process_name, s.depth, t.utid, t.tid
        FROM slice s
        LEFT JOIN thread_track tt ON s.track_id = tt.id
        LEFT JOIN thread t ON tt.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE s.id = ${id}
      `,
        {
          id: NUM_NULL,
          name: STR_NULL,
          ts: LONG,
          dur: LONG,
          dur_ms: NUM_NULL,
          thread_name: STR_NULL,
          process_name: STR_NULL,
          depth: NUM_NULL,
          utid: NUM_NULL,
          tid: NUM_NULL,
        },
      );

      // 2) If the selected slice is an Android FrameTimeline row, resolve the
      // paired expected/actual/SF-present timing up front. This keeps the
      // default selected-frame analysis on the quick path.
      await runQuery(
        `selected FrameTimeline frame for slice ${id}`,
        `
        WITH selected AS (
          SELECT 'actual' AS selected_kind, id, name, upid, display_frame_token,
                 surface_frame_token, layer_name
          FROM actual_frame_timeline_slice
          WHERE id = ${id}
          UNION ALL
          SELECT 'expected' AS selected_kind, id, name, upid, display_frame_token,
                 surface_frame_token, layer_name
          FROM expected_frame_timeline_slice
          WHERE id = ${id}
        ),
        frame_key AS (
          SELECT * FROM selected LIMIT 1
        ),
        expected_match AS (
          SELECT e.*
          FROM expected_frame_timeline_slice e
          JOIN frame_key k ON e.upid = k.upid AND e.name = k.name
          ORDER BY e.id
          LIMIT 1
        ),
        actual_match AS (
          SELECT a.*
          FROM actual_frame_timeline_slice a
          JOIN frame_key k ON
            (a.id = k.id AND k.selected_kind = 'actual')
            OR (a.upid = k.upid AND a.name = k.name)
            OR (
              k.display_frame_token IS NOT NULL
              AND a.display_frame_token = k.display_frame_token
              AND a.upid = k.upid
            )
          ORDER BY CASE WHEN a.id = k.id THEN 0 ELSE 1 END, a.dur DESC
          LIMIT 1
        ),
        sf_match AS (
          SELECT sf.*
          FROM actual_frame_timeline_slice sf
          JOIN actual_match a ON
            a.display_frame_token IS NOT NULL
            AND sf.display_frame_token = a.display_frame_token
          WHERE sf.surface_frame_token IS NULL
          ORDER BY sf.ts + sf.dur DESC
          LIMIT 1
        )
        SELECT
          k.selected_kind,
          k.id AS selected_id,
          COALESCE(a.name, e.name, k.name) AS frame_id,
          COALESCE(a.layer_name, e.layer_name, k.layer_name) AS layer_name,
          p.name AS process_name,
          e.ts AS expected_start_ns,
          e.ts + e.dur AS expected_end_ns,
          CAST(e.dur / 1e6 AS REAL) AS expected_ms,
          a.ts AS actual_start_ns,
          a.ts + a.dur AS actual_end_ns,
          CAST(a.dur / 1e6 AS REAL) AS actual_ms,
          sf.ts AS sf_start_ns,
          sf.ts + sf.dur AS sf_present_ns,
          CAST(sf.dur / 1e6 AS REAL) AS sf_ms,
          a.present_type,
          a.on_time_finish,
          a.jank_type,
          a.jank_severity_type,
          a.prediction_type,
          a.gpu_composition
        FROM frame_key k
        LEFT JOIN expected_match e ON 1 = 1
        LEFT JOIN actual_match a ON 1 = 1
        LEFT JOIN sf_match sf ON 1 = 1
        LEFT JOIN process p ON p.upid = COALESCE(a.upid, e.upid, k.upid)
      `,
        {
          selected_kind: STR_NULL,
          selected_id: NUM_NULL,
          frame_id: STR_NULL,
          layer_name: STR_NULL,
          process_name: STR_NULL,
          expected_start_ns: NUM_NULL,
          expected_end_ns: NUM_NULL,
          expected_ms: NUM_NULL,
          actual_start_ns: NUM_NULL,
          actual_end_ns: NUM_NULL,
          actual_ms: NUM_NULL,
          sf_start_ns: NUM_NULL,
          sf_present_ns: NUM_NULL,
          sf_ms: NUM_NULL,
          present_type: STR_NULL,
          on_time_finish: NUM_NULL,
          jank_type: STR_NULL,
          jank_severity_type: STR_NULL,
          prediction_type: STR_NULL,
          gpu_composition: NUM_NULL,
        },
      );

      // 3) Ancestor chain (up to 10 levels)
      await runQuery(
        `caller chain of slice ${id}`,
        `
        WITH RECURSIVE ancestors(id, parent_id, name, dur, depth) AS (
          SELECT id, parent_id, name, dur, depth FROM slice WHERE id = ${id}
          UNION ALL
          SELECT s.id, s.parent_id, s.name, s.dur, s.depth
          FROM slice s JOIN ancestors a ON s.id = a.parent_id LIMIT 10
        )
        SELECT id, name, CAST(dur/1e6 AS REAL) as dur_ms, depth
        FROM ancestors WHERE id != ${id} ORDER BY depth ASC
      `,
        {id: NUM_NULL, name: STR_NULL, dur_ms: NUM_NULL, depth: NUM_NULL},
      );

      // 4) Direct children (call tree)
      await runQuery(
        `children of slice ${id}`,
        `
        SELECT id, name, CAST(dur/1e6 AS REAL) as dur_ms, depth,
          ROUND(dur * 100.0 / NULLIF((SELECT dur FROM slice WHERE id = ${id}), 0), 1) as pct
        FROM slice WHERE parent_id = ${id} ORDER BY dur DESC LIMIT 50
      `,
        {
          id: NUM_NULL,
          name: STR_NULL,
          dur_ms: NUM_NULL,
          depth: NUM_NULL,
          pct: NUM_NULL,
        },
      );

      // 5) Thread state distribution
      if (durNs > 0) {
        await runQuery(
          `thread state during slice ${id}`,
          `
          SELECT cpu, state, COUNT(*) AS cnt,
            CAST(SUM(MIN(ts + dur, ${endNs}) - MAX(ts, ${tsNs}))/1e6 AS REAL) as total_ms,
            CAST(SUM(MIN(ts + dur, ${endNs}) - MAX(ts, ${tsNs}))*100.0/${durNs} AS REAL) as pct
          FROM thread_state
          WHERE utid = (SELECT tt.utid FROM slice s JOIN thread_track tt ON s.track_id=tt.id WHERE s.id=${id})
            AND ts < ${endNs} AND ts + dur > ${tsNs} AND dur > 0
          GROUP BY cpu, state ORDER BY total_ms DESC
        `,
          {
            cpu: NUM_NULL,
            state: STR_NULL,
            cnt: NUM_NULL,
            total_ms: NUM_NULL,
            pct: NUM_NULL,
          },
        );
      }
    } else {
      const scope = this.getAreaQueryScope(selectionContext);
      if (!scope) return datasets;
      const {startNs, endNs} = scope;
      const threadScope = this.areaThreadPredicate(scope);
      const sliceScope = this.areaSlicePredicate(scope);
      const freqBucketMhz = 100;

      // Top slices by total duration
      await runQuery(
        `top slices in range`,
        `
        WITH clipped AS (
          SELECT
            s.name,
            MIN(s.ts + s.dur, ${endNs}) - MAX(s.ts, ${startNs}) AS clipped_dur
          FROM slice s
          LEFT JOIN thread_track tt ON s.track_id = tt.id
          LEFT JOIN thread t ON tt.utid = t.utid
          WHERE s.ts < ${endNs}
            AND s.ts + s.dur > ${startNs}
            AND s.dur > 0
            ${sliceScope}
        )
        SELECT name, COUNT(*) as cnt,
          CAST(SUM(clipped_dur)/1e6 AS REAL) as total_ms,
          CAST(AVG(clipped_dur)/1e6 AS REAL) as avg_ms
        FROM clipped
        WHERE clipped_dur > 0
        GROUP BY name ORDER BY total_ms DESC LIMIT 20
      `,
        {name: STR_NULL, cnt: NUM_NULL, total_ms: NUM_NULL, avg_ms: NUM_NULL},
      );

      // Thread state summary
      await runQuery(
        `thread states in range`,
        `
        SELECT
          COALESCE(t.name, '<unknown>') as thread_name,
          COALESCE(p.name, '<unknown>') as process_name,
          ts.state,
          CAST(SUM(MIN(ts.ts + ts.dur, ${endNs}) - MAX(ts.ts, ${startNs}))/1e6 AS REAL) as total_ms
        FROM thread_state ts
        JOIN thread t ON ts.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE ts.ts < ${endNs}
          AND ts.ts + ts.dur > ${startNs}
          AND ts.dur > 0
          ${threadScope}
        GROUP BY t.utid, ts.state ORDER BY total_ms DESC LIMIT 30
      `,
        {
          thread_name: STR_NULL,
          process_name: STR_NULL,
          state: STR_NULL,
          total_ms: NUM_NULL,
        },
      );

      await runQuery(
        `running threads in range`,
        `
        WITH ${this.cpuTopologyCte()},
        running AS (
          SELECT
            ts.utid,
            COALESCE(t.name, '<unknown>') AS thread_name,
            COALESCE(p.name, '<unknown>') AS process_name,
            t.tid,
            ts.cpu,
            COALESCE(ct.core_type, 'unknown') AS core_type,
            MIN(ts.ts + ts.dur, ${endNs}) - MAX(ts.ts, ${startNs}) AS clipped_dur
          FROM thread_state ts
          JOIN thread t ON ts.utid = t.utid
          LEFT JOIN process p ON t.upid = p.upid
          LEFT JOIN cpu_topology ct ON ts.cpu = ct.cpu_id
          WHERE ts.ts < ${endNs}
            AND ts.ts + ts.dur > ${startNs}
            AND ts.dur > 0
            AND ts.state = 'Running'
            ${threadScope}
        )
        SELECT
          thread_name,
          process_name,
          tid,
          CAST(SUM(clipped_dur)/1e6 AS REAL) as running_ms,
          GROUP_CONCAT(DISTINCT cpu) as cpus,
          GROUP_CONCAT(DISTINCT core_type) as core_types,
          CAST(SUM(CASE WHEN core_type IN ('big', 'medium', 'prime') THEN clipped_dur ELSE 0 END) * 100.0 / NULLIF(SUM(clipped_dur), 0) AS REAL) as perf_core_pct
        FROM running
        WHERE clipped_dur > 0
        GROUP BY utid
        ORDER BY running_ms DESC
        LIMIT 30
      `,
        {
          thread_name: STR_NULL,
          process_name: STR_NULL,
          tid: NUM_NULL,
          running_ms: NUM_NULL,
          cpus: STR_NULL,
          core_types: STR_NULL,
          perf_core_pct: NUM_NULL,
        },
      );

      await runQuery(
        `running processes in range`,
        `
        SELECT
          COALESCE(p.name, '<unknown>') AS process_name,
          p.pid,
          CAST(SUM(MIN(ts.ts + ts.dur, ${endNs}) - MAX(ts.ts, ${startNs}))/1e6 AS REAL) as running_ms,
          COUNT(DISTINCT ts.utid) as thread_count
        FROM thread_state ts
        JOIN thread t ON ts.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE ts.ts < ${endNs}
          AND ts.ts + ts.dur > ${startNs}
          AND ts.dur > 0
          AND ts.state = 'Running'
          ${threadScope}
        GROUP BY p.upid
        ORDER BY running_ms DESC
        LIMIT 20
      `,
        {
          process_name: STR_NULL,
          pid: NUM_NULL,
          running_ms: NUM_NULL,
          thread_count: NUM_NULL,
        },
      );

      await runQuery(
        `thread quadrants and CPU placement in range`,
        `
        WITH ${this.cpuTopologyCte()},
        states AS (
          SELECT
            ts.utid,
            COALESCE(t.name, '<unknown>') AS thread_name,
            COALESCE(p.name, '<unknown>') AS process_name,
            t.tid,
            ts.ts,
            ts.state,
            ts.cpu,
            COALESCE(ct.core_type, 'unknown') AS core_type,
            MIN(ts.ts + ts.dur, ${endNs}) - MAX(ts.ts, ${startNs}) AS clipped_dur
          FROM thread_state ts
          JOIN thread t ON ts.utid = t.utid
          LEFT JOIN process p ON t.upid = p.upid
          LEFT JOIN cpu_topology ct ON ts.cpu = ct.cpu_id
          WHERE ts.ts < ${endNs}
            AND ts.ts + ts.dur > ${startNs}
            AND ts.dur > 0
            ${threadScope}
        ),
        running_events AS (
          SELECT
            utid,
            ts,
            cpu,
            core_type,
            LAG(cpu) OVER (PARTITION BY utid ORDER BY ts) AS prev_cpu,
            LAG(core_type) OVER (PARTITION BY utid ORDER BY ts) AS prev_core_type
          FROM states
          WHERE state = 'Running' AND clipped_dur > 0
        ),
        migrations AS (
          SELECT
            utid,
            SUM(CASE WHEN prev_cpu IS NOT NULL AND cpu != prev_cpu THEN 1 ELSE 0 END) AS migrations,
            SUM(CASE WHEN prev_cpu IS NOT NULL AND cpu != prev_cpu AND core_type != prev_core_type THEN 1 ELSE 0 END) AS cross_cluster_migrations
          FROM running_events
          GROUP BY utid
        )
        SELECT
          s.thread_name,
          s.process_name,
          s.tid,
          CAST(SUM(CASE WHEN s.state = 'Running' THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS total_cpu_ms,
          CAST(SUM(CASE WHEN s.state = 'Running' AND s.core_type IN ('big', 'medium', 'prime') THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS q1_big_running_ms,
          CAST(SUM(CASE WHEN s.state = 'Running' AND s.core_type = 'little' THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS q2_little_running_ms,
          CAST(SUM(CASE WHEN s.state IN ('R', 'R+') THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS q3_runnable_ms,
          CAST(SUM(CASE WHEN s.state IN ('D', 'DK') THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS q4a_io_blocked_ms,
          CAST(SUM(CASE WHEN s.state IN ('S', 'I') THEN s.clipped_dur ELSE 0 END)/1e6 AS REAL) AS q4b_sleeping_ms,
          CAST(SUM(s.clipped_dur)/1e6 AS REAL) AS total_state_ms,
          GROUP_CONCAT(DISTINCT CASE WHEN s.state = 'Running' THEN s.cpu END) AS running_cpus,
          GROUP_CONCAT(DISTINCT CASE WHEN s.state = 'Running' THEN s.core_type END) AS running_core_types,
          COALESCE(m.migrations, 0) AS migrations,
          COALESCE(m.cross_cluster_migrations, 0) AS cross_cluster_migrations
        FROM states s
        LEFT JOIN migrations m ON s.utid = m.utid
        WHERE s.clipped_dur > 0
        GROUP BY s.utid
        HAVING total_cpu_ms > 0
        ORDER BY total_cpu_ms DESC
        LIMIT 20
      `,
        {
          thread_name: STR_NULL,
          process_name: STR_NULL,
          tid: NUM_NULL,
          total_cpu_ms: NUM_NULL,
          q1_big_running_ms: NUM_NULL,
          q2_little_running_ms: NUM_NULL,
          q3_runnable_ms: NUM_NULL,
          q4a_io_blocked_ms: NUM_NULL,
          q4b_sleeping_ms: NUM_NULL,
          total_state_ms: NUM_NULL,
          running_cpus: STR_NULL,
          running_core_types: STR_NULL,
          migrations: NUM_NULL,
          cross_cluster_migrations: NUM_NULL,
        },
      );

      await runQuery(
        `CPU frequency summary in range`,
        `
        WITH ${this.cpuFrequencySpansCte(scope, startNs, endNs)}
        SELECT
          c.cpu,
          COALESCE(ct.core_type, 'unknown') AS core_type,
          CAST(SUM(freq_khz * dur_ns) / NULLIF(SUM(dur_ns), 0) / 1000 AS REAL) AS avg_freq_mhz,
          CAST(MIN(freq_khz) / 1000 AS REAL) AS min_freq_mhz,
          CAST(MAX(freq_khz) / 1000 AS REAL) AS max_freq_mhz,
          CAST(SUM(dur_ns)/1e6 AS REAL) AS covered_ms
        FROM freq_clipped c
        LEFT JOIN cpu_topology ct ON c.cpu = ct.cpu_id
        WHERE dur_ns > 0
        GROUP BY c.cpu
        ORDER BY c.cpu
      `,
        {
          cpu: NUM_NULL,
          core_type: STR_NULL,
          avg_freq_mhz: NUM_NULL,
          min_freq_mhz: NUM_NULL,
          max_freq_mhz: NUM_NULL,
          covered_ms: NUM_NULL,
        },
      );

      await runQuery(
        `CPU frequency distribution in range`,
        `
        WITH ${this.cpuFrequencySpansCte(scope, startNs, endNs)},
        buckets AS (
          SELECT
            cpu,
            CAST(ROUND(freq_khz / (${freqBucketMhz} * 1000.0)) * ${freqBucketMhz} AS INTEGER) AS freq_mhz_bucket,
            dur_ns
          FROM freq_clipped
        )
        SELECT
          c.cpu,
          COALESCE(ct.core_type, 'unknown') AS core_type,
          c.freq_mhz_bucket,
          CAST(SUM(c.dur_ns)/1e6 AS REAL) AS duration_ms,
          CAST(SUM(c.dur_ns) * 100.0 / NULLIF(${endNs} - ${startNs}, 0) AS REAL) AS pct_of_range
        FROM buckets c
        LEFT JOIN cpu_topology ct ON c.cpu = ct.cpu_id
        WHERE c.dur_ns > 0
        GROUP BY c.cpu, c.freq_mhz_bucket
        ORDER BY c.cpu, duration_ms DESC
        LIMIT 80
      `,
        {
          cpu: NUM_NULL,
          core_type: STR_NULL,
          freq_mhz_bucket: NUM_NULL,
          duration_ms: NUM_NULL,
          pct_of_range: NUM_NULL,
        },
      );
    }

    return datasets;
  }

  private updateSliceCard(): void {
    if (!this.trace) return;
    const sel = this.trace.selection.selection;
    const selKey =
      sel.kind === 'track_event'
        ? `te-${sel.eventId}`
        : sel.kind === 'area'
          ? `area-${Number(sel.start)}-${Number(sel.end)}`
          : 'none';
    if (selKey === this.state.sliceCardPrevSelId) return;
    this.state.sliceCardPrevSelId = selKey;
    this.state.sliceCardDismissed = false;
    this.state.sliceCardInfo = null;
    this.state.areaCardInfo = null;
    if (sel.kind === 'track_event') {
      this.querySliceCardInfo(sel.eventId).then((info) => {
        this.state.sliceCardInfo = info;
        m.redraw();
      });
    } else if (sel.kind === 'area') {
      this.queryAreaCardInfo(Number(sel.start), Number(sel.end)).then(
        (info) => {
          this.state.areaCardInfo = info;
          m.redraw();
        },
      );
    }
  }

  private fmtDurMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(2)}ms`;
    return `${(ms * 1000).toFixed(0)}μs`;
  }

  /**
   * Render the Slice Selected card above the input box.
   */
  private renderSliceCard(): m.Vnode | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'track_event') return null;
    if (this.state.sliceCardDismissed) return null;
    const info = this.state.sliceCardInfo;
    if (!info) return null;

    const dur = this.fmtDurMs(info.durMs);
    const isSlow = info.durMs >= 16;

    const onAction = (query: string) => {
      this.state.sliceCardDismissed = true;
      this.state.input = query;
      // Pre-query trace data before sending — result stored in pendingTraceContext
      this.querySelectionData().then((datasets) => {
        this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
        this.sendMessage();
      });
    };

    return m('div.sp-sel-card', [
      m('div.sp-sel-card-header', [
        m('span.sp-sel-card-title', `⬛ Slice Selected${isSlow ? ' ⚠️' : ''}`),
        m(
          'button.sp-sel-card-dismiss',
          {
            onclick: () => {
              this.state.sliceCardDismissed = true;
              m.redraw();
            },
            title: 'Dismiss',
          },
          '✕',
        ),
      ]),
      m('div.sp-sel-card-meta', [
        m('span.sp-meta-pill', [m('strong', info.name)]),
        m('span.sp-meta-pill', ['⏱ ', m('strong', dur)]),
        info.threadName
          ? m('span.sp-meta-pill', ['🧵 ', info.threadName])
          : null,
        info.processName
          ? m('span.sp-meta-pill', ['📦 ', info.processName])
          : null,
        info.childCount > 0
          ? m('span.sp-meta-pill', ['🌿 ', `${info.childCount} children`])
          : null,
        m(
          'span.sp-meta-pill',
          {
            style: 'cursor:pointer',
            title: 'Jump to timestamp',
            onclick: () =>
              this.trace!.timeline.panIntoView(Time.fromRaw(BigInt(info.ts))),
          },
          [`📍 `, `${(info.ts / 1e6).toFixed(1)}ms`],
        ),
      ]),
      m('div.sp-sel-card-actions', [
        m(
          'button.sp-action-btn.sp-action-btn--primary',
          {
            onclick: () =>
              onAction(
                `快速分析当前选中的 Slice：${info.name}（${dur}），先给出它是什么、关键时间和是否异常`,
              ),
            disabled: this.state.isLoading,
          },
          '🔍 分析此 Slice',
        ),
        m(
          'button.sp-action-btn.sp-action-btn--secondary',
          {
            onclick: () =>
              onAction(
                `找出 "${info.name}" 耗时 ${dur} 的根本原因，分析调用链和子调用`,
              ),
            disabled: this.state.isLoading,
          },
          '🔎 找根因',
        ),
        m(
          'button.sp-action-btn.sp-action-btn--secondary',
          {
            onclick: () =>
              onAction(
                `展示 "${info.name}" 的完整调用链，包括父调用和子调用，并找出最耗时的部分`,
              ),
            disabled: this.state.isLoading,
          },
          '📊 调用链',
        ),
        isSlow
          ? m(
              'button.sp-action-btn.sp-action-btn--secondary',
              {
                onclick: () =>
                  onAction(
                    `"${info.name}" 耗时 ${dur} 超过帧预算（16ms），分析为什么会卡顿`,
                  ),
                disabled: this.state.isLoading,
              },
              '🚨 卡顿分析',
            )
          : null,
      ]),
    ]);
  }

  /**
   * Render the Area Selected card above the input box.
   */
  private renderAreaCard(): m.Vnode | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'area') return null;
    if (this.state.sliceCardDismissed) return null;
    const info = this.state.areaCardInfo;
    if (!info) return null;

    const startMs = (info.startNs / 1e6).toFixed(1);
    const endMs = (info.endNs / 1e6).toFixed(1);
    const dur = this.fmtDurMs(info.durationMs);

    const onAction = (query: string) => {
      this.state.sliceCardDismissed = true;
      this.state.input = query;
      this.querySelectionData().then((datasets) => {
        this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
        this.sendMessage();
      });
    };

    return m('div.sp-sel-card', [
      m('div.sp-sel-card-header', [
        m(
          'span.sp-sel-card-title',
          `⬜ 时间范围选中${info.hasJank ? ' ⚠️ Jank' : ''}`,
        ),
        m(
          'button.sp-sel-card-dismiss',
          {
            onclick: () => {
              this.state.sliceCardDismissed = true;
              m.redraw();
            },
            title: 'Dismiss',
          },
          '✕',
        ),
      ]),
      m('div.sp-sel-card-meta', [
        m('span.sp-meta-pill', ['⏱ ', m('strong', dur)]),
        m('span.sp-meta-pill', ['📍 ', `${startMs}ms – ${endMs}ms`]),
        info.sliceCount > 0
          ? m('span.sp-meta-pill', ['📋 ', `${info.sliceCount} slices`])
          : null,
        info.trackCount > 0
          ? m('span.sp-meta-pill', ['🎛 ', `${info.trackCount} tracks`])
          : null,
        info.hasJank
          ? m(
              'span.sp-meta-pill',
              {
                style: 'background:#fef2f2;border-color:#fca5a5;color:#b91c1c',
              },
              ['⚠️ ', `${info.jankCount} jank frames`],
            )
          : null,
      ]),
      info.topSlices.length > 0
        ? m(
            'div',
            {style: 'padding: 0 10px 5px; font-size:11px; color:#6b7280'},
            [
              'Top: ',
              info.topSlices
                .slice(0, 3)
                .map((s, i) =>
                  m('span', {style: 'margin-right:6px'}, [
                    i > 0 ? '· ' : '',
                    m(
                      'strong',
                      s.name.length > 30 ? s.name.slice(0, 30) + '…' : s.name,
                    ),
                    ` (${this.fmtDurMs(s.durMs)})`,
                  ]),
                ),
            ],
          )
        : null,
      m('div.sp-sel-card-actions', [
        m(
          'button.sp-action-btn.sp-action-btn--primary',
          {
            onclick: () =>
              onAction(
                `分析 ${startMs}ms–${endMs}ms 这段时间范围（${dur}），找出性能瓶颈`,
              ),
            disabled: this.state.isLoading,
          },
          '🔍 分析此时间段',
        ),
        info.hasJank
          ? m(
              'button.sp-action-btn.sp-action-btn--secondary',
              {
                onclick: () =>
                  onAction(
                    `分析 ${startMs}ms–${endMs}ms 范围内的 ${info.jankCount} 个 Jank 帧，找出卡顿根因`,
                  ),
                disabled: this.state.isLoading,
              },
              '🚨 找卡顿原因',
            )
          : null,
        m(
          'button.sp-action-btn.sp-action-btn--secondary',
          {
            onclick: () =>
              onAction(`找出 ${startMs}ms–${endMs}ms 时间段内主线程的耗时操作`),
            disabled: this.state.isLoading,
          },
          '🧵 主线程分析',
        ),
        m(
          'button.sp-action-btn.sp-action-btn--secondary',
          {
            onclick: () =>
              onAction(`分析 ${startMs}ms–${endMs}ms 内的 Binder 调用和锁竞争`),
            disabled: this.state.isLoading,
          },
          '🔗 Binder/锁',
        ),
      ]),
    ]);
  }

  /**
   * Called on every handleChatMessage() so the backend always gets the latest selection.
   */
  private messageReferencesCurrentRange(message?: string): boolean {
    if (!message) return false;
    return RANGE_REFERENCE_PATTERNS.some((pattern) => pattern.test(message));
  }

  private captureVisibleWindowContext(message?: string): SelectionContext | null {
    if (!this.trace || !this.messageReferencesCurrentRange(message)) return null;
    const visibleSpan = this.trace.timeline.visibleWindow.toTimeSpan();
    const startNs = Number(visibleSpan.start);
    const endNs = Number(visibleSpan.end);
    if (!Number.isFinite(startNs) || !Number.isFinite(endNs) || endNs <= startNs) {
      return null;
    }
    return {
      kind: 'area',
      source: 'visible_window',
      startNs,
      endNs,
      durationNs: endNs - startNs,
      tracks: [],
      trackCount: 0,
    };
  }

  private async captureSelectionContext(
    message?: string,
  ): Promise<SelectionContext | null> {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;

    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      const startNs = Number(sel.start);
      const endNs = Number(sel.end);
      const durationNs = timeSpan ? Number(timeSpan.duration) : endNs - startNs;

      // Resolve track metadata (thread/process names) from track tags
      const tracks = await this.resolveTrackInfos(sel.tracks);

      return {
        kind: 'area',
        source: 'area_selection',
        startNs,
        endNs,
        durationNs,
        tracks,
        trackCount: sel.trackUris.length,
      };
    }

    if (sel.kind === 'track_event') {
      // Reuse pre-queried sliceCardInfo if it matches current selection (avoids redundant SQL)
      const cardInfo =
        this.state.sliceCardInfo?.id === sel.eventId
          ? this.state.sliceCardInfo
          : null;
      const ctx: SelectionContext = {
        kind: 'track_event',
        source: 'track_event_selection',
        trackUri: sel.trackUri,
        eventId: sel.eventId,
        ts: Number(sel.ts),
        dur: sel.dur !== undefined ? Number(sel.dur) : undefined,
      };
      if (cardInfo) {
        ctx.name = cardInfo.name;
        ctx.threadName = cardInfo.threadName;
        ctx.processName = cardInfo.processName;
        ctx.depth = cardInfo.depth;
        ctx.childCount = cardInfo.childCount;
      }
      console.log(
        '[AIPanel] captureSelectionContext: track_event captured',
        ctx,
      );
      return ctx;
    }

    const visibleWindowContext = this.captureVisibleWindowContext(message);
    if (visibleWindowContext) {
      console.log(
        '[AIPanel] captureSelectionContext: using visible window as range scope',
        visibleWindowContext,
      );
      return visibleWindowContext;
    }

    console.log(
      '[AIPanel] captureSelectionContext: no selection (kind=' +
        sel.kind +
        '), returning null',
    );
    return null;
  }

  /**
   * Batch-resolve track tags (utid/upid/cpu) into human-readable names via SQL.
   */
  private async resolveTrackInfos(
    tracks: ReadonlyArray<import('../../public/track').Track>,
  ): Promise<SelectionTrackInfo[]> {
    const result: SelectionTrackInfo[] = [];
    const utids = new Set<number>();
    const upids = new Set<number>();

    // Collect utid/upid/cpu from track tags
    for (const t of tracks) {
      const info: SelectionTrackInfo = {uri: t.uri};
      if (t.tags?.cpu !== undefined) info.cpu = t.tags.cpu as number;
      if (t.tags?.type) info.kind = t.tags.type as string;
      if (t.tags?.utid !== undefined) {
        info.utid = t.tags.utid as number;
        utids.add(info.utid);
      }
      if (t.tags?.upid !== undefined) {
        info.upid = t.tags.upid as number;
        upids.add(info.upid);
      }
      result.push(info);
    }

    if (!this.engine || (utids.size === 0 && upids.size === 0)) return result;

    // Batch query thread names
    const threadMap = new Map<
      number,
      {name: string; tid: number; upid?: number}
    >();
    if (utids.size > 0) {
      try {
        const q = `SELECT utid, name, tid, upid FROM thread WHERE utid IN (${[...utids].join(',')})`;
        const res = await this.engine.query(q);
        const it = res.iter({});
        while (it.valid()) {
          threadMap.set(Number(it.get('utid')), {
            name: String(it.get('name') ?? ''),
            tid: Number(it.get('tid')),
            upid: it.get('upid') != null ? Number(it.get('upid')) : undefined,
          });
          // Also collect upids from thread rows for process name resolution
          if (it.get('upid') != null) upids.add(Number(it.get('upid')));
          it.next();
        }
      } catch {
        /* non-fatal */
      }
    }

    // Batch query process names
    const processMap = new Map<number, {name: string; pid: number}>();
    if (upids.size > 0) {
      try {
        const q = `SELECT upid, name, pid FROM process WHERE upid IN (${[...upids].join(',')})`;
        const res = await this.engine.query(q);
        const it = res.iter({});
        while (it.valid()) {
          processMap.set(Number(it.get('upid')), {
            name: String(it.get('name') ?? ''),
            pid: Number(it.get('pid')),
          });
          it.next();
        }
      } catch {
        /* non-fatal */
      }
    }

    // Merge resolved names back into result
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const info = result[i];
      const utid = t.tags?.utid as number | undefined;
      const upid = t.tags?.upid as number | undefined;

      if (utid !== undefined) {
        const th = threadMap.get(utid);
        if (th) {
          info.threadName = th.name;
          info.tid = th.tid;
          // Resolve process via thread's upid
          if (th.upid !== undefined) {
            info.upid = th.upid;
            const proc = processMap.get(th.upid);
            if (proc) {
              info.processName = proc.name;
              info.pid = proc.pid;
            }
          }
        }
      }
      if (upid !== undefined && !info.processName) {
        const proc = processMap.get(upid);
        if (proc) {
          info.processName = proc.name;
          info.pid = proc.pid;
        }
      }
    }

    return result;
  }

  private async handleAnrCommand() {
    this.setLoadingState(true);
    m.redraw();

    try {
      const query = `
        SELECT
          id,
          name,
          ts,
          dur / 1e6 as duration_ms,
          EXTRACT_ARG(arg_set_id, 'anr.error_type') as error_type
        FROM slice
        WHERE dur > 5000000000
          AND (category = 'Java' OR name LIKE '%ANR%')
        ORDER BY dur DESC
        LIMIT 20
      `;

      // Store query for pinning
      this.state.lastQuery = query;

      const result = await this.engine?.query(query);
      if (result) {
        const columns = result.columns();
        const rows: any[][] = [];

        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        if (rows.length > 0) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `Found **${rows.length}** potential ANRs in this trace.`,
            timestamp: Date.now(),
            query: query,
            sqlResult: {columns, rows, rowCount: rows.length, query},
          });
        } else {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: '**No ANRs detected** in this trace. Good job!',
            timestamp: Date.now(),
          });
        }
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error detecting ANRs:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleJankCommand() {
    this.setLoadingState(true);
    m.redraw();

    try {
      const query = `
        SELECT
          id,
          name,
          ts,
          dur / 1e6 as duration_ms,
          track_id
        FROM slice
        WHERE category = 'gfx'
          AND dur > 16670000
          AND name LIKE 'Jank%'
        ORDER BY dur DESC
        LIMIT 50
      `;

      // Store query for pinning
      this.state.lastQuery = query;

      const result = await this.engine?.query(query);
      if (result) {
        const columns = result.columns();
        const rows: any[][] = [];

        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        if (rows.length > 0) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `Found **${rows.length}** janky frames in this trace.`,
            timestamp: Date.now(),
            query: query,
            sqlResult: {columns, rows, rowCount: rows.length, query},
          });
        } else {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: '**No jank detected** in this trace. Smooth rendering!',
            timestamp: Date.now(),
          });
        }
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error detecting jank:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleSlowCommand() {
    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content:
          '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。`/slow` 命令需要后端支持。',
        timestamp: Date.now(),
      });
      return;
    }
    await this.handleChatMessage('分析慢操作（IO/数据库/输入事件）');
  }

  private async handleMemoryCommand() {
    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content:
          '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。`/memory` 命令需要后端支持。',
        timestamp: Date.now(),
      });
      return;
    }
    await this.handleChatMessage('分析内存与 GC/LMK 情况');
  }

  /**
   * Ensure backend has an active Agent session for multi-turn continuity.
   * Attempts to restore from backend persistence after reload/restart.
   */
  private async ensureAgentSessionReady(): Promise<void> {
    if (!this.state.agentSessionId || !this.state.backendTraceId) {
      return;
    }

    const sessionId = this.state.agentSessionId;
    try {
      const response = await this.fetchBackend(
        buildAssistantApiV1Url(this.state.settings.backendUrl, '/resume'),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            sessionId,
            traceId: this.state.backendTraceId,
          }),
        },
      );

      if (response.ok) {
        const resumeData = await response.json().catch(() => ({}) as any);
        const requestIdFromHeader = response.headers.get('x-request-id') || '';
        if (
          this.applyAgentObservability({
            ...resumeData,
            requestId: resumeData.requestId || requestIdFromHeader,
          })
        ) {
          this.saveCurrentSession();
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Agent observability updated from resume response:',
              {
                runId: this.state.agentRunId,
                requestId: this.state.agentRequestId,
                runSequence: this.state.agentRunSequence,
              },
            );
        }
        return;
      }

      const errorData = await response.json().catch(() => ({}) as any);
      const code = String(errorData?.code || '');
      const errorText = String(errorData?.error || '');

      // Non-recoverable continuity failures: clear stale session and continue with a new chain.
      if (
        response.status === 404 ||
        code === 'TRACE_ID_MISMATCH' ||
        errorText.includes('Session not found')
      ) {
        console.warn(
          '[AIPanel] Agent session continuity unavailable, falling back to new session:',
          {
            sessionId,
            code,
            errorText,
          },
        );
        this.state.agentSessionId = null;
        this.clearAgentObservability();
        this.saveCurrentSession();
        // P1-F1: Notify user that context continuity was lost
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `⚠️ **上下文已重置** — 之前的分析会话已过期或后端已重启，本次将以新会话开始分析。之前的对话上下文不会被继承。`,
          timestamp: Date.now(),
        });
        m.redraw();
        return;
      }

      throw new Error(
        `resume failed: ${response.status} ${errorText || response.statusText}`,
      );
    } catch (error) {
      console.warn(
        '[AIPanel] Failed to ensure Agent session continuity:',
        error,
      );
      // Keep current sessionId in state for potential transient backend failures.
    }
  }

  private async tryRecoverMissingSseSession(
    sessionId: string,
  ): Promise<'restored' | 'notRecoverable' | 'transientError'> {
    if (!this.state.backendTraceId) {
      return 'notRecoverable';
    }

    try {
      this.upsertSseStatusMessage(
        '正在恢复会话：后端可能刚刚重启，正在重新绑定分析上下文。',
      );
      m.redraw();

      const response = await this.fetchBackend(
        buildAssistantApiV1Url(this.state.settings.backendUrl, '/resume'),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            sessionId,
            traceId: this.state.backendTraceId,
          }),
        },
      );

      if (response.ok) {
        const resumeData = await response.json().catch(() => ({}) as any);
        const requestIdFromHeader = response.headers.get('x-request-id') || '';
        this.state.agentSessionId = sessionId;
        this.state.sseLastEventId = null;
        if (
          this.applyAgentObservability({
            ...resumeData,
            requestId: resumeData.requestId || requestIdFromHeader,
          })
        ) {
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Agent observability updated from SSE resume:',
              {
                runId: this.state.agentRunId,
                requestId: this.state.agentRequestId,
                runSequence: this.state.agentRunSequence,
              },
            );
        }
        this.upsertSseStatusMessage(
          '后端已重启，已恢复会话，正在重新连接结果流。',
        );
        this.saveCurrentSession();
        m.redraw();
        return 'restored';
      }

      const errorData = await response.json().catch(() => ({}) as any);
      const code = String(errorData?.code || '');
      const errorText = String(errorData?.error || '');
      if (
        response.status === 404 ||
        code === 'TRACE_ID_MISMATCH' ||
        code === 'TRACE_NOT_UPLOADED' ||
        errorText.includes('Session not found')
      ) {
        this.state.agentSessionId = null;
        this.state.sseLastEventId = null;
        this.state.sseConnectionState = 'disconnected';
        this.clearAgentObservability();
        this.setLoadingState(false);
        const content =
          code === 'TRACE_NOT_UPLOADED'
            ? '后端已重启，当前 Trace 需要重新连接。请点击右上角“重试连接”重新上传 Trace 后再分析。'
            : '后端已重启，当前分析会话无法恢复。本次流式分析已停止，请重新发起分析。';
        this.upsertSseStatusMessage(content);
        this.saveCurrentSession();
        m.redraw();
        return 'notRecoverable';
      }

      console.warn('[AIPanel] SSE session recovery returned retryable error:', {
        status: response.status,
        code,
        errorText,
      });
      return 'transientError';
    } catch (error) {
      console.warn('[AIPanel] SSE session recovery failed:', error);
      return 'transientError';
    }
  }

  private async handleChatMessage(message: string) {
    if (DEBUG_AI_PANEL)
      console.log('[AIPanel] handleChatMessage called with:', message);
    if (DEBUG_AI_PANEL)
      console.log('[AIPanel] backendTraceId:', this.state.backendTraceId);

    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content:
          '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。后端将执行 SQL 查询并提供详细分析。',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    this.state.completionHandled = false; // Reset completion flag for new analysis
    this.state.displayedSkillProgress.clear(); // Clear progress tracking for new analysis
    this.state.collectedErrors = []; // Clear error collection for new analysis
    this.resetStreamingFlow(); // Reset progressive transcript for new analysis turn
    this.resetStreamingAnswer(); // Reset incremental answer stream for new analysis turn
    // AI Everywhere: update cross-component state + clear old timeline notes
    updateAISharedState({
      status: 'analyzing',
      findings: [],
      currentPhase: '',
      issueCount: 0,
    });
    if (this.trace) clearAIFindingNotes(this.trace);
    m.redraw();

    try {
      // Ensure prior multi-turn context is restored when possible.
      await this.ensureAgentSessionReady();

      // Call Agent API (Agent-Driven Orchestrator)
      const apiUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        '/analyze',
      );
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Calling Agent API:',
          apiUrl,
          'with traceId:',
          this.state.backendTraceId,
        );

      // Build request body, include sessionId for multi-turn dialogue
      const requestBody: Record<string, any> = {
        query: message,
        traceId: this.state.backendTraceId,
        options: {
          maxRounds: 3, // Reduced to avoid unnecessary iterations
          confidenceThreshold: 0.5, // Match backend default
          maxNoProgressRounds: 2,
          maxFailureRounds: 2,
          analysisMode: this.state.analysisMode,
        },
      };

      // Comparison mode: include reference trace ID
      if (this.state.referenceTraceId) {
        requestBody.referenceTraceId = this.state.referenceTraceId;
      }

      // Capture current Perfetto selection (area / slice) and include in request
      const selectionContext = await this.captureSelectionContext(message);
      if (selectionContext) {
        requestBody.selectionContext = selectionContext;
        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Injecting selectionContext:',
            selectionContext,
          );
        if (!this.state.referenceTraceId && !this.state.pendingTraceContext) {
          const datasets = await this.querySelectionData(selectionContext);
          this.state.pendingTraceContext =
            datasets.length > 0 ? datasets : null;
        }
      }

      // Attach pre-queried trace data (set by quick-action buttons) and consume it
      if (this.state.pendingTraceContext) {
        requestBody.traceContext = this.state.pendingTraceContext;
        this.state.pendingTraceContext = null;
      }

      // Include agentSessionId if available for multi-turn dialogue
      if (this.state.agentSessionId) {
        requestBody.sessionId = this.state.agentSessionId;
        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Reusing Agent session for multi-turn dialogue:',
            this.state.agentSessionId,
          );
      }

      const response = await this.fetchBackend(apiUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(requestBody),
      });

      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Agent API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (
          errorData.code === 'TRACE_NOT_UPLOADED' ||
          errorData.error?.includes('not found')
        ) {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content:
              '⚠️ **后端未找到该 Trace**\n\nTrace 可能已过期。请点击右上角"重试连接"按钮重新上传。',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          // P1-F6: Also clear stale agentSessionId when trace is gone
          this.state.agentSessionId = null;
          this.clearAgentObservability();
          // Note: Don't return early - let finally block handle cleanup
          const error = new Error('TRACE_NOT_FOUND');
          (error as any).code = 'TRACE_NOT_FOUND';
          throw error; // Will be caught and cleanup will run
        }
        const error = new Error(
          `API error: ${response.status} ${errorData.error || response.statusText}`,
        );
        (error as any).code = errorData.code;
        (error as any).terminalStatus = errorData.status;
        throw error;
      }

      const data = await response.json();
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Agent API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Analysis failed');
      }

      const requestIdFromHeader = response.headers.get('x-request-id') || '';
      const observabilityUpdated = this.applyAgentObservability({
        ...data,
        requestId: data.requestId || requestIdFromHeader,
      });
      if (observabilityUpdated) {
        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Agent observability updated from analyze response:',
            {
              runId: this.state.agentRunId,
              requestId: this.state.agentRequestId,
              runSequence: this.state.agentRunSequence,
            },
          );
      }

      // Use SSE for real-time progress updates
      const sessionId = data.sessionId;
      if (sessionId) {
        // Save sessionId for multi-turn dialogue
        // Only save if this is a new session or reusing existing session
        const isNewSession = data.isNewSession !== false;
        if (isNewSession) {
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Saving new Agent session for multi-turn dialogue:',
              sessionId,
            );
        } else {
          if (DEBUG_AI_PANEL)
            console.log(
              '[AIPanel] Continuing existing Agent session:',
              sessionId,
            );
        }
        this.state.agentSessionId = sessionId;
        this.saveCurrentSession();

        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Starting Agent SSE listener for session:',
            sessionId,
          );
        await this.listenToAgentSSE(sessionId);
      } else {
        if (DEBUG_AI_PANEL)
          console.log('[AIPanel] No sessionId in response, data:', data);
      }
    } catch (e: any) {
      const message = e?.message || 'Failed to start analysis';
      const quotaStopped =
        e?.terminalStatus === 'quota_exceeded' ||
        e?.code === 'QUOTA_EXCEEDED' ||
        e?.code === 'BUDGET_EXCEEDED' ||
        /quota|budget|配额|预算/i.test(message);
      updateAISharedState({
        status: quotaStopped ? 'quota_exceeded' : 'error',
        currentPhase: '',
      });
      // Don't show duplicate error message for TRACE_NOT_FOUND (already shown above)
      if (message !== 'TRACE_NOT_FOUND') {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `**Error:** ${message}`,
          timestamp: Date.now(),
        });
      }
    } finally {
      // Always reset loading state, even on early returns via thrown errors
      this.setLoadingState(false);
      m.redraw();
    }
  }

  private async handleSmartAnalysisCommand(selection?: SmartSceneSelectionRequest) {
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content:
          '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。',
        timestamp: Date.now(),
      });
      return;
    }

    if (this.state.referenceTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '智能分析暂不支持对比模式。请先退出 Trace 对比后再运行。',
        timestamp: Date.now(),
      });
      return;
    }

    const smartAction = selection ? 'analyze' : 'preview';
    const previewPayload = selection ? this.getSmartPreviewPayload() : undefined;
    const boundSelection = selection
      ? {
          ...selection,
          ...(selection.reportId || !previewPayload?.reportId
            ? {}
            : {reportId: previewPayload.reportId}),
        }
      : undefined;
    if (selection) {
      this.addMessage({
        id: this.generateId(),
        role: 'user',
        content: `智能分析：${boundSelection?.label || '所选场景'}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(true);
    this.state.completionHandled = false;
    this.state.displayedSkillProgress.clear();
    this.state.collectedErrors = [];
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    const existingPreviewReport = this.state.storyState.cachedReport;
    this.state.storyState = {
      ...createStoryPanelState(),
      status: 'running',
      cachedReport: selection ? existingPreviewReport : null,
    };
    updateAISharedState({
      status: 'analyzing',
      findings: [],
      currentPhase: boundSelection ? `智能分析：${boundSelection.label || '所选场景'}` : '智能分析场景盘点',
      issueCount: 0,
    });
    if (this.trace) clearAIFindingNotes(this.trace);
    m.redraw();

    try {
      const apiUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        '/analyze',
      );
      const response = await this.fetchBackend(apiUrl, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          query: '/smart',
          traceId: this.state.backendTraceId,
          ...(boundSelection && this.state.agentSessionId
            ? {sessionId: this.state.agentSessionId}
            : {}),
          options: {
            analysisMode: this.state.analysisMode,
            preset: 'smart',
            smartAction,
            ...(boundSelection ? {smartSelection: boundSelection} : {}),
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const error = new Error(
          `API error: ${response.status} ${errorData.error || response.statusText}`,
        );
        (error as any).code = errorData.code;
        (error as any).terminalStatus = errorData.status;
        throw error;
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Smart analysis failed');
      }

      const requestIdFromHeader = response.headers.get('x-request-id') || '';
      this.applyAgentObservability({
        ...data,
        requestId: data.requestId || requestIdFromHeader,
      });

      const sessionId = data.sessionId;
      if (sessionId) {
        this.state.agentSessionId = sessionId;
        this.state.storyState.analysisId = sessionId;
        this.saveCurrentSession();
        await this.listenToAgentSSE(sessionId);
      }
    } catch (e: any) {
      const message = e?.message || 'Failed to start smart analysis';
      updateAISharedState({
        status:
          e?.terminalStatus === 'quota_exceeded' ||
          e?.code === 'QUOTA_EXCEEDED' ||
          e?.code === 'BUDGET_EXCEEDED'
            ? 'quota_exceeded'
            : 'error',
        currentPhase: '',
      });
      this.state.storyState = {
        ...this.state.storyState,
        status: 'failed',
        lastError: message,
      };
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error:** ${message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Calculate exponential backoff delay for SSE reconnection
   * Base: 1 second, Max: 30 seconds
   */
  private calculateBackoffDelay(retryCount: number): number {
    const baseDelay = 1000; // 1 second
    const maxDelay = 30000; // 30 seconds
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    // Add jitter (±20%) to prevent thundering herd
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  /**
   * Cancel any ongoing SSE connection
   */
  private cancelSSEConnection(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    this.state.sseConnectionState = 'disconnected';
  }

  /**
   * User-initiated analysis cancellation. Aborts the SSE stream,
   * resets loading state, and adds a cancellation notice to chat.
   */
  private cancelAnalysis(): void {
    this.cancelSSEConnection();
    this.setLoadingState(false);
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    // P1-4: Best-effort notify backend to stop consuming tokens
    if (this.state.agentSessionId) {
      const cancelUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        `/${this.state.agentSessionId}/cancel`,
      );
      this.fetchBackend(cancelUrl, {method: 'POST'}).catch(() => {});
    }
    // P2-10: Mark orphaned streaming-flow messages as cancelled
    for (const msg of this.state.messages) {
      if (msg.flowTag === 'streaming_flow') {
        msg.content = '_分析已取消_';
      }
    }
    // P1-F2: Clear agentSessionId after cancellation to avoid resuming a mid-cancelled session
    this.state.agentSessionId = null;
    this.clearAgentObservability();
    this.saveCurrentSession();
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: '分析已取消。下次分析将以新会话开始。',
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * Listen to Agent SSE events from MasterOrchestrator
   * With automatic reconnection and exponential backoff.
   *
   * @param sessionId The agent session ID to stream from.
   * @param resumeFromLastEventId If true, preserve the current
   *   `sseLastEventId` so the backend replays events from that point.
   *   Used by transient state restore after Pop Out / Dock Back.
   */
  private async listenToAgentSSE(
    sessionId: string,
    resumeFromLastEventId: boolean = false,
  ): Promise<void> {
    const apiUrl = buildAgentSseStreamUrl(
      this.state.settings.backendUrl,
      sessionId,
    );

    // Cancel any existing connection
    this.cancelSSEConnection();

    // Create new AbortController for this connection
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    // Mark as connecting
    this.state.sseConnectionState = 'connecting';
    this.state.sseRetryCount = 0;
    if (!resumeFromLastEventId) {
      this.state.sseLastEventId = null; // Reset for fresh connection; preserved across reconnects
    }
    m.redraw();

    // Main connection loop with retry logic
    let attemptedSessionRecovery = false;
    while (this.state.sseRetryCount <= this.state.sseMaxRetries) {
      try {
        // Check if aborted before attempting connection
        if (signal.aborted) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE connection aborted');
          return;
        }

        const response = await this.fetchBackend(
          apiUrl,
          buildAgentSseStreamInit(signal, this.state.sseLastEventId),
        );
        if (!response.ok) {
          if (response.status === 404 && !attemptedSessionRecovery) {
            attemptedSessionRecovery = true;
            const recovery = await this.tryRecoverMissingSseSession(sessionId);
            if (recovery === 'restored') {
              continue;
            }
            if (recovery === 'notRecoverable') {
              return;
            }
          }

          // P2-2: 4xx errors are not transient (bad request, not found, etc.) — don't retry
          if (response.status >= 400 && response.status < 500) {
            console.error(
              `[AIPanel] SSE got ${response.status} — not retryable, giving up`,
            );
            this.state.sseConnectionState = 'disconnected';
            this.setLoadingState(false);
            this.upsertSseStatusMessage(
              `后端连接失败：${response.status} ${response.statusText}`,
            );
            m.redraw();
            return;
          }
          throw new Error(
            `Agent SSE connection failed: ${response.statusText}`,
          );
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        // Connection successful - update state
        this.state.sseConnectionState = 'connected';
        this.state.sseRetryCount = 0;
        this.state.sseLastEventTime = Date.now();
        if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE connected successfully');
        m.redraw();

        const decoder = new TextDecoder();
        let buffer = '';
        // Persist event type across read chunks to handle large payloads
        // that may span multiple reader.read() calls
        let currentEventType = '';

        // Read loop
        while (true) {
          // Check if aborted
          if (signal.aborted) {
            if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE reader aborted');
            reader.releaseLock();
            return;
          }

          const {done, value} = await reader.read();
          if (done) {
            if (DEBUG_AI_PANEL)
              console.log('[AIPanel] SSE stream ended normally');
            reader.releaseLock();
            // Stream ended normally (server closed), no need to reconnect
            this.state.sseConnectionState = 'disconnected';
            m.redraw();
            return;
          }

          buffer += decoder.decode(value, {stream: true});
          this.state.sseLastEventTime = Date.now();

          // Process complete SSE messages
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith(':')) continue; // Skip keep-alive comments

            if (line.startsWith('id:')) {
              // F3: Track last event sequence ID for replay on reconnect
              const id = parseInt(line.replace('id:', '').trim(), 10);
              if (!isNaN(id)) {
                this.state.sseLastEventId = id;
              }
            } else if (line.startsWith('event:')) {
              currentEventType = line.replace('event:', '').trim();
            } else if (line.startsWith('data:')) {
              const dataStr = line.replace('data:', '').trim();
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr);
                  const eventType = currentEventType || data.type;
                  if (!eventType) {
                    console.warn(
                      '[AIPanel] SSE event with no type, skipping:',
                      Object.keys(data),
                    );
                  } else {
                    const observabilityUpdated =
                      this.applyAgentObservability(data);
                    if (observabilityUpdated) {
                      this.saveCurrentSession();
                      if (DEBUG_AI_PANEL)
                        console.log(
                          '[AIPanel] Agent observability updated from SSE:',
                          {
                            eventType,
                            runId: this.state.agentRunId,
                            requestId: this.state.agentRequestId,
                            runSequence: this.state.agentRunSequence,
                          },
                        );
                    }
                    if (DEBUG_AI_PANEL)
                      console.log('[AIPanel] Agent SSE event:', eventType);
                    this.handleSSEEvent(eventType, data);

                    // Check for terminal events (no need to reconnect after these)
                    // 'conclusion' from agentv3 is near-terminal (answer done) but
                    // 'analysis_completed' follows with reportUrl after HTML report
                    // generation. Only close on analysis_completed/analysis_cancelled/error/end.
                    if (
                      eventType === 'analysis_completed' ||
                      eventType === 'analysis_cancelled' ||
                      eventType === 'error' ||
                      eventType === 'end'
                    ) {
                      this.flushSessionSave();
                      this.cancelSSEConnection();
                      m.redraw();
                      return;
                    }
                  }
                } catch (e) {
                  console.error(
                    '[AIPanel] Failed to parse Agent SSE data:',
                    e,
                    dataStr.substring(0, 200),
                  );
                }
              }
              currentEventType = '';
            }
          }
        }
      } catch (e: any) {
        // Check if this was an intentional abort
        if (signal.aborted || e.name === 'AbortError') {
          if (DEBUG_AI_PANEL)
            console.log('[AIPanel] SSE connection intentionally aborted');
          this.state.sseConnectionState = 'disconnected';
          return;
        }

        console.error(
          '[AIPanel] Agent SSE error (attempt',
          this.state.sseRetryCount + 1,
          '):',
          e,
        );

        // Check if we have retries left
        if (this.state.sseRetryCount >= this.state.sseMaxRetries) {
          // Max retries exceeded - give up
          console.error('[AIPanel] SSE max retries exceeded, giving up');
          this.state.sseConnectionState = 'disconnected';
          this.setLoadingState(false);
          this.upsertSseStatusMessage(
            `后端连接失败：${e.message || 'Agent 后端连接中断'}\n\n已重试 ${this.state.sseMaxRetries} 次，请重新发起分析。`,
          );
          m.redraw();
          return;
        }

        // Schedule reconnection with exponential backoff
        this.state.sseRetryCount++;
        this.state.sseConnectionState = 'reconnecting';
        const delay = this.calculateBackoffDelay(this.state.sseRetryCount - 1);
        if (DEBUG_AI_PANEL)
          console.log(
            `[AIPanel] SSE reconnecting in ${delay}ms (attempt ${this.state.sseRetryCount}/${this.state.sseMaxRetries})`,
          );

        // Update UI to show reconnecting status
        this.upsertSseStatusMessage(
          `连接中断，正在重连...（第 ${this.state.sseRetryCount}/${this.state.sseMaxRetries} 次）`,
        );
        m.redraw();

        // Wait before retrying (unless aborted)
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, delay);
          // If aborted during wait, clear timeout and resolve immediately
          const abortHandler = () => {
            clearTimeout(timeoutId);
            resolve();
          };
          signal.addEventListener('abort', abortHandler, {once: true});
        });

        if (signal.aborted) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE retry wait aborted');
          return;
        }

        // Check if analysis already completed while disconnected
        if (await this.checkSessionStatus(sessionId, signal)) {
          return;
        }
      }
    }
  }

  /**
   * Check backend session status after SSE reconnect.
   * If analysis already completed/failed during disconnect, finalize the UI.
   * Returns true if the session is terminal (no need to reconnect).
   */
  private async checkSessionStatus(
    sessionId: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      const statusUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        `/${sessionId}/status`,
      );
      const res = await this.fetchBackend(statusUrl, {signal});
      if (!res.ok) return false;
      const body = await res.json();
      const status = body.status || body.state;
      if (status === 'completed' || status === 'quota_exceeded' || status === 'cancelled' || status === 'failed') {
        if (DEBUG_AI_PANEL)
          console.log(
            '[AIPanel] Session already',
            status,
            '— stopping SSE reconnect',
          );
        this.state.sseConnectionState = 'disconnected';
        this.setLoadingState(false);
        updateAISharedState({
          status:
            status === 'failed'
              ? 'error'
              : status === 'cancelled'
                ? 'cancelled'
              : status === 'quota_exceeded'
                ? 'quota_exceeded'
                : body.result?.partial === true
                  ? 'partial'
                : 'completed',
          currentPhase: '',
          ...(status === 'failed' ? {} : {lastAnalysisTime: Date.now()}),
        });
        // Remove reconnecting indicator if present
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (
          lastMsg?.role === 'assistant' &&
          lastMsg.content.startsWith('\u{1F504}')
        ) {
          this.state.messages.pop();
        }
        if (status === 'failed') {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Analysis failed** while reconnecting. Please try again.`,
            timestamp: Date.now(),
          });
        } else if (status === 'cancelled') {
          this.handleSSEEvent('analysis_cancelled', {
            type: 'analysis_cancelled',
            data: {
              reason: body.error || 'Analysis cancelled while reconnecting',
              terminalRunStatus: 'cancelled',
            },
            timestamp: Date.now(),
          });
        } else if (body.result && typeof body.result === 'object') {
          this.handleSSEEvent('analysis_completed', {
            type: 'analysis_completed',
            architecture: 'agent-driven',
            data: {
              ...body.result,
              terminalRunStatus: status === 'quota_exceeded'
                ? 'quota_exceeded'
                : 'completed',
            },
            timestamp: Date.now(),
          });
        } else if (status === 'quota_exceeded') {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Analysis stopped by quota limit** while reconnecting. The partial result is available from the completed session.`,
            timestamp: Date.now(),
          });
        }
        this.flushSessionSave();
        m.redraw();
        return true;
      }
    } catch {
      // Status check failed — continue with reconnect attempt
    }
    return false;
  }

  private buildTeachingPipelineRequestContext(): {
    packageName?: string;
    visibleWindow?: {startTs: number; endTs: number};
    selectionContext?: Record<string, unknown>;
  } {
    const visibleSpan = this.trace?.timeline?.visibleWindow?.toTimeSpan?.();
    const visibleWindow = visibleSpan
      ? {
          startTs: Number(visibleSpan.start),
          endTs: Number(visibleSpan.end),
        }
      : undefined;
    const selection = this.trace?.selection?.selection;
    const sliceInfo = this.state.sliceCardInfo;
    const areaInfo = this.state.areaCardInfo;
    const selectionContext =
      selection?.kind === 'track_event'
        ? {
            kind: 'track_event',
            eventId: selection.eventId,
            ts: sliceInfo?.ts ?? Number(selection.ts),
            dur:
              sliceInfo?.dur ??
              (selection.dur !== undefined ? Number(selection.dur) : undefined),
            name: sliceInfo?.name,
            threadName: sliceInfo?.threadName,
            processName: sliceInfo?.processName,
          }
        : selection?.kind === 'area'
          ? {
              kind: 'area',
              startTs: areaInfo?.startNs ?? Number(selection.start),
              endTs: areaInfo?.endNs ?? Number(selection.end),
              durationMs: areaInfo?.durationMs,
            }
          : undefined;

    return {
      packageName: sliceInfo?.processName || undefined,
      visibleWindow,
      selectionContext,
    };
  }

  private buildTeachingPipelineMarkdown(
    result: TeachingPipelineResult,
    pinExecution?: TeachingPinExecutionResult,
  ): string {
    const content = teachingContent(result);
    const observedFlow = result.observedFlow;
    const detection = result.detection;
    const pipelineType = teachingPrimaryPipelineId(result);
    const confidence = formatTeachingConfidence(teachingPrimaryConfidence(result));
    const lines: string[] = [
      '## 🎓 渲染管线教学',
      '',
      '### 检测结果',
      `- **管线类型**: \`${pipelineType}\` (置信度: ${confidence})`,
    ];

    const subvariants = detection.subvariants || {};
    for (const [label, value] of [
      ['Buffer 模式', subvariants.buffer_mode],
      ['Flutter 引擎', subvariants.flutter_engine],
      ['WebView 模式', subvariants.webview_mode],
      ['游戏引擎', subvariants.game_engine],
    ]) {
      if (value && value !== 'UNKNOWN' && value !== 'N/A') {
        lines.push(`- **${label}**: ${value}`);
      }
    }

    if (detection.candidates && detection.candidates.length > 1) {
      lines.push(
        `- **候选类型**: ${detection.candidates
          .slice(0, 5)
          .map(
            (candidate) =>
              `${candidate.id} (${formatTeachingConfidence(candidate.confidence)})`,
          )
          .join(', ')}`,
      );
    }
    if (detection.features && detection.features.length > 0) {
      lines.push(
        `- **伴随特性**: ${detection.features
          .map((feature) => teachingFeatureName(feature))
          .join(', ')}`,
      );
    }

    lines.push('', '### 当前 Trace 实际链路');
    if (observedFlow?.context?.timeRange) {
      const {startTs, endTs, source} = observedFlow.context.timeRange;
      lines.push(
        `- **时间范围**: ${formatTeachingNs(startTs)} ~ ${formatTeachingNs(endTs)} ns (${source})`,
      );
    }
    if (observedFlow?.context?.fallbackUsed) {
      lines.push(`- **上下文 fallback**: ${observedFlow.context.fallbackUsed}`);
    }
    lines.push(`- **观测泳道**: ${observedFlow?.lanes?.length || 0}`);
    lines.push(`- **实际事件**: ${observedFlow?.events?.length || 0}`);
    lines.push(`- **调度依赖**: ${observedFlow?.dependencies?.length || 0}`);
    lines.push(`- **Critical task / Wakeup**: ${observedFlow?.criticalTasks?.length || 0}`);
    if (observedFlow?.lanes?.length) {
      lines.push('', '| Lane | 角色 | Trace 标识 | 置信度 | 证据 |');
      lines.push('|------|------|------------|--------|------|');
      for (const lane of observedFlow.lanes.slice(0, 12)) {
        const marker = lane.threadName || lane.processName || lane.layerName || '-';
        lines.push(
          `| ${lane.title || lane.id} | ${lane.role} | ${marker} | ${formatTeachingConfidence(lane.confidence)} | ${lane.evidenceSource || '-'} |`,
        );
      }
    }
    if (observedFlow?.dependencies?.length) {
      const lanesById = new Map((observedFlow.lanes || []).map((lane) => [lane.id, lane]));
      lines.push('', '| From | Relation | To | Evidence |');
      lines.push('|------|----------|----|----------|');
      for (const dependency of observedFlow.dependencies.slice(0, 16)) {
        const from = lanesById.get(dependency.fromLaneId);
        const to = lanesById.get(dependency.toLaneId);
        lines.push(
          `| ${from?.title || dependency.fromLaneId} | ${dependency.relation} | ${to?.title || dependency.toLaneId} | ${dependency.evidenceSource || dependency.detail || '-'} |`,
        );
      }
    }
    if (observedFlow?.criticalTasks?.length) {
      lines.push('', '| Kind | Task | Waker | ts(ns) | dur | Evidence |');
      lines.push('|------|------|-------|--------|-----|----------|');
      for (const task of observedFlow.criticalTasks.slice(0, 16)) {
        const owner =
          [task.threadName, task.processName].filter(Boolean).join(' / ') ||
          task.name ||
          '-';
        const waker = task.waker
          ? [task.waker.threadName, task.waker.processName].filter(Boolean).join(' / ') ||
            task.waker.kind ||
            '-'
          : '-';
        lines.push(
          `| ${task.kind} | ${owner} | ${waker} | ${formatTeachingNs(task.ts)} | ${formatTeachingMs(task.durMs)} | ${task.evidenceSource || '-'} |`,
        );
      }
    }
    if (observedFlow?.events?.length) {
      lines.push('', '| Stage | Slice | Thread / Process | ts(ns) | dur |');
      lines.push('|-------|-------|------------------|--------|-----|');
      for (const event of observedFlow.events.slice(0, 16)) {
        const owner = [event.threadName, event.processName]
          .filter(Boolean)
          .join(' / ') || '-';
        lines.push(
          `| ${event.stage} | ${event.name} | ${owner} | ${formatTeachingNs(event.ts)} | ${formatTeachingMs(event.durMs)} |`,
        );
      }
    }
    if (observedFlow?.completeness?.missingSignals?.length) {
      lines.push('', '### 采集/观测缺口');
      for (const missing of observedFlow.completeness.missingSignals) {
        lines.push(`- ${missing}`);
      }
    }

    if (content) {
      lines.push('', '---', '', `### ${content.title}`, '', content.summary || '');
      if (content.threadRoles?.length) {
        lines.push('', '#### 关键线程角色', '', '| 线程 | 职责 | Trace 标签 |');
        lines.push('|------|------|------------|');
        for (const role of content.threadRoles) {
          lines.push(
            `| ${role.thread} | ${role.responsibility} | ${role.traceTag || '-'} |`,
          );
        }
      }
      if (content.keySlices?.length) {
        lines.push('', '#### 关键 Slice', `\`${content.keySlices.join('`, `')}\``);
      }
      if (content.mermaidBlocks?.length) {
        lines.push('', '#### 时序图', '', '```mermaid');
        lines.push(content.mermaidBlocks[0]);
        lines.push('```');
      }
    }

    const traceWarnings =
      detection.trace_requirements_missing ||
      detection.traceRequirementsMissing ||
      [];
    if (traceWarnings.length > 0) {
      lines.push('', '### 采集建议');
      for (const hint of traceWarnings) lines.push(`- ${hint}`);
    }
    if (result.warnings?.length) {
      lines.push('', '### 教学结果提示');
      for (const warning of result.warnings.slice(0, 20)) {
        lines.push(
          `- [${warning.severity || 'info'}] ${warning.message || warning.code || 'warning'}`,
        );
      }
    }
    if (pinExecution) {
      lines.push('', '### Pin 执行结果');
      lines.push(`- 已 pin: ${pinExecution.count}`);
      lines.push(`- 未命中/跳过: ${pinExecution.skipped}`);
      lines.push(`- 失败: ${pinExecution.failed}`);
      if (pinExecution.missingPatterns?.length > 0) {
        lines.push(`- 未命中的 pattern: ${pinExecution.missingPatterns.join(', ')}`);
      }
      if (pinExecution.pinnedTrackNames?.length > 0) {
        lines.push(`- 已 pin 的 track: ${pinExecution.pinnedTrackNames.join(', ')}`);
      }
    }

    return lines.join('\n');
  }

  private buildTeachingPinInstructions(
    result: TeachingPipelineResult,
  ): TeachingPinInstruction[] {
    const merged: TeachingPinInstruction[] = [];
    const seen = new Set<string>();
    const addInstruction = (instruction: TeachingPinInstruction | null) => {
      if (!instruction) return;
      const key = [
        instruction.matchBy,
        instruction.pattern,
        instruction.mainThreadOnly ? 'main' : '',
        instruction.activeProcessNames?.join(',') || '',
      ].join('|');
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(instruction);
    };

    for (const instruction of result.pinInstructions || []) {
      addInstruction(instruction);
    }
    for (const [index, hint] of (
      result.pinPlan?.expectedTrackHints || []
    ).entries()) {
      addInstruction(this.pinInstructionFromTrackHint(hint, index));
    }

    return merged.sort((a, b) => a.priority - b.priority);
  }

  private pinInstructionFromTrackHint(
    hint: TeachingTrackHint,
    index: number,
  ): TeachingPinInstruction | null {
    const rawPattern =
      hint.pattern || hint.threadName || hint.processName || hint.layerName;
    if (!rawPattern) return null;

    const label = hint.threadName || hint.processName || hint.layerName || rawPattern;
    const instruction: TeachingPinInstruction = {
      pattern: rawPattern,
      matchBy: 'name',
      priority: 1000 + index,
      reason: `Observed lane: ${label}`,
    };

    if (hint.matchBy === 'uri') {
      instruction.matchBy = 'uri';
    } else if (hint.matchBy === 'process') {
      instruction.matchBy = 'path';
      instruction.pattern = escapeTeachingRegex(hint.processName || rawPattern);
    } else if (hint.matchBy === 'layer') {
      instruction.matchBy = 'path';
      instruction.pattern = escapeTeachingRegex(hint.layerName || rawPattern);
    } else if (hint.matchBy === 'thread') {
      instruction.matchBy = 'name';
      instruction.pattern = `^${escapeTeachingRegex(hint.threadName || rawPattern)}$`;
    } else if (hint.matchBy === 'slice' || hint.matchBy === 'name') {
      instruction.matchBy = 'name';
    }

    if (hint.mainThreadOnly !== undefined) {
      instruction.mainThreadOnly = hint.mainThreadOnly;
    }
    if (hint.processName) {
      instruction.smartPin = true;
      instruction.activeProcessNames = [hint.processName];
    }
    return instruction;
  }

  /**
   * Handle /teaching-pipeline command
   * Detects the rendering pipeline type and shows educational content
   */
  private async handleTeachingPipelineCommand() {
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '⚠️ **无法执行管线检测**\n\n请先确保 Trace 已上传到后端。',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    m.redraw();

    if (DEBUG_AI_PANEL)
      console.log(
        '[AIPanel] Teaching pipeline request with traceId:',
        this.state.backendTraceId,
      );

    try {
      const requestContext = this.buildTeachingPipelineRequestContext();
      const response = await this.fetchBackend(
        buildAssistantApiV1Url(
          this.state.settings.backendUrl,
          '/teaching/pipeline',
        ),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            traceId: this.state.backendTraceId,
            ...requestContext,
          }),
        },
      );

      if (!response.ok) {
        // Try to parse error details from response body
        try {
          const errorData = await response.json();
          console.error(
            '[AIPanel] Teaching pipeline error response:',
            errorData,
          );
          throw new Error(
            errorData.error ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        } catch (parseErr) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data = (await response.json()) as TeachingPipelineResult & {
        error?: string;
      };
      if (!data.success) {
        throw new Error(data.error || 'Pipeline detection failed');
      }

      const pinInstructions = this.buildTeachingPinInstructions(data);
      const activeRenderingProcesses = data.activeRenderingProcesses || [];
      let pinExecution: TeachingPinExecutionResult | undefined;
      if (pinInstructions.length > 0 && this.trace) {
        pinExecution = await this.pinTracksFromInstructions(
          pinInstructions,
          activeRenderingProcesses,
        );
      }

      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: this.buildTeachingPipelineMarkdown(data, pinExecution),
        timestamp: Date.now(),
        teachingPipeline: data,
        teachingPinExecution: pinExecution,
      });
    } catch (error: any) {
      console.error('[AIPanel] Teaching pipeline error:', error);
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `❌ **管线检测失败**\n\n${error.message || '未知错误'}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  // Scene reconstruction constants (SCENE_DISPLAY_NAMES / SCENE_PIN_MAPPING /
  // SCENE_THRESHOLDS and rating helpers) live in ./scene_constants.ts.
  // AIPanel consumes them only indirectly through story_controller.ts.

  // =============================================================================
  // Scene Reconstruction (delegates to StoryController)
  // =============================================================================
  // Controller logic lives in ./story_controller.ts; AIPanel keeps only the
  // thin command-dispatch wrapper below.

  private storyController: StoryController | null = null;

  private getOrCreateStoryController(): StoryController {
    if (!this.storyController) {
      const ctx: StoryControllerContext = {
        getBackendTraceId: () => this.state.backendTraceId,
        getBackendUrl: () => this.state.settings.backendUrl,
        getTrace: () => this.trace,
        addMessage: (msg) => this.addMessage(msg),
        updateMessage: (id, updates) => this.updateMessage(id, updates),
        generateId: () => this.generateId(),
        setLoadingState: (loading) => this.setLoadingState(loading),
        fetchBackend: (url, opts) => this.fetchBackend(url, opts),
        pinTracksFromInstructions: async (insts, procs) => {
          await this.pinTracksFromInstructions(insts, procs);
        },
        setDetectedScenes: (scenes) => {
          this.state.detectedScenes = scenes;
        },
        debug: DEBUG_AI_PANEL,
      };
      this.storyController = new StoryController(ctx);
    }
    return this.storyController;
  }

  /**
   * Trigger a preview check for scene reconstruction. Called when the Story
   * tab opens with a loaded trace, or when the user explicitly asks for
   * /scene. Hits POST /scene-reconstruct/preview which returns in sub-second
   * for small traces (or ~5-10s for GB-scale files while hashing).
   */
  private async handleStoryPreview() {
    const traceId = this.state.backendTraceId;
    if (!traceId) return;
    if (this.state.storyState.status === 'previewing') return; // dedupe

    this.state.storyState.status = 'previewing';
    this.state.storyState.lastError = null;
    this.state.storyState.preview = null;
    this.state.storyState.cachedReport = null;
    m.redraw();

    try {
      const ctrl = this.getOrCreateStoryController();
      const preview = await ctrl.preview(traceId);
      this.state.storyState.preview = preview;

      if (preview.cached) {
        // Cache hit — auto-load the full report for instant display.
        this.state.storyState.status = 'preview_cached';
        m.redraw();
        try {
          const report = await ctrl.loadReport(preview.cached.reportId);
          this.state.storyState.cachedReport = report;
          this.state.storyState.status = 'completed';

          // Rebuild track overlays from the cached envelopes so the
          // timeline looks the same as a fresh run.
          this.replayOverlaysFromReport(report);

          // Sync detected scenes for the navigation bar.
          if (Array.isArray(report.displayedScenes)) {
            this.state.detectedScenes = report.displayedScenes.map(
              (s: any) => ({
                type: s.sceneType,
                startTs: s.startTs,
                endTs: s.endTs,
                durationMs: s.durationMs,
                appPackage: s.processName,
                metadata: s.metadata,
              }),
            );
          }
        } catch (loadErr: any) {
          // Cached report failed to load (expired between preview and load?).
          // Degrade to cold path so the user can still run fresh.
          console.warn(
            '[AIPanel] Cached report load failed, falling back to cold path:',
            loadErr,
          );
          this.state.storyState.status = 'preview_cold';
        }
      } else {
        this.state.storyState.status = 'preview_cold';
      }
    } catch (err: any) {
      this.state.storyState.status = 'failed';
      this.state.storyState.lastError = err?.message ?? 'Preview failed';
    }
    m.redraw();
  }

  /**
   * User confirmed the cold-path estimate — start the full pipeline.
   * Pass forceRefresh=true to bypass the backend cache (used by "重新分析").
   */
  private async handleStoryConfirm(opts?: {forceRefresh?: boolean}) {
    this.state.storyState.status = 'running';
    this.state.storyState.lastError = null;
    m.redraw();

    try {
      const ctrl = this.getOrCreateStoryController();
      await ctrl.start({forceRefresh: opts?.forceRefresh});
      this.state.storyState.status = 'completed';
    } catch (err: any) {
      this.state.storyState.status = 'failed';
      this.state.storyState.lastError =
        err?.message ?? 'Scene reconstruction failed';
    }
    m.redraw();
  }

  /**
   * Cancel an in-flight pipeline run.
   */
  private async handleStoryCancel() {
    const analysisId = this.state.storyState.analysisId;
    if (!analysisId) return;
    const path =
      analysisId === this.state.agentSessionId
        ? `/${analysisId}/cancel`
        : `/scene-reconstruct/${analysisId}/cancel`;
    try {
      await this.fetchBackend(
        buildAssistantApiV1Url(
          this.state.settings.backendUrl,
          path,
        ),
        {method: 'POST'},
      );
    } catch (e) {
      console.warn('[AIPanel] Cancel request failed:', e);
    }
  }

  /**
   * Handle /scene command — delegates to StoryController and mirrors the
   * lifecycle into storyState so the Story view can show running/completed.
   *
   * StoryController.start() catches its own errors and pushes them to the
   * chat message stream, so from this wrapper's perspective the call always
   * resolves. A future iteration can thread a status callback through the
   * controller context if we need richer progress reporting.
   */
  private async handleSceneReconstructCommand() {
    // Open the Story drawer and trigger preview. Results render in the Story
    // drawer while Chat keeps showing the ongoing conversation.
    this.state.showStorySidebar = true;
    this.state.showSessionSidebar = false;
    void this.handleStoryPreview();
  }

  private renderStorySidebar(): m.Children {
    return m('aside.ai-story-sidebar', [
      m('div.ai-story-sidebar-header', [
        m('i.pf-icon', 'movie'),
        m('span', 'Story'),
        m(
          'button.ai-story-sidebar-close',
          {
            onclick: () => {
              this.state.showStorySidebar = false;
              m.redraw();
            },
            title: '隐藏 Story',
          },
          m('i.pf-icon', 'close'),
        ),
      ]),
      m('div.ai-story-sidebar-body', this.renderStoryBody()),
    ]);
  }

  /**
   * Render the Story Panel body — a state-machine-driven view that walks
   * the user through preview → confirm → pipeline → results, all inline.
   */
  private renderStoryBody(): m.Children {
    const hasTrace = !!this.state.backendTraceId;
    const s = this.state.storyState;

    // Auto-trigger preview when the Story tab opens with a loaded trace.
    if (hasTrace && s.status === 'idle') {
      setTimeout(() => this.handleStoryPreview(), 0);
    }

    return m('div.ai-story-body', [
      m('h2', {style: 'margin: 0 0 8px 0;'}, '🎬 场景还原'),
      m(
        'p',
        {style: 'color: var(--chat-text-secondary); margin: 0 0 16px 0;'},
        '从 Trace 中自动检测用户操作场景并分析性能问题。',
      ),

      !hasTrace
        ? m(
            'div.ai-story-card.ai-story-card--warn',
            '⚠ 请先把 Trace 上传到后端(打开文件后自动完成)',
          )
        : null,

      s.status === 'previewing'
        ? m(
            'div.ai-story-card.ai-story-card--info',
            '⏳ 正在检查缓存与估算成本...',
          )
        : null,

      s.status === 'preview_cached'
        ? m(
            'div.ai-story-card.ai-story-card--success',
            '✅ 发现历史缓存报告,正在加载...',
          )
        : null,

      // Preview: cold path — show estimate + confirm button.
      s.status === 'preview_cold' && s.preview
        ? m('div.ai-story-card.ai-story-card--cold-preview', [
            m('div.ai-story-cold-preview-title', '预估分析成本'),
            m('div.ai-story-cold-preview-metrics', [
              this.renderEstimateMetric(
                `${s.preview.estimate.expectedScenes}`,
                '预估场景数',
              ),
              this.renderEstimateMetric(
                `~${s.preview.estimate.etaSec}s`,
                '预估耗时',
              ),
              this.renderEstimateMetric(
                `$${s.preview.estimate.estimatedUsd}`,
                '预估费用',
              ),
            ]),
            s.preview.estimate.confidence === 'low'
              ? m('div.ai-story-hint', '* 预估基于启发式公式,实际可能有所偏差')
              : null,
            m('div.ai-story-cold-preview-actions', [
              m(
                'button.ai-story-btn-primary',
                {
                  onclick: () => this.handleStoryConfirm(),
                },
                '▶ 开始分析',
              ),
              m(
                'button.ai-story-btn-secondary',
                {
                  onclick: () => {
                    this.state.storyState = createStoryPanelState();
                    m.redraw();
                  },
                },
                '取消',
              ),
            ]),
          ])
        : null,

      s.status === 'running'
        ? m('div.ai-story-card.ai-story-card--info', [
            m('div', {style: 'margin-bottom: 8px;'}, '🎬 场景还原进行中...'),
            m(
              'div',
              {style: 'font-size: 13px; color: var(--chat-text-secondary);'},
              '进度消息同步显示在 Chat 视图中。',
            ),
            m(
              'button.ai-story-btn-ghost-danger',
              {
                onclick: () => this.handleStoryCancel(),
              },
              '取消分析',
            ),
          ])
        : null,

      s.status === 'selection_ready'
        ? m('div.ai-story-card.ai-story-card--cold-preview', [
            m('div.ai-story-cold-preview-title', '选择智能分析范围'),
            m(
              'div',
              {style: 'font-size: 13px; color: var(--chat-text-secondary); margin-bottom: 12px;'},
              `已识别 ${this.getSmartPreviewScenes().length} 个场景。选择后才会开始深钻分析。`,
            ),
            this.renderSmartSelectionButtons('story'),
          ])
        : null,

      s.status === 'completed' ? this.renderStoryCompleted() : null,

      s.status === 'failed'
        ? m('div.ai-story-card.ai-story-card--error', [
            m('div', `❌ ${s.lastError || '场景还原失败'}`),
            m(
              'button.ai-story-btn-retry',
              {
                onclick: () => this.handleStoryPreview(),
              },
              '重试',
            ),
          ])
        : null,
    ]);
  }

  private renderEstimateMetric(value: string, label: string): m.Children {
    return m('div', [
      m('div.ai-story-estimate-metric-value', value),
      m('div.ai-story-estimate-metric-label', label),
    ]);
  }

  /**
   * Render the completed state — either a cached report inline or a
   * "done, check Chat" banner.
   */
  private renderStoryCompleted(): m.Children {
    const report = this.state.storyState.cachedReport;
    const scenes: any[] = report?.displayedScenes ?? [];

    return m('div', [
      m('div.ai-story-card.ai-story-card--success', [
        report
          ? m('div', [
              m(
                'div',
                {style: 'font-weight: 600; margin-bottom: 4px;'},
                `✅ 场景还原完成 — ${scenes.length} 个场景`,
              ),
              report.summary
                ? m(
                    'div',
                    {
                      style:
                        'margin-top: 8px; font-size: 14px; line-height: 1.6;',
                    },
                    report.summary,
                  )
                : null,
              report.cachePolicy === 'disk_7d'
                ? m(
                    'div',
                    {
                      style:
                        'margin-top: 8px; font-size: 12px; color: var(--chat-text-secondary);',
                    },
                    `来自缓存 (${new Date(report.createdAt).toLocaleString()})`,
                  )
                : null,
            ])
          : '✅ 场景还原完成。切换到 Chat 视图查看完整结果。',
      ]),

      scenes.length > 0
        ? m('div.ai-story-scenes-table', [
            m('table', [
              m(
                'thead',
                m(
                  'tr',
                  ['#', '类型', '时长', '应用/进程', '状态'].map((h) =>
                    m('th', h),
                  ),
                ),
              ),
              m(
                'tbody',
                scenes.map((scene: any, i: number) => {
                  const displayName =
                    SCENE_DISPLAY_NAMES[scene.sceneType] ?? scene.sceneType;
                  const dur =
                    scene.durationMs >= 1000
                      ? `${(scene.durationMs / 1000).toFixed(2)}s`
                      : `${Math.round(scene.durationMs)}ms`;
                  const severity =
                    scene.severity === 'bad'
                      ? '🔴'
                      : scene.severity === 'warning'
                        ? '🟡'
                        : scene.severity === 'good'
                          ? '🟢'
                          : '⚪';
                  const stateClass =
                    scene.analysisState === 'completed'
                      ? 'ai-story-scene-state--completed'
                      : scene.analysisState === 'failed'
                        ? 'ai-story-scene-state--failed'
                        : 'ai-story-scene-state--pending';
                  return m(
                    'tr',
                    {
                      key: scene.id,
                      title: `点击跳转到 ${scene.startTs}`,
                    },
                    [
                      m('td.col-index', `${i + 1}`),
                      m('td.col-type', `${severity} ${displayName}`),
                      m('td.col-duration', dur),
                      m('td.col-process', scene.processName ?? '-'),
                      m(
                        'td',
                        m(
                          `span.ai-story-scene-state.${stateClass}`,
                          scene.analysisState ?? 'not_planned',
                        ),
                      ),
                    ],
                  );
                }),
              ),
            ]),
          ])
        : null,

      m(
        'button.ai-story-btn-ghost-accent',
        {
          onclick: () => {
            // Do NOT reset to idle — that re-triggers handleStoryPreview()
            // which hits the cache again and shows the same old result.
            this.state.storyState.cachedReport = null;
            this.state.storyState.preview = null;
            this.handleStoryConfirm({forceRefresh: true});
          },
        },
        '重新分析',
      ),
    ]);
  }

  /**
   * Replay track overlays from a cached SceneReport's envelopes.
   * Called on cache-hit so the timeline looks the same as a fresh run.
   */
  private replayOverlaysFromReport(report: any): void {
    if (!Array.isArray(report?.cachedDataEnvelopes)) return;
    const trace = this.trace;
    if (!trace) return;

    for (const envelope of report.cachedDataEnvelopes) {
      if (
        !envelope?.meta?.stepId ||
        !envelope?.data?.columns ||
        !envelope?.data?.rows
      )
        continue;
      const overlayId = STEP_TO_OVERLAY.get(envelope.meta.stepId);
      if (overlayId) {
        createOverlayTrack(
          trace,
          overlayId,
          envelope.data.columns,
          envelope.data.rows,
        ).catch((err: Error) =>
          console.warn('[AIPanel] Cached overlay creation failed:', err),
        );
      }
    }
  }

  /**
   * Update an existing message by ID
   */
  private updateMessage(
    messageId: string,
    updates: Partial<Message>,
    options: {persist?: boolean} = {},
  ) {
    const index = this.state.messages.findIndex((m) => m.id === messageId);
    if (index !== -1) {
      this.state.messages[index] = {
        ...this.state.messages[index],
        ...updates,
      };
      if (options.persist !== false) {
        this.saveHistory();
        this.saveCurrentSession();
      }
    }
  }

  // =============================================================================
  // Quick Scene Detection (for navigation bar)
  // =============================================================================

  /**
   * Perform quick scene detection for the navigation bar
   * Called automatically when trace loads and manually on refresh
   */
  private async detectScenesQuick() {
    if (!this.state.backendTraceId) {
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] No backend trace ID, skipping quick scene detection',
        );
      return;
    }

    if (this.state.scenesLoading) {
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Scene detection already in progress');
      return;
    }

    this.state.scenesLoading = true;
    this.state.scenesError = null;
    m.redraw();

    if (DEBUG_AI_PANEL)
      console.log(
        '[AIPanel] Starting quick scene detection for trace:',
        this.state.backendTraceId,
      );

    try {
      const response = await this.fetchBackend(
        buildAssistantApiV1Url(
          this.state.settings.backendUrl,
          '/scene-detect-quick',
        ),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            traceId: this.state.backendTraceId,
          }),
        },
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Quick scene detection failed');
      }

      this.state.detectedScenes = data.scenes || [];
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Quick scene detection complete:',
          this.state.detectedScenes.length,
          'scenes',
        );
    } catch (error: any) {
      console.warn('[AIPanel] Quick scene detection failed:', error.message);
      this.state.scenesError = error.message;
      this.state.detectedScenes = [];
    }

    this.state.scenesLoading = false;
    m.redraw();
  }

  /**
   * Pin tracks based on pin instructions from the teaching pipeline API
   * v3 Enhancement: Uses activeRenderingProcesses to only pin RenderThreads from active processes
   * v4 Enhancement: Uses mainThreadOnly to only pin main thread tracks (checks track.chips)
   */
  private async pinTracksFromInstructions(
    instructions: TeachingPinInstruction[],
    activeRenderingProcesses: TeachingActiveRenderingProcess[] = [],
  ): Promise<TeachingPinExecutionResult> {
    const pinnedCount: TeachingPinExecutionResult = {
      count: 0,
      skipped: 0,
      failed: 0,
      attempted: instructions.length,
      missingPatterns: [],
      pinnedTrackNames: [],
    };

    if (!this.trace) {
      return {
        ...pinnedCount,
        reason: 'trace context is not available',
      };
    }

    const workspace = this.trace.currentWorkspace;
    if (!workspace) {
      console.warn('[AIPanel] No workspace available for track pinning');
      return {
        ...pinnedCount,
        reason: 'workspace is not available',
      };
    }

    const sortedInstructions = [...instructions].sort(
      (a, b) => a.priority - b.priority,
    );

    // Build set of active process names for smart filtering
    const activeProcessNames = new Set(
      activeRenderingProcesses.map((p) => p.processName),
    );
    const activeProcessNamesList = Array.from(activeProcessNames);

    const trackActivityCountCache = new Map<string, number>();

    const isCounterOrSliceTrack = (
      uri: string,
      kind: 'CounterTrack' | 'SliceTrack' | 'ThreadStateTrack',
    ): boolean => {
      const track = this.trace?.tracks.getTrack(uri);
      return Boolean(track?.tags?.kinds?.includes(kind));
    };

    // Check if track is suitable for main thread pinning (SliceTrack or ThreadStateTrack)
    const isMainThreadPinnableTrack = (uri: string): boolean => {
      return (
        isCounterOrSliceTrack(uri, 'SliceTrack') ||
        isCounterOrSliceTrack(uri, 'ThreadStateTrack')
      );
    };

    const getTrackActivityCount = async (trackNode: any): Promise<number> => {
      const uri = trackNode?.uri as string | undefined;
      if (!uri) return 0;
      if (trackActivityCountCache.has(uri))
        return trackActivityCountCache.get(uri) ?? 0;

      const track = this.trace?.tracks.getTrack(uri);
      const trackIdsRaw = track?.tags?.trackIds;
      const trackIds = Array.isArray(trackIdsRaw)
        ? trackIdsRaw
            .map((v: any) => Number(v))
            .filter((v: number) => Number.isFinite(v))
        : [];
      if (trackIds.length === 0) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      const engine = this.engine;
      if (!engine) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      let table: 'counter' | 'slice' | undefined;
      if (track?.tags?.kinds?.includes('CounterTrack')) table = 'counter';
      if (track?.tags?.kinds?.includes('SliceTrack')) table = table ?? 'slice';
      if (!table) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      const query = `select count(*) as cnt from ${table} where track_id in (${trackIds.join(',')})`;
      try {
        const result = await engine.query(query);
        const it = result.iter({});
        let count = 0;
        if (it.valid()) {
          const raw = it.get('cnt');
          count = typeof raw === 'bigint' ? Number(raw) : Number(raw);
          if (!Number.isFinite(count)) count = 0;
        }
        trackActivityCountCache.set(uri, count);
        return count;
      } catch {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }
    };

    const activityHints = new Set<string>();
    const flatTracks = workspace.flatTracks;
    if (flatTracks && activeProcessNamesList.length > 0) {
      for (const trackNode of flatTracks) {
        const name = trackNode?.name || '';
        if (!/^BufferTX\b/i.test(name)) continue;
        if (!activeProcessNamesList.some((p) => name.includes(p))) continue;
        const hint = getActivityHintFromBufferTxTrackName(name);
        if (hint) activityHints.add(hint);
      }
    }

    // Debug: Log available track names and active processes
    if (flatTracks) {
      const trackNames = flatTracks.slice(0, 50).map((t) => t.name);
      if (DEBUG_AI_PANEL)
        console.log('[AIPanel] Available track names (first 50):', trackNames);
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Active rendering processes:',
          Array.from(activeProcessNames),
        );
      if (DEBUG_AI_PANEL)
        console.log(
          '[AIPanel] Active surface hints:',
          Array.from(activityHints),
        );
    }

    for (const inst of sortedInstructions) {
      const pinnedBeforeInstruction = pinnedCount.count;
      const skippedBeforeInstruction = pinnedCount.skipped;
      try {
        // v3.1: Skip instructions marked with skipPin (e.g., RenderThread with no active processes)
        if (inst.skipPin) {
          if (DEBUG_AI_PANEL)
            console.log(
              `[AIPanel] Skipped by skipPin flag: ${inst.pattern} - ${inst.reason || 'no reason'}`,
            );
          pinnedCount.skipped++;
          continue;
        }

        const regex = new RegExp(inst.pattern);
        const smartProcessNames =
          inst.activeProcessNames ?? Array.from(activeProcessNames);
        const shouldSmartFilterByProcess =
          Boolean(inst.smartPin) && smartProcessNames.length > 0;
        const maxPinsForInstruction = getMaxPinsForPattern(inst.pattern);
        const shouldAttemptDisambiguation = needsActiveDisambiguation(
          inst.pattern,
        );
        let pinnedForInstruction = 0;

        // Manual iteration keeps the execution result factual: we only count
        // tracks we can observe and pin in the current workspace.
        if (flatTracks) {
          const candidates: any[] = [];
          const hasActiveContext =
            smartProcessNames.length > 0 || activityHints.size > 0;
          const shouldFilterToActive =
            hasActiveContext &&
            (shouldSmartFilterByProcess || shouldAttemptDisambiguation);

          for (const trackNode of flatTracks) {
            const matchValue =
              inst.matchBy === 'uri'
                ? trackNode.uri
                : inst.matchBy === 'path'
                  ? this.trackFullPathToString(trackNode as any)
                  : trackNode.name;
            if (!matchValue || !regex.test(matchValue)) continue;
            if (this.shouldIgnoreAutoPinTrackName(trackNode.name || '')) {
              pinnedCount.skipped++;
              continue;
            }

            if (inst.mainThreadOnly) {
              const uri = trackNode.uri as string | undefined;
              if (!uri) {
                pinnedCount.skipped++;
                continue;
              }
              const hasMainThreadChip =
                trackNode.chips?.includes('main thread') ?? false;
              // Allow both SliceTrack (events) and ThreadStateTrack (CPU scheduling state)
              if (!hasMainThreadChip || !isMainThreadPinnableTrack(uri)) {
                pinnedCount.skipped++;
                continue;
              }
            }

            if (shouldFilterToActive) {
              const trackFullPathStr = this.trackFullPathToString(
                trackNode as any,
              );
              const matchesProcess = smartProcessNames.some((procName) =>
                trackFullPathStr.includes(procName),
              );
              const matchesActivityHint = matchesProcess
                ? true
                : Array.from(activityHints).some((hint) =>
                    trackFullPathStr.includes(hint),
                  );

              if (!matchesProcess && !matchesActivityHint) {
                pinnedCount.skipped++;
                continue;
              }
            }

            candidates.push(trackNode);
          }

          // Main thread fallback: thread name is often NOT literally "main" (pid == tid).
          // Pin both SliceTrack (events) and ThreadStateTrack (CPU scheduling state)
          if (candidates.length === 0 && inst.pattern.startsWith('^main')) {
            // Track by proc+kind to allow both SliceTrack and ThreadStateTrack per process
            const pinnedByProcAndKind = new Set<string>();
            for (const trackNode of flatTracks) {
              if (this.shouldIgnoreAutoPinTrackName(trackNode.name || ''))
                continue;
              const uri = trackNode.uri as string | undefined;
              if (!uri || !isMainThreadPinnableTrack(uri)) continue;

              const hasMainThreadChip =
                trackNode.chips?.includes('main thread') ?? false;
              if (!hasMainThreadChip) continue;

              // Determine track kind for dedup key
              const track = this.trace.tracks.getTrack(uri);
              const kinds = track?.tags?.kinds ?? [];
              const trackKind = kinds.includes('SliceTrack')
                ? 'slice'
                : kinds.includes('ThreadStateTrack')
                  ? 'state'
                  : 'other';

              if (smartProcessNames.length > 0) {
                const pathStr = this.trackFullPathToString(trackNode as any);
                const matchedProc = smartProcessNames.find((p) =>
                  pathStr.includes(p),
                );
                if (!matchedProc) continue;
                // Allow one SliceTrack and one ThreadStateTrack per process
                const dedupKey = `${matchedProc}:${trackKind}`;
                if (pinnedByProcAndKind.has(dedupKey)) continue;
                pinnedByProcAndKind.add(dedupKey);
              }

              if (trackNode.isPinned) {
                pinnedCount.skipped++;
                pinnedForInstruction++;
              } else {
                trackNode.pin();
                if (inst.expand) trackNode.expand();
                pinnedCount.pinnedTrackNames.push(
                  this.trackFullPathToString(trackNode as any) ||
                    trackNode.name ||
                    uri,
                );
                pinnedCount.count++;
                pinnedForInstruction++;
              }
              // If we don't have per-proc filtering, pin at most 2 (slice + state).
              if (smartProcessNames.length === 0 && pinnedForInstruction >= 2)
                break;
            }
            if (
              pinnedCount.count === pinnedBeforeInstruction &&
              pinnedCount.skipped === skippedBeforeInstruction
            ) {
              pinnedCount.missingPatterns.push(inst.pattern);
            }
            continue;
          }

          if (candidates.length > 0) {
            let nodesToPin = candidates;

            if (
              maxPinsForInstruction !== undefined &&
              candidates.length > maxPinsForInstruction
            ) {
              const scored = await Promise.all(
                candidates.map(async (trackNode) => {
                  let score = await getTrackActivityCount(trackNode);
                  const name = trackNode?.name || '';

                  // Prefer tracks tied to the active app surface when possible.
                  if (
                    /^QueuedBuffer\\b/i.test(name) &&
                    activityHints.size > 0
                  ) {
                    if (Array.from(activityHints).some((h) => name.includes(h)))
                      score += 1_000_000;
                  }
                  if (
                    /^BufferTX\\b/i.test(name) &&
                    smartProcessNames.length > 0
                  ) {
                    if (smartProcessNames.some((p) => name.includes(p)))
                      score += 1_000_000;
                  }
                  if (/BufferQueue/i.test(name) && activityHints.size > 0) {
                    if (Array.from(activityHints).some((h) => name.includes(h)))
                      score += 1_000_000;
                  }

                  return {trackNode, score};
                }),
              );

              scored.sort((a, b) => b.score - a.score);
              nodesToPin = scored
                .slice(0, maxPinsForInstruction)
                .map((x) => x.trackNode);
            }

            for (const trackNode of nodesToPin) {
              if (trackNode.isPinned) {
                pinnedCount.skipped++;
                pinnedForInstruction++;
                continue;
              }
              trackNode.pin();
              if (inst.expand) trackNode.expand();
              pinnedCount.pinnedTrackNames.push(
                this.trackFullPathToString(trackNode as any) ||
                  trackNode.name ||
                  trackNode.uri ||
                  inst.pattern,
              );
              pinnedCount.count++;
              pinnedForInstruction++;
              if (
                maxPinsForInstruction &&
                pinnedForInstruction >= maxPinsForInstruction
              )
                break;
            }
          }
        }

        if (
          pinnedCount.count === pinnedBeforeInstruction &&
          pinnedCount.skipped === skippedBeforeInstruction
        ) {
          pinnedCount.missingPatterns.push(inst.pattern);
        }
      } catch (e) {
        console.warn(
          `[AIPanel] Failed to pin tracks with pattern ${inst.pattern}:`,
          e,
        );
        pinnedCount.failed++;
        pinnedCount.missingPatterns.push(inst.pattern);
      }
    }

    if (pinnedCount.count > 0 || pinnedCount.skipped > 0) {
      if (DEBUG_AI_PANEL)
        console.log(
          `[AIPanel] Pinned ${pinnedCount.count} tracks for teaching (skipped ${pinnedCount.skipped} inactive)`,
        );
    }

    pinnedCount.missingPatterns = Array.from(new Set(pinnedCount.missingPatterns));
    pinnedCount.pinnedTrackNames = Array.from(new Set(pinnedCount.pinnedTrackNames));
    return pinnedCount;
  }

  private getHelpMessage(): string {
    return `**AI Assistant Commands:**

| Command | Description |
|---------|-------------|
| \`/sql <query>\` | Execute SQL query |
| \`/goto <ts>\` | Jump to timestamp |
| \`/analyze\` | Analyze current selection |
| \`/anr\` | Find ANRs |
| \`/jank\` | Find janky frames |
| \`/slow\` | Analyze slow operations (backend) |
| \`/memory\` | Analyze memory usage (backend) |
| \`/teaching-pipeline\` | 🎓 教学：检测渲染管线类型 |
| \`/scene\` | 🎬 场景还原：识别 Trace 中的操作场景 |
| \`/export [csv|json]\` | Export session results |
| \`/pins\` | View pinned query results |
| \`/clear\` | Clear chat history |
| \`/help\` | Show this help |
| \`/settings\` | Open settings |

**Tips:**
- Use arrow keys to navigate command history
- Shift+Enter for new line, Enter to send
- Click 📄 CSV or 📋 JSON buttons to export query results
- Click 📌 Pin to save query results for later`;
  }

  /**
   * 渲染 Session 历史侧边栏（分区显示：当前对话 + 历史对话）
   */
  private renderSessionSidebar(
    sessions: AISession[],
    _currentIndex: number,
  ): m.Children {
    // 找到当前 Session
    const currentSession = sessions.find(
      (s) => s.sessionId === this.state.currentSessionId,
    );

    // 历史 Sessions（排除当前，按最后活动时间倒序）
    const historySessions = sessions
      .filter((s) => s.sessionId !== this.state.currentSessionId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // 渲染单个 Session 项
    const renderSessionItem = (session: AISession, isCurrent: boolean) => {
      const messageCount = session.messages.length;
      const lastActive = this.formatRelativeTime(session.lastActiveAt);

      // 获取 session 摘要（取第一条用户消息或自动生成）
      const userMessages = session.messages.filter((m) => m.role === 'user');
      const summary = isCurrent
        ? '当前对话'
        : session.summary ||
          (userMessages.length > 0
            ? userMessages[0].content.slice(0, 30)
            : '新对话');

      return m(
        'div.ai-session-sidebar-item',
        {
          class: isCurrent ? 'current' : '',
          onclick: () => {
            if (!isCurrent) {
              this.loadSession(session.sessionId);
            }
          },
          title: isCurrent ? '当前对话' : summary,
        },
        [
          m('div.ai-session-sidebar-item-indicator', isCurrent ? '●' : '○'),
          m('div.ai-session-sidebar-item-content', [
            m(
              'div.ai-session-sidebar-item-summary',
              summary + (!isCurrent && summary.length >= 30 ? '...' : ''),
            ),
            m('div.ai-session-sidebar-item-meta', [
              m('span', `${messageCount} 条`),
              m('span', '·'),
              m('span', lastActive),
            ]),
          ]),
          // 删除按钮（只对历史 session 显示）
          !isCurrent
            ? m(
                'button.ai-session-sidebar-item-delete',
                {
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    if (confirm('确定删除这个对话？')) {
                      this.deleteSession(session.sessionId);
                    }
                  },
                  title: '删除对话',
                },
                m('i.pf-icon', 'close'),
              )
            : null,
        ],
      );
    };

    return m('div.ai-session-sidebar', [
      // 标题栏
      m('div.ai-session-sidebar-header', [
        m('i.pf-icon', 'chat'),
        m('span', '对话'),
      ]),

      // Session 列表
      m('div.ai-session-sidebar-items', [
        // 当前对话（固定在顶部）
        currentSession ? renderSessionItem(currentSession, true) : null,

        // 历史对话分隔线（只在有历史时显示）
        historySessions.length > 0
          ? m('div.ai-session-sidebar-divider', '历史对话')
          : null,

        // 历史对话列表
        historySessions.map((session) => renderSessionItem(session, false)),
      ]),

      // 新建对话按钮
      m(
        'button.ai-session-sidebar-new',
        {
          onclick: () => {
            this.cancelSSEConnection();
            // 保存当前 session 再创建新的
            this.saveCurrentSession();
            this.createNewSession();
            this.state.messages = [];
            this.state.agentSessionId = null; // Reset Agent session for new conversation
            this.clearAgentObservability();
            if (this.state.backendTraceId || this.engine?.mode === 'HTTP_RPC') {
              this.addRpcModeWelcomeMessage();
            } else {
              this.addBackendUnavailableMessage();
            }
            m.redraw();
          },
          title: '新建对话',
        },
        [m('i.pf-icon', 'add')],
      ),
    ]);
  }

  /**
   * 格式化相对时间
   */
  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} 天前`;
    if (hours > 0) return `${hours} 小时前`;
    if (minutes > 0) return `${minutes} 分钟前`;
    return '刚刚';
  }

  /**
   * Jump to a specific timestamp in the Perfetto timeline
   */
  private jumpToTimestamp(
    timestampNs: bigint,
  ): {ok: true} | {ok: false; error: string} {
    if (!this.trace) {
      console.error('[AIPanel] No trace available for navigation');
      return {ok: false, error: 'trace context is not available'};
    }

    const traceStart = this.trace.traceInfo.start as unknown as bigint;
    const traceEnd = this.trace.traceInfo.end as unknown as bigint;
    if (timestampNs < traceStart || timestampNs > traceEnd) {
      return {
        ok: false,
        error: `timestamp is outside trace range [${traceStart.toString()}ns, ${traceEnd.toString()}ns]`,
      };
    }

    try {
      // Create a 10ms window around the timestamp for better visibility
      const windowNs = BigInt(10_000_000); // 10ms
      const startNs = timestampNs - windowNs / BigInt(2);
      const endNs = timestampNs + windowNs / BigInt(2);

      if (DEBUG_AI_PANEL)
        console.log(`[AIPanel] Jumping to timestamp: ${timestampNs}ns`);

      this.trace.scrollTo({
        time: {
          start: Time.fromRaw(startNs > BigInt(0) ? startNs : BigInt(0)),
          end: Time.fromRaw(endNs),
        },
      });
      return {ok: true};
    } catch (error) {
      console.error('[AIPanel] Failed to jump to timestamp:', error);
      const errorText = error instanceof Error ? error.message : String(error);
      return {ok: false, error: errorText};
    }
  }

  private async clearChat() {
    this.cancelSSEConnection();
    this.setLoadingState(false);

    // Persist current conversation before wiping
    this.flushSessionSave();
    this.saveCurrentSession();

    // Do not delete backend trace resources when clearing chat.
    // Clear-chat resets conversation state only and preserves trace continuity.

    // Clear frontend state
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.state.pinnedResults = []; // Clear pinned results
    this.state.agentSessionId = null; // Clear Agent session for multi-turn dialogue
    this.revealedBlockCounts.clear();
    this.state.completionHandled = false;
    this.state.displayedSkillProgress = new Set();
    this.state.collectedErrors = [];
    this.state.collapsedTables = new Set();
    this.clearAgentObservability();
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    this.saveHistory();
    // AI Everywhere: reset cross-component state + clear timeline notes
    resetAISharedState();
    if (this.trace) clearAIFindingNotes(this.trace);

    // Show appropriate welcome message based on mode
    if (this.state.backendTraceId || this.engine?.mode === 'HTTP_RPC') {
      this.addRpcModeWelcomeMessage();
    } else {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: this.getWelcomeMessage(),
        timestamp: Date.now(),
      });
    }
    m.redraw();
  }

  /**
   * Pop out the AI panel into a body-level floating window.
   *
   * The full handoff (cancel SSE, save session, snapshot state) runs
   * inside the transient saver registered in oncreate, so this method
   * is just a one-liner. Dock Back goes through the same saver via
   * switchFloatingMode('tab').
   */
  private popOutToFloatingWindow() {
    switchFloatingMode('floating');
  }

  /**
   * Snapshot per-instance state that's not saved to localStorage sessions,
   * for hand-off during Pop Out / Dock Back. Called by the registered
   * transient saver closure in ai_transient_state.ts.
   *
   * The saver already cancelled SSE before calling this, so the state
   * is stable — no event processing can mutate fields between snapshot
   * and the new instance's restore.
   *
   * For replay idempotency (Codex HIGH 3), we must carry the full
   * streamingFlow/streamingAnswer/displayedSkillProgress state so the
   * new instance's handlers can dedupe replayed events.
   */
  private snapshotTransientState(): TransientState {
    // isLoading tracks active analysis more reliably than sseConnectionState
    // (which may be 'disconnected' briefly between connect retries).
    const isAnalysisActive =
      this.state.isLoading || !!this.state.agentSessionId;
    return {
      inputDraft: this.state.input,
      collapsedTables: Array.from(this.state.collapsedTables),
      historyIndex: this.state.historyIndex,
      activeAnalysis:
        isAnalysisActive && this.state.agentSessionId
          ? {
              agentSessionId: this.state.agentSessionId,
              lastEventId: this.state.sseLastEventId,
              agentRunId: this.state.agentRunId,
              agentRequestId: this.state.agentRequestId,
              agentRunSequence: this.state.agentRunSequence,
              loadingPhase: this.state.loadingPhase,
              // Dedup sets + completion flag — shallow clone (old instance
              // is frozen after saver's cancelSSEConnection, won't mutate).
              displayedSkillProgress: Array.from(
                this.state.displayedSkillProgress,
              ),
              completionHandled: this.state.completionHandled,
              collectedErrors: [...this.state.collectedErrors],
              // Streaming UI state — shallow clone of outer object, deep
              // clone of collections that would otherwise be shared refs.
              streamingFlow: this.cloneStreamingFlow(),
              streamingAnswer: {...this.state.streamingAnswer},
            }
          : null,
    };
  }

  /** Shallow-clone StreamingFlowState with deep copies of its collections. */
  private cloneStreamingFlow(): StreamingFlowState {
    const f = this.state.streamingFlow;
    return {
      ...f,
      phases: [...f.phases],
      thoughts: [...f.thoughts],
      tools: [...f.tools],
      outputs: [...f.outputs],
      conversationLines: [...f.conversationLines],
      conversationPendingSteps: {...f.conversationPendingSteps},
      conversationSeenEventIds: new Set(f.conversationSeenEventIds),
      subAgents: f.subAgents.map((s) => ({...s})),
      dataSourceRefs: f.dataSourceRefs.map((ref) => ({...ref})),
      dataSourceKindOrdinals: {...f.dataSourceKindOrdinals},
      // Timer must NOT be carried across — it references a window-scoped
      // handle that will expire/fire on the old instance's event loop.
      // New instance will schedule its own timer if needed.
      conversationFlushTimer: undefined,
    };
  }

  /**
   * Restore per-instance state from a transient snapshot. Called on the
   * newly-mounted AIPanel instance after a mode switch. If the snapshot
   * contains an active SSE analysis, reconnect and resume streaming —
   * the backend replays events after the saved lastEventId.
   *
   * For replay idempotency (Codex HIGH 3), we restore the full dedup
   * state (displayedSkillProgress, completionHandled, collectedErrors)
   * and streaming UI state before reconnecting SSE, so replayed events
   * hit the same handler state the old instance had and don't
   * re-trigger already-handled paths.
   */
  private restoreTransientState(snapshot: TransientState | null): void {
    if (!snapshot) return;

    this.state.input = snapshot.inputDraft;
    this.state.collapsedTables = new Set(snapshot.collapsedTables);
    this.state.historyIndex = snapshot.historyIndex;

    if (snapshot.activeAnalysis) {
      const a = snapshot.activeAnalysis;
      // Agent identity + cursor
      this.state.agentSessionId = a.agentSessionId;
      // Null cursor → use 0 so backend replays from the start of the
      // ring buffer (Codex HIGH 2: missing first id: event edge case).
      this.state.sseLastEventId = a.lastEventId ?? 0;
      this.state.agentRunId = a.agentRunId;
      this.state.agentRequestId = a.agentRequestId;
      this.state.agentRunSequence = a.agentRunSequence;
      this.state.loadingPhase = a.loadingPhase;
      // Replay-sensitive handler state (Codex HIGH 3)
      this.state.displayedSkillProgress = new Set(a.displayedSkillProgress);
      this.state.completionHandled = a.completionHandled;
      this.state.collectedErrors = [...a.collectedErrors];
      this.state.streamingFlow = {
        ...createStreamingFlowState(),
        ...a.streamingFlow,
        dataSourceRefs: a.streamingFlow.dataSourceRefs || [],
        dataSourceOrdinal:
          a.streamingFlow.dataSourceOrdinal ||
          (a.streamingFlow.dataSourceRefs || []).length,
        dataSourceKindOrdinals:
          a.streamingFlow.dataSourceKindOrdinals ||
          this.dataSourceKindOrdinalsFromRefs(a.streamingFlow.dataSourceRefs || []),
      };
      this.state.streamingAnswer = a.streamingAnswer;
      // Mark loading + resume SSE. The resumeFromLastEventId flag tells
      // listenToAgentSSE to preserve sseLastEventId so the initial fetch
      // sends Last-Event-ID. The backend replays any events that arrived
      // during the unmount-remount gap.
      this.setLoadingState(true);
      void this.listenToAgentSSE(
        a.agentSessionId,
        /* resumeFromLastEventId */ true,
      );
    }
  }

  private openSettings() {
    this.state.showSettings = true;
    m.redraw();
  }

  private closeSettings() {
    this.state.showSettings = false;
    m.redraw();
  }

  // NOTE: uploadTraceToBackend() method removed - auto-upload now happens in load_trace.ts

  /**
   * Export SQL result to CSV or JSON
   */
  private async exportResult(
    result: SqlQueryResult,
    format: 'csv' | 'json',
  ): Promise<void> {
    this.setLoadingState(true);
    m.redraw();

    try {
      const response = await this.fetchBackend(
        `${this.state.settings.backendUrl}/api/export/result`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            result: {
              columns: result.columns,
              rows: result.rows,
              rowCount: result.rowCount,
              query: result.query,
            },
            format,
            options:
              format === 'json' ? {prettyPrint: true} : {includeHeaders: true},
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      // Get filename from Content-Disposition header or generate one
      const contentDisp = response.headers.get('Content-Disposition') || '';
      const filenameMatch = contentDisp.match(/filename="(.+)"/);
      const filename = filenameMatch
        ? filenameMatch[1]
        : `result-${Date.now()}.${format}`;

      // Download file
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `✅ Exported **${result.rowCount}** rows as ${format.toUpperCase()}`,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Export failed:** ${e.message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Export current session
   */
  private async exportCurrentSession(
    format: 'csv' | 'json' = 'json',
  ): Promise<void> {
    // Collect all SQL results from messages
    const results = this.state.messages
      .filter((msg) => msg.sqlResult)
      .map((msg) => ({
        name: `Query at ${new Date(msg.timestamp).toLocaleTimeString()}`,
        result: msg.sqlResult!,
      }));

    if (results.length === 0) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**No SQL results to export.** Run some queries first.',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    m.redraw();

    try {
      const response = await this.fetchBackend(
        `${this.state.settings.backendUrl}/api/export/session`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            results,
            format,
            options:
              format === 'json' ? {prettyPrint: true} : {includeHeaders: true},
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      const contentDisp = response.headers.get('Content-Disposition') || '';
      const filenameMatch = contentDisp.match(/filename="(.+)"/);
      const filename = filenameMatch
        ? filenameMatch[1]
        : `session-${Date.now()}.${format}`;

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `✅ Exported session with **${results.length}** query results as ${format.toUpperCase()}`,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Export failed:** ${e.message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Handle /export command
   */
  private async handleExportCommand(formatArg?: string) {
    const format = formatArg === 'csv' ? 'csv' : 'json';
    await this.exportCurrentSession(format);
  }

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Universal value formatter for displaying any data type in tables.
   * Handles: null, undefined, numbers, bigints, objects, arrays, strings.
   *


  /**
   * Convert backend frame detail data to sections format expected by renderExpandableContent.
   *
   * Backend returns: FrameDetailData { diagnosis_summary, full_analysis: FullAnalysis }






  /**
   * 从SQL查询结果中提取关键时间点作为导航书签
   * 根据查询内容和结果自动识别掉帧、ANR、慢函数等关键点
   */
  private extractBookmarksFromQueryResult(
    query: string,
    columns: string[],
    rows: any[][],
  ): void {
    // 只处理包含时间戳的查询结果
    const tsColumnIndex = columns.findIndex((col) =>
      /^ts$|^timestamp$|^start_ts$|_ts$/i.test(col),
    );

    if (tsColumnIndex === -1 || rows.length === 0) {
      return; // 没有时间戳列，不提取书签
    }

    const bookmarks: NavigationBookmark[] = [];
    const queryLower = query.toLowerCase();

    // 根据查询类型确定书签类型
    let bookmarkType: NavigationBookmark['type'] = 'custom';
    let labelPrefix = '关键点';

    if (
      queryLower.includes('jank') ||
      queryLower.includes('掉帧') ||
      queryLower.includes('frame')
    ) {
      bookmarkType = 'jank';
      labelPrefix = '掉帧';
    } else if (queryLower.includes('anr')) {
      bookmarkType = 'anr';
      labelPrefix = 'ANR';
    } else if (
      queryLower.includes('slow') ||
      queryLower.includes('慢') ||
      queryLower.includes('dur')
    ) {
      bookmarkType = 'slow_function';
      labelPrefix = '慢函数';
    } else if (queryLower.includes('binder')) {
      bookmarkType = 'binder_slow';
      labelPrefix = 'Binder';
    }

    // 限制书签数量，避免太多
    const maxBookmarks = 20;
    const rowsToProcess = rows.slice(0, maxBookmarks);

    rowsToProcess.forEach((row, index) => {
      const timestamp = row[tsColumnIndex];
      if (typeof timestamp === 'number' && timestamp > 0) {
        // 尝试获取更多上下文信息
        const nameColumnIndex = columns.findIndex((col) =>
          /name|slice|function/i.test(col),
        );
        const durColumnIndex = columns.findIndex((col) => /^dur$/i.test(col));

        let description = `${labelPrefix} #${index + 1}`;
        if (nameColumnIndex >= 0 && row[nameColumnIndex]) {
          description += ` - ${row[nameColumnIndex]}`;
        }
        if (durColumnIndex >= 0 && row[durColumnIndex]) {
          const durMs = (row[durColumnIndex] as number) / 1000000;
          description += ` (${durMs.toFixed(2)}ms)`;
        }

        bookmarks.push({
          id: `bookmark-${Date.now()}-${index}`,
          timestamp,
          label: `${labelPrefix} #${index + 1}`,
          type: bookmarkType,
          description,
        });
      }
    });

    // 更新书签列表
    if (bookmarks.length > 0) {
      this.state.bookmarks = bookmarks;
      if (DEBUG_AI_PANEL)
        console.log(
          `Extracted ${bookmarks.length} bookmarks from query result`,
        );
      // AI Everywhere: also create timeline notes for visual annotation
      if (this.trace) {
        const findings = addBookmarkNotes(this.trace, bookmarks);
        updateAISharedState({findings, issueCount: findings.length});
      }
    }
  }

  /**
   * Centralized loading state setter. Clears loadingPhase on both start and stop
   * to prevent stale phase text from previous analyses.
   */
  private setLoadingState(loading: boolean): void {
    this.state.isLoading = loading;
    this.state.loadingPhase = '';
  }

  /**
   * Auto-scroll to bottom only if the user is already near the bottom.
   * This prevents stealing scroll position during long analyses when
   * the user has scrolled up to review intermediate results.
   * @param force If true, always scroll (e.g., on user-initiated message send).
   */
  private scrollToBottom(force = false): void {
    if (!this.messagesContainer) return;
    const el = this.messagesContainer;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only auto-scroll if within 150px of bottom or forced
    if (force || distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Throttled variant for streaming updates — avoids forced reflow on every redraw. */
  private throttledScrollToBottom(): void {
    if (this.scrollThrottleTimer) return;
    this.scrollThrottleTimer = setTimeout(() => {
      this.scrollThrottleTimer = null;
      this.scrollToBottom();
    }, 100);
  }

  // ==========================================================================
  // Comparison Mode
  // ==========================================================================

  /** Fetch available traces from backend for the trace picker. */
  private async fetchAvailableTraces(): Promise<void> {
    this.state.comparisonTraceLoading = true;
    m.redraw();
    try {
      const url = buildSmartPerfettoWorkspaceApiUrl(
        this.state.settings.backendUrl,
        'traces',
      );
      const response = await this.fetchBackend(url);
      if (response.ok) {
        const data = await response.json();
        this.availableTraces = (data.traces || []).map((t: any) => ({
          id: t.id,
          originalName: t.originalName || t.name,
          uploadedAt: t.uploadedAt,
          size: t.size,
        }));
      }
    } catch (e) {
      console.warn('[AIPanel] Failed to fetch traces:', e);
      this.availableTraces = [];
    } finally {
      this.state.comparisonTraceLoading = false;
      m.redraw();
    }
  }

  private startWindowHeartbeat(): void {
    if (this.windowHeartbeatTimer) return;
    void this.postWindowHeartbeat();
    this.windowHeartbeatTimer = setInterval(() => {
      void this.postWindowHeartbeat();
    }, 30_000);
  }

  private async postWindowHeartbeat(): Promise<void> {
    const backendUrl = this.state.settings.backendUrl;
    if (!backendUrl) return;

    const context = getSmartPerfettoRequestContext();
    const latest = this.state.latestAnalysisSnapshot;
    const traceTitle = this.trace?.traceInfo?.traceTitle;
    const traceId =
      this.state.backendTraceId || this.state.currentTraceFingerprint || undefined;

    try {
      const url = buildSmartPerfettoWorkspaceApiUrl(
        backendUrl,
        'windows',
        `/${encodeURIComponent(context.windowId)}/heartbeat`,
      );
      const response = await this.fetchBackend(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          traceId,
          backendTraceId: this.state.backendTraceId || undefined,
          activeSessionId:
            this.state.agentSessionId || this.state.currentSessionId || undefined,
          latestSnapshotId: latest?.snapshotId,
          traceTitle: traceTitle || undefined,
          sceneType: latest?.sceneType,
          updatedAt: Date.now(),
        }),
      });
      if (!response.ok) return;

      const data = await response.json();
      this.activeResultWindowStates = Array.isArray(data.activeWindows)
        ? data.activeWindows
            .filter((item: any) => item && typeof item.windowId === 'string')
            .map((item: any) => ({
              windowId: item.windowId,
              userId: typeof item.userId === 'string' ? item.userId : undefined,
              traceId: typeof item.traceId === 'string' ? item.traceId : undefined,
              backendTraceId:
                typeof item.backendTraceId === 'string'
                  ? item.backendTraceId
                  : undefined,
              activeSessionId:
                typeof item.activeSessionId === 'string'
                  ? item.activeSessionId
                  : undefined,
              latestSnapshotId:
                typeof item.latestSnapshotId === 'string'
                  ? item.latestSnapshotId
                  : undefined,
              traceTitle:
                typeof item.traceTitle === 'string' ? item.traceTitle : undefined,
              sceneType:
                typeof item.sceneType === 'string' ? item.sceneType : undefined,
              updatedAt:
                typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
              expiresAt:
                typeof item.expiresAt === 'number' ? item.expiresAt : Date.now(),
            }))
        : [];
      if (this.state.showResultPicker) {
        m.redraw();
      }
    } catch (error) {
      if (DEBUG_AI_PANEL) {
        console.warn('[AIPanel] Failed to post window heartbeat:', error);
      }
    }
  }

  private getSortedAnalysisResults(): AnalysisResultPickerItem[] {
    const latestId = this.state.latestAnalysisSnapshot?.snapshotId;
    const activeRank = new Map<string, number>();
    this.activeResultWindowStates.forEach((state, index) => {
      if (state.latestSnapshotId && !activeRank.has(state.latestSnapshotId)) {
        activeRank.set(state.latestSnapshotId, index);
      }
    });

    return [...this.availableAnalysisResults].sort((left, right) => {
      const leftRank =
        left.id === latestId ? -2 : activeRank.get(left.id) ?? Number.MAX_SAFE_INTEGER;
      const rightRank =
        right.id === latestId ? -2 : activeRank.get(right.id) ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return right.createdAt - left.createdAt;
    });
  }

  /** Fetch persisted analysis-result snapshots for the result picker. */
  private async fetchAnalysisResults(
    options: {silent?: boolean} = {},
  ): Promise<void> {
    if (!options.silent) {
      this.state.resultPickerLoading = true;
    }
    this.state.resultPickerError = null;
    this.state.resultComparisonError = null;
    if (!options.silent) {
      m.redraw();
    }

    try {
      const url = new URL(
        buildSmartPerfettoWorkspaceApiUrl(
          this.state.settings.backendUrl,
          'analysis-results',
        ),
        window.location.href,
      );
      url.searchParams.set('limit', '500');

      const response = await this.fetchBackend(url.toString());
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      this.availableAnalysisResults = (Array.isArray(data.results)
        ? data.results
        : [])
        .map((item: any) => this.normalizeAnalysisResultItem(item))
        .filter((item: AnalysisResultPickerItem | null): item is AnalysisResultPickerItem =>
          item !== null,
        );
      this.reconcileLatestAnalysisSnapshotFromResults();
      this.syncResultPickerSelection();
    } catch (error) {
      console.warn('[AIPanel] Failed to fetch analysis results:', error);
      this.availableAnalysisResults = [];
      this.state.resultPickerError =
        error instanceof Error ? error.message : 'Failed to load analysis results';
    } finally {
      if (!options.silent) {
        this.state.resultPickerLoading = false;
      }
      m.redraw();
    }
  }

  private latestSnapshotFromPickerItem(
    item: AnalysisResultPickerItem,
  ): LatestAnalysisSnapshot {
    return {
      snapshotId: item.id,
      status: item.status,
      sceneType: item.sceneType,
      metricCount: item.metrics?.length ?? 0,
      evidenceRefCount: item.evidenceRefs?.length ?? 0,
      traceId: item.traceId,
      sessionId: item.sessionId,
      runId: item.runId,
      reportId: item.reportId,
      visibility: item.visibility,
      createdAt: item.createdAt,
    };
  }

  private resolveCurrentAnalysisResultSnapshotId(): string | undefined {
    const latestId = this.state.latestAnalysisSnapshot?.snapshotId;
    if (
      latestId &&
      this.availableAnalysisResults.some((item) => item.id === latestId)
    ) {
      return latestId;
    }

    const sessionId = this.state.agentSessionId || this.state.currentSessionId;
    const traceId = this.state.backendTraceId;
    const candidates = this.availableAnalysisResults
      .filter((item) =>
        (sessionId && item.sessionId === sessionId) ||
        (traceId && item.traceId === traceId),
      )
      .sort((left, right) => right.createdAt - left.createdAt);
    return candidates[0]?.id;
  }

  private reconcileLatestAnalysisSnapshotFromResults(): void {
    const snapshotId = this.resolveCurrentAnalysisResultSnapshotId();
    if (!snapshotId) return;
    const item = this.availableAnalysisResults.find(
      (result) => result.id === snapshotId,
    );
    if (!item) return;
    if (this.state.latestAnalysisSnapshot?.snapshotId === item.id) return;
    this.state.latestAnalysisSnapshot = this.latestSnapshotFromPickerItem(item);
  }

  private normalizeAnalysisResultItem(
    item: any,
  ): AnalysisResultPickerItem | null {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string') {
      return null;
    }
    const metrics = Array.isArray(item.metrics)
      ? item.metrics
          .filter((metric: any) => metric && typeof metric === 'object')
          .map((metric: any) => ({
            key: String(metric.key || ''),
            label: String(metric.label || metric.key || ''),
            group: String(metric.group || 'general'),
            value:
              typeof metric.value === 'number' ||
              typeof metric.value === 'string' ||
              metric.value === null
                ? metric.value
                : null,
            unit: typeof metric.unit === 'string' ? metric.unit : undefined,
            confidence:
              typeof metric.confidence === 'number'
                ? metric.confidence
                : undefined,
          }))
      : [];

    return {
      id: item.id,
      traceId: typeof item.traceId === 'string' ? item.traceId : '',
      sessionId: typeof item.sessionId === 'string' ? item.sessionId : '',
      runId: typeof item.runId === 'string' ? item.runId : '',
      reportId: typeof item.reportId === 'string' ? item.reportId : undefined,
      createdBy:
        typeof item.createdBy === 'string' ? item.createdBy : undefined,
      visibility:
        typeof item.visibility === 'string' ? item.visibility : 'private',
      sceneType: typeof item.sceneType === 'string' ? item.sceneType : 'general',
      title: typeof item.title === 'string' ? item.title : item.id,
      userQuery:
        typeof item.userQuery === 'string' ? item.userQuery : '',
      traceLabel:
        typeof item.traceLabel === 'string'
          ? item.traceLabel
          : typeof item.traceId === 'string'
            ? item.traceId
            : '',
      status: typeof item.status === 'string' ? item.status : 'partial',
      createdAt:
        typeof item.createdAt === 'number' ? item.createdAt : Date.now(),
      expiresAt:
        typeof item.expiresAt === 'number' ? item.expiresAt : undefined,
      metrics,
      evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [],
    };
  }

  private syncResultPickerSelection(): void {
    const ids = new Set(this.availableAnalysisResults.map((item) => item.id));
    const latestId = this.state.latestAnalysisSnapshot?.snapshotId;
    const currentBaseline = this.state.selectedResultBaselineId;

    if (currentBaseline && !ids.has(currentBaseline)) {
      this.state.selectedResultBaselineId = null;
    }
    if (!this.state.selectedResultBaselineId && latestId && ids.has(latestId)) {
      this.state.selectedResultBaselineId = latestId;
    }
    if (!this.state.selectedResultBaselineId) {
      this.state.selectedResultBaselineId =
        this.availableAnalysisResults[0]?.id ?? null;
    }

    const nextCandidates = new Set<string>();
    for (const id of this.state.selectedResultCandidateIds) {
      if (ids.has(id) && id !== this.state.selectedResultBaselineId) {
        nextCandidates.add(id);
      }
    }
    this.state.selectedResultCandidateIds = nextCandidates;
  }

  private selectResultBaseline(snapshotId: string): void {
    this.state.selectedResultBaselineId = snapshotId;
    if (this.state.selectedResultCandidateIds.has(snapshotId)) {
      const next = new Set(this.state.selectedResultCandidateIds);
      next.delete(snapshotId);
      this.state.selectedResultCandidateIds = next;
    }
    m.redraw();
  }

  private toggleResultCandidate(snapshotId: string): void {
    if (snapshotId === this.state.selectedResultBaselineId) return;
    const next = new Set(this.state.selectedResultCandidateIds);
    if (next.has(snapshotId)) {
      next.delete(snapshotId);
    } else {
      next.add(snapshotId);
    }
    this.state.selectedResultCandidateIds = next;
    m.redraw();
  }

  private async updateAnalysisResultVisibility(
    snapshotId: string,
    visibility: 'private' | 'workspace',
  ): Promise<void> {
    if (this.resultVisibilityUpdatingIds.has(snapshotId)) return;
    this.resultVisibilityUpdatingIds.add(snapshotId);
    m.redraw();

    try {
      const url = buildSmartPerfettoWorkspaceApiUrl(
        this.state.settings.backendUrl,
        'analysis-results',
        `/${encodeURIComponent(snapshotId)}`,
      );
      const response = await this.fetchBackend(url, {
        method: 'PATCH',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({visibility}),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const updated = this.normalizeAnalysisResultItem(data.snapshot);
      if (!updated) {
        await this.fetchAnalysisResults();
        return;
      }

      this.availableAnalysisResults = this.availableAnalysisResults.map((item) =>
        item.id === updated.id ? updated : item,
      );
      if (this.state.latestAnalysisSnapshot?.snapshotId === updated.id) {
        this.state.latestAnalysisSnapshot = {
          ...this.state.latestAnalysisSnapshot,
          visibility: updated.visibility,
        };
      }
    } catch (error) {
      console.warn('[AIPanel] Failed to update analysis result visibility:', error);
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content:
          error instanceof Error
            ? `更新分析结果可见性失败: ${error.message}`
            : '更新分析结果可见性失败。',
        timestamp: Date.now(),
      });
    } finally {
      this.resultVisibilityUpdatingIds.delete(snapshotId);
      m.redraw();
    }
  }

  private formatComparisonNumber(value: number): string {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.?0+$/, '');
  }

  private formatComparisonMetricValue(
    cell: AnalysisResultComparisonCell | undefined,
    unit?: string,
  ): string {
    if (!cell || cell.value === null || cell.value === undefined) {
      return 'missing';
    }
    const value =
      typeof cell.numericValue === 'number'
        ? cell.numericValue
        : cell.value;
    const formattedValue =
      typeof value === 'number'
        ? this.formatComparisonNumber(value)
        : String(value);
    const displayUnit = cell.unit || unit;
    return displayUnit ? `${formattedValue} ${displayUnit}` : formattedValue;
  }

  private formatComparisonDelta(
    delta: AnalysisResultComparisonDelta | undefined,
    row: AnalysisResultComparisonMatrixRow,
  ): string {
    if (!delta || delta.deltaValue === null) return 'n/a';
    const valueSign = delta.deltaValue > 0 ? '+' : '';
    const value = `${valueSign}${this.formatComparisonNumber(delta.deltaValue)}`;
    const pct =
      typeof delta.deltaPct === 'number'
        ? ` (${delta.deltaPct > 0 ? '+' : ''}${this.formatComparisonNumber(delta.deltaPct)}%)`
        : '';
    const unit = row.unit ? ` ${row.unit}` : '';
    return `${value}${unit}${pct}, ${delta.assessment}`;
  }

  private escapeMarkdownTableCell(value: string): string {
    return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  private formatComparisonResultMessage(
    comparison: AnalysisResultComparisonRun,
  ): string {
    const result = comparison.result;
    if (!result) {
      return `**分析结果对比已创建**\n\nComparison: \`${comparison.id}\`\nStatus: ${comparison.status}`;
    }

    const matrix = result.matrix;
    const inputSnapshotIds = matrix.inputSnapshots.map((item) => item.snapshotId);
    const baseline = matrix.inputSnapshots.find(
      (item) => item.snapshotId === matrix.baselineSnapshotId,
    );
    const candidates = matrix.inputSnapshots.filter(
      (item) => item.snapshotId !== matrix.baselineSnapshotId,
    );
    const rows = matrix.rows.slice(0, 12);
    const tableRows = rows.map((row) => {
      const candidateSummary = candidates
        .map((snapshot) => {
          const cell = row.cells.find(
            (item) => item.snapshotId === snapshot.snapshotId,
          );
          const delta = row.deltas.find(
            (item) => item.snapshotId === snapshot.snapshotId,
          );
          const title = snapshot.title || snapshot.traceLabel || snapshot.snapshotId;
          return `${title} (${formatAnalysisResultRef(snapshot.snapshotId, inputSnapshotIds)}): ${this.formatComparisonMetricValue(cell, row.unit)}, Δ ${this.formatComparisonDelta(delta, row)}`;
        })
        .join('; ');
      return [
        this.escapeMarkdownTableCell(row.label || row.metricKey),
        this.escapeMarkdownTableCell(this.formatComparisonMetricValue(row.baseline, row.unit)),
        this.escapeMarkdownTableCell(candidateSummary || 'n/a'),
      ];
    });
    const table = tableRows.length > 0
      ? [
          '| Metric | Baseline | Candidate values and deltas |',
          '|---|---:|---|',
          ...tableRows.map((row) => `| ${row[0]} | ${row[1]} | ${row[2]} |`),
        ].join('\n')
      : '没有可展示的 metric 行。';

    const exportUrl = buildSmartPerfettoWorkspaceApiUrl(
      this.state.settings.backendUrl,
      'comparisons',
      `/${encodeURIComponent(comparison.id)}/report/export`,
    );
    const hiddenRows = matrix.rows.length - rows.length;
    const hiddenText = hiddenRows > 0 ? `\n\n还有 ${hiddenRows} 行未在消息中展开，完整内容见 HTML 报告。` : '';
    const baselineTitle =
      baseline?.title || baseline?.traceLabel || baseline?.snapshotId || 'baseline';
    const candidateTitles = candidates
      .map((item) =>
        `${item.title || item.traceLabel || item.snapshotId} (${formatAnalysisResultRef(item.snapshotId, inputSnapshotIds)})`)
      .join(', ');
    const baselineRef = baseline?.snapshotId
      ? ` (${formatAnalysisResultRef(baseline.snapshotId, inputSnapshotIds)})`
      : '';

    return [
      '**分析结果对比已完成**',
      '',
      `Comparison: \`${comparison.id}\``,
      `Baseline: ${baselineTitle}${baselineRef}`,
      `Candidates: ${candidateTitles || 'n/a'}`,
      `Significant changes: ${result.significantChanges.length}`,
      '',
      table,
      hiddenText,
      '',
      `[导出 HTML 报告](${exportUrl})`,
    ].join('\n');
  }

  private async createAnalysisResultComparison(input: {
    baseline: AnalysisResultPickerItem;
    candidates: AnalysisResultPickerItem[];
    query: string;
    closePicker?: boolean;
  }): Promise<void> {
    if (this.state.resultComparisonLoading) return;
    if (input.candidates.length === 0) return;

    this.state.resultComparisonLoading = true;
    this.state.resultComparisonError = null;
    m.redraw();

    try {
      const query = input.query.trim() ||
        `Compare ${input.baseline.title || input.baseline.id} with ${input.candidates
          .map((item) => item.title || item.id)
          .join(', ')}`;
      const url = buildSmartPerfettoWorkspaceApiUrl(
        this.state.settings.backendUrl,
        'comparisons',
      );
      const response = await this.fetchBackend(url, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          baselineSnapshotId: input.baseline.id,
          candidateSnapshotIds: input.candidates.map((item) => item.id),
          query,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message =
          typeof data.error === 'string' ? data.error : `HTTP ${response.status}`;
        throw new Error(message);
      }

      const comparison = data.comparison as AnalysisResultComparisonRun | undefined;
      if (!comparison?.id) {
        throw new Error('Comparison response is missing comparison.id');
      }

      if (this.state.input.trim() === query) {
        this.state.input = '';
      }
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: this.formatComparisonResultMessage(comparison),
        timestamp: Date.now(),
      });
      if (input.closePicker !== false) {
        this.state.showResultPicker = false;
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to create comparison';
      this.state.resultComparisonError = message;
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `创建分析结果对比失败: ${message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.state.resultComparisonLoading = false;
      m.redraw();
    }
  }

  private async startSelectedResultComparison(): Promise<void> {
    const baseline = this.availableAnalysisResults.find(
      (item) => item.id === this.state.selectedResultBaselineId,
    );
    const candidates = this.availableAnalysisResults.filter((item) =>
      this.state.selectedResultCandidateIds.has(item.id),
    );
    if (!baseline || candidates.length === 0) return;
    const query =
      this.state.input.trim() ||
      `Compare ${baseline.title || baseline.id} with ${candidates
        .map((item) => item.title || item.id)
        .join(', ')}`;
    await this.createAnalysisResultComparison({
      baseline,
      candidates,
      query,
      closePicker: true,
    });
  }

  private formatAnalysisResultTime(timestamp: number): string {
    if (!Number.isFinite(timestamp)) return '';
    return new Date(timestamp).toLocaleString();
  }

  private formatAnalysisResultStatus(status: string): string {
    if (status === 'ready') return 'Ready';
    if (status === 'failed') return 'Failed';
    return 'Partial';
  }

  private renderResultPicker(): m.Vnode {
    const selectedCount = this.state.selectedResultCandidateIds.size;
    const canPrepare = !!this.state.selectedResultBaselineId && selectedCount > 0;
    const comparisonLoading = this.state.resultComparisonLoading;

    return m('aside.ai-trace-picker-sidebar.ai-result-picker-sidebar', [
      m('div.ai-trace-picker-sidebar-header', [
        m('i.pf-icon', 'fact_check'),
        m('span', '选择分析结果'),
        m(
          'button.ai-trace-picker-sidebar-close',
          {
            onclick: () => {
              this.state.showResultPicker = false;
              m.redraw();
            },
            title: '关闭',
          },
          m('i.pf-icon', 'close'),
        ),
      ]),
      m('div.ai-trace-picker-sidebar-body', [
        m('div.ai-result-picker', [
          this.state.resultPickerLoading
            ? m('div.ai-trace-picker-loading', '加载分析结果中...')
            : this.state.resultPickerError
              ? m('div.ai-result-picker-error', [
                  m('div', `加载失败: ${this.state.resultPickerError}`),
                  m(
                    'button.ai-result-picker-text-btn',
                    {
                      onclick: () => this.fetchAnalysisResults(),
                    },
                    '重试',
                  ),
                ])
              : m('div.ai-result-picker-list', [
                  this.availableAnalysisResults.length > 0
                    ? this.getSortedAnalysisResults().map((item) =>
                        this.renderResultPickerItem(item),
                      )
                    : m(
                        'div.ai-trace-picker-empty',
                        '当前 workspace 还没有可用于对比的分析结果。',
                      ),
                ]),
        ]),
        this.availableAnalysisResults.length > 0
          ? m('div.ai-trace-picker-sidebar-actions.ai-result-picker-actions', [
              this.state.resultComparisonError
                ? m(
                    'span.ai-result-picker-action-error',
                    `对比失败: ${this.state.resultComparisonError}`,
                  )
                : null,
              m(
                'button.ai-result-picker-primary',
                {
                  disabled: !canPrepare || comparisonLoading,
                  onclick: () => {
                    void this.startSelectedResultComparison();
                  },
                },
                comparisonLoading ? '对比中...' : '开始对比',
              ),
              m(
                'button.ai-result-picker-secondary',
                {
                  disabled: comparisonLoading,
                  onclick: () => {
                    this.state.selectedResultBaselineId =
                      this.state.latestAnalysisSnapshot?.snapshotId ?? null;
                    this.state.selectedResultCandidateIds = new Set();
                    this.state.resultComparisonError = null;
                    this.syncResultPickerSelection();
                    m.redraw();
                  },
                },
                '重置',
              ),
              m(
                'span.ai-result-picker-selection',
                canPrepare
                  ? `1 baseline · ${selectedCount} candidate`
                  : '请选择 baseline 和 candidate',
              ),
            ])
          : null,
      ]),
    ]);
  }

  private renderResultPickerItem(item: AnalysisResultPickerItem): m.Vnode {
    const isBaseline = item.id === this.state.selectedResultBaselineId;
    const isCandidate = this.state.selectedResultCandidateIds.has(item.id);
    const isCurrent =
      item.id === this.state.latestAnalysisSnapshot?.snapshotId;
    const activeWindow = this.activeResultWindowStates.find(
      (state) => state.latestSnapshotId === item.id,
    );
    const isVisibilityUpdating = this.resultVisibilityUpdatingIds.has(item.id);
    const metricCount = item.metrics?.length ?? 0;
    const evidenceCount = item.evidenceRefs?.length ?? 0;

    return m(
      'div.ai-result-picker-item',
      {
        key: item.id,
        class: [
          isBaseline ? 'baseline' : '',
          isCandidate ? 'candidate' : '',
          isCurrent ? 'current' : '',
        ]
          .filter(Boolean)
          .join(' '),
      },
      [
        m('div.ai-result-picker-item-main', [
          m('div.ai-result-picker-title-row', [
            m('div.ai-result-picker-item-name', item.title || item.id),
            m(
              'span.ai-result-picker-pill.ref-id',
              {title: `Snapshot: ${item.id}`},
              formatAnalysisResultRef(
                item.id,
                this.availableAnalysisResults.map((result) => result.id),
              ),
            ),
            isCurrent
              ? m('span.ai-result-picker-pill.current', 'Current')
              : null,
            activeWindow
              ? m('span.ai-result-picker-pill.active-window', 'Open')
              : null,
            m(
              `span.ai-result-picker-pill.${item.status === 'ready' ? 'ready' : item.status === 'failed' ? 'failed' : 'partial'}`,
              this.formatAnalysisResultStatus(item.status),
            ),
          ]),
          m(
            'div.ai-result-picker-query',
            item.userQuery || item.traceLabel || item.traceId,
          ),
          m(
            'div.ai-result-picker-item-meta',
            [
              item.sceneType,
              activeWindow?.traceTitle,
              item.traceLabel || item.traceId,
              this.formatAnalysisResultTime(item.createdAt),
              item.createdBy || '',
            ]
              .filter(Boolean)
              .join(' · '),
          ),
          m('div.ai-result-picker-coverage', [
            `${metricCount} metrics`,
            evidenceCount ? ` · ${evidenceCount} refs` : '',
            ` · ${item.visibility}`,
          ]),
        ]),
        m('div.ai-result-picker-item-actions', [
          m(
            'button.ai-result-picker-role-btn',
            {
              class: isBaseline ? 'active' : '',
              onclick: () => this.selectResultBaseline(item.id),
              title: '设为 baseline',
            },
            '基线',
          ),
          m(
            'button.ai-result-picker-role-btn',
            {
              class: isCandidate ? 'active' : '',
              disabled: isBaseline,
              onclick: () => this.toggleResultCandidate(item.id),
              title: isBaseline ? 'baseline 不能同时作为 candidate' : '加入候选',
            },
            '候选',
          ),
          item.visibility === 'private'
            ? m(
                'button.ai-result-picker-role-btn',
                {
                  disabled: isVisibilityUpdating,
                  onclick: () =>
                    this.updateAnalysisResultVisibility(item.id, 'workspace'),
                  title: '设为 workspace 可见',
                },
                isVisibilityUpdating ? '...' : '共享',
              )
            : null,
        ]),
      ],
    );
  }

  /** Render trace picker drawer for selecting a reference trace. */
  private renderTracePicker(): m.Vnode {
    return m('aside.ai-trace-picker-sidebar', [
      m('div.ai-trace-picker-sidebar-header', [
        m('i.pf-icon', 'compare_arrows'),
        m('span', '选择对比 Trace'),
        m(
          'button.ai-trace-picker-sidebar-close',
          {
            onclick: () => {
              this.state.showTracePicker = false;
              m.redraw();
            },
            title: '关闭',
          },
          m('i.pf-icon', 'close'),
        ),
      ]),
      m('div.ai-trace-picker-sidebar-body', [
        m('div.ai-trace-picker', [
          this.state.comparisonTraceLoading
            ? m('div.ai-trace-picker-loading', '加载 Trace 列表中...')
            : m('div.ai-trace-picker-list', [
                // Show available traces from backend
                this.availableTraces.length > 0
                  ? this.availableTraces
                      .filter((t) => t.id !== this.state.backendTraceId) // Exclude current trace
                      .map((t) =>
                        m(
                          'div.ai-trace-picker-item',
                          {
                            key: t.id,
                            onclick: () =>
                              this.enterComparisonMode(
                                t.id,
                                t.originalName || t.id,
                              ),
                            class:
                              this.state.referenceTraceId === t.id
                                ? 'selected'
                                : '',
                          },
                          [
                            m(
                              'div.ai-trace-picker-item-name',
                              t.originalName || t.id,
                            ),
                            m(
                              'div.ai-trace-picker-item-meta',
                              [
                                t.uploadedAt
                                  ? new Date(t.uploadedAt).toLocaleString()
                                  : '',
                                t.size
                                  ? ` · ${(t.size / 1024 / 1024).toFixed(1)}MB`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(''),
                            ),
                          ],
                        ),
                      )
                  : m(
                      'div.ai-trace-picker-empty',
                      '没有可用的参考 Trace。请先上传另一个 Trace 文件到后端。',
                    ),
              ]),
        ]),
        this.state.referenceTraceId
          ? m('div.ai-trace-picker-sidebar-actions', [
              m(
                'button.ai-btn-secondary',
                {
                  onclick: () => this.exitComparisonMode(),
                },
                '退出对比',
              ),
            ])
          : null,
      ]),
    ]);
  }

  /** Enter comparison mode with a reference trace. */
  private async enterComparisonMode(
    refTraceId: string,
    refTraceName: string,
  ): Promise<void> {
    if (this.state.agentSessionId) {
      this.state.agentSessionId = null;
      this.state.agentRunId = null;
      this.clearAgentObservability();
    }
    this.state.referenceTraceId = refTraceId;
    this.state.referenceTraceName = refTraceName;
    this.state.showTracePicker = false;
    this.state.isReferenceActive = false;

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content:
        `**对比模式已激活**\n\n` +
        `- 主 Trace: ${this.trace?.traceInfo?.traceTitle || '当前 Trace'}\n` +
        `- 参考 Trace: ${refTraceName}\n\n` +
        `你可以直接提问，AI 会同时分析两个 Trace 并输出对比结论。\n` +
        `点击 **[切换]** 可在 Perfetto 中查看参考 Trace。`,
      timestamp: Date.now(),
    });
    this.saveCurrentSession();
    m.redraw();
  }

  /** Exit comparison mode. */
  private exitComparisonMode(): void {
    const hadComparisonSession = !!this.state.agentSessionId;
    this.state.referenceTraceId = null;
    this.state.referenceTraceName = null;
    this.state.isReferenceActive = false;
    this.state.showTracePicker = false;
    this.state.comparisonTraceLoading = false;
    this.state.agentSessionId = null;
    this.state.agentRunId = null;
    if (hadComparisonSession) {
      this.clearAgentObservability();
    }
    clearComparisonState();

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: hadComparisonSession
        ? '已退出对比模式，回到单 Trace 分析。后续问题将开始新的单 Trace 会话。'
        : '已退出对比模式，回到单 Trace 分析。',
      timestamp: Date.now(),
    });
    this.saveCurrentSession();
    m.redraw();
  }

  /** Open the reference trace in a new browser tab for visual verification.
   *  In-tab trace switching is deferred — openTraceFromUrl would re-import
   *  the trace into trace_processor (duplicate data risk) and requires
   *  downloading the full file (slow for large traces). New-tab approach
   *  is zero-risk and keeps the current AI analysis session undisturbed. */
  private switchComparisonTrace(): void {
    if (!this.state.referenceTraceId) return;

    const targetTraceId = this.state.isReferenceActive
      ? this.state.backendTraceId // Switch back to primary → open primary in new tab
      : this.state.referenceTraceId; // Switch to reference → open reference in new tab

    if (!targetTraceId) return;

    // Open the trace file download URL — browser/Perfetto will handle it in a new tab
    const fileUrl = buildSmartPerfettoWorkspaceApiUrl(
      this.state.settings.backendUrl,
      'traces',
      `/${targetTraceId}/file`,
    );
    window.open(fileUrl, '_blank');

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: this.state.isReferenceActive
        ? `已在新标签页中打开主 Trace，可在那里视觉验证 AI 的分析结论。`
        : `已在新标签页中打开参考 Trace: **${this.state.referenceTraceName}**，可在那里视觉验证 AI 的对比结论。\n\n当前标签页的 AI 对话和分析不受影响。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }
}
