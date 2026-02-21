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
 * SSE (Server-Sent Events) event handlers for the AI Assistant plugin.
 *
 * This module processes SSE events from the backend analysis API,
 * transforming raw event data into UI-friendly messages and state updates.
 *
 * Event types handled:
 * - progress: Analysis progress updates
 * - sql_generated/sql_executed: SQL query lifecycle
 * - skill_section/skill_layered_result: Skill execution results
 * - hypothesis_generated/round_start: Agent-driven analysis
 * - analysis_completed/error: Terminal events
 */

import {
  ConversationStepTimelineItem,
  Message,
  InterventionPoint,
  InterventionState,
  StreamingAnswerState,
  StreamingFlowState,
} from './types';
import {
  formatLayerName,
  translateCategory,
  translateComponent,
  extractConclusionFromOverview,
  convertToExpandableSections,
  parseSummaryToTable,
} from './data_formatter';
import {
  ConclusionContract,
  DataEnvelope,
  DataPayload,
  isDataEnvelope,
  envelopeToSqlQueryResult,
} from './generated';
import {CONTRACT_ALIASES} from './conclusion_contract_aliases';

type AnalysisHypothesisItem = {
  status?: string;
  description?: string;
};

type AnalysisCompletedPayload = {
  summary?: string;
  conclusionContract?: ConclusionContract | Record<string, unknown>;
  reportUrl?: string;
  findings?: unknown[];
  suggestions?: string[];
  answer?: string;
  conclusion?: string;
  confidence?: number;
  rounds?: number;
  reportError?: string;
  hypotheses?: AnalysisHypothesisItem[];
};

type RawSSEEvent = Record<string, unknown> | null | undefined;
type SqlResultData = NonNullable<Message['sqlResult']>;
type SqlColumnDefinition = NonNullable<SqlResultData['columnDefinitions']>[number];
type InterventionOptionValue = InterventionPoint['options'][number];

const INTERVENTION_TYPES: ReadonlyArray<InterventionPoint['type']> = [
  'low_confidence',
  'ambiguity',
  'timeout',
  'agent_request',
  'circuit_breaker',
  'validation_required',
];

