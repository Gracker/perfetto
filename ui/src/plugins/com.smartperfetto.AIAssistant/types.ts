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

import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';

/**
 * Shared type definitions for the AI Assistant plugin.
 *
 * This module centralizes all interface definitions to prevent circular
 * dependencies between the various AI panel modules.
 */

import {NavigationBookmark} from './navigation_bookmark_bar';
import {DetectedScene} from './scene_navigation_bar';
import type {
  AnalysisReceiptV1,
  QueryReviewV1,
  UiActionProposalV1,
} from './generated/data_contract.types';
import type {ServerRuntimeKind} from './provider_types';

export type {AnalysisReceiptV1, QueryReviewV1, UiActionProposalV1};

/**
 * A chat message in the AI conversation.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  flowTag?:
    | 'streaming_flow'
    | 'answer_stream'
    | 'progress_note'
    | 'round_separator';
  /** Model active when this user message was sent — used to show model-change badge */
  model?: string;
  sqlResult?: SqlQueryResult;
  query?: string;
  reportUrl?: string; // HTML report link
  sourceContext?: DataSourceContext;
  // Chart data for visualization (display.format: 'chart')
  chartData?: {
    type: 'pie' | 'bar' | 'histogram';
    title?: string;
    data: Array<{
      label: string;
      value: number;
      percentage?: number;
      color?: string;
    }>;
  };
  // Metric card data (display.format: 'metric')
  metricData?: {
    title: string;
    value: string | number;
    unit?: string;
    status?: 'good' | 'warning' | 'critical';
    delta?: string; // e.g., "+5%" or "-10ms"
  };
  teachingPipeline?: TeachingPipelineResult;
  teachingPinExecution?: TeachingPinExecutionResult;
  smartScenePreview?: SmartScenePreviewPayload;
  quickRun?: QuickRunReceipt;
  analysisReceipt?: AnalysisReceiptV1;
  uiActionProposals?: UiActionProposalV1[];
}

export interface QuickRunReceipt {
  requestedMode: 'fast' | 'auto' | 'full';
  resolvedMode: 'quick' | 'full';
  profile: 'normal' | 'extended' | 'triage';
  targetTurns: number;
  hardCapTurns: number;
  actualTurns: number;
  elapsedMs: number;
  enforcement: 'turn_cap' | 'timeout_only' | 'not_available';
  stopReason:
    | 'answered'
    | 'needs_full'
    | 'extended_answered'
    | 'hard_cap'
    | 'timeout'
    | 'partial';
  evidence: {
    frontendPrequeryInjected: number;
    frontendPrequeryCited: number;
    currentRunDataEnvelopes: number;
    citedEvidenceRefs: number;
  };
  contextInjected: {
    conversationTurns: number;
    recentSqlResults: number;
    sqlPitfallPairs: number;
    patternHints: number;
    negativePatternHints: number;
    caseBackgroundCases: number;
  };
  verifierStatus: 'passed' | 'issues' | 'not_checked' | 'failed';
}

export interface SmartDisplayedScene {
  id: string;
  sceneType: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  processName?: string;
  label?: string;
  severity?: 'good' | 'warning' | 'bad' | 'unknown' | string;
  analysisState?: string;
  sceneRole?: 'action' | 'marker' | 'context' | string;
  analysisEligible?: boolean;
  confidenceScore?: number;
  confidenceLevel?: 'high' | 'medium' | 'low' | string;
  confidenceReasons?: string[];
  parentSceneId?: string;
  childSceneIds?: string[];
}

export interface SmartSceneVerificationPayload {
  status?: 'passed' | 'needs_review' | 'skipped' | 'failed' | string;
  verifier?: string;
  summary?: string;
  checkedSceneCount?: number;
  lowConfidenceSceneIds?: string[];
  conflictSceneIds?: string[];
  issues?: Array<{
    severity?: 'info' | 'warning' | 'bad' | string;
    sceneId?: string;
    type?: string;
    message?: string;
  }>;
  llm?: {
    status?: string;
    summary?: string;
    error?: string;
  };
}

export interface SmartScenePreviewPayload {
  reportId?: string;
  scenes: SmartDisplayedScene[];
  sceneVerification?: SmartSceneVerificationPayload;
  eligibleSceneCount?: number;
  sceneTypeCounts?: Record<string, number>;
}

export interface TeachingPipelineResult {
  success: boolean;
  schemaVersion?: string;
  detection: TeachingDetection;
  observedFlow?: TeachingObservedFlow;
  teaching?: TeachingContent | null;
  teachingContent?: TeachingContent | null;
  pinPlan?: TeachingPinPlan;
  overlayPlan?: TeachingOverlayPlan;
  warnings?: TeachingWarning[];
  pinInstructions?: TeachingPinInstruction[];
  activeRenderingProcesses?: TeachingActiveRenderingProcess[];
}