const INTERVENTION_ACTIONS: ReadonlyArray<InterventionOptionValue['action']> = [
  'continue',
  'focus',
  'abort',
  'custom',
  'select_option',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalNumberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toAnalysisCompletedPayload(value: unknown): AnalysisCompletedPayload | undefined {
  const source = asRecord(value);
  if (Object.keys(source).length === 0) return undefined;

  const payload: AnalysisCompletedPayload = {};

  const summary = readStringField(source, 'summary');
  if (summary) payload.summary = summary;

  const conclusionContract = source.conclusionContract;
  if (isRecord(conclusionContract)) {
    payload.conclusionContract = conclusionContract;
  }

  const reportUrl = readStringField(source, 'reportUrl');
  if (reportUrl) payload.reportUrl = reportUrl;

  if (Array.isArray(source.findings)) {
    payload.findings = source.findings;
  }

  const suggestions = readStringArrayField(source, 'suggestions');
  if (suggestions.length > 0) payload.suggestions = suggestions;

  const answer = readStringField(source, 'answer');
  if (answer) payload.answer = answer;

  const conclusion = readStringField(source, 'conclusion');
  if (conclusion) payload.conclusion = conclusion;

  const confidence = readOptionalNumberField(source, 'confidence');
  if (confidence !== undefined) payload.confidence = confidence;

  const rounds = readOptionalNumberField(source, 'rounds');
  if (rounds !== undefined) payload.rounds = rounds;

  const reportError = readStringField(source, 'reportError');
  if (reportError) payload.reportError = reportError;

  if (Array.isArray(source.hypotheses)) {
    const hypotheses: AnalysisHypothesisItem[] = [];
    for (const item of source.hypotheses) {
      const hypothesis = asRecord(item);
      const status = readStringField(hypothesis, 'status');
      const description = readStringField(hypothesis, 'description');
      if (!status && !description) continue;
      hypotheses.push({
        status: status || undefined,
        description: description || undefined,
      });
    }
    if (hypotheses.length > 0) payload.hypotheses = hypotheses;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function eventPayload(event: RawSSEEvent): Record<string, unknown> {
  const eventRecord = asRecord(event);
  return asRecord(eventRecord.data);
}

function readStringField(source: Record<string, unknown>, key: string, fallback = ''): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumberField(source: Record<string, unknown>, key: string, fallback = 0): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBooleanField(source: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArrayField(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

function readAliasedValue(source: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (key in source) return source[key];
  }
  return undefined;
}

function readAliasedUnknownArray(source: Record<string, unknown>, keys: readonly string[]): unknown[] {
  const value = readAliasedValue(source, keys);
  return Array.isArray(value) ? value : [];
}

function readAliasedRecord(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return asRecord(readAliasedValue(source, keys));
}

function readAliasedRecordArray(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown>[] {
  return readAliasedUnknownArray(source, keys)
    .filter((item): item is Record<string, unknown> => isRecord(item));
}

function readLegacySummary(value: unknown): {title: string; content: string} | undefined {
  if (!isRecord(value)) return undefined;
  const title = readStringField(value, 'title');
  const content = readStringField(value, 'content');
  if (!title && !content) return undefined;
  return {
    title: title || '摘要',
    content,
  };
}

function readSummaryReport(value: unknown): SqlResultData['summaryReport'] | undefined {
  if (!isRecord(value)) return undefined;

  const title = readStringField(value, 'title');
  const content = readStringField(value, 'content');
  if (!title && !content) return undefined;

  const summaryReport: NonNullable<SqlResultData['summaryReport']> = {
    title: title || '摘要',
    content,
  };

  const keyMetricsRaw = value.keyMetrics;
  if (Array.isArray(keyMetricsRaw)) {
    type SummaryKeyMetric = {
      name: string;
      value: string;
      status?: 'good' | 'warning' | 'critical';
    };

    const keyMetrics: SummaryKeyMetric[] = [];
    for (const item of keyMetricsRaw) {
      const metric = asRecord(item);
      const name = readStringField(metric, 'name');
      const metricValue = readStringField(metric, 'value');
      if (!name && !metricValue) continue;

      const statusRaw = readStringField(metric, 'status');
      const status = statusRaw === 'good' || statusRaw === 'warning' || statusRaw === 'critical'
        ? statusRaw
        : undefined;

      keyMetrics.push({
        name,
        value: metricValue,
        status,
      });
    }

    if (keyMetrics.length > 0) {
      summaryReport.keyMetrics = keyMetrics;
    }
  }

  return summaryReport;
}

function readExpandableData(value: unknown): SqlResultData['expandableData'] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: NonNullable<SqlResultData['expandableData']> = [];
  for (const entry of value) {
    const entryRecord = asRecord(entry);
    const item = asRecord(entryRecord.item);
    if (Object.keys(item).length === 0) continue;

    const result = asRecord(entryRecord.result);
    const sections = isRecord(result.sections) ? result.sections : undefined;
    const error = readStringField(result, 'error') || undefined;
    const success = readBooleanField(result, 'success', sections !== undefined && !error);

    entries.push({
      item,
      result: {
        success,
        sections,
        error,
      },
    });
  }

  return entries.length > 0 ? entries : undefined;
}

function readInterventionType(value: unknown): InterventionPoint['type'] {
  if (typeof value === 'string') {
    for (const candidate of INTERVENTION_TYPES) {
      if (candidate === value) return candidate;
    }
  }
  return 'agent_request';
}

function readInterventionAction(value: unknown): InterventionOptionValue['action'] {
  if (typeof value === 'string') {
    for (const candidate of INTERVENTION_ACTIONS) {
      if (candidate === value) return candidate;
    }
  }
  return 'continue';
}

function readInterventionOptions(value: unknown): InterventionPoint['options'] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry, index) => {
      const option = asRecord(entry);
      const id = readStringField(option, 'id') || `option_${index + 1}`;
      const label = readStringField(option, 'label') || `选项 ${index + 1}`;
      return {
        id,
        label,
        description: readStringField(option, 'description', label),
        action: readInterventionAction(option.action),
        recommended: readBooleanField(option, 'recommended', false) || undefined,
      };
    });
}

/**
 * Context object passed to SSE event handlers.
 * Contains references to state and methods needed for event processing.
 */
export interface SSEHandlerContext {
  /** Add a message to the conversation */
  addMessage: (msg: Message) => void;
  /** Update an existing message */
  updateMessage: (
    messageId: string,
    updates: Partial<Message>,
    options?: {persist?: boolean}
  ) => void;
  /** Generate a unique message ID */
  generateId: () => string;
  /** Get the current messages array (read-only) */
  getMessages: () => readonly Message[];
  /** Remove the last message if it matches a condition */
  removeLastMessageIf: (predicate: (msg: Message) => boolean) => boolean;
  /** Set/get loading state */
  setLoading: (loading: boolean) => void;
  /** Track displayed skill progress for deduplication */
  displayedSkillProgress: Set<string>;
  /** Collected non-fatal errors for summary */
  collectedErrors: Array<{
    skillId: string;
    stepId?: string;
    error: string;
    timestamp: number;
  }>;
  /** Whether completion event was already handled */
  completionHandled: boolean;
  /** Set completion handled flag */
  setCompletionHandled: (handled: boolean) => void;
  /** Backend URL for building report links */
  backendUrl: string;
  /** Progressive transcript state for streaming output */
  streamingFlow: StreamingFlowState;
  /** Incremental final answer stream state */
  streamingAnswer: StreamingAnswerState;

  // Agent-Driven Architecture v2.0 - Intervention support
  /** Set intervention state */
  setInterventionState?: (state: Partial<InterventionState>) => void;
  /** Get current intervention state */
  getInterventionState?: () => InterventionState;
}

/**
 * Handler result indicating what action to take after processing.
 */
export interface SSEHandlerResult {
  /** Whether this is a terminal event (analysis complete or error) */
  isTerminal?: boolean;
  /** Whether to stop loading indicator */
  stopLoading?: boolean;
}

const STREAM_FLOW_LIMITS = {
  phases: 8,
  thoughts: 6,
  tools: 8,
  outputs: 8,
  conversation: 20,
} as const;

const ANSWER_STREAM_RENDER_INTERVAL_MS = 16;
const ANSWER_STREAM_PENDING_CHUNK_SIZE = 24;

type StreamingFlowSection = 'phase' | 'thought' | 'tool' | 'output' | 'conversation';

function normalizeFlowLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function appendFlowLine(lines: string[], rawLine: unknown, max: number): boolean {
  const line = normalizeFlowLine(rawLine);
  if (!line) return false;
  if (lines[lines.length - 1] === line) return false;
  lines.push(line);
  if (lines.length > max) {
    lines.splice(0, lines.length - max);
  }
  return true;
}

function flowSectionLines(flow: StreamingFlowState, section: StreamingFlowSection): string[] {
  switch (section) {
    case 'phase':
      return flow.phases;
    case 'thought':
      return flow.thoughts;
    case 'tool':
      return flow.tools;
    case 'output':
      return flow.outputs;
    case 'conversation':
      return flow.conversationLines;
  }
}

function getFlowSectionMessageId(
  flow: StreamingFlowState,
  section: StreamingFlowSection
): string | null {
  switch (section) {
    case 'phase':
      return flow.phaseMessageId || flow.messageId;
    case 'thought':
      return flow.thoughtMessageId;
    case 'tool':
      return flow.toolMessageId;
    case 'output':
      return flow.outputMessageId;
    case 'conversation':
      return flow.conversationMessageId;
  }
}

function setFlowSectionMessageId(
  flow: StreamingFlowState,
  section: StreamingFlowSection,
  messageId: string | null
): void {
  switch (section) {
    case 'phase':
      flow.phaseMessageId = messageId;
      flow.messageId = messageId;
      break;
    case 'thought':
      flow.thoughtMessageId = messageId;
      break;
    case 'tool':
      flow.toolMessageId = messageId;
      break;
    case 'output':
      flow.outputMessageId = messageId;
      break;
    case 'conversation':
      flow.conversationMessageId = messageId;
      break;
  }
}

function flowStatusHint(flow: StreamingFlowState): string {
  if (flow.status === 'running') {
    return '_持续更新中..._';
  }
  if (flow.status === 'completed') {
    return '_流程完成，结论已生成。_';
  }
  if (flow.status === 'failed') {
    return `_流程中断: ${flow.error || '发生错误'}_`;
  }
  return '_等待后端事件..._';
}

function buildStreamingFlowContent(flow: StreamingFlowState, section: StreamingFlowSection): string {
  const lines: string[] = [];
  switch (section) {
    case 'phase':
      lines.push('### 🧭 分析步骤');
      break;
    case 'thought':
      lines.push('### 💭 思考');
      break;
    case 'tool':
      lines.push('### 🛠 工具与动作');
      break;
    case 'output':
      lines.push('### 📤 中间产出');
      break;
    case 'conversation':
      lines.push('### 🧵 对话时间线');
      break;
  }

  const sectionLines = flowSectionLines(flow, section);
  if (sectionLines.length > 0) {
    lines.push('');
    for (const item of sectionLines) {
      lines.push(`- ${item}`);
    }
  }

  if (section === 'phase' || section === 'conversation') {
    lines.push('');
    lines.push(flowStatusHint(flow));
  }

  return lines.join('\n');
}

function resolveStreamingFlowMessageId(
  ctx: SSEHandlerContext,
  section: StreamingFlowSection
): string | null {
  const flow = ctx.streamingFlow;
  const messageId = getFlowSectionMessageId(flow, section);
  if (!messageId) return null;
  const exists = ctx.getMessages().some((msg) => msg.id === messageId);
  if (!exists) {
    setFlowSectionMessageId(flow, section, null);
    return null;
  }
  return messageId;
}

function ensureStreamingFlowMessage(
  ctx: SSEHandlerContext,
  section: StreamingFlowSection
): string | null {
  const flow = ctx.streamingFlow;
  if (flow.status === 'idle') {
    flow.status = 'running';
    flow.startedAt = Date.now();
  }

  const lines = flowSectionLines(flow, section);
  if (
    lines.length === 0 &&
    section !== 'phase' &&
    !(section === 'conversation' && flow.conversationEnabled)
  ) {
    return null;
  }

  let messageId = resolveStreamingFlowMessageId(ctx, section);
  if (!messageId) {
    messageId = ctx.generateId();
    setFlowSectionMessageId(flow, section, messageId);
    ctx.addMessage({
      id: messageId,
      role: 'assistant',
      content: buildStreamingFlowContent(flow, section),
      timestamp: Date.now(),
      flowTag: 'streaming_flow',
    });
  }

  return messageId;
}

function refreshStreamingFlowMessage(
  ctx: SSEHandlerContext,
  section: StreamingFlowSection,
  options: {createIfMissing?: boolean} = {}
): void {
  const flow = ctx.streamingFlow;
  const messageId = options.createIfMissing === false
    ? resolveStreamingFlowMessageId(ctx, section)
    : ensureStreamingFlowMessage(ctx, section);
  if (!messageId) return;
  flow.lastUpdatedAt = Date.now();
  ctx.updateMessage(messageId, {
    content: buildStreamingFlowContent(flow, section),
    timestamp: flow.lastUpdatedAt,
    flowTag: 'streaming_flow',
  }, {persist: false});
}

function isConversationTimelineEnabled(ctx: SSEHandlerContext): boolean {
  return ctx.streamingFlow.conversationEnabled;
}

function pushStreamingPhase(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (appendFlowLine(ctx.streamingFlow.phases, line, STREAM_FLOW_LIMITS.phases)) {
    refreshStreamingFlowMessage(ctx, 'phase');
  }
}

function pushStreamingThought(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (appendFlowLine(ctx.streamingFlow.thoughts, line, STREAM_FLOW_LIMITS.thoughts)) {
    refreshStreamingFlowMessage(ctx, 'thought');
  }
}

function pushStreamingTool(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (appendFlowLine(ctx.streamingFlow.tools, line, STREAM_FLOW_LIMITS.tools)) {
    refreshStreamingFlowMessage(ctx, 'tool');
  }
}

function pushStreamingOutput(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (appendFlowLine(ctx.streamingFlow.outputs, line, STREAM_FLOW_LIMITS.outputs)) {
    refreshStreamingFlowMessage(ctx, 'output');
  }
}

function getConversationPhaseLabel(phase: ConversationStepTimelineItem['phase']): string {
  switch (phase) {
    case 'progress':
      return '进度';
    case 'thinking':
      return '思考';
    case 'tool':
      return '工具';
    case 'result':
      return '结果';
    case 'error':
      return '错误';
  }
}

function getConversationRoleLabel(role: ConversationStepTimelineItem['role']): string {
  return role === 'system' ? '系统' : '助手';
}

function renderConversationStepLine(step: ConversationStepTimelineItem): string {
  const phaseLabel = getConversationPhaseLabel(step.phase);
  const roleLabel = getConversationRoleLabel(step.role);
  return `#${step.ordinal} [${phaseLabel}/${roleLabel}] ${step.text}`;
}

function getConversationPhaseMinGapMs(phase: ConversationStepTimelineItem['phase']): number {
  switch (phase) {
    case 'thinking':
      return 220;
    case 'tool':
      return 160;
    case 'result':
      return 120;
    case 'error':
      return 0;
    case 'progress':
    default:
      return 120;
  }
}

function flushConversationTimeline(
  ctx: SSEHandlerContext,
  options: {force?: boolean} = {}
): boolean {
  const flow = ctx.streamingFlow;
  let changed = false;
  let flushed = 0;
  while (true) {
    const nextOrdinal = flow.conversationLastOrdinal + 1;
    const step = flow.conversationPendingSteps[nextOrdinal];
    if (!step) break;

    if (options.force !== true) {
      const lastRenderedAt = flow.conversationLastRenderedAt || 0;
      const minGapMs = getConversationPhaseMinGapMs(step.phase);
      const now = Date.now();
      if (lastRenderedAt > 0 && now - lastRenderedAt < minGapMs) {
        break;
      }
    }

    delete flow.conversationPendingSteps[nextOrdinal];
    const line = renderConversationStepLine(step);
    if (appendFlowLine(flow.conversationLines, line, STREAM_FLOW_LIMITS.conversation)) {
      changed = true;
    }
    flow.conversationLastOrdinal = nextOrdinal;
    flow.conversationLastRenderedAt = Date.now();
    flushed += 1;
    if (options.force !== true && flushed >= 1) {
      break;
    }
  }
  if (changed) {
    refreshStreamingFlowMessage(ctx, 'conversation');
  }
  return changed;
}

function completeStreamingFlow(ctx: SSEHandlerContext): void {
  if (ctx.streamingFlow.status === 'running' || ctx.streamingFlow.status === 'idle') {
    ctx.streamingFlow.status = 'completed';
    if (ctx.streamingFlow.conversationEnabled) {
      flushConversationTimeline(ctx, {force: true});
    }
    const hasLegacyFlow = (
      ctx.streamingFlow.phases.length > 0 ||
      ctx.streamingFlow.thoughts.length > 0 ||
      ctx.streamingFlow.tools.length > 0 ||
      ctx.streamingFlow.outputs.length > 0
    );
    refreshStreamingFlowMessage(ctx, 'phase', {createIfMissing: hasLegacyFlow});
    if (ctx.streamingFlow.conversationEnabled) {
      refreshStreamingFlowMessage(ctx, 'conversation', {
        createIfMissing: ctx.streamingFlow.conversationLines.length > 0,
      });
    }
  }
}

function failStreamingFlow(ctx: SSEHandlerContext, error?: string): void {
  ctx.streamingFlow.status = 'failed';
  ctx.streamingFlow.error = normalizeFlowLine(error || 'unknown_error');
  if (ctx.streamingFlow.conversationEnabled) {
    flushConversationTimeline(ctx, {force: true});
  }
  const hasLegacyFlow = (
    ctx.streamingFlow.phases.length > 0 ||
    ctx.streamingFlow.thoughts.length > 0 ||
    ctx.streamingFlow.tools.length > 0 ||
    ctx.streamingFlow.outputs.length > 0
  );
  refreshStreamingFlowMessage(ctx, 'phase', {createIfMissing: hasLegacyFlow});
  if (ctx.streamingFlow.conversationEnabled) {
    refreshStreamingFlowMessage(ctx, 'conversation', {
      createIfMissing: ctx.streamingFlow.conversationLines.length > 0,
    });
  }
}

function ensureStreamingAnswerMessage(ctx: SSEHandlerContext): string {
  const answer = ctx.streamingAnswer;
  if (answer.status === 'idle') {
    answer.status = 'streaming';
    answer.startedAt = Date.now();
  }

  const hasExisting = answer.messageId
    ? ctx.getMessages().some((msg) => msg.id === answer.messageId)
    : false;

  if (!hasExisting) {
    answer.messageId = ctx.generateId();
    ctx.addMessage({
      id: answer.messageId,
      role: 'assistant',
      content: answer.content || '',
      timestamp: Date.now(),
      flowTag: 'answer_stream',
    });
  }

  return answer.messageId!;
}

function flushStreamingAnswer(
  ctx: SSEHandlerContext,
  options: {force?: boolean; persist?: boolean} = {}
): void {
  const answer = ctx.streamingAnswer;
  if (!options.force && !answer.pending) return;

  const messageId = ensureStreamingAnswerMessage(ctx);
  if (answer.pending) {
    answer.content += answer.pending;
    answer.pending = '';
  }

  answer.lastUpdatedAt = Date.now();
  ctx.updateMessage(messageId, {
    content: answer.content,
    timestamp: answer.lastUpdatedAt,
    flowTag: 'answer_stream',
  }, {persist: options.persist === true});
}

function completeStreamingAnswer(ctx: SSEHandlerContext): void {
  const answer = ctx.streamingAnswer;
  if (answer.status === 'completed') return;
  if (!answer.messageId && !answer.pending && !answer.content) {
    answer.status = 'completed';
    return;
  }
  flushStreamingAnswer(ctx, {force: true, persist: true});
  answer.status = 'completed';
}

function failStreamingAnswer(ctx: SSEHandlerContext): void {
  const answer = ctx.streamingAnswer;
  if (answer.status === 'failed') return;
  if (!answer.messageId && !answer.pending && !answer.content) {
    answer.status = 'failed';
    return;
  }
  flushStreamingAnswer(ctx, {force: true, persist: true});
  answer.status = 'failed';
}

function describeEnvelopeOutput(envelope: DataEnvelope): string {
  const title = envelope.display?.title || envelope.meta?.stepId || envelope.meta?.skillId || '数据更新';
  const payload = envelope.data;
  const rowCount = Array.isArray(payload?.rows) ? payload.rows.length : undefined;
  if (typeof rowCount === 'number') {
    return `${title} (${rowCount} 行)`;
  }
  return `${title} (${envelope.display?.format || 'table'})`;
}

/**
 * Process a progress event - shows analysis phase updates.
 */
export function handleProgressEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const phase = normalizeFlowLine(readStringField(payload, 'phase'));
  const phaseMessage = normalizeFlowLine(readStringField(payload, 'message'));

  if (readStringField(payload, 'phase') === 'analysis_plan') {
    pushStreamingPhase(ctx, phaseMessage || '分析计划已确认');
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: formatAnalysisPlanMessage(payload.plan, readStringField(payload, 'message')),
      timestamp: Date.now(),
    });
    return {};
  }

  if (phaseMessage) {
    pushStreamingPhase(ctx, phaseMessage);
    return {};
  }

  if (phase) {
    pushStreamingPhase(ctx, `阶段: ${phase}`);
  }
  return {};
}

function formatAnalysisPlanMessage(plan: unknown, fallbackMessage?: string): string {
  if (!isRecord(plan)) {
    return `### 🧭 分析计划已确认\n\n${fallbackMessage || '先收集证据，再给根因假设。'}`;
  }

  const planRecord = plan;

  const lines: string[] = ['### 🧭 分析计划已确认'];

  const objective = readStringField(planRecord, 'objective').trim();
  if (objective) {
    lines.push('', `目标: ${objective}`);
  }

  const mode = readStringField(planRecord, 'mode').trim();
  if (mode) {
    lines.push('', `模式: \`${mode}\``);
  }

  const strategy = asRecord(planRecord.strategy);
  if (Object.keys(strategy).length > 0) {
    const strategyName = readStringField(strategy, 'name') || readStringField(strategy, 'id') || 'unknown';
    lines.push('', `策略: **${strategyName}**`);
  }

  const rawSteps = Array.isArray(planRecord.steps) ? planRecord.steps : [];
  const steps = rawSteps.map((step) => asRecord(step));
  if (steps.length > 0) {
    lines.push('', '**步骤**');
    const sorted = [...steps].sort((a, b) => (readNumberField(a, 'order', 0)) - (readNumberField(b, 'order', 0)));
    for (const step of sorted) {
      const order = readNumberField(step, 'order', 0);
      const title = readStringField(step, 'title', '步骤');
      const action = readStringField(step, 'action');
      lines.push(`${order}. **${title}**: ${action}`);
    }
  }

  const evidence = Array.isArray(planRecord.evidence) ? planRecord.evidence : [];
  if (evidence.length > 0) {
    lines.push('', '**证据清单**');
    for (const item of evidence) {
      lines.push(`- ${String(item)}`);
    }
  }

  lines.push('', '说明: 先收集证据，再给根因假设。');
  return lines.join('\n');
}

/**
 * Normalize markdown spacing to avoid excessive vertical gaps in chat bubbles.
 */
function normalizeMarkdownSpacing(content: string): string {
  return content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    // Collapse 3+ blank lines (including whitespace-only lines) into 1 blank line.
    .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
    .trim();
}

function normalizeColumnDefinitions(columns: unknown): SqlColumnDefinition[] | undefined {
  if (!Array.isArray(columns)) return undefined;

  const definitions = columns
    .map((col): SqlColumnDefinition | null => {
      if (typeof col === 'string') {
        return {name: col};
      }
      if (isRecord(col) && typeof col.name === 'string') {
        const normalized: SqlColumnDefinition = {name: col.name};
        if (typeof col.type === 'string') normalized.type = col.type;
        if (typeof col.format === 'string') normalized.format = col.format;
        if (typeof col.clickAction === 'string') normalized.clickAction = col.clickAction;
        if (typeof col.durationColumn === 'string') normalized.durationColumn = col.durationColumn;
        if (col.unit === 'ns' || col.unit === 'us' || col.unit === 'ms' || col.unit === 's') {
          normalized.unit = col.unit;
        }
        if (typeof col.hidden === 'boolean') normalized.hidden = col.hidden;
        return normalized;
      }
      return null;
    })
    .filter((col): col is SqlColumnDefinition => col !== null);

  return definitions.length > 0 ? definitions : undefined;
}

/**
 * Process sql_executed event - shows query results.
 */
export function handleSqlExecutedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const result = asRecord(payload.result);
  if (Object.keys(result).length > 0) {
    const rowCount = readNumberField(result, 'rowCount', 0);
    const columns = Array.isArray(result.columns) ? result.columns : [];
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const sql = readStringField(payload, 'sql');
    const expandableData = readExpandableData(result.expandableData);
    const summary = readLegacySummary(result.summary);
    pushStreamingTool(ctx, '执行 SQL 查询');
    pushStreamingOutput(ctx, `SQL 结果返回 ${rowCount} 行`);
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `📊 查询到 **${rowCount}** 条记录`,
      timestamp: Date.now(),
      sqlResult: {
        columns,
        rows,
        rowCount,
        query: sql,
        expandableData,
        summary,
      },
    });
  }
  return {};
}

/**
 * Process skill_section event - displays skill step data as a table.
 */
export function handleSkillSectionEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const section = eventPayload(data);
  if (Object.keys(section).length > 0) {
    const sectionTitle = readStringField(section, 'sectionTitle', 'Skill Section');
    const rowCount = readNumberField(section, 'rowCount', 0);
    const sectionIndex = readNumberField(section, 'sectionIndex', 0);
    const totalSections = readNumberField(section, 'totalSections', 0);
    const columns = Array.isArray(section.columns) ? section.columns : [];
    const rows = Array.isArray(section.rows) ? section.rows : [];
    const expandableData = readExpandableData(section.expandableData);
    const summary = readLegacySummary(section.summary);
    pushStreamingOutput(
      ctx,
      `${sectionTitle} (${rowCount} 行)`
    );
    // Show progress for this section - use sectionTitle for compact display
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',  // No message content, title is in table header
      timestamp: Date.now(),
      sqlResult: rowCount > 0 ? {
        columns,
        rows,
        rowCount,
        query: '',  // No SQL display
        sectionTitle: `${sectionTitle} (${sectionIndex}/${totalSections})`,
        expandableData,
        summary,
      } : undefined,
    });
  }
  return {};
}

/**
 * Process skill_diagnostics event - shows diagnostic messages.
 */
export function handleSkillDiagnosticsEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.map((item) => asRecord(item))
    : [];
  if (diagnostics.length > 0) {
    const criticalItems = diagnostics.filter((d) => readStringField(d, 'severity') === 'critical');
    const warningItems = diagnostics.filter((d) => readStringField(d, 'severity') === 'warning');
    const infoItems = diagnostics.filter((d) => readStringField(d, 'severity') === 'info');

    let content = '**🔍 诊断结果**\n\n';
    if (criticalItems.length > 0) {
      content += '🔴 **严重问题:**\n';
      criticalItems.forEach((d) => {
        content += `- ${readStringField(d, 'message')}\n`;
        const suggestions = readStringArrayField(d, 'suggestions');
        if (suggestions.length > 0) {
          content += `  *建议: ${suggestions.join('; ')}*\n`;
        }
      });
      content += '\n';
    }
    if (warningItems.length > 0) {
      content += '🟡 **警告:**\n';
      warningItems.forEach((d) => {
        content += `- ${readStringField(d, 'message')}\n`;
      });
      content += '\n';
    }
    if (infoItems.length > 0) {
      content += '🔵 **提示:**\n';
      infoItems.forEach((d) => {
        content += `- ${readStringField(d, 'message')}\n`;
      });
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: content.trim(),
      timestamp: Date.now(),
    });
    pushStreamingOutput(ctx, `诊断输出 ${diagnostics.length} 条`);
  }
  return {};
}

/**
 * Process skill_layered_result event - displays multi-layer analysis results.
 * Handles overview (L1), list (L2), and deep (L4) layer data.
 */
export function handleSkillLayeredResultEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const result = asRecord(payload.result);
  const resultLayers = asRecord(result.layers);
  const directLayers = asRecord(payload.layers);
  const layeredResult = Object.keys(resultLayers).length > 0 ? resultLayers : directLayers;
  if (Object.keys(layeredResult).length === 0) return {};

  // Deduplication check
  const resultMetadata = asRecord(result.metadata);
  const skillId =
    readStringField(payload, 'skillId') ||
    readStringField(resultMetadata, 'skillId') ||
    'unknown';
  const deduplicationKey = `skill_layered_result:${skillId}`;
  if (ctx.displayedSkillProgress.has(deduplicationKey)) {
    console.log('[SSEHandlers] Skipping duplicate skill_layered_result:', deduplicationKey);
    return {};
  }
  ctx.displayedSkillProgress.add(deduplicationKey);

  console.log('[SSEHandlers] skill_layered_result received:', payload);
  const layers = layeredResult;
  const metadata = Object.keys(resultMetadata).length > 0 ? resultMetadata : {
    skillName: readStringField(payload, 'skillName') || readStringField(payload, 'skillId'),
  };

  pushStreamingOutput(ctx, `技能结果: ${readStringField(metadata, 'skillName', skillId)}`);

  // Process overview layer (L1)
  const overview = asRecord(layers.overview ?? layers.L1);
  if (overview && Object.keys(overview).length > 0) {
    processOverviewLayer(overview, metadata, ctx);
  }

  // Process list layer (L2)
  const deep = asRecord(layers.deep ?? layers.L4);
  const list = asRecord(layers.list ?? layers.L2);
  if (list && typeof list === 'object') {
    processListLayer(list, deep, ctx);
  }

  // Show conclusion card if available
  const conclusionCandidate = result.conclusion ?? extractConclusionFromOverview(overview);
  const conclusion = asRecord(conclusionCandidate);
  if (readStringField(conclusion, 'category') && readStringField(conclusion, 'category') !== 'UNKNOWN') {
    renderConclusionCard(conclusion, ctx);
  }

  // Show summary if available
  const summary = readStringField(payload, 'summary');
  if (summary) {
    renderSummary(summary, ctx);
  }

  return {};
}

/**
 * Process overview (L1) layer data.
 */
function processOverviewLayer(
  overview: Record<string, unknown>,
  metadata: Record<string, unknown>,
  ctx: SSEHandlerContext
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (obj: unknown): obj is {data: unknown[]; display?: Record<string, unknown>} => {
    const record = asRecord(obj);
    return Array.isArray(record.data);
  };

  // Helper to extract data from StepResult
  const extractData = (obj: unknown): Record<string, unknown>[] | null => {
    if (isStepResult(obj)) {
      return obj.data.filter((item): item is Record<string, unknown> => isRecord(item));
    }
    return null;
  };

  // Helper to get display title
  const getDisplayTitle = (key: string, obj: unknown): string => {
    if (isStepResult(obj)) {
      const display = asRecord(obj.display);
      const displayTitle = readStringField(display, 'title');
      if (displayTitle) return displayTitle;
    }
    const skillName = readStringField(metadata, 'skillName');
    const skillContext = skillName ? ` (${skillName})` : '';
    return formatLayerName(key) + skillContext;
  };

  // Helper to get display format
  const getDisplayFormat = (obj: unknown): string => {
    const record = asRecord(obj);
    const display = asRecord(record.display);
    return readStringField(display, 'format', 'table').toLowerCase();
  };

  // Process each entry in overview layer
  for (const [key, val] of Object.entries(overview)) {
    if (val === null || val === undefined) continue;

    const format = getDisplayFormat(val);
    const title = getDisplayTitle(key, val);

    // Route based on display format
    if (format === 'chart') {
      const chartData = buildChartData(val, title);
      if (chartData) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          chartData,
        });
        continue;
      }
    } else if (format === 'metric') {
      const metricData = buildMetricData(val, title);
      if (metricData) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          metricData,
        });
        continue;
      }
    }

    // Default: table format
    const dataArray = extractData(val);
    if (dataArray && dataArray.length > 0) {
      const firstRow = dataArray[0];
      if (isRecord(firstRow)) {
        const valRecord = asRecord(val);
        const display = asRecord(valRecord.display);
        const displayColumnDefs = normalizeColumnDefinitions(display.columns);
        const rowColumns = Object.keys(firstRow);
        const orderedColumns = displayColumnDefs
          ? [
              ...displayColumnDefs
                .map((def) => def.name)
                .filter((name: string) => rowColumns.includes(name)),
              ...rowColumns.filter((name) =>
                !displayColumnDefs.some((def) => def.name === name)
              ),
            ]
          : rowColumns;
        const filteredColumnDefs = displayColumnDefs
          ? displayColumnDefs.filter((def) => orderedColumns.includes(def.name))
          : undefined;
        const rows = dataArray.map((item) =>
          orderedColumns.map(col => item[col])
        );

        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          sqlResult: {
            columns: orderedColumns,
            rows,
            rowCount: rows.length,
            columnDefinitions: filteredColumnDefs,
            sectionTitle: `📊 ${title}`,
          },
        });
      }
    } else if (isRecord(val)) {
      // Nested object: display as single-row table
      const objColumns = Object.keys(val);
      const objRow = objColumns.map(col => val[col]);

      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        sqlResult: {
          columns: objColumns,
          rows: [objRow],
          rowCount: 1,
          sectionTitle: `📈 ${formatLayerName(key)}`,
        },
      });
    }
  }
}