export interface TeachingDetection {
  detected?: boolean;
  primaryPipelineId?: string;
  primaryRenderingTypeId?: string;
  primaryConfidence?: number;
  primary_pipeline?: {
    id: string;
    confidence: number;
  };
  renderingType?: {
    id: string;
    docPath: string;
  };
  candidates?: Array<{id: string; confidence: number}>;
  renderingTypeCandidates?: Array<{id: string; confidence: number}>;
  relatedRenderingTypes?: Array<{
    id: string;
    confidence: number;
    docPath: string;
  }>;
  features?: Array<{
    id?: string;
    name?: string;
    feature?: string;
    detected?: boolean;
    confidence?: number;
    value?: string | number;
  }>;
  subvariants?: {
    buffer_mode?: string;
    flutter_engine?: string;
    webview_mode?: string;
    game_engine?: string;
  };
  traceRequirementsMissing?: string[];
  trace_requirements_missing?: string[];
}

export interface TeachingContent {
  title: string;
  summary: string;
  mermaidBlocks?: string[];
  threadRoles?: Array<{
    thread: string;
    responsibility: string;
    traceTag?: string;
  }>;
  keySlices?: string[];
  docPath?: string;
}

export interface TeachingObservedFlow {
  schemaVersion: string;
  context?: {
    traceId?: string;
    packageName?: string;
    processName?: string;
    fallbackUsed?: string;
    timeRange?: {
      startTs: number;
      endTs: number;
      source: string;
    };
    sourcePriority?: string[];
  };
  lanes: TeachingObservedLane[];
  events: TeachingObservedEvent[];
  dependencies?: Array<{
    fromLaneId: string;
    toLaneId: string;
    relation: string;
    confidence?: number;
    evidenceSource?: string;
    fromEventId?: string;
    toEventId?: string;
    fromTaskId?: string;
    toTaskId?: string;
    detail?: string;
  }>;
  criticalTasks?: TeachingObservedCriticalTask[];
  completeness?: {
    level: 'high' | 'medium' | 'low';
    missingSignals?: string[];
    warnings?: string[];
  };
}

export interface TeachingObservedLane {
  id: string;
  role: string;
  title: string;
  processName?: string;
  threadName?: string;
  layerName?: string;
  trackHint?: {
    matchBy: string;
    pattern: string;
    processName?: string;
    threadName?: string;
    layerName?: string;
    mainThreadOnly?: boolean;
  };
  pipelineIds?: string[];
  confidence?: number;
  evidenceSource?: string;
}

export interface TeachingObservedEvent {
  id: string;
  stage: string;
  name: string;
  ts: number;
  dur: number;
  durMs?: number;
  processName?: string;
  threadName?: string;
  trackId?: number;
  utid?: number;
  upid?: number;
  laneId?: string;
  evidenceSource?: string;
  confidence?: number;
  threadStateId?: number;
  criticalTaskId?: string;
}

export interface TeachingObservedWakeupRef {
  threadStateId?: number;
  utid?: number;
  processName?: string;
  threadName?: string;
  state?: string;
  irqContext?: boolean;
  kind?: string;
}

export interface TeachingObservedCriticalTask {
  id: string;
  kind: string;
  rootEventId: string;
  rootLaneId?: string;
  laneId?: string;
  name: string;
  ts: number;
  dur: number;
  durMs?: number;
  processName?: string;
  threadName?: string;
  utid?: number;
  threadStateId?: number;
  state?: string;
  tableName?: string;
  stackDepth?: number;
  waker?: TeachingObservedWakeupRef;
  evidenceSource?: string;
  confidence?: number;
}

export interface TeachingWarning {
  code?: string;
  severity?: 'info' | 'warning' | 'error';
  message: string;
  source?: string;
}

export interface TeachingPinPlan {
  status: 'planned' | 'empty' | 'partial' | 'failed';
  instructions?: TeachingPinInstruction[];
  expectedLaneIds?: string[];
  expectedTrackHints?: TeachingTrackHint[];
  summary?: string;
  warnings?: string[];
}

export interface TeachingTrackHint {
  matchBy: string;
  pattern: string;
  processName?: string;
  threadName?: string;
  layerName?: string;
  mainThreadOnly?: boolean;
}

export interface TeachingOverlayPlan {
  status: 'ready' | 'empty' | 'partial' | 'failed';
  skillId?: string;
  eventIds?: string[];
  keySliceNames?: string[];
  timeRange?: {
    startTs: number;
    endTs: number;
    source: string;
  };
  summary?: string;
  warnings?: string[];
}

export interface TeachingPinInstruction {
  pattern: string;
  matchBy: string;
  priority: number;
  reason: string;
  expand?: boolean;
  mainThreadOnly?: boolean;
  smartPin?: boolean;
  skipPin?: boolean;
  activeProcessNames?: string[];
}

export interface TeachingActiveRenderingProcess {
  upid?: number;
  processName: string;
  frameCount: number;
  renderThreadTid?: number;
}