/**
 * Build chart data from step result.
 */
function buildChartData(obj: unknown, title: string): Message['chartData'] | null {
  const dataArray = asRecord(obj).data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!isRecord(firstRow)) return null;

  const keys = Object.keys(firstRow);
  const labelKey = keys.find(k =>
    k.toLowerCase().includes('label') ||
    k.toLowerCase().includes('name') ||
    k.toLowerCase().includes('type')
  );
  const valueKey = keys.find(k =>
    k.toLowerCase().includes('value') ||
    k.toLowerCase().includes('count') ||
    k.toLowerCase().includes('total')
  );

  if (!labelKey || !valueKey) return null;

  return {
    type: 'bar',
    title: title,
    data: dataArray
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        label: String(item[labelKey] || 'Unknown'),
        value: Number(item[valueKey]) || 0,
      })),
  };
}

/**
 * Build metric data from step result.
 */
function buildMetricData(obj: unknown, title: string): Message['metricData'] | null {
  const dataArray = asRecord(obj).data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!isRecord(firstRow)) return null;

  const keys = Object.keys(firstRow);
  const valueKey = keys.find(k =>
    k.toLowerCase().includes('value') ||
    k.toLowerCase().includes('total') ||
    k.toLowerCase().includes('avg')
  );

  if (valueKey) {
    const value = firstRow[valueKey];
    const rawStatus = firstRow.status;
    const status = rawStatus === 'good' || rawStatus === 'warning' || rawStatus === 'critical'
      ? rawStatus
      : undefined;
    return {
      title: title,
      value: typeof value === 'number' ? value.toFixed(2) : String(value),
      status,
    };
  }

  // If single key-value pair, use first entry
  if (keys.length === 1) {
    return {
      title: title,
      value: String(firstRow[keys[0]]),
    };
  }

  return null;
}

/**
 * Process list (L2) layer data with optional deep (L4) expandable content.
 */
function processListLayer(
  list: Record<string, unknown>,
  deep: Record<string, unknown> | undefined,
  ctx: SSEHandlerContext
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (obj: unknown): obj is {data: unknown; display?: unknown} => {
    const record = asRecord(obj);
    if (!('data' in record)) return false;
    if (Array.isArray(record.data)) return true;
    const dataRecord = asRecord(record.data);
    if (Object.keys(dataRecord).length > 0 &&
        (Array.isArray(dataRecord.columns) || Array.isArray(dataRecord.rows))) {
      return true;
    }
    return false;
  };

  // Helper to check if data is in DataPayload format
  const isDataPayloadFormat = (data: unknown): data is DataPayload => {
    const record = asRecord(data);
    return Array.isArray(record.columns) || Array.isArray(record.rows);
  };

  // Helper to find frame detail in deep layer
  const findFrameDetail = (frameId: string | number, sessionId?: string | number): Record<string, unknown> | null => {
    if (!deep || !isRecord(deep)) return null;

    const sessionKeys = sessionId !== undefined
      ? [String(sessionId), `session_${sessionId}`]
      : [];
    const frameKeys = [String(frameId), `frame_${frameId}`];

    for (const [sid, frames] of Object.entries(deep)) {
      if (sessionId !== undefined) {
        const sessionMatches = sessionKeys.some(sk => sid === sk);
        if (!sessionMatches) continue;
      }

      if (isRecord(frames)) {
        for (const fk of frameKeys) {
          const frameData = frames[fk];
          if (isRecord(frameData)) return frameData;
        }
      }
    }
    return null;
  };

  for (const [key, value] of Object.entries(list)) {
    let items: Record<string, unknown>[] = [];
    let columns: string[] = [];
    let rows: unknown[][] = [];
    let displayTitle = formatLayerName(key);
    let isExpandable = false;
    let metadataColumns: string[] = [];
    let hiddenColumns: string[] = [];
    let displayColumnDefs: SqlColumnDefinition[] | undefined;
    let filteredColumnDefs: SqlColumnDefinition[] | undefined;
    let preBindedExpandableData: SqlResultData['expandableData'] | undefined;
    let summaryReport: unknown;

    if (isStepResult(value)) {
      const stepValue = asRecord(value);
      const stepData = stepValue.data;
      const displayConfig = asRecord(stepValue.display);

      const displayTitleCandidate = readStringField(displayConfig, 'title');
      if (displayTitleCandidate) {
        displayTitle = displayTitleCandidate;
      }
      isExpandable = readBooleanField(displayConfig, 'expandable');

      const metadataCandidates = [displayConfig.metadataFields, displayConfig.metadata_columns];
      for (const candidate of metadataCandidates) {
        if (Array.isArray(candidate)) {
          metadataColumns = candidate
            .map((item) => (typeof item === 'string' ? item : ''))
            .filter((item) => item.length > 0);
          if (metadataColumns.length > 0) break;
        }
      }

      const hiddenCandidates = [displayConfig.hidden_columns, displayConfig.hiddenColumns];
      for (const candidate of hiddenCandidates) {
        if (Array.isArray(candidate)) {
          hiddenColumns = candidate
            .map((item) => (typeof item === 'string' ? item : ''))
            .filter((item) => item.length > 0);
          if (hiddenColumns.length > 0) break;
        }
      }

      displayColumnDefs = normalizeColumnDefinitions(displayConfig.columns);

      // Keep duration columns that are required by navigate_range bindings.
      if (displayColumnDefs && hiddenColumns.length > 0) {
        const durationDeps = new Set(
          displayColumnDefs
            .flatMap((def) => (
              def?.clickAction === 'navigate_range' &&
              typeof def?.durationColumn === 'string' &&
              def.durationColumn.length > 0
                ? [def.durationColumn]
                : []
            ))
        );
        hiddenColumns = hiddenColumns.filter((name) => !durationDeps.has(name));
      }

      // Extract hidden columns from column definitions
      if (displayColumnDefs && displayColumnDefs.length > 0) {
        const hiddenFromDefs = displayColumnDefs
          .filter((c) => c.hidden === true)
          .map((c) => c.name);
        hiddenColumns = [...new Set([...hiddenColumns, ...hiddenFromDefs])];
      }

      if (displayColumnDefs && hiddenColumns.length > 0) {
        const durationDeps = new Set(
          displayColumnDefs
            .flatMap((def) => (
              def?.clickAction === 'navigate_range' &&
              typeof def?.durationColumn === 'string' &&
              def.durationColumn.length > 0
                ? [def.durationColumn]
                : []
            ))
        );
        hiddenColumns = hiddenColumns.filter((name) => !durationDeps.has(name));
      }

      if (isDataPayloadFormat(stepData)) {
        // NEW DataPayload format
        const allColumns = stepData.columns || [];
        const allRows = (stepData.rows || []).filter((row): row is unknown[] => Array.isArray(row));
        preBindedExpandableData = readExpandableData(stepData.expandableData);
        summaryReport = stepData.summary;

        items = allRows.map((row) => {
          const obj: Record<string, unknown> = {};
          allColumns.forEach((col: string, i: number) => { obj[col] = row[i]; });
          return obj;
        });

        // Apply column filtering
        const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
        if (columnsToHide.size > 0) {
          const visibleIndices: number[] = [];
          columns = allColumns.filter((col: string, idx: number) => {
            if (!columnsToHide.has(col)) {
              visibleIndices.push(idx);
              return true;
            }
            return false;
          });
          rows = allRows.map((row) =>
            visibleIndices.map(idx => row[idx])
          );
        } else {
          columns = allColumns;
          rows = allRows.map((row) =>
            row.map((val) => val)
          );
        }

        if (displayColumnDefs && displayColumnDefs.length > 0) {
          const ordered = [
            ...displayColumnDefs
              .map((def) => def.name)
              .filter((name: string) => columns.includes(name)),
            ...columns.filter((name) =>
              !displayColumnDefs!.some((def) => def.name === name)
            ),
          ];

          const indexMap = new Map(columns.map((name: string, idx: number) => [name, idx]));
          columns = ordered;
          rows = rows.map((row) =>
            ordered.map((name: string) => row[indexMap.get(name) ?? -1])
          );

          filteredColumnDefs = displayColumnDefs.filter((def) =>
            columns.includes(def.name)
          );
        }
      } else {
        // Legacy format: data is array of row objects
        items = Array.isArray(stepData)
          ? stepData.filter((item): item is Record<string, unknown> => isRecord(item))
          : [];
      }
    } else if (Array.isArray(value)) {
      items = value.filter((item): item is Record<string, unknown> => isRecord(item));
    }

    // Skip if no data
    if (items.length === 0 && rows.length === 0) continue;

    // Build columns/rows from items if needed
    if (columns.length === 0 && items.length > 0) {
      const allColumns = Object.keys(items[0] || {});
      const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
      const visibleColumns = allColumns.filter(col => !columnsToHide.has(col));
      if (displayColumnDefs && displayColumnDefs.length > 0) {
        columns = [
          ...displayColumnDefs
            .map((def) => def.name)
            .filter((name: string) => visibleColumns.includes(name)),
          ...visibleColumns.filter((name) =>
            !displayColumnDefs!.some((def) => def.name === name)
          ),
        ];
        filteredColumnDefs = displayColumnDefs.filter((def) =>
          columns.includes(def.name)
        );
      } else {
        columns = visibleColumns;
      }
      rows = items.map((item) => columns.map(col => item[col]));
    }

    // Build expandable data
    let expandableData: SqlResultData['expandableData'] | undefined;
    if (preBindedExpandableData && preBindedExpandableData.length > 0) {
      expandableData = preBindedExpandableData;
    } else if (isExpandable && deep) {
      const generatedExpandableData: NonNullable<SqlResultData['expandableData']> = [];
      for (const item of items) {
        const rawFrameId = item.frame_id ?? item.frameId ?? item.id;
        if (typeof rawFrameId !== 'string' && typeof rawFrameId !== 'number') continue;

        const rawSessionId = item.session_id ?? item.sessionId;
        const sessionId = (typeof rawSessionId === 'string' || typeof rawSessionId === 'number')
          ? rawSessionId
          : undefined;

        const frameDetail = findFrameDetail(rawFrameId, sessionId);
        if (!frameDetail) continue;

        const sections = convertToExpandableSections(frameDetail.data);
        const detailItem = isRecord(frameDetail.item) ? frameDetail.item : item;
        generatedExpandableData.push({
          item: detailItem,
          result: { success: true, sections },
        });
      }

      expandableData = generatedExpandableData.length > 0 ? generatedExpandableData : undefined;
    }

    // Extract metadata for header display
    const extractedMetadata: Record<string, unknown> = {};
    if (metadataColumns.length > 0 && items.length > 0) {
      for (const col of metadataColumns) {
        if (items[0][col] !== undefined) {
          extractedMetadata[col] = items[0][col];
        }
      }
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sqlResult: {
        columns,
        rows,
        rowCount: rows.length,
        columnDefinitions: filteredColumnDefs,
        sectionTitle: `📋 ${displayTitle} (${rows.length}条)`,
        expandableData,
        metadata: Object.keys(extractedMetadata).length > 0 ? extractedMetadata : undefined,
        summaryReport: readSummaryReport(summaryReport),
      },
    });
  }
}

/**
 * Render conclusion card from analysis result.
 */
function renderConclusionCard(conclusion: Record<string, unknown>, ctx: SSEHandlerContext): void {
  const category = readStringField(conclusion, 'category', 'UNKNOWN');
  const component = readStringField(conclusion, 'component', 'unknown');
  const summary = readStringField(conclusion, 'summary', '暂无总结');
  const suggestion = readStringField(conclusion, 'suggestion');
  const evidence = readStringArrayField(conclusion, 'evidence');
  const confidencePercent = Math.round(readNumberField(conclusion, 'confidence', 0.5) * 100);

  const categoryEmoji = category === 'APP' ? '📱' :
                        category === 'SYSTEM' ? '⚙️' :
                        category === 'MIXED' ? '🔄' : '❓';
  const confidenceBar = '█'.repeat(Math.floor(confidencePercent / 10)) +
                        '░'.repeat(10 - Math.floor(confidencePercent / 10));

  let conclusionContent = `## 🎯 分析结论\n\n`;
  conclusionContent += `**问题分类:** ${categoryEmoji} **${translateCategory(category)}**\n`;
  conclusionContent += `**问题组件:** \`${translateComponent(component)}\`\n`;
  conclusionContent += `**置信度:** ${confidenceBar} ${confidencePercent}%\n\n`;
  conclusionContent += `### 📋 根因分析\n${summary}\n\n`;

  if (suggestion) {
    conclusionContent += `### 💡 优化建议\n${suggestion}\n\n`;
  }

  if (evidence.length > 0) {
    conclusionContent += `### 📊 证据\n`;
    evidence.forEach((e: string) => {
      conclusionContent += `- ${e}\n`;
    });
  }

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: conclusionContent,
    timestamp: Date.now(),
  });
}

/**
 * Render summary section.
 */
function renderSummary(summary: string, ctx: SSEHandlerContext): void {
  const summaryTableData = parseSummaryToTable(summary);
  if (summaryTableData) {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sqlResult: {
        columns: summaryTableData.columns,
        rows: summaryTableData.rows,
        rowCount: summaryTableData.rows.length,
        sectionTitle: '📝 分析摘要',
      },
    });
  } else {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `**📝 分析摘要:** ${summary}`,
      timestamp: Date.now(),
    });
  }
}

function renderConclusionContract(
  contract: ConclusionContract | Record<string, unknown> | null | undefined
): string | null {
  if (!contract || typeof contract !== 'object') return null;

  const contractRecord = asRecord(contract);
  const toNumber = (value: unknown): number | undefined => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const n = Number(value.replace(/[%％]/g, '').trim());
      if (Number.isFinite(n)) return n;
    }
    return undefined;
  };
  const toPercent = (value: unknown): number | undefined => {
    const n = toNumber(value);
    if (n === undefined) return undefined;
    return n <= 1 ? n * 100 : n;
  };
  const toText = (value: unknown): string => String(value ?? '').trim();

  const readFrameRefs = (value: unknown): string[] => {
    if (Array.isArray(value)) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of value) {
        const token = toText(item);
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push(token);
      }
      return out;
    }

    if (typeof value !== 'string') return [];
    const normalized = String(value)
      .replace(/[（(]\s*其余\s*\d+\s*帧省略\s*[）)]/g, '')
      .trim();
    if (!normalized) return [];

    const seen = new Set<string>();
    const out: string[] = [];
    for (const part of normalized.split(/[\/|,，;；\s]+/g)) {
      const token = toText(part);
      if (!token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
    return out;
  };

  const conclusions = readAliasedRecordArray(contractRecord, CONTRACT_ALIASES.root.conclusions);
  const clusters = readAliasedRecordArray(contractRecord, CONTRACT_ALIASES.root.clusters);
  const evidenceChain = readAliasedRecordArray(contractRecord, CONTRACT_ALIASES.root.evidenceChain);
  const uncertainties = readAliasedUnknownArray(contractRecord, CONTRACT_ALIASES.root.uncertainties);
  const nextSteps = readAliasedUnknownArray(contractRecord, CONTRACT_ALIASES.root.nextSteps);
  const metadata = readAliasedRecord(contractRecord, CONTRACT_ALIASES.root.metadata);

  const resolveClusterHeading = (): string => {
    const sceneId = toText(
      readAliasedValue(contractRecord, CONTRACT_ALIASES.root.sceneId) ??
      readAliasedValue(metadata, CONTRACT_ALIASES.metadata.sceneId)
    ).toLowerCase();
    return sceneId === 'jank' ? '## 掉帧聚类（先看大头）' : '## 聚类（先看大头）';
  };

  const resolveClusterLimit = (): number | undefined => {
    const clusterPolicy = readAliasedRecord(metadata, CONTRACT_ALIASES.metadata.clusterPolicy);
    const maxClusters = toNumber(
      readAliasedValue(clusterPolicy, CONTRACT_ALIASES.metadata.maxClusters) ??
      readAliasedValue(metadata, CONTRACT_ALIASES.metadata.maxClusters)
    );
    if (maxClusters === undefined || maxClusters <= 0) return undefined;
    return Math.round(maxClusters);
  };

  const hasSignal =
    conclusions.length > 0 ||
    clusters.length > 0 ||
    evidenceChain.length > 0 ||
    uncertainties.length > 0 ||
    nextSteps.length > 0;
  if (!hasSignal) return null;

  const lines: string[] = [];
  lines.push('## 结论（按可能性排序）');
  if (conclusions.length === 0) {
    lines.push('1. 结论信息缺失（证据不足）');
  } else {
    conclusions.slice(0, 3).forEach((item, idx: number) => {
      const statement = toText(readAliasedValue(item, CONTRACT_ALIASES.conclusion.statement));
      const trigger = toText(readAliasedValue(item, CONTRACT_ALIASES.conclusion.trigger));
      const supply = toText(readAliasedValue(item, CONTRACT_ALIASES.conclusion.supply));
      const amplification = toText(readAliasedValue(item, CONTRACT_ALIASES.conclusion.amplification));
      let resolved = statement;
      if (!resolved && (trigger || supply || amplification)) {
        const parts: string[] = [];
        if (trigger) parts.push(`触发因子（直接原因）: ${trigger}`);
        if (supply) parts.push(`供给约束（资源瓶颈）: ${supply}`);
        if (amplification) parts.push(`放大路径（问题放大环节）: ${amplification}`);
        resolved = parts.join('；');
      }
      const confidence = toPercent(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.confidence)
      );
      const suffix = confidence !== undefined ? `（置信度: ${Math.round(confidence)}%）` : '';
      lines.push(`${idx + 1}. ${resolved || '结论信息缺失'}${suffix}`);
    });
  }
  lines.push('');

  lines.push(resolveClusterHeading());
  if (clusters.length === 0) {
    lines.push('- 暂无');
  } else {
    const clusterLimit = resolveClusterLimit();
    const clusterItems = clusterLimit !== undefined ? clusters.slice(0, clusterLimit) : clusters;
    clusterItems.forEach((item) => {
      const cluster = toText(readAliasedValue(item, CONTRACT_ALIASES.cluster.cluster));
      const description = toText(readAliasedValue(item, CONTRACT_ALIASES.cluster.description));
      const frames = toNumber(readAliasedValue(item, CONTRACT_ALIASES.cluster.frames));
      const percentage = toPercent(readAliasedValue(item, CONTRACT_ALIASES.cluster.percentage));
      const label = description ? `${cluster || 'K?'}: ${description}` : (cluster || 'K?');
      const metrics: string[] = [];
      if (frames !== undefined) metrics.push(`${Math.round(frames)}帧`);
      if (percentage !== undefined) metrics.push(`${percentage.toFixed(1)}%`);
      const frameRefs = readFrameRefs(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.frameRefs)
      );
      const omittedFrames = toNumber(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.omittedFrames)
      );
      const frameRefText = frameRefs.length > 0 ? `；帧: ${frameRefs.join(' / ')}` : '';
      const omittedHint = omittedFrames && omittedFrames > 0 ? `（其余 ${Math.round(omittedFrames)} 帧省略）` : '';
      lines.push(`- ${label}${metrics.length > 0 ? `（${metrics.join(', ')}）` : ''}${frameRefText}${omittedHint}`);
    });
  }
  lines.push('');

  lines.push('## 证据链（对应上述结论）');
  if (evidenceChain.length === 0) {
    lines.push('- 证据链信息缺失');
  } else {
    evidenceChain.slice(0, 12).forEach((item, idx: number) => {
      const cid = toText(
        readAliasedValue(item, CONTRACT_ALIASES.evidence.conclusionId) || `C${idx + 1}`
      );
      const evidence = readAliasedValue(item, CONTRACT_ALIASES.evidence.evidence);
      if (Array.isArray(evidence)) {
        for (const entry of evidence) {
          const text = toText(entry);
          if (text) lines.push(`- ${cid}: ${text}`);
        }
      } else {
        const text = toText(
          readAliasedValue(item, CONTRACT_ALIASES.evidence.text) ||
          evidence ||
          readAliasedValue(item, CONTRACT_ALIASES.evidence.statement) ||
          readAliasedValue(item, CONTRACT_ALIASES.evidence.data)
        );
        if (text) lines.push(`- ${cid}: ${text}`);
      }
    });
  }
  lines.push('');

  lines.push('## 不确定性与反例');
  if (uncertainties.length === 0) {
    lines.push('- 暂无');
  } else {
    uncertainties.slice(0, 6).forEach((item: unknown) => {
      const text = toText(item);
      if (text) lines.push(`- ${text}`);
    });
  }
  lines.push('');

  lines.push('## 下一步（最高信息增益）');
  if (nextSteps.length === 0) {
    lines.push('- 暂无');
  } else {
    nextSteps.slice(0, 6).forEach((item: unknown) => {
      const text = toText(item);
      if (text) lines.push(`- ${text}`);
    });
  }

  const metadataConfidence = readAliasedValue(metadata, CONTRACT_ALIASES.metadata.confidencePercent);
  const metadataRounds = readAliasedValue(metadata, CONTRACT_ALIASES.metadata.rounds);
  const confidence =
    toPercent(
      metadataConfidence ??
      readAliasedValue(contractRecord, CONTRACT_ALIASES.root.confidence)
    );
  const rounds = toNumber(metadataRounds ?? readAliasedValue(contractRecord, CONTRACT_ALIASES.root.rounds));
  if (confidence !== undefined || rounds !== undefined) {
    lines.push('');
    lines.push('## 分析元数据');
    if (confidence !== undefined) lines.push(`- 置信度: ${Math.round(confidence)}%`);
    if (rounds !== undefined) lines.push(`- 分析轮次: ${Math.round(rounds)}`);
  }

  return lines.join('\n');
}

/**
 * Process analysis_completed event - final analysis result.
 */