export interface TeachingPinExecutionResult {
  count: number;
  skipped: number;
  failed: number;
  attempted: number;
  missingPatterns: string[];
  pinnedTrackNames: string[];
  reason?: string;
}

/**
 * Streaming transcript state for progressive, step-by-step output.
 */
export interface ConversationStepTimelineItem {
  ordinal: number;
  phase: 'progress' | 'thinking' | 'tool' | 'result' | 'error';
  role: 'agent' | 'system';
  text: string;
  timestamp?: number;
}

/** Tracked sub-agent state for UI cards. */
export interface SubAgentCard {
  agentName: string;
  description: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  startedAt: number;
  completedAt?: number;
  toolUses?: number;
}

export interface DataSourceContext {
  ref: string;
  title: string;
  source: string;
  reason: string;
  meaning: string;
  kind?:
    | 'table'
    | 'summary'
    | 'metric'
    | 'chart'
    | 'text'
    | 'timeline'
    | 'diagnostic';
  rowCount?: number;
  phase?: string;
  evidenceRefId?: string;
  traceSide?: 'current' | 'reference';
  paneSide?: TracePaneSide;
  traceId?: string;
  queryHash?: string;
  sourceToolCallId?: string;
  paramsHash?: string;
  planPhaseId?: string;
  planPhaseTitle?: string;
  planPhaseGoal?: string;
  planPhaseAttribution?:
    | 'active'
    | 'inferred'
    | 'missing'
    | 'ambiguous'
    | 'unexpected_tool'
    | 'none';
  planPhaseWarning?: string;
  producerReason?: string;
  toolNarration?: string;
}

export interface StreamingFlowState {
  messageId: string | null;
  phaseMessageId: string | null;
  thoughtMessageId: string | null;
  toolMessageId: string | null;
  outputMessageId: string | null;
  conversationMessageId: string | null;
  conversationEnabled: boolean;
  conversationLines: string[];
  conversationLastOrdinal: number;
  conversationLastRenderedAt: number | null;
  conversationPendingSteps: Record<number, ConversationStepTimelineItem>;
  conversationSeenEventIds: Set<string>;
  /** Synthetic answer-stream checkpoints rendered into the conversation timeline. */
  answerTimelineStarted: boolean;
  answerTimelineOrdinal: number;
  answerTimelineLastSnapshot: string;
  answerTimelineLastSnapshotCharCount: number;
  answerTimelineLastSnapshotAt: number | null;
  answerTimelineCompleted: boolean;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled';
  phases: string[];
  thoughts: string[];
  tools: string[];
  outputs: string[];
  startedAt: number | null;
  lastUpdatedAt: number | null;
  error: string | null;
  /** Active/completed sub-agent cards for visual tracking. */
  subAgents: SubAgentCard[];
  /** Per-run data table references used to connect tables and conclusions. */
  dataSourceRefs: DataSourceContext[];
  dataSourceOrdinal: number;
  dataSourceKindOrdinals: Record<string, number>;
  /** Deferred retry timer for throttled conversation timeline steps. */
  conversationFlushTimer?: number;
}

export function createStreamingFlowState(): StreamingFlowState {
  return {
    messageId: null,
    phaseMessageId: null,
    thoughtMessageId: null,
    toolMessageId: null,
    outputMessageId: null,
    conversationMessageId: null,
    conversationEnabled: false,
    conversationLines: [],
    conversationLastOrdinal: 0,
    conversationLastRenderedAt: null,
    conversationPendingSteps: {},
    conversationSeenEventIds: new Set<string>(),
    answerTimelineStarted: false,
    answerTimelineOrdinal: 0,
    answerTimelineLastSnapshot: '',
    answerTimelineLastSnapshotCharCount: 0,
    answerTimelineLastSnapshotAt: null,
    answerTimelineCompleted: false,
    status: 'idle',
    phases: [],
    thoughts: [],
    tools: [],
    outputs: [],
    startedAt: null,
    lastUpdatedAt: null,
    error: null,
    subAgents: [],
    dataSourceRefs: [],
    dataSourceOrdinal: 0,
    dataSourceKindOrdinals: {},
    conversationFlushTimer: undefined,
  };
}

/**
 * Incremental final-answer text stream state.
 */
export interface StreamingAnswerState {
  messageId: string | null;
  content: string;
  pending: string;
  status: 'idle' | 'streaming' | 'completed' | 'failed';
  startedAt: number | null;
  lastUpdatedAt: number | null;
}

export function createStreamingAnswerState(): StreamingAnswerState {
  return {
    messageId: null,
    content: '',
    pending: '',
    status: 'idle',
    startedAt: null,
    lastUpdatedAt: null,
  };
}

/**
 * SQL query result data structure.
 */