export function handleAnalysisCompletedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const architecture = readStringField(eventRecord, 'architecture');
  const rawPayload = asRecord(eventRecord.data);
  const payload = toAnalysisCompletedPayload(eventRecord.data);
  console.log('[SSEHandlers] analysis_completed received, architecture:', architecture || 'unknown');

  mergeConversationTimelineFromAnalysisCompleted(rawPayload, ctx);

  // Guard against duplicate handling
  if (ctx.completionHandled) {
    console.log('[SSEHandlers] Completion already handled, skipping');
    return { isTerminal: true, stopLoading: true };
  }

  // Support both 'answer' (legacy) and 'conclusion' (agent-driven),
  // and fall back to structured conclusionContract when narrative text is absent.
  const contractContent = renderConclusionContract(payload?.conclusionContract);
  const answerContent = payload?.answer || payload?.conclusion || contractContent;

  if (answerContent) {
    ctx.setCompletionHandled(true);
    // Keep the in-flight context object consistent as well (unit tests and
    // any caller that reuses the same context instance for multiple events).
    ctx.completionHandled = true;
    pushStreamingOutput(ctx, '最终结论已生成');
    completeStreamingFlow(ctx);

    // Build content with agent-driven metadata if available
    let content = answerContent;

    const isAgentDriven = architecture === 'v2-agent-driven' || architecture === 'agent-driven';
    if (isAgentDriven && payload?.hypotheses) {
      const hypotheses = payload.hypotheses;
      const confirmed = hypotheses.filter((h: AnalysisHypothesisItem) => h.status === 'confirmed');
      const confidence = payload.confidence || 0;

      const hasMetadataSection = /(?:^|\n)(?:##\s*分析元数据|\*\*分析元数据\*\*)/m.test(content);
      if (!hasMetadataSection && (confirmed.length > 0 || confidence > 0)) {
        content += `\n\n---\n**分析元数据**\n`;
        content += `- 置信度: ${(confidence * 100).toFixed(0)}%\n`;
        content += `- 分析轮次: ${payload.rounds || 1}\n`;
        if (confirmed.length > 0) {
          content += `- 确认假设: ${confirmed.map((h: AnalysisHypothesisItem) => h.description).join(', ')}\n`;
        }
      }
    }

    const reportUrl = payload?.reportUrl;
    if (!reportUrl && payload?.reportError) {
      console.warn('[SSEHandlers] HTML report generation failed:', payload.reportError);
    }

    const streamedAnswerMessageId = ctx.streamingAnswer.messageId;
    const hasStreamedAnswer = Boolean(
      streamedAnswerMessageId &&
      ctx.getMessages().some(
        (m) => m.id === streamedAnswerMessageId && String(m.content || '').trim().length > 0
      )
    );

    if (hasStreamedAnswer && streamedAnswerMessageId) {
      completeStreamingAnswer(ctx);
      ctx.streamingAnswer.content = content;
      ctx.streamingAnswer.pending = '';
      ctx.streamingAnswer.status = 'completed';
      ctx.updateMessage(streamedAnswerMessageId, {
        content,
        timestamp: Date.now(),
        reportUrl: reportUrl ? `${ctx.backendUrl}${reportUrl}` : undefined,
        flowTag: 'answer_stream',
      }, {persist: true});
    } else {
    // Check if conclusion was already shown
      const messages = ctx.getMessages();
      const hasConclusionAlready = messages.some(
        m => m.role === 'assistant' && m.content.includes('🎯 分析结论')
      );

      if (!hasConclusionAlready) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: content,
          timestamp: Date.now(),
          reportUrl: reportUrl ? `${ctx.backendUrl}${reportUrl}` : undefined,
        });
      }
    }
  }

  // Show error summary if there were any non-fatal errors
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  if (ctx.streamingFlow.status === 'running') {
    completeStreamingFlow(ctx);
  }
  if (ctx.streamingAnswer.status === 'streaming') {
    completeStreamingAnswer(ctx);
  }

  return { isTerminal: true, stopLoading: true };
}

/**
 * Process hypothesis_generated event - initial hypotheses from AI.
 */
export function handleHypothesisGeneratedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const hypotheses = readStringArrayField(payload, 'hypotheses');
  if (hypotheses.length > 0) {
    const evidenceBased = readBooleanField(payload, 'evidenceBased', false);
    const evidenceSummary = readStringArrayField(payload, 'evidenceSummary');
    pushStreamingThought(ctx, `形成 ${hypotheses.length} 个待验证假设`);
    for (const hypothesis of hypotheses.slice(0, 3)) {
      pushStreamingThought(ctx, hypothesis);
    }

    let content = '';
    if (evidenceBased) {
      content += `### 🧪 基于证据形成了 ${hypotheses.length} 个待验证假设\n`;
      if (evidenceSummary.length > 0) {
        content += '\n**首轮证据摘要**\n';
        for (const item of evidenceSummary) {
          content += `- ${item}\n`;
        }
      }
      content += '\n**待验证假设**\n';
      for (let i = 0; i < hypotheses.length; i++) {
        const h = hypotheses[i];
        content += `${i + 1}. ${h}\n`;
      }
      content += '\n_下一步将继续验证并收敛假设。_';
    } else {
      content += `### 🧪 生成了 ${hypotheses.length} 个分析假设\n`;
      for (let i = 0; i < hypotheses.length; i++) {
        const h = hypotheses[i];
        content += `${i + 1}. ${h}\n`;
      }
      content += '\n_AI 将验证这些假设..._';
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process round_start event - analysis round started.
 */
export function handleRoundStartEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const round = readNumberField(payload, 'round', 1);
    const maxRounds = readNumberField(payload, 'maxRounds', 5);
    const message = readStringField(payload, 'message') || `分析轮次 ${round}`;
    pushStreamingPhase(ctx, `${message} (${round}/${maxRounds})`);

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ 🔄 ${message} (${round}/${maxRounds})`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process agent_task_dispatched event - tasks sent to domain agents.
 */
export function handleAgentTaskDispatchedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const taskCount = readNumberField(payload, 'taskCount', 0);
    const agents = readStringArrayField(payload, 'agents');
    const message = readStringField(payload, 'message') || `派发 ${taskCount} 个任务`;
    const agentText = agents.length > 0 ? ` -> ${agents.join(', ')}` : '';
    pushStreamingTool(ctx, `${message}${agentText}`);

    let content = `⏳ 🤖 ${message}`;
    if (agents.length > 0) {
      content += `\n\n派发给: ${agents.map((a: string) => `\`${a}\``).join(', ')}`;
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process synthesis_complete event - feedback synthesis complete.
 */
export function handleSynthesisCompleteEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const confirmedFindings = readNumberField(payload, 'confirmedFindings', 0);
    const updatedHypotheses = readNumberField(payload, 'updatedHypotheses', 0);
    const message = readStringField(payload, 'message') || '综合分析结果';
    pushStreamingPhase(ctx, message);
    pushStreamingOutput(ctx, `确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`);

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ 📝 ${message}\n\n确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process strategy_decision event - next iteration strategy decided.
 */
export function handleStrategyDecisionEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const strategy = readStringField(payload, 'strategy') || 'continue';
    const confidence = readNumberField(payload, 'confidence', 0);
    const message = readStringField(payload, 'message') || `策略: ${strategy}`;
    pushStreamingPhase(ctx, `${message} (置信度 ${(confidence * 100).toFixed(0)}%)`);

    const strategyEmoji = strategy === 'conclude' ? '✅' :
                         strategy === 'deep_dive' ? '🔍' :
                         strategy === 'pivot' ? '↩️' : '➡️';

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ ${strategyEmoji} ${message} (置信度: ${(confidence * 100).toFixed(0)}%)`,
      timestamp: Date.now(),
    });
  }
  return {};
}

/**
 * Process data event - v2.0 DataEnvelope format.
 */
export function handleDataEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  if (Object.keys(eventRecord).length === 0) return {};

  console.log('[SSEHandlers] v2.0 data event received:', eventRecord.id, eventRecord.envelope);

  const rawEnvelope = eventRecord.envelope;
  const envelopeCandidates = Array.isArray(rawEnvelope)
    ? rawEnvelope
    : (rawEnvelope ? [rawEnvelope] : []);

  for (const candidate of envelopeCandidates) {
    if (!isDataEnvelope(candidate)) {
      console.warn('[SSEHandlers] Invalid DataEnvelope:', candidate);
      continue;
    }

    const envelope = candidate;

    // Generate deduplication key
    const deduplicationKey = envelope.meta.source ||
      `${envelope.meta.skillId || 'unknown'}:${envelope.meta.stepId || 'unknown'}`;

    if (ctx.displayedSkillProgress.has(deduplicationKey)) {
      console.log('[SSEHandlers] Skipping duplicate data envelope:', deduplicationKey);
      continue;
    }
    ctx.displayedSkillProgress.add(deduplicationKey);
    pushStreamingOutput(ctx, describeEnvelopeOutput(envelope));

    renderDataEnvelope(envelope, ctx);
  }

  return {};
}

/**
 * Render a DataEnvelope based on its display format.
 */
function renderDataEnvelope(envelope: DataEnvelope, ctx: SSEHandlerContext): void {
  const format = envelope.display.format || 'table';
  const payload = envelope.data;
  const title = envelope.display.title;

  switch (format) {
    case 'text':
      if (payload.text) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: `**${title}**\n\n${payload.text}`,
          timestamp: Date.now(),
        });
      }
      break;

    case 'summary':
      if (payload.summary) {
        const sections: string[] = [`## 📊 ${payload.summary.title || title}`];

        const normalizedBody = normalizeMarkdownSpacing(String(payload.summary.content || ''));
        if (normalizedBody) {
          sections.push(normalizedBody);
        }

        if (payload.summary.metrics && payload.summary.metrics.length > 0) {
          const metricLines: string[] = ['### 关键指标'];
          for (const metric of payload.summary.metrics) {
            const icon = metric.severity === 'critical' ? '🔴' :
                         metric.severity === 'warning' ? '🟡' : '🟢';
            const unit = metric.unit || '';
            metricLines.push(`${icon} **${metric.label}:** ${metric.value}${unit}`);
          }
          sections.push(metricLines.join('\n'));
        }

        const summaryContent = sections.join('\n\n');

        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: summaryContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'metric':
      if (payload.summary && payload.summary.metrics) {
        let metricContent = `### 📈 ${title}\n\n`;
        for (const metric of payload.summary.metrics) {
          const icon = metric.severity === 'critical' ? '🔴' :
                       metric.severity === 'warning' ? '🟡' : '🟢';
          const unit = metric.unit || '';
          metricContent += `| ${icon} ${metric.label} | **${metric.value}${unit}** |\n`;
        }
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: metricContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'chart':
      if (payload.chart) {
        const chartConfig = payload.chart;
        let chartContent = `### 📉 ${title}\n\n`;
        chartContent += `**图表类型:** ${chartConfig.type}\n\n`;
        chartContent += `*[图表渲染暂未实现，数据已记录]*\n`;
        console.log('[SSEHandlers] Chart data received:', chartConfig);
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: chartContent,
          timestamp: Date.now(),
        });
      }
      break;

    case 'timeline':
      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: `### ⏱️ ${title}\n\n*[时间线渲染暂未实现]*\n`,
        timestamp: Date.now(),
      });
      break;

    case 'table':
    default:
      const rawResult = envelopeToSqlQueryResult(envelope);
      let filteredColumns = rawResult.columns;
      let filteredRows = rawResult.rows;
      let filteredColumnDefs = rawResult.columnDefinitions;

      if (rawResult.columnDefinitions && Array.isArray(rawResult.columnDefinitions)) {
        const hiddenFromDefs = rawResult.columnDefinitions
          .filter((c) => c.hidden === true)
          .map((c) => c.name);
        const metadataFields = envelope.display.metadataFields || [];
        const columnsToHide = new Set([...hiddenFromDefs, ...metadataFields]);

        if (columnsToHide.size > 0 && rawResult.columns.length > 0) {
          const visibleIndices: number[] = [];
          filteredColumns = rawResult.columns.filter((col: string, idx: number) => {
            if (!columnsToHide.has(col)) {
              visibleIndices.push(idx);
              return true;
            }
            return false;
          });

          filteredRows = rawResult.rows.map((row) =>
            visibleIndices.map(idx => row[idx])
          );

          filteredColumnDefs = rawResult.columnDefinitions.filter(
            (def) => !columnsToHide.has(def.name)
          );
        }
      }

      if (filteredRows.length > 0) {
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          sqlResult: {
            columns: filteredColumns,
            rows: filteredRows,
            rowCount: filteredRows.length,
            columnDefinitions: filteredColumnDefs,
            sectionTitle: title,
            group: envelope.display.group,
            collapsible: envelope.display.collapsible,
            defaultCollapsed: envelope.display.defaultCollapsed,
            maxVisibleRows: envelope.display.maxVisibleRows,
            expandableData: rawResult.expandableData,  // 【修复】传递 expandableData 用于行展开功能
          },
        });
      }
      break;
  }
}