export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  hideQuery?: boolean; // Keep query for audit/export, but do not render raw SQL in analysis tables.
  sectionTitle?: string; // For skill_section messages - shows title in table header
  stepId?: string; // Skill step identifier (from DataEnvelope.meta.stepId)
  layer?: string; // Display layer (overview/list/detail/deep)
  // Output structure optimization: grouping and collapse support
  group?: string; // Group identifier for interval grouping
  collapsible?: boolean; // Whether this table can be collapsed
  defaultCollapsed?: boolean; // Whether this table starts collapsed
  maxVisibleRows?: number; // Max rows to show before "show more"
  queryReview?: QueryReviewV1;
  // Column definitions for schema-driven rendering (v2.0)
  columnDefinitions?: Array<{
    name: string;
    label?: string;
    type?: string;
    format?: string;
    clickAction?: string;
    durationColumn?: string;
    unit?: 'ns' | 'us' | 'ms' | 's';
    hidden?: boolean;
  }>;
  // Expandable row data (for iterator type results)
  expandableData?: Array<{
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }>;
  // Summary report (legacy format)
  summary?: {
    title: string;
    content: string;
  };
  // Summary report (v2.0 DataPayload format - from SummaryContent)
  summaryReport?: {
    title: string;
    content: string;
    keyMetrics?: Array<{
      name: string;
      value: string;
      status?: 'good' | 'warning' | 'critical';
    }>;
  };
  // Metadata: fixed values extracted from the list (e.g., layer_name, process_name)
  // These values are the same across all rows, displayed in the header area
  metadata?: Record<string, any>;
  // UI-only source context that explains why the table appeared and how it
  // relates to the analysis timeline/conclusion.
  sourceContext?: DataSourceContext;
}

/**
 * Story Panel state — tracks the full Scene Story lifecycle including the
 * preview/confirmation flow introduced in PR3.
 *
 * State machine:
 *   idle → previewing → preview_cached → completed  (cache hit fast-path)
 *   idle → previewing → preview_cold   → running → completed | failed
 *   idle → running → selection_ready → running → completed | failed (smart)
 */
export type StoryPanelStatus =
  | 'idle' // Story tab opened, not yet previewed
  | 'previewing' // POST /preview in flight
  | 'preview_cached' // Preview returned a cached report
  | 'preview_cold' // Preview returned an estimate (no cache)
  | 'selection_ready' // Smart preview has listed scenes and waits for a deep-dive scope
  | 'running' // POST /scene-reconstruct in flight (user confirmed)
  | 'completed' // Report ready (fresh or cached)
  | 'failed'; // Pipeline or preview error

export interface StoryPreviewEstimate {
  expectedScenes: number;
  etaSec: number;
  estimatedUsd: number;
  confidence: 'low' | 'medium' | 'high';
}

export interface StoryPreviewCacheHit {
  reportId: string;
  createdAt: number;
  expiresAt: number | null;
  cachePolicy: string;
  partialReport: boolean;
  sceneCount: number;
  jobCount: number;
}

export interface StoryPreviewResult {
  traceDurationSec: number;
  estimate: StoryPreviewEstimate;
  cached: StoryPreviewCacheHit | null;
}

export interface StoryPanelState {
  status: StoryPanelStatus;
  lastError: string | null;
  /** Preview result from POST /scene-reconstruct/preview */
  preview: StoryPreviewResult | null;
  /** Full cached SceneReport loaded from GET /report/:reportId */
  cachedReport: any | null;
  /** Analysis ID from the running pipeline (for cancel) */
  analysisId: string | null;
}

export function createStoryPanelState(): StoryPanelState {
  return {
    status: 'idle',
    lastError: null,
    preview: null,
    cachedReport: null,
    analysisId: null,
  };
}

/** Latest persisted analysis-result snapshot for the current panel/window. */
export interface LatestAnalysisSnapshot {
  snapshotId: string;
  status: 'ready' | 'partial' | 'failed' | string;
  sceneType: string;
  metricCount: number;
  evidenceRefCount: number;
  traceId?: string;
  sessionId?: string;
  runId?: string;
  reportId?: string;
  visibility?: 'private' | 'workspace' | string;
  createdAt: number;
}

/** Persisted analysis result shown by the multi-result comparison picker. */
export interface AnalysisResultPickerItem {
  id: string;
  traceId: string;
  sessionId: string;
  runId: string;
  reportId?: string;
  createdBy?: string;
  visibility: 'private' | 'workspace' | string;
  sceneType: string;
  title: string;
  userQuery: string;
  traceLabel: string;
  status: 'ready' | 'partial' | 'failed' | string;
  createdAt: number;
  expiresAt?: number;
  metrics?: Array<{
    key: string;
    label: string;
    group: string;
    value: number | string | null;
    unit?: string;
    confidence?: number;
  }>;
  evidenceRefs?: unknown[];
}

export interface AnalysisResultWindowState {
  windowId: string;
  userId?: string;
  traceId?: string;
  backendTraceId?: string;
  activeSessionId?: string;
  latestSnapshotId?: string;
  traceTitle?: string;
  sceneType?: string;
  updatedAt: number;
  expiresAt: number;
}