/**
 * Process skill_error event - collect non-fatal skill errors.
 */
export function handleSkillErrorEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  if (Object.keys(eventRecord).length > 0) {
    const payload = eventPayload(data);
    const skillId = readStringField(eventRecord, 'skillId', 'unknown');
    const stepId = readStringField(payload, 'stepId') || undefined;
    const error = readStringField(payload, 'error', 'Unknown error');
    const errorInfo = {
      skillId,
      stepId,
      error,
      timestamp: Date.now(),
    };
    console.log('[SSEHandlers] Skill error collected:', errorInfo);
    ctx.collectedErrors.push(errorInfo);
    pushStreamingOutput(ctx, `步骤错误: ${errorInfo.skillId}${errorInfo.stepId ? `/${errorInfo.stepId}` : ''}`);
  }
  return {};
}

/**
 * Process error event - fatal error occurred.
 */
export function handleErrorEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  failStreamingAnswer(ctx);

  const payload = eventPayload(data);
  const error = readStringField(payload, 'error');

  if (error) {
    failStreamingFlow(ctx, error);
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `**错误:** ${error}`,
      timestamp: Date.now(),
    });
  } else {
    failStreamingFlow(ctx, '分析失败');
  }

  // Show collected errors summary if any
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  return { isTerminal: true, stopLoading: true };
}

/**
 * Show a summary of all collected errors from the analysis.
 */
function showErrorSummary(ctx: SSEHandlerContext): void {
  if (ctx.collectedErrors.length === 0) return;

  // Group errors by skillId
  const errorsBySkill = new Map<string, Array<{ stepId?: string; error: string }>>();
  for (const err of ctx.collectedErrors) {
    if (!errorsBySkill.has(err.skillId)) {
      errorsBySkill.set(err.skillId, []);
    }
    errorsBySkill.get(err.skillId)!.push({ stepId: err.stepId, error: err.error });
  }

  let summaryContent = `### ⚠️ 分析过程中遇到 ${ctx.collectedErrors.length} 个错误\n\n`;

  for (const [skillId, errors] of errorsBySkill) {
    summaryContent += `**Skill: ${skillId}**\n`;
    for (const err of errors) {
      const stepInfo = err.stepId ? ` (step: ${err.stepId})` : '';
      summaryContent += `- ${err.error}${stepInfo}\n`;
    }
    summaryContent += '\n';
  }

  summaryContent += `\n*这些错误不影响其他分析结果的展示，但可能导致部分数据缺失。*`;

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: summaryContent,
    timestamp: Date.now(),
  });

  // Clear collected errors after showing summary
  ctx.collectedErrors.length = 0;
}

// =============================================================================
// Agent-Driven Architecture v2.0 - Intervention Event Handlers
// =============================================================================

/**
 * Process intervention_required event - user input needed.
 * Shows the intervention panel with options for the user.
 */
export function handleInterventionRequiredEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const interventionData = eventPayload(data);
  console.log('[SSEHandlers] intervention_required received:', interventionData);

  if (!ctx.setInterventionState) {
    console.warn('[SSEHandlers] Intervention state handler not available');
    return {};
  }

  if (!readStringField(interventionData, 'interventionId')) {
    console.warn('[SSEHandlers] Invalid intervention_required event:', data);
    return {};
  }

  const rawContext = asRecord(interventionData.context);

  // Build intervention point
  const intervention: InterventionPoint = {
    interventionId: readStringField(interventionData, 'interventionId'),
    type: readInterventionType(interventionData.type),
    options: readInterventionOptions(interventionData.options),
    context: {
      confidence: readNumberField(rawContext, 'confidence', 0),
      elapsedTimeMs: readNumberField(rawContext, 'elapsedTimeMs', 0),
      roundsCompleted: readNumberField(rawContext, 'roundsCompleted', 0),
      progressSummary: readStringField(rawContext, 'progressSummary', ''),
      triggerReason: readStringField(rawContext, 'triggerReason', ''),
      findingsCount: readNumberField(rawContext, 'findingsCount', 0),
    },
    timeout: readNumberField(interventionData, 'timeout', 60000),
  };

  // Update intervention state to show panel
  ctx.setInterventionState({
    isActive: true,
    intervention,
    selectedOptionId: null,
    customInput: '',
    isSending: false,
    timeoutRemaining: intervention.timeout,
  });

  // Add a message to show intervention is required
  pushStreamingPhase(ctx, '等待用户决策');

  const typeEmoji = intervention.type === 'low_confidence' ? '🤔' :
                    intervention.type === 'ambiguity' ? '🔀' :
                    intervention.type === 'timeout' ? '⏰' :
                    intervention.type === 'circuit_breaker' ? '⚠️' : '❓';

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'system',
    content: `${typeEmoji} **需要您的决定**\n\n${intervention.context.triggerReason || '分析需要用户输入才能继续。'}\n\n_请在下方选择操作..._`,
    timestamp: Date.now(),
  });

  return {};
}

/**
 * Process intervention_resolved event - user responded to intervention.
 */
export function handleInterventionResolvedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const resolvedData = eventPayload(data);
  console.log('[SSEHandlers] intervention_resolved received:', resolvedData);

  if (!ctx.setInterventionState) {
    return {};
  }

  if (Object.keys(resolvedData).length === 0) return {};

  const action = readStringField(resolvedData, 'action', 'continue');

  // Clear intervention state
  ctx.setInterventionState({
    isActive: false,
    intervention: null,
    selectedOptionId: null,
    customInput: '',
    isSending: false,
    timeoutRemaining: null,
  });

  // Add confirmation message
  const actionEmoji = action === 'continue' ? '▶️' :
                      action === 'focus' ? '🎯' :
                      action === 'abort' ? '🛑' : '✅';
  pushStreamingPhase(ctx, `用户决策: ${action}`);

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: `${actionEmoji} 已收到您的决定: **${action}**\n\n_分析继续中..._`,
    timestamp: Date.now(),
  });

  return {};
}

/**
 * Process intervention_timeout event - user didn't respond in time.
 */
export function handleInterventionTimeoutEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const timeoutData = eventPayload(data);
  console.log('[SSEHandlers] intervention_timeout received:', timeoutData);

  if (!ctx.setInterventionState) {
    return {};
  }

  const defaultAction = readStringField(timeoutData, 'defaultAction', 'abort');

  // Clear intervention state
  ctx.setInterventionState({
    isActive: false,
    intervention: null,
    selectedOptionId: null,
    customInput: '',
    isSending: false,
    timeoutRemaining: null,
  });

  // Add timeout message
  pushStreamingPhase(ctx, `用户响应超时，执行默认动作 ${defaultAction}`);
  ctx.addMessage({
    id: ctx.generateId(),
    role: 'system',
    content: `⏰ **响应超时**\n\n已自动执行默认操作: **${defaultAction}**`,
    timestamp: Date.now(),
  });

  return {};
}

/**
 * Process strategy_selected event - strategy was matched.
 */
export function handleStrategySelectedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const strategyData = eventPayload(data);
  console.log('[SSEHandlers] strategy_selected received:', strategyData);

  if (Object.keys(strategyData).length === 0) return {};

  const selectionMethod = readStringField(strategyData, 'selectionMethod', 'keyword');
  const strategyName = readStringField(strategyData, 'strategyName', 'unknown');
  const confidencePercent = Math.round(readNumberField(strategyData, 'confidence', 0) * 100);
  const reasoning = readStringField(strategyData, 'reasoning', '开始执行分析流水线...');
  const methodEmoji = selectionMethod === 'llm' ? '🧠' : '🔑';
  pushStreamingPhase(
    ctx,
    `选择策略 ${strategyName} (${confidencePercent}%, ${selectionMethod})`
  );

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: `⏳ ${methodEmoji} 选择策略: **${strategyName}** (${confidencePercent}%)\n\n_${reasoning}_`,
    timestamp: Date.now(),
  });

  return {};
}

/**
 * Process strategy_fallback event - no strategy matched, using hypothesis-driven.
 */
export function handleStrategyFallbackEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const fallbackData = eventPayload(data);
  console.log('[SSEHandlers] strategy_fallback received:', fallbackData);

  if (Object.keys(fallbackData).length === 0) return {};
  const reason = readStringField(fallbackData, 'reason', '未命中预设策略');
  pushStreamingPhase(ctx, `回退到假设驱动分析: ${reason}`);

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: `⏳ 🔄 使用假设驱动分析\n\n_${reason || '未匹配到预设策略，启动自适应分析...'}_`,
    timestamp: Date.now(),
  });

  return {};
}

/**
 * Process focus_updated event - user focus tracking updated.
 */
export function handleFocusUpdatedEvent(
  data: RawSSEEvent,
  _ctx: SSEHandlerContext  // eslint-disable-line @typescript-eslint/no-unused-vars
): SSEHandlerResult {
  // Focus updates are typically silent - just log for debugging
  console.log('[SSEHandlers] focus_updated:', eventPayload(data));
  return {};
}

/**
 * Process thought / worker_thought event - progressive reasoning output.
 */
export function handleThoughtEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
  source: 'assistant' | 'worker'
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = eventPayload(data);
  const content = normalizeFlowLine(
    readStringField(payload, 'content') ||
    readStringField(payload, 'message') ||
    readStringField(eventRecord, 'content') ||
    readStringField(eventRecord, 'message')
  );
  if (!content) return {};

  const prefix = source === 'worker' ? 'Worker' : 'Assistant';
  pushStreamingThought(ctx, `${prefix}: ${content}`);
  return {};
}

/**
 * Process agent_dialogue event - tool/task dispatch details.
 */
export function handleAgentDialogueEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const task = asRecord(payload.task);
  const phase = normalizeFlowLine(payload.phase || payload.type || 'task_dispatched');
  const agentId = normalizeFlowLine(payload.agentId || payload.agent || 'agent');
  const taskId = normalizeFlowLine(payload.taskId || payload.task_id || '');
  const title = normalizeFlowLine(
    payload.taskTitle ||
    task.title ||
    task.description ||
    payload.message ||
    ''
  );

  const taskSuffix = taskId ? ` (#${taskId})` : '';
  const detail = title ? `: ${title}` : '';
  pushStreamingTool(ctx, `${agentId} ${phase}${taskSuffix}${detail}`);
  return {};
}

/**
 * Process agent_response event - tool/task completion details.
 */
export function handleAgentResponseEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const response = asRecord(payload.response);
  const agentId = normalizeFlowLine(payload.agentId || payload.agent || 'agent');
  const taskId = normalizeFlowLine(payload.taskId || payload.task_id || '');
  const summary = normalizeFlowLine(
    payload.message ||
    payload.summary ||
    response.summary ||
    response.conclusion ||
    '任务完成'
  );

  const taskSuffix = taskId ? ` (#${taskId})` : '';
  pushStreamingTool(ctx, `${agentId} 完成任务${taskSuffix}`);
  pushStreamingOutput(ctx, `${agentId}: ${summary}`);
  return {};
}

/**
 * Process tool_call event - generic tool/task lifecycle updates.
 */
export function handleToolCallEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const phase = normalizeFlowLine(readStringField(payload, 'phase', 'task_dispatched')).toLowerCase();
  const isCompletedPhase = (
    phase.includes('completed') ||
    phase.includes('done') ||
    phase.includes('finished')
  );
  if (isCompletedPhase) {
    return handleAgentResponseEvent({data: payload}, ctx);
  }
  return handleAgentDialogueEvent({data: payload}, ctx);
}

/**
 * Process finding event - compact incremental findings summary.
 */
export function handleFindingEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const findingsRaw = Array.isArray(payload.findings) ? payload.findings : [];
  if (findingsRaw.length === 0) return {};

  pushStreamingOutput(ctx, `新增发现 ${findingsRaw.length} 条`);
  for (const item of findingsRaw.slice(0, 2)) {
    const finding = asRecord(item);
    const title = normalizeFlowLine(
      readStringField(finding, 'title') ||
      readStringField(finding, 'description')
    );
    if (title) {
      pushStreamingOutput(ctx, title);
    }
  }
  return {};
}

/**
 * Process stage_transition event - strategy stage progress.
 */
export function handleStageTransitionEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const stageName = normalizeFlowLine(readStringField(payload, 'stageName'));
  const stageIndex = readNumberField(payload, 'stageIndex', -1);
  const totalStages = readNumberField(payload, 'totalStages', 0);
  const skipped = readBooleanField(payload, 'skipped', false);
  const skipReason = normalizeFlowLine(readStringField(payload, 'skipReason'));

  if (!stageName && stageIndex < 0) return {};

  const stageSeq = stageIndex >= 0 && totalStages > 0
    ? ` (${stageIndex + 1}/${totalStages})`
    : '';
  const label = skipped ? '跳过阶段' : '进入阶段';
  const detail = stageName ? ` ${stageName}` : '';
  const reason = skipped && skipReason ? `: ${skipReason}` : '';
  pushStreamingPhase(ctx, `${label}${detail}${stageSeq}${reason}`);
  return {};
}

function toConversationPhase(value: string): ConversationStepTimelineItem['phase'] {
  switch (value) {
    case 'thinking':
    case 'tool':
    case 'result':
    case 'error':
      return value;
    case 'progress':
    default:
      return 'progress';
  }
}

function toConversationRole(value: string): ConversationStepTimelineItem['role'] {
  return value === 'system' ? 'system' : 'agent';
}

/**
 * Process conversation_step event - strict ordinal conversational timeline.
 */
export function handleConversationStepEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = eventPayload(data);
  const content = asRecord(payload.content);

  const text = normalizeFlowLine(
    readStringField(content, 'text') ||
    readStringField(payload, 'text') ||
    readStringField(payload, 'message')
  );
  if (!text) return {};

  const eventId = normalizeFlowLine(
    readStringField(payload, 'eventId') ||
    readStringField(eventRecord, 'id')
  );
  if (eventId && ctx.streamingFlow.conversationSeenEventIds.has(eventId)) {
    return {};
  }
  if (eventId) {
    ctx.streamingFlow.conversationSeenEventIds.add(eventId);
    if (ctx.streamingFlow.conversationSeenEventIds.size > 512) {
      const first = ctx.streamingFlow.conversationSeenEventIds.values().next().value;
      if (typeof first === 'string') {
        ctx.streamingFlow.conversationSeenEventIds.delete(first);
      }
    }
  }

  let ordinal = readNumberField(payload, 'ordinal', -1);
  if (!Number.isFinite(ordinal) || ordinal <= 0) {
    ordinal = ctx.streamingFlow.conversationLastOrdinal + 1;
  }
  if (ordinal <= ctx.streamingFlow.conversationLastOrdinal) {
    return {};
  }

  const flow = ctx.streamingFlow;
  flow.conversationEnabled = true;
  if (flow.status === 'idle') {
    flow.status = 'running';
    flow.startedAt = Date.now();
  }

  if (!flow.conversationPendingSteps[ordinal]) {
    flow.conversationPendingSteps[ordinal] = {
      ordinal,
      phase: toConversationPhase(normalizeFlowLine(readStringField(payload, 'phase', 'progress')).toLowerCase()),
      role: toConversationRole(normalizeFlowLine(readStringField(payload, 'role', 'agent')).toLowerCase()),
      text,
    };
  }

  const changed = flushConversationTimeline(ctx);
  if (!changed) {
    refreshStreamingFlowMessage(ctx, 'conversation', {createIfMissing: true});
  }
  return {};
}

function mergeConversationTimelineFromAnalysisCompleted(
  source: Record<string, unknown>,
  ctx: SSEHandlerContext
): void {
  const timeline = Array.isArray(source.conversationTimeline)
    ? source.conversationTimeline
    : [];
  if (timeline.length === 0) return;

  for (const entry of timeline) {
    const step = asRecord(entry);
    const stepEvent = {
      id: readStringField(step, 'eventId') || undefined,
      data: {
        eventId: readStringField(step, 'eventId'),
        ordinal: readNumberField(step, 'ordinal', -1),
        phase: readStringField(step, 'phase', 'progress'),
        role: readStringField(step, 'role', 'agent'),
        content: {
          text: readStringField(step, 'text'),
        },
      },
    };
    handleConversationStepEvent(stepEvent, ctx);
  }

  if (ctx.streamingFlow.conversationEnabled) {
    flushConversationTimeline(ctx, {force: true});
  }
}

/**
 * Process answer_token event - incremental final answer stream.
 */
export function handleAnswerTokenEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const payload = eventPayload(data);
  const rawToken = payload.token ?? payload.delta ?? '';
  const token = String(rawToken || '');
  const done = payload.done === true;

  if (token) {
    const answer = ctx.streamingAnswer;
    if (answer.status === 'idle') {
      pushStreamingOutput(ctx, '最终回答生成中...');
    }
    answer.status = 'streaming';
    answer.pending += token;

    const now = Date.now();
    const lastUpdate = answer.lastUpdatedAt || 0;
    const shouldFlush =
      !answer.messageId ||
      token.includes('\n') ||
      /[。！？!?；;：:,，]$/.test(token) ||
      answer.pending.length >= ANSWER_STREAM_PENDING_CHUNK_SIZE ||
      now - lastUpdate >= ANSWER_STREAM_RENDER_INTERVAL_MS;

    if (shouldFlush) {
      flushStreamingAnswer(ctx, {persist: false});
    }
  }

  if (done) {
    pushStreamingOutput(ctx, '最终回答已输出');
    completeStreamingAnswer(ctx);
  }

  return {};
}

/**
 * Main SSE event dispatcher.
 * Routes events to appropriate handlers based on event type.
 */
export function handleSSEEvent(
  eventType: string,
  data: unknown,
  ctx: SSEHandlerContext
): SSEHandlerResult {
  const eventData = asRecord(data);
  console.log('[SSEHandlers] SSE event:', eventType, eventData);

  switch (eventType) {
    case 'connected':
      return {};

    case 'conversation_step':
      return handleConversationStepEvent(eventData, ctx);

    case 'progress':
      return handleProgressEvent(eventData, ctx);

    case 'sql_generated':
      // SQL was generated - don't show raw SQL to user
      pushStreamingTool(ctx, 'SQL 已生成，等待执行');
      return {};

    case 'sql_executed':
      return handleSqlExecutedEvent(eventData, ctx);

    case 'step_completed':
      // A step was completed - already shown in sql_executed
      return {};

    case 'skill_section':
      return handleSkillSectionEvent(eventData, ctx);

    case 'skill_diagnostics':
      return handleSkillDiagnosticsEvent(eventData, ctx);

    case 'skill_layered_result':
      return handleSkillLayeredResultEvent(eventData, ctx);

    case 'analysis_completed':
      return handleAnalysisCompletedEvent(eventData, ctx);

    case 'thought':
      return handleThoughtEvent(eventData, ctx, 'assistant');

    case 'worker_thought':
      return handleThoughtEvent(eventData, ctx, 'worker');

    case 'answer_token':
      return handleAnswerTokenEvent(eventData, ctx);

    case 'data':
      return handleDataEvent(eventData, ctx);

    case 'skill_data':
      // DEPRECATED: Convert to skill_layered_result
      console.warn('[SSEHandlers] DEPRECATED: skill_data event received');
      if (eventData.data) {
        const legacyData = asRecord(eventData.data);
        const transformedData = {
          data: {
            skillId: legacyData.skillId,
            skillName: legacyData.skillName,
            layers: legacyData.layers,
            diagnostics: legacyData.diagnostics,
          },
        };
        return handleSkillLayeredResultEvent(transformedData, ctx);
      }
      return {};

    case 'finding':
      return handleFindingEvent(eventData, ctx);

    case 'hypothesis_generated':
      return handleHypothesisGeneratedEvent(eventData, ctx);

    case 'round_start':
      return handleRoundStartEvent(eventData, ctx);

    case 'stage_transition':
      return handleStageTransitionEvent(eventData, ctx);

    case 'stage_start':
      // Stage start in strategy execution
      {
        const payload = asRecord(eventData.data);
        const message = payload.message;
        if (typeof message === 'string') {
          pushStreamingPhase(ctx, message);
        }
      }
      return {};

    case 'agent_task_dispatched':
      return handleAgentTaskDispatchedEvent(eventData, ctx);

    case 'agent_dialogue':
      return handleAgentDialogueEvent(eventData, ctx);

    case 'agent_response':
      return handleAgentResponseEvent(eventData, ctx);

    case 'tool_call':
      return handleToolCallEvent(eventData, ctx);

    case 'synthesis_complete':
      return handleSynthesisCompleteEvent(eventData, ctx);

    case 'strategy_decision':
      return handleStrategyDecisionEvent(eventData, ctx);

    case 'conclusion':
      // Skip - let analysis_completed handle final message
      pushStreamingOutput(ctx, '结论文本已生成，等待落地输出');
      console.log('[SSEHandlers] CONCLUSION event received - waiting for analysis_completed');
      return {};

    // Agent-Driven Architecture v2.0 - Intervention Events
    case 'intervention_required':
      return handleInterventionRequiredEvent(eventData, ctx);

    case 'intervention_resolved':
      return handleInterventionResolvedEvent(eventData, ctx);

    case 'intervention_timeout':
      return handleInterventionTimeoutEvent(eventData, ctx);

    // Agent-Driven Architecture v2.0 - Strategy Selection Events
    case 'strategy_selected':
      return handleStrategySelectedEvent(eventData, ctx);

    case 'strategy_fallback':
      return handleStrategyFallbackEvent(eventData, ctx);

    // Agent-Driven Architecture v2.0 - Focus Tracking Events
    case 'focus_updated':
      return handleFocusUpdatedEvent(eventData, ctx);

    case 'incremental_scope':
      // Incremental scope changes are internal - just log
      console.log('[SSEHandlers] incremental_scope:', eventData.data);
      {
        const payload = asRecord(eventData.data);
        const scopeType = payload.scopeType;
        if (typeof scopeType === 'string' && scopeType) {
          pushStreamingPhase(ctx, `增量范围: ${scopeType}`);
        }
      }
      return {};

    case 'error':
      return handleErrorEvent(eventData, ctx);

    case 'skill_error':
      return handleSkillErrorEvent(eventData, ctx);

    case 'end':
      if (ctx.streamingFlow.status === 'running') {
        completeStreamingFlow(ctx);
      }
      if (ctx.streamingAnswer.status === 'streaming') {
        completeStreamingAnswer(ctx);
      }
      return { stopLoading: true };

    default:
      console.log(`[SSEHandlers] Unhandled event type: ${eventType}`);
      return {};
  }
}