export interface AnalysisResultComparisonInputSnapshot {
  snapshotId: string;
  traceId: string;
  title: string;
  traceLabel: string;
  sceneType: string;
  userQuery: string;
  visibility: string;
  createdAt: number;
}

export interface AnalysisResultComparisonCell {
  snapshotId: string;
  metricKey: string;
  value: number | string | null;
  numericValue?: number;
  unit?: string;
}

export interface AnalysisResultComparisonDelta {
  snapshotId: string;
  baselineSnapshotId: string;
  metricKey: string;
  deltaValue: number | null;
  deltaPct: number | null;
  assessment: 'better' | 'worse' | 'same' | 'unknown' | string;
}

export interface AnalysisResultComparisonMatrixRow {
  metricKey: string;
  label: string;
  group: string;
  unit?: string;
  baseline?: AnalysisResultComparisonCell;
  cells: AnalysisResultComparisonCell[];
  deltas: AnalysisResultComparisonDelta[];
  missingSnapshotIds: string[];
}

export interface AnalysisResultComparisonMatrix {
  inputSnapshots: AnalysisResultComparisonInputSnapshot[];
  baselineSnapshotId: string;
  rows: AnalysisResultComparisonMatrixRow[];
}

export interface AnalysisResultComparisonResult {
  matrix: AnalysisResultComparisonMatrix;
  significantChanges: AnalysisResultComparisonDelta[];
  reportId?: string;
  reportUrl?: string;
  reportExportUrl?: string;
}

export interface AnalysisResultComparisonRun {
  id: string;
  inputSnapshotIds: string[];
  baselineSnapshotId?: string;
  query: string;
  status:
    | 'pending'
    | 'running'
    | 'completed'
    | 'failed'
    | 'needs_selection'
    | string;
  result?: AnalysisResultComparisonResult;
  error?: string;
}

export type SimilarityHintSource = 'analysis_result_snapshot' | 'case_library';
export type SimilarityHintBand = 'strong' | 'partial' | 'background';

export interface SimilarityMatchReason {
  feature: string;
  currentValue?: string | number | boolean;
  matchedValue?: string | number | boolean;
  weight: number;
}

export interface SimilarityHintV1 {
  schemaVersion: 1;
  id: string;
  source: SimilarityHintSource;
  sourceId: string;
  score: number;
  band: SimilarityHintBand;
  matchReasons: SimilarityMatchReason[];
  limitations: string[];
  allowedUse: 'navigation_hint_only';
}

export interface AnalysisResultSimilarityResponse {
  success: boolean;
  allowedUse?: 'navigation_hint_only';
  schemaVersion?: 1;
  snapshotId?: string;
  snapshotHints?: SimilarityHintV1[];
  caseHints?: SimilarityHintV1[];
  hints?: SimilarityHintV1[];
  count?: number;
  error?: string;
}

export interface AnalysisResultSimilarityState {
  loadingSnapshotId: string | null;
  error: string | null;
  result: AnalysisResultSimilarityResponse | null;
}

export type TraceConfigProposalConfidence = 'high' | 'medium' | 'low';

export interface TraceConfigProposalCommand {
  config: string[];
  capture: string[];
}

export interface TraceConfigProposalV1 {
  schemaVersion: 1;
  proposalId: string;
  createdAt: string;
  source: 'deterministic';
  target: 'android';
  request: string;
  app: string;
  preset: string;
  presetLabel: string;
  intent: string;
  confidence: TraceConfigProposalConfidence;
  rationale: string[];
  warnings: string[];
  blockedDangerousOptions: string[];
  command: TraceConfigProposalCommand;
  config: {
    textproto: string;
    dataSources: string[];
    ftraceEvents: string[];
    atraceCategories: string[];
    durationSeconds: number;
    bufferSizeKb: number;
  };
}

export interface TraceConfigProposalRequestPayload {
  request: string;
  app?: string;
  durationSeconds?: number;
  categories?: string[];
}

export interface TraceConfigProposalApiResponse {
  success: boolean;
  proposal?: TraceConfigProposalV1;
  error?: string;
}

export interface CaptureConfigSuggestionState {
  visible: boolean;
  request: string;
  app: string;
  durationSeconds: string;
  categories: string;
  loading: boolean;
  error: string | null;
  proposal: TraceConfigProposalV1 | null;
}

/**
 * AI panel internal state.
 */
export interface AIPanelState {
  messages: Message[];
  input: string;
  isLoading: boolean;
  loadingPhase: string; // Current analysis phase text (from SSE progress events)
  showSettings: boolean;
  settings: AISettings;
  commandHistory: string[];
  historyIndex: number;
  lastQuery: string;
  pinnedResults: PinnedResult[];
  backendTraceId: string | null;
  bookmarks: NavigationBookmark[]; // Navigation bookmarks
  currentTraceFingerprint: string | null; // Current Trace fingerprint
  currentSessionId: string | null; // Current Session ID
  isRetryingBackend: boolean; // Retrying backend connection
  retryError: string | null; // Retry connection error message
  agentSessionId: string | null; // Agent multi-turn dialogue Session ID
  agentRunId: string | null; // Current/last agent run ID for observability
  agentRequestId: string | null; // Current/last request ID for observability
  agentRunSequence: number; // Current/last run sequence for observability
  displayedSkillProgress: Set<string>; // Displayed skill progress (skillId:step) for deduplication
  completionHandled: boolean; // Whether analysis completion event was handled
  // SSE Connection State (Phase 2: Reconnection Logic)
  sseConnectionState:
    | 'disconnected'
    | 'connecting'
    | 'connected'
    | 'reconnecting';
  sseRetryCount: number; // Current retry attempt count
  sseMaxRetries: number; // Maximum retry attempts (default: 5)
  sseLastEventTime: number | null; // Last received event timestamp
  sseLastEventId: number | null; // F3: Last received SSE event sequence ID for replay on reconnect
  // Error Aggregation (Phase 3: Error Summary Display)
  collectedErrors: Array<{
    skillId: string;
    stepId?: string;
    error: string;
    timestamp: number;
  }>;
  // Output structure optimization: track collapsed table states
  collapsedTables: Set<string>; // Message IDs of currently collapsed tables
  // Scene Navigation Bar state
  detectedScenes: DetectedScene[]; // Detected scenes from quick detection
  scenesLoading: boolean; // Loading state for scene detection
  scenesError: string | null; // Error message from scene detection
  streamingFlow: StreamingFlowState;
  streamingAnswer: StreamingAnswerState;
  // Comparison mode state
  referenceTraceId: string | null; // Backend trace ID of the reference trace
  referenceTraceName: string | null; // Display name of the reference trace
  isReferenceActive: boolean;
  tracePairWorkspaceOpen: boolean;
  tracePairLayout: TracePairLayout;
  tracePairSplitPercent: number;
  tracePairMaximizedTraceSide: TracePairTraceSide | null;
  tracePairMinimizedTraceSides: Set<TracePairTraceSide>;
  showTracePicker: boolean; // Whether trace picker modal is visible
  comparisonTraceLoading: boolean; // Loading state for reference trace processor
  // Latest analysis-result snapshot for result comparison flow
  latestAnalysisSnapshot: LatestAnalysisSnapshot | null;
  showResultPicker: boolean; // Whether analysis result picker is visible
  resultPickerLoading: boolean; // Loading state for analysis result picker
  resultPickerError: string | null; // Error message for analysis result picker
  resultComparisonLoading: boolean; // Loading state for result comparison creation
  resultComparisonError: string | null; // Error message for result comparison creation
  resultSimilarity: AnalysisResultSimilarityState;
  selectedResultBaselineId: string | null; // Baseline snapshot selected by result picker
  selectedResultCandidateIds: Set<string>; // Candidate snapshots selected by result picker
  // Story Panel state
  storyState: StoryPanelState;
  /** Analysis mode toggle: 'fast' (quick path) / 'full' (pipeline) / 'auto' (classifier-driven).
   *  Persisted in localStorage under ANALYSIS_MODE_KEY. */
  analysisMode: 'fast' | 'full' | 'auto';
  /** Whether the compact analysis mode menu in the input bar is open. */
  showAnalysisModeMenu: boolean;
  /** Whether the conversation history sidebar is visible. */
  showSessionSidebar: boolean;
  /** Whether the Story panel is visible as a right sidebar. */
  showStorySidebar: boolean;
  // Slice Selected card state
  sliceCardInfo: SliceCardInfo | null; // Queried slice metadata for the card
  areaCardInfo: AreaCardInfo | null; // Queried area metadata for the card
  sliceCardPrevSelId: string; // Last seen selection key for diff detection
  sliceCardDismissed: boolean; // Whether user dismissed the card
  // Pre-queried trace context to attach to next request (set by quick-action buttons)
  pendingTraceContext: TraceDataset[] | null;
  captureConfigSuggestion: CaptureConfigSuggestionState;
}

/** A pre-queried trace dataset sent to the backend alongside the query. */
export interface TraceDataset {
  label: string; // Human-readable description of the SQL
  columns: string[];
  rows: unknown[][];
  evidenceRefId?: string;
  sourceToolCallId?: string;
  queryHash?: string;
  traceSide?: 'current' | 'reference';
  paneSide?: TracePaneSide;
  traceId?: string;
}

export type TracePairLayout = 'horizontal' | 'vertical';

export type TracePairTraceSide = 'current' | 'reference';

export type TracePaneSide = 'left' | 'right' | 'top' | 'bottom';

export interface TracePairPaneContext {
  side: TracePaneSide;
  traceSide: TracePairTraceSide;
  traceId: string;
  traceName?: string;
  traceFingerprint?: string;
  active?: boolean;
  visualState?: 'live' | 'context_only';
}

export interface TracePairContext {
  schemaVersion: 1;
  layout: TracePairLayout;
  primarySide: TracePaneSide;
  referenceSide: TracePaneSide;
  activeSide?: TracePaneSide;
  workspaceOpen?: boolean;
  splitPercent?: number;
  maximizedTraceSide?: TracePairTraceSide;
  minimizedTraceSides?: TracePairTraceSide[];
  aliases?: Record<string, TracePairTraceSide>;
  panes: TracePairPaneContext[];
}

export interface SliceCardInfo {
  id: number;
  name: string;
  ts: number;
  dur: number;
  durMs: number;
  threadName: string;
  processName: string;
  depth: number;
  childCount: number;
}

export interface AreaCardInfo {
  startNs: number;
  endNs: number;
  durationMs: number;
  sliceCount: number;
  trackCount: number;
  topSlices: Array<{name: string; durMs: number; count: number}>;
  hasJank: boolean;
  jankCount: number;
}

/**
 * A pinned SQL query result.
 */
export interface PinnedResult {
  id: string;
  query: string;
  columns: string[];
  rows: any[][];
  timestamp: number;
}

/**
 * AI service provider settings.
 * NOTE: Legacy fields (provider, ollama*, openai*, deepseek*) are kept for
 * backward compatibility with existing localStorage data. The actual agent SDK
 * runtime is configured server-side via Provider Manager or backend/.env. The
 * frontend only needs backendUrl and backendApiKey; backendApiKey is
 * SmartPerfetto backend auth (SMARTPERFETTO_API_KEY), not an LLM provider key.
 */
export interface AISettings {
  provider: 'ollama' | 'openai' | 'deepseek';
  ollamaUrl: string;
  ollamaModel: string;
  openaiUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  deepseekModel: string;
  deepseekApiKey: string;
  backendUrl: string;
  backendApiKey: string;
}

/**
 * Server status returned from backend /health endpoint.
 */
export interface ServerStatusActiveProvider {
  id: string;
  name: string;
  type: string;
}

export type AiCapabilityFeature =
  | 'trace_upload'
  | 'execute_sql'
  | 'invoke_deterministic_skill'
  | 'capture_config'
  | 'capture_android'
  | 'report_read'
  | 'provider_config_read'
  | 'provider_config_write'
  | 'provider_switch'
  | 'agent_analyze'
  | 'agent_resume'
  | 'scene_reconstruct_start'
  | 'provider_test'
  | 'cli_provider_test'
  | 'capture_analyze'
  | 'llm_skill_step'
  | 'background_review_agent';

export interface AiCapabilityPolicy {
  schemaVersion: 1;
  aiEnabled: boolean;
  source: 'env' | 'system_default';
  disabledReason?: string;
  env?: {
    key: 'SMARTPERFETTO_AI_ENABLED';
    rawValue?: string;
    valid: boolean;
  };
  allowedDeterministicFeatures: AiCapabilityFeature[];
  blockedFeatures: AiCapabilityFeature[];
  blockingError?: {
    code: 'AI_DISABLED';
    message: string;
    retryable: false;
  };
}

export interface ServerRuntimeDiagnostics {
  runtime?: ServerRuntimeKind;
  providerMode?: string;
  model?: string;
  lightModel?: string;
  protocol?: string;
  baseUrl?: string;
  baseUrlConfigured?: boolean;
  configured?: boolean;
  credentialSources?: string[];
  outputLanguage?: {
    value?: string;
    displayName?: string;
    env?: string;
    default?: string;
  };
  configHint?: string;
  sdkBinary?: {
    detectedPlatformKey?: string | null;
    chosenPath?: string | null;
    fallbackUsed?: boolean;
    source?: string;
    error?: string;
  };
}

export interface ServerStatus {
  connected: boolean;
  version?: string;
  runtime?: ServerRuntimeKind;
  model?: string;
  providerMode?: string;
  configured?: boolean;
  environment?: string;
  source?: 'provider' | 'snapshot' | 'env' | 'default';
  credentialSource?: string;
  envCredentialSources?: string[];
  providerOverridesEnv?: boolean;
  activeProvider?: ServerStatusActiveProvider;
  authRequired?: boolean;
  aiEnabled?: boolean;
  disabledReason?: string;
  aiPolicy?: AiCapabilityPolicy;
  diagnostics?: ServerRuntimeDiagnostics;
}

/**
 * Session data structure for multi-turn conversations.
 */
export interface AISession {
  sessionId: string;
  traceFingerprint: string;
  traceName: string; // Display name (e.g., filename)
  backendTraceId?: string; // Backend session ID
  agentSessionId?: string; // Backend Agent multi-turn session ID
  agentRunId?: string; // Backend run ID
  agentRequestId?: string; // Backend request ID
  agentRunSequence?: number; // Backend run sequence
  latestAnalysisSnapshot?: LatestAnalysisSnapshot; // Latest persisted analysis result for result comparison
  createdAt: number;
  lastActiveAt: number;
  messages: Message[];
  summary?: string; // AI-generated conversation summary
  pinnedResults?: PinnedResult[]; // Pinned query results
  bookmarks?: NavigationBookmark[]; // Navigation bookmarks
  /** Session type: 'single' for normal, 'comparison' for dual-trace analysis */
  type?: 'single' | 'comparison';
  /** Reference trace fingerprint (comparison mode only) */
  referenceTraceFingerprint?: string;
  /** Reference trace backend ID (comparison mode only) */
  referenceBackendTraceId?: string;
  /** Reference trace display name (comparison mode only) */
  referenceTraceName?: string;
  tracePairLayout?: TracePairLayout;
  tracePairSplitPercent?: number;
  tracePairActiveTraceSide?: TracePairTraceSide;
  tracePairCurrentPane?: 'first' | 'second';
}

/**
 * Sessions storage structure indexed by trace fingerprint.
 */
export interface SessionsStorage {
  byTrace: Record<string, AISession[]>;
}

/**
 * Default settings for AI service configuration.
 */
export const DEFAULT_SETTINGS: AISettings = {
  provider: 'deepseek',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.4',
  openaiUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiApiKey: '',
  deepseekModel: 'deepseek-chat',
  deepseekApiKey: '',
  backendUrl: getDefaultSmartPerfettoBackendUrl(),
  backendApiKey: '',
};

// Storage keys for localStorage
export const SETTINGS_KEY = 'smartperfetto-ai-settings';
export const HISTORY_KEY = 'smartperfetto-ai-history';
export const SESSIONS_KEY = 'smartperfetto-ai-sessions';
export const PENDING_BACKEND_TRACE_KEY = 'smartperfetto-pending-backend-trace';

/**
 * Preset questions for quick analysis buttons.
 */
export interface PresetQuestion {
  label: string;
  question: string;
  icon: string;
  isTeaching?: boolean;
  isScene?: boolean;
  isSmart?: boolean;
}

export const PRESET_QUESTIONS: PresetQuestion[] = [
  // Teaching mode - helps users understand rendering pipelines
  {
    label: '🎓 出图教学',
    question: '/teaching-pipeline',
    icon: 'school',
    isTeaching: true,
  },
  // Scene reconstruction - understand what happened in the trace
  {label: '🎬 场景还原', question: '/scene', icon: 'movie', isScene: true},
  // Smart mixed-trace analysis - detect and deep-dive multiple user actions.
  {
    label: '🧠 智能',
    question: '/smart',
    icon: 'auto_awesome',
    isSmart: true,
  },
  // Analysis mode - actual performance analysis
  {label: '滑动', question: '分析滑动性能', icon: 'swipe'},
  {label: '启动', question: '分析启动性能', icon: 'rocket_launch'},
  {label: '跳转', question: '分析跳转性能', icon: 'open_in_new'},
];

/** Preset questions for comparison mode. */
export const COMPARISON_PRESET_QUESTIONS: PresetQuestion[] = [
  {
    label: '对比滑动',
    question: '对比两个 Trace 的滑动性能',
    icon: 'compare_arrows',
  },
  {
    label: '对比启动',
    question: '对比两个 Trace 的启动性能',
    icon: 'compare_arrows',
  },
  {
    label: '对比帧率',
    question: '对比两个 Trace 的帧率分布和 Jank 情况',
    icon: 'compare_arrows',
  },
  {
    label: '对比 CPU',
    question: '对比两个 Trace 的 CPU 调度和频率',
    icon: 'compare_arrows',
  },
];

// =============================================================================
// User Selection Context — passed to backend /analyze for scoped analysis
// =============================================================================

/**
 * Describes the user's current Perfetto UI selection (area or single slice).
 * Serialized and sent to the backend so that Claude can scope its analysis
 * to the user-selected time range or slice.
 */
export interface SelectionContext {
  kind: 'area' | 'track_event';
  /** Where this scope came from: explicit Perfetto selection, selected slice, or current viewport fallback. */
  source?: 'area_selection' | 'track_event_selection' | 'visible_window';
  // ── Area selection (M key) ──
  startNs?: number;
  endNs?: number;
  durationNs?: number;
  /** Resolved track metadata for the selected area */
  tracks?: SelectionTrackInfo[];
  trackCount?: number;
  // ── Single slice selection ──
  trackUri?: string;
  eventId?: number;
  ts?: number;
  dur?: number;
  // Pre-queried metadata from frontend (avoids first SQL turn in AI)
  name?: string;
  threadName?: string;
  processName?: string;
  depth?: number;
  childCount?: number;
}

/** Human-readable metadata for a track in an area selection. */
export interface SelectionTrackInfo {
  uri: string;
  utid?: number;
  upid?: number;
  threadName?: string;
  processName?: string;
  tid?: number;
  pid?: number;
  cpu?: number;
  kind?: string;
}
