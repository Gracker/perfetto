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
 * - analysis_completed/analysis_cancelled/degraded/error: Terminal events and degraded-result notices
 */

import type {
  AnalysisReceipt,
  ConversationStepTimelineItem,
  DataSourceContext,
  Message,
  QuickRunReceipt,
  SmartScenePreviewPayload,
  StreamingAnswerState,
  StreamingFlowState,
  TracePaneSide,
  UiActionProposalV1,
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
  type ConclusionContract,
  type AnalysisCompletedEvent,
  type DataEnvelope,
  type DataPayload,
  isDataEnvelope,
  envelopeToSqlQueryResult,
} from './generated';
import {CONTRACT_ALIASES} from './conclusion_contract_aliases';
import {STEP_TO_OVERLAY} from './track_overlay';
import {updateAISharedState} from './ai_shared_state';
import {
  normalizePaneSide,
  normalizeTraceSide,
  traceLocationLabel,
} from './trace_location_label';
import {uiOutputLanguage, uiText} from './ui_language';
import {parseSourceUseReceipt} from './analysis_context';

/** Set to true for verbose SSE event logging during development. */
const DEBUG_SSE = false;

type AnalysisHypothesisItem = {
  status?: string;
  description?: string;
};

type AnalysisCompletedPayload = {
  success?: boolean;
  summary?: string;
  conclusionContract?: ConclusionContract | Record<string, unknown>;
  claimSupport?: unknown[];
  claimVerificationResult?: Record<string, unknown>;
  identityResolutions?: unknown[];
  reportUrl?: string;
  resultSnapshotId?: string;
  findings?: unknown[];
  suggestions?: string[];
  answer?: string;
  conclusion?: string;
  confidence?: number;
  rounds?: number;
  reportError?: string;
  terminalRunStatus?: AnalysisCompletedEvent['data']['terminalRunStatus'];
  completionStatus?: NonNullable<AnalysisCompletedEvent['data']['completion']>['status'];
  deliveryIncomplete?: boolean;
  deliveryCompletionPassed?: boolean;
  sourceVerificationFailed?: boolean;
  /** Local projection fields, never accepted from SSE JSON. */
  hasResultContent?: boolean;
  effectiveResultStatus?: StreamingFlowState['lastTerminalStatus'];
  partial?: boolean;
  terminationReason?: string;
  terminationMessage?: string;
  hypotheses?: AnalysisHypothesisItem[];
  smartScenePreview?: SmartScenePreviewPayload;
  quickRun?: QuickRunReceipt;
  analysisReceipt?: AnalysisReceipt;
  sourceUseReceipt?: Message['sourceUseReceipt'];
  sourceEnrichmentPending?: boolean;
  uiActionProposals?: UiActionProposalV1[];
  serverVerificationBinding?: Message['serverVerificationBinding'];
};

type DegradedPayload = {
  code?: string;
  fallback?: string;
  message?: string;
  partial?: boolean;
  terminationReason?: string;
};

type RawSSEEvent = Record<string, unknown> | null | undefined;
type SqlResultData = NonNullable<Message['sqlResult']>;
type SqlColumnDefinition = NonNullable<
  SqlResultData['columnDefinitions']
>[number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readOptionalNumberField(
  source: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function toAnalysisCompletedPayload(
  value: unknown,
): AnalysisCompletedPayload | undefined {
  const source = asRecord(value);
  if (Object.keys(source).length === 0) return undefined;

  const payload: AnalysisCompletedPayload = {};
  if (typeof source.success === 'boolean') payload.success = source.success;

  const summary = readStringField(source, 'summary');
  if (summary) payload.summary = summary;

  const conclusionContract = source.conclusionContract;
  if (isRecord(conclusionContract)) {
    payload.conclusionContract = conclusionContract;
    payload.sourceUseReceipt = parseSourceUseReceipt(conclusionContract, source.sourceClaimVerificationResult);
  }
  if (Array.isArray(source.claimSupport)) {
    payload.claimSupport = source.claimSupport;
  }
  if (isRecord(source.claimVerificationResult)) {
    payload.claimVerificationResult = source.claimVerificationResult;
  }
  if (Array.isArray(source.identityResolutions)) {
    payload.identityResolutions = source.identityResolutions;
  }
  if (
    isRecord(source.smartScenePreview) &&
    Array.isArray(source.smartScenePreview.scenes)
  ) {
    payload.smartScenePreview =
      source.smartScenePreview as unknown as SmartScenePreviewPayload;
  }

  const reportUrl = readStringField(source, 'reportUrl');
  if (reportUrl) payload.reportUrl = reportUrl;

  const resultSnapshotId = readStringField(source, 'resultSnapshotId');
  if (resultSnapshotId) payload.resultSnapshotId = resultSnapshotId;

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

  if (source.partial === true) payload.partial = true;
  if (isRecord(source.completion) && source.completion.schemaVersion === 1) {
    const completion = source.completion;
    const status = completion.status;
    payload.completionStatus = status === 'completed' || status === 'incomplete' || status === 'failed' ||
      status === 'cancelled' ? status : 'unknown';
    const candidateRef = readStringField(completion, 'candidateRef');
    const runId = readStringField(completion, 'runId');
    const attemptId = readStringField(completion, 'attemptId');
    const conclusionFingerprint = readStringField(completion, 'conclusionFingerprint');
    if (candidateRef && runId && attemptId && conclusionFingerprint) {
      payload.serverVerificationBinding = {
        candidateRef,
        runId,
        attemptId,
        conclusionFingerprint,
      };
    }
  }
  if (isRecord(source.deliveryAssurance) && source.deliveryAssurance.schemaVersion === 1) {
    const assurance = source.deliveryAssurance;
    payload.deliveryIncomplete = ['completion', 'claims', 'source', 'identity', 'report']
      .some(key => assurance[key] === 'failed' || assurance[key] === 'coverage_incomplete');
    payload.deliveryCompletionPassed = assurance.completion === 'passed';
  }
  if (isRecord(source.sourceClaimVerificationResult) &&
      source.sourceClaimVerificationResult.schemaVersion === 'source_claim_verifier@1') {
    payload.sourceVerificationFailed = source.sourceClaimVerificationResult.status === 'failed';
  }

  if (isRecord(source.quickRun)) {
    payload.quickRun = source.quickRun as unknown as QuickRunReceipt;
  }
  if (isRecord(source.analysisReceipt)) {
    payload.analysisReceipt =
      source.analysisReceipt as unknown as AnalysisReceipt;
  }
  if (source.sourceEnrichmentPending === true) {
    payload.sourceEnrichmentPending = true;
  }
  if (Array.isArray(source.uiActionProposals)) {
    payload.uiActionProposals =
      source.uiActionProposals as unknown as UiActionProposalV1[];
  }

  const terminationReason = readStringField(source, 'terminationReason');
  if (terminationReason) payload.terminationReason = terminationReason;

  const terminationMessage = readStringField(source, 'terminationMessage');
  if (terminationMessage) payload.terminationMessage = terminationMessage;

  const terminalRunStatus = readStringField(source, 'terminalRunStatus');
  if (
    terminalRunStatus === 'completed' ||
    terminalRunStatus === 'failed' ||
    terminalRunStatus === 'cancelled' ||
    terminalRunStatus === 'quota_exceeded'
  ) {
    payload.terminalRunStatus = terminalRunStatus;
  }

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

function analysisCompletedRunStatus(
  payload: AnalysisCompletedPayload | undefined,
): NonNullable<AnalysisCompletedPayload['terminalRunStatus']> {
  return payload?.terminalRunStatus ??
    (payload?.success === false ? 'failed' : 'completed');
}

/** Transport completion does not establish that the delivered answer is complete. */
function analysisCompletedResultStatus(
  payload: AnalysisCompletedPayload | undefined,
  flow?: StreamingFlowState,
): NonNullable<AnalysisCompletedPayload['terminalRunStatus']> | 'partial' {
  if (payload?.effectiveResultStatus) return payload.effectiveResultStatus;
  const claimVerification = payload?.claimVerificationResult;
  const knownVerification = claimVerification?.schemaVersion === 'claim_verifier@1' ||
    claimVerification?.schemaVersion === 'claim_verifier@2';
  const verificationFailed = knownVerification &&
    (claimVerification?.status === 'failed' ||
      (Array.isArray(claimVerification?.issues) && claimVerification.issues.some(issue =>
        isRecord(issue) && issue.severity === 'error')));
  const bindingIneligible = payload?.conclusionContract?.bindingEligibility === 'ineligible' ||
    payload?.claimSupport?.some(claim => isRecord(claim) && claim.bindingEligibility === 'ineligible');
  const explicitVerdict = payload?.terminalRunStatus !== undefined ||
    payload?.success !== undefined || payload?.completionStatus !== undefined ||
    payload?.partial === true || payload?.deliveryIncomplete || payload?.deliveryCompletionPassed ||
    payload?.sourceVerificationFailed || verificationFailed || bindingIneligible ||
    (knownVerification && claimVerification?.status === 'passed');
  if (!explicitVerdict) {
    if (flow?.lastTerminalStatus) return flow.lastTerminalStatus;
    if (flow?.status === 'partial' || flow?.status === 'failed' || flow?.status === 'cancelled') {
      return flow.status;
    }
    // Legacy full-result events may have no status fields. Report metadata or
    // an empty duplicate is never evidence that an answer completed.
    return payload?.hasResultContent ? 'completed' : 'partial';
  }
  const runStatus = analysisCompletedRunStatus(payload);
  if (runStatus !== 'completed') return runStatus;
  if (payload?.completionStatus === 'failed' || payload?.completionStatus === 'cancelled') {
    return payload.completionStatus;
  }
  return payload?.partial === true || payload?.success === false ||
    payload?.completionStatus === 'incomplete' || payload?.completionStatus === 'unknown' ||
    payload?.deliveryIncomplete || payload?.sourceVerificationFailed || verificationFailed ||
    bindingIneligible
    ? 'partial' : 'completed';
}

function settleAnalysisCompletedStreams(
  ctx: SSEHandlerContext,
  payload: AnalysisCompletedPayload | undefined,
): void {
  const status = analysisCompletedResultStatus(payload, ctx.streamingFlow);
  ctx.streamingFlow.lastTerminalStatus = status;
  if (status === 'failed') {
    failStreamingFlow(
      ctx,
      payload?.terminationMessage ?? ctx.streamingFlow.error ??
        uiText('分析未完成', 'Analysis did not complete'),
    );
    // The authoritative body was already projected. Changing run state must
    // not flush an earlier incremental buffer over that final body.
    ctx.streamingAnswer.status = 'failed';
  } else if (status === 'cancelled') {
    cancelStreamingFlow(ctx);
  } else if (status === 'partial' || status === 'quota_exceeded') {
    partialStreamingFlow(ctx, payload?.terminationMessage ?? ctx.streamingFlow.error ?? (status === 'quota_exceeded'
      ? uiText('达到使用额度，未完成全部分析。', 'The usage quota was reached before analysis completed.')
      : uiText('结果仍不完整或尚未通过核验。', 'The result is incomplete or has not passed verification.')));
  } else {
    completeStreamingFlow(ctx);
  }
}

function uiActionProposalMessageUpdate(
  payload: AnalysisCompletedPayload | undefined,
): Pick<Message, 'uiActionProposals'> {
  const proposals = payload?.uiActionProposals;
  return proposals && proposals.length > 0
    ? {uiActionProposals: proposals}
    : {};
}

function toDegradedPayload(value: unknown): DegradedPayload {
  const source = asRecord(value);
  const payload: DegradedPayload = {};
  const message = readStringField(source, 'message');
  if (message) payload.message = message;
  const code = readStringField(source, 'code');
  if (code) payload.code = code;
  const fallback = readStringField(source, 'fallback');
  if (fallback) payload.fallback = fallback;
  const terminationReason = readStringField(source, 'terminationReason');
  if (terminationReason) payload.terminationReason = terminationReason;
  if (source.partial === true) payload.partial = true;
  return payload;
}

function eventPayload(event: RawSSEEvent): Record<string, unknown> {
  const eventRecord = asRecord(event);
  return asRecord(eventRecord.data);
}

function readStringField(
  source: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = source[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumberField(
  source: Record<string, unknown>,
  key: string,
  fallback = 0,
): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readBooleanField(
  source: Record<string, unknown>,
  key: string,
  fallback = false,
): boolean {
  const value = source[key];
  return typeof value === 'boolean' ? value : fallback;
}

function readStringArrayField(
  source: Record<string, unknown>,
  key: string,
): string[] {
  const value = source[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item ?? '').trim())
    .filter((item) => item.length > 0);
}

function readAliasedValue(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (key in source) return source[key];
  }
  return undefined;
}

function readAliasedUnknownArray(
  source: Record<string, unknown>,
  keys: readonly string[],
): unknown[] {
  const value = readAliasedValue(source, keys);
  return Array.isArray(value) ? value : [];
}

function readAliasedRecord(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return asRecord(readAliasedValue(source, keys));
}

function readAliasedRecordArray(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown>[] {
  return readAliasedUnknownArray(source, keys).filter(
    (item): item is Record<string, unknown> => isRecord(item),
  );
}

function readLegacySummary(
  value: unknown,
): {title: string; content: string} | undefined {
  if (!isRecord(value)) return undefined;
  const title = readStringField(value, 'title');
  const content = readStringField(value, 'content');
  if (!title && !content) return undefined;
  return {
    title: title || uiText('摘要', 'Summary'),
    content,
  };
}

function readSummaryReport(
  value: unknown,
): SqlResultData['summaryReport'] | undefined {
  if (!isRecord(value)) return undefined;

  const title = readStringField(value, 'title');
  const content = readStringField(value, 'content');
  if (!title && !content) return undefined;

  const summaryReport: NonNullable<SqlResultData['summaryReport']> = {
    title: title || uiText('摘要', 'Summary'),
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
      const status =
        statusRaw === 'good' ||
        statusRaw === 'warning' ||
        statusRaw === 'critical'
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

function readExpandableData(
  value: unknown,
): SqlResultData['expandableData'] | undefined {
  if (!Array.isArray(value)) return undefined;

  const entries: NonNullable<SqlResultData['expandableData']> = [];
  for (const entry of value) {
    const entryRecord = asRecord(entry);
    const item = asRecord(entryRecord.item);
    if (Object.keys(item).length === 0) continue;

    const result = asRecord(entryRecord.result);
    const sections = isRecord(result.sections) ? result.sections : undefined;
    const error = readStringField(result, 'error') || undefined;
    const success = readBooleanField(
      result,
      'success',
      sections !== undefined && !error,
    );

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

/**
 * Context object passed to SSE event handlers.
 * Contains references to state and methods needed for event processing.
 */
export interface SSEHandlerContext {
  /** Canonical scene snapshots; raw data envelopes are never final stories. */
  onSceneTimelineReceived?: (timeline: unknown, terminal: boolean) => void;
  /** Add a message to the conversation */
  addMessage: (msg: Message) => void;
  /** Update an existing message */
  updateMessage: (
    messageId: string,
    updates: Partial<Message>,
    options?: {persist?: boolean},
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

  // Track overlay - callback when overlay-eligible data arrives
  /** Called with columns+rows from skill steps that have timeline overlay configs */
  onOverlayDataReceived?: (
    overlayId: string,
    columns: string[],
    rows: unknown[][],
  ) => void;
}

/**
 * Handler result indicating what action to take after processing.
 */
export interface SSEHandlerResult {
  /** Whether this is a terminal event (analysis complete or error) */
  isTerminal?: boolean;
  /** Whether to stop loading indicator */
  stopLoading?: boolean;
  /** Current analysis phase text from progress events */
  loadingPhase?: string;
}

const STREAM_FLOW_LIMITS = {
  phases: 8,
  thoughts: 6,
  tools: 8,
  outputs: 8,
  conversation: 60,
} as const;

const ANSWER_STREAM_RENDER_INTERVAL_MS = 16;
const ANSWER_STREAM_PENDING_CHUNK_SIZE = 24;

type StreamingFlowSection =
  | 'phase'
  | 'thought'
  | 'tool'
  | 'output'
  | 'conversation';

function normalizeFlowLine(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function appendFlowLine(
  lines: string[],
  rawLine: unknown,
  max: number,
): boolean {
  const line = normalizeFlowLine(rawLine);
  if (!line) return false;
  if (lines[lines.length - 1] === line) return false;
  lines.push(line);
  if (lines.length > max) {
    lines.splice(0, lines.length - max);
  }
  return true;
}

function flowSectionLines(
  flow: StreamingFlowState,
  section: StreamingFlowSection,
): string[] {
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
      // Structured steps are rendered by buildConversationTimelineMarkdown.
      return [];
  }
}

function getFlowSectionMessageId(
  flow: StreamingFlowState,
  section: StreamingFlowSection,
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
  messageId: string | null,
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
    return uiText('_持续更新中…_', '_Continuously updating…_');
  }
  if (flow.status === 'completed') {
    return uiText(
      '_流程完成，结论已生成。_',
      '_Flow complete; the conclusion is ready._',
    );
  }
  if (flow.status === 'partial') {
    return uiText(
      `_流程已结束：${flow.error || '结果仍不完整或尚未通过核验。'}_`,
      `_Flow ended: ${flow.error || 'the result is incomplete or has not passed verification.'}_`,
    );
  }
  if (flow.status === 'cancelled') {
    return uiText(
      '_流程已取消，未生成完整结论。_',
      '_Flow cancelled before a complete conclusion was generated._',
    );
  }
  if (flow.status === 'failed') {
    return uiText(
      `_流程中断：${flow.error || '发生错误'}_`,
      `_Flow interrupted: ${flow.error || 'an error occurred'}_`,
    );
  }
  return uiText('_等待后端事件…_', '_Waiting for backend events…_');
}

function buildStreamingFlowContent(
  flow: StreamingFlowState,
  section: StreamingFlowSection,
): string {
  const lines: string[] = [];
  switch (section) {
    case 'phase':
      lines.push(uiText('### 🧭 分析步骤', '### 🧭 Analysis steps'));
      break;
    case 'thought':
      lines.push(uiText('### 💭 思考', '### 💭 Reasoning'));
      break;
    case 'tool':
      lines.push(uiText('### 🛠 工具与动作', '### 🛠 Tools and actions'));
      break;
    case 'output':
      lines.push(uiText('### 📤 中间产出', '### 📤 Intermediate output'));
      break;
    case 'conversation':
      lines.push(uiText('### 🧭 分析过程', '### 🧭 Analysis process'));
      break;
  }

  if (section === 'conversation') {
    const timelineLines = buildConversationTimelineMarkdown(flow);
    if (timelineLines.length > 0) {
      lines.push('');
      lines.push(...timelineLines);
    }
  } else {
    const sectionLines = flowSectionLines(flow, section);
    if (sectionLines.length > 0) {
      lines.push('');
      for (const item of sectionLines) {
        lines.push(`- ${item}`);
      }
    }
  }

  // Render sub-agent cards in the tool section
  if (section === 'tool' && flow.subAgents.length > 0) {
    lines.push('');
    lines.push(buildSubAgentCardsHtml(flow.subAgents));
  }

  if (section === 'phase' || section === 'conversation') {
    lines.push('');
    lines.push(flowStatusHint(flow));
  }

  return lines.join('\n');
}

/** Build HTML for sub-agent status cards. */
function buildSubAgentCardsHtml(
  agents: StreamingFlowState['subAgents'],
): string {
  const cards = agents.map((a) => {
    const statusIcon =
      a.status === 'running' ? '⏳' : a.status === 'completed' ? '✅' : '❌';
    const statusClass = `sub-agent-${a.status}`;
    const dur = a.completedAt
      ? `${Math.round((a.completedAt - a.startedAt) / 1000)}s`
      : `${Math.round((Date.now() - a.startedAt) / 1000)}s...`;
    const tools =
      a.toolUses !== undefined
        ? uiText(` · ${a.toolUses} 次调用`, ` · ${a.toolUses} tool calls`)
        : '';
    return (
      `<div class="ai-sub-agent-card ${statusClass}">` +
      `<span class="ai-sub-agent-icon">${statusIcon}</span>` +
      `<span class="ai-sub-agent-name">${a.agentName}</span>` +
      `<span class="ai-sub-agent-desc">${a.description}</span>` +
      `<span class="ai-sub-agent-meta">${dur}${tools}</span>` +
      `</div>`
    );
  });
  return `<div class="ai-sub-agent-cards">${cards.join('')}</div>`;
}

function resolveStreamingFlowMessageId(
  ctx: SSEHandlerContext,
  section: StreamingFlowSection,
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
  section: StreamingFlowSection,
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
  options: {createIfMissing?: boolean; persist?: boolean} = {},
): void {
  const flow = ctx.streamingFlow;
  const messageId =
    options.createIfMissing === false
      ? resolveStreamingFlowMessageId(ctx, section)
      : ensureStreamingFlowMessage(ctx, section);
  if (!messageId) return;
  flow.lastUpdatedAt = Date.now();
  ctx.updateMessage(
    messageId,
    {
      content: buildStreamingFlowContent(flow, section),
      timestamp: flow.lastUpdatedAt,
      flowTag: 'streaming_flow',
    },
    {persist: options.persist === true},
  );
}

function isConversationTimelineEnabled(ctx: SSEHandlerContext): boolean {
  return ctx.streamingFlow.conversationEnabled;
}

function pushStreamingPhase(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (
    appendFlowLine(ctx.streamingFlow.phases, line, STREAM_FLOW_LIMITS.phases)
  ) {
    refreshStreamingFlowMessage(ctx, 'phase');
  }
}

function pushStreamingThought(ctx: SSEHandlerContext, line: string): void {
  if (isConversationTimelineEnabled(ctx)) return;
  if (
    appendFlowLine(
      ctx.streamingFlow.thoughts,
      line,
      STREAM_FLOW_LIMITS.thoughts,
    )
  ) {
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
  if (
    appendFlowLine(ctx.streamingFlow.outputs, line, STREAM_FLOW_LIMITS.outputs)
  ) {
    refreshStreamingFlowMessage(ctx, 'output');
  }
}

/**
 * Push a locally generated timeline step (sub-agent delegation and completion).
 *
 * These carry no backend ordinal, so they use their own numbering space. Taking
 * `conversationLastOrdinal + 1` instead consumed the next backend ordinal, and
 * the real step that later arrived with that number was discarded as
 * out-of-order: every sub-agent delegation silently swallowed one step.
 */
function pushConversationStep(
  ctx: SSEHandlerContext,
  phase: ConversationStepTimelineItem['phase'],
  role: ConversationStepTimelineItem['role'],
  text: string,
): void {
  const flow = ctx.streamingFlow;
  flow.localStepOrdinal += 1;
  const changed = appendConversationTimelineStep(flow, {
    ordinal: LOCAL_STEP_ORDINAL_BASE + flow.localStepOrdinal,
    phase,
    role,
    text,
    timestamp: Date.now(),
  });
  if (changed) {
    refreshStreamingFlowMessage(ctx, 'conversation', {createIfMissing: true});
  }
}

/**
 * Refresh the sub-agent cards in the streaming flow tool section.
 * Renders running/completed sub-agent cards as markdown for display.
 */
function refreshSubAgentCards(ctx: SSEHandlerContext): void {
  // Sub-agent cards are rendered as part of the tool section flow.
  // No separate message needed — the tool section already has the text lines.
  // This function triggers a re-render of the tool section to pick up updated card state.
  if (ctx.streamingFlow.tools.length > 0) {
    refreshStreamingFlowMessage(ctx, 'tool');
  }
}



/** Backend event that marks a plan phase boundary. */
const PLAN_PHASE_SOURCE_EVENT_TYPE = 'plan_phase_updated';
/** Marks the synthetic checkpoints the frontend adds around the answer stream. */
const ANSWER_TIMELINE_SOURCE_EVENT_TYPE = 'answer_stream';
/**
 * Locally generated steps carry ordinals from their own numbering spaces so
 * they cannot collide with the backend's per-run counter. Display order comes
 * from arrival, not from these numbers.
 */
const ANSWER_TIMELINE_ORDINAL_BASE = 2_000_000;
const LOCAL_STEP_ORDINAL_BASE = 1_000_000;

function isPlanPhaseStep(step: ConversationStepTimelineItem): boolean {
  return step.sourceEventType === PLAN_PHASE_SOURCE_EVENT_TYPE;
}

/**
 * Append a step in arrival order, bounded.
 *
 * The list is deliberately not sorted by ordinal. Backend steps are already
 * ordered before they get here — `flushConversationTimeline` releases them
 * strictly by `conversationLastOrdinal + 1` — while locally generated steps
 * (sub-agent delegation, answer checkpoints) carry ordinals from separate
 * numbering spaces that exist to avoid collisions, not to express time.
 * Sorting by ordinal therefore pushed every sub-agent delegation to the end of
 * the run instead of leaving it where it happened.
 *
 * Trimming drops the oldest steps. Phase lines are boundary markers rather
 * than containers, so losing one cannot strand the steps that followed it.
 */
function appendConversationTimelineStep(
  flow: StreamingFlowState,
  step: ConversationStepTimelineItem,
): boolean {
  const steps = flow.conversationSteps;
  const last = steps[steps.length - 1];
  if (last && last.ordinal === step.ordinal && last.text === step.text) return false;

  steps.push(step);
  if (steps.length > STREAM_FLOW_LIMITS.conversation) {
    steps.splice(0, steps.length - STREAM_FLOW_LIMITS.conversation);
  }
  return true;
}

function conversationStepIcon(step: ConversationStepTimelineItem): string {
  if (isPlanPhaseStep(step)) return '▸';
  switch (step.phase) {
    case 'thinking':
      return '💭';
    case 'tool':
      return '🔧';
    case 'result':
      return '→';
    case 'error':
      return '⚠';
    case 'progress':
    default:
      return '·';
  }
}

function conversationStepTime(step: ConversationStepTimelineItem): string {
  if (!step.timestamp) return '';
  return new Date(step.timestamp).toLocaleTimeString(uiText('zh-CN', 'en-US'), {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * Render the analysis process.
 *
 * Plan phases are boundary markers, not containers. Indenting steps under a
 * phase would assert that each step belongs to it, and the stream cannot
 * support that claim: a tool call is dispatched *before* the auto transition it
 * triggers, and a phase can be closed retroactively after later work already
 * started. Only `data` events carry a real `planPhaseId`. So the phase line is
 * emphasized and the steps stay flat — a weaker layout that is never wrong,
 * which also removes any way for trimming to strand an indented step.
 */
function buildConversationTimelineMarkdown(
  flow: StreamingFlowState,
): string[] {
  const steps = flow.conversationSteps;
  if (steps.length === 0) return [];

  return steps.map((step) => {
    const icon = conversationStepIcon(step);
    if (isPlanPhaseStep(step)) {
      return `- ${icon} **${step.text}**`;
    }
    const time = conversationStepTime(step);
    const timePrefix = time ? `\`${time}\` ` : '';
    return `- ${icon} ${timePrefix}${step.text}`;
  });
}



function appendAnswerTimelineLine(
  ctx: SSEHandlerContext,
  phase: ConversationStepTimelineItem['phase'],
  role: ConversationStepTimelineItem['role'],
  text: string,
): boolean {
  const lineText = normalizeFlowLine(text);
  if (!lineText) return false;

  const flow = ctx.streamingFlow;
  flow.conversationEnabled = true;
  if (flow.status === 'idle') {
    flow.status = 'running';
    flow.startedAt = Date.now();
  }

  flow.answerTimelineOrdinal += 1;
  const changed = appendConversationTimelineStep(flow, {
    // Answer checkpoints have no backend ordinal; keep them after the
    // backend steps so the process reads in the order it happened.
    ordinal: ANSWER_TIMELINE_ORDINAL_BASE + flow.answerTimelineOrdinal,
    phase,
    role,
    text: lineText,
    timestamp: Date.now(),
    sourceEventType: ANSWER_TIMELINE_SOURCE_EVENT_TYPE,
  });
  if (changed) {
    refreshStreamingFlowMessage(ctx, 'conversation', {createIfMissing: true});
  }
  return changed;
}

function ensureAnswerTimelineStarted(ctx: SSEHandlerContext): void {
  const flow = ctx.streamingFlow;
  if (flow.answerTimelineStarted) return;
  flow.answerTimelineStarted = true;
  appendAnswerTimelineLine(
    ctx,
    'progress',
    'agent',
    uiText('开始流式输出分析结果。', 'Started streaming the analysis result.'),
  );
}







function syncAnswerStreamToConversationTimeline(
  ctx: SSEHandlerContext,
  options: {force?: boolean; completed?: boolean} = {},
): void {
  const answer = ctx.streamingAnswer;
  const answerText = `${answer.content}${answer.pending}`.trim();
  if (!answerText) return;

  if (answerText) {
    ensureAnswerTimelineStarted(ctx);
  }

  const flow = ctx.streamingFlow;
  const textLength = answerText.length;
  // Answer snippets are deliberately not mirrored into the process view. They
  // existed to keep the timeline moving while it sat above the answer; the
  // answer bubble streams live on its own, and with the process shown below the
  // answer these snapshots would print the same text twice.

  if (options.completed === true && !flow.answerTimelineCompleted) {
    flow.answerTimelineCompleted = true;
    appendAnswerTimelineLine(
      ctx,
      'result',
      'agent',
      uiText(
        `最终回答已输出（${textLength} 字）。`,
        `The final answer was emitted (${textLength} characters).`,
      ),
    );
    refreshStreamingFlowMessage(ctx, 'conversation', {
      createIfMissing: true,
      persist: true,
    });
  }
}

function getConversationPhaseMinGapMs(
  phase: ConversationStepTimelineItem['phase'],
): number {
  switch (phase) {
    case 'thinking':
      return 80;
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
  options: {force?: boolean} = {},
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
        // Schedule a deferred retry so throttled steps are not lost
        if (!flow.conversationFlushTimer) {
          const retryMs = minGapMs - (now - lastRenderedAt) + 10;
          flow.conversationFlushTimer = window.setTimeout(() => {
            flow.conversationFlushTimer = undefined;
            const retryChanged = flushConversationTimeline(ctx);
            if (retryChanged) refreshStreamingFlowMessage(ctx, 'conversation');
          }, retryMs);
        }
        break;
      }
    }

    delete flow.conversationPendingSteps[nextOrdinal];
    if (appendConversationTimelineStep(flow, step)) {
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

function persistSettledStreamingFlow(ctx: SSEHandlerContext): void {
  if (ctx.streamingFlow.conversationFlushTimer) {
    clearTimeout(ctx.streamingFlow.conversationFlushTimer);
    ctx.streamingFlow.conversationFlushTimer = undefined;
  }
  if (ctx.streamingFlow.conversationEnabled) {
    flushConversationTimeline(ctx, {force: true});
  }
  const hasLegacyFlow =
    ctx.streamingFlow.phases.length > 0 ||
    ctx.streamingFlow.thoughts.length > 0 ||
    ctx.streamingFlow.tools.length > 0 ||
    ctx.streamingFlow.outputs.length > 0;
  refreshStreamingFlowMessage(ctx, 'phase', {
    createIfMissing: hasLegacyFlow,
    persist: true,
  });
  if (ctx.streamingFlow.conversationEnabled) {
    refreshStreamingFlowMessage(ctx, 'conversation', {
      createIfMissing: ctx.streamingFlow.conversationSteps.length > 0,
      persist: true,
    });
  }
}

function completeStreamingFlow(ctx: SSEHandlerContext): void {
  // Called only after the authoritative analysis_completed verdict. A replay
  // may settle a provisional partial state left by an interrupted stream.
  ctx.streamingFlow.status = 'completed';
  ctx.streamingFlow.error = null;
  persistSettledStreamingFlow(ctx);
}

function failStreamingFlow(ctx: SSEHandlerContext, error?: string): void {
  ctx.streamingFlow.status = 'failed';
  ctx.streamingFlow.error = normalizeFlowLine(error || 'unknown_error');
  persistSettledStreamingFlow(ctx);
}

function partialStreamingFlow(ctx: SSEHandlerContext, reason: string): void {
  ctx.streamingFlow.status = 'partial';
  ctx.streamingFlow.error = normalizeFlowLine(reason);
  persistSettledStreamingFlow(ctx);
}

function cancelStreamingFlow(ctx: SSEHandlerContext): void {
  ctx.streamingFlow.status = 'cancelled';
  ctx.streamingFlow.error = null;
  persistSettledStreamingFlow(ctx);
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
  options: {force?: boolean; persist?: boolean} = {},
): void {
  const answer = ctx.streamingAnswer;
  if (!options.force && !answer.pending) return;

  const messageId = ensureStreamingAnswerMessage(ctx);
  if (answer.pending) {
    answer.content += answer.pending;
    answer.pending = '';
  }

  answer.lastUpdatedAt = Date.now();
  ctx.updateMessage(
    messageId,
    {
      content: answer.content,
      timestamp: answer.lastUpdatedAt,
      flowTag: 'answer_stream',
    },
    {persist: options.persist === true},
  );
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
  const title = inferDataSourceTitle({
    source: envelope.meta?.source,
    title:
      envelope.display?.title ||
      envelope.meta?.stepId ||
      envelope.meta?.skillId ||
      uiText('数据更新', 'Data update'),
    columns: envelopeColumnsForContext(envelope),
    query: readStringField(asRecord(envelope), 'sql') || undefined,
  });
  const payload = envelope.data;
  const rowCount = Array.isArray(payload?.rows)
    ? payload.rows.length
    : undefined;
  const traceLabel = traceLocationLabel(
    readEnvelopeTraceSide(envelope),
    readEnvelopePaneSide(envelope),
  );
  const tracePrefix = traceLabel ? `${traceLabel} · ` : '';
  const preview = envelope.display.preview;
  if (preview) {
    return uiText(
      `${tracePrefix}${title}（共 ${preview.totalRows} 行，预览 ${preview.returnedRows} 行）`,
      `${tracePrefix}${title} (${preview.totalRows} rows, ${preview.returnedRows} in preview)`,
    );
  }
  if (typeof rowCount === 'number') {
    return uiText(
      `${tracePrefix}${title}（${rowCount} 行）`,
      `${tracePrefix}${title} (${rowCount} rows)`,
    );
  }
  return `${tracePrefix}${title} (${envelope.display?.format || 'table'})`;
}

function inferDataSourceReason(
  input: {
    source?: string;
    layer?: string;
    title?: string;
    query?: string;
    columns?: string[];
    planPhaseId?: string;
    planPhaseTitle?: string;
  },
  fallbackReason = '',
): string {
  const source = (input.source || '').toLowerCase();
  const title = (input.title || '').toLowerCase();
  const layer = (input.layer || '').toLowerCase();
  const planPhase =
    `${input.planPhaseId || ''} ${input.planPhaseTitle || ''}`.toLowerCase();
  const identity = `${title} ${source} ${planPhase}`;
  const columns = (input.columns || []).map((col) => col.toLowerCase());
  const joinedColumns = columns.join(' ');

  if (uiOutputLanguage() === 'en') {
    if (/insight|__synthesize_summary__/.test(identity)) {
      return 'Condenses key metrics, anomaly signals, and candidate directions to prioritize the next investigation steps.';
    }
    if (/startup_quality/.test(identity)) {
      return 'Checks trace completeness and quality warnings to determine whether conclusions are reliable.';
    }
    if (/evidence matrix/.test(identity)) {
      return 'Collects matched rules, evidence, and attribution labels so each root-cause claim can be verified.';
    }
    if (/binder|ipc/.test(identity) || /binder|ipc/.test(joinedColumns)) {
      return 'Measures cross-process calls and waits to determine whether IPC materially contributes to latency.';
    }
    if (
      /cpu|sched|core|freq/.test(identity) ||
      /cpu|sched|core|freq/.test(joinedColumns)
    ) {
      return 'Measures CPU execution, scheduling wait, core placement, or frequency supply for the target time range.';
    }
    if (/gc|memory|lmk/.test(identity) || /gc|memory|lmk/.test(joinedColumns)) {
      return 'Checks memory pressure and collection activity for a material contribution to the target latency.';
    }
    if (/slice/.test(identity) || /slice_name/.test(joinedColumns)) {
      return 'Lists matching trace slices and their durations to verify that referenced events exist in the target range.';
    }
    if (fallbackReason && !isLowSignalReason(fallbackReason)) {
      return /\p{Script=Han}/u.test(fallbackReason)
        ? 'Structured evidence produced by the current analysis step.'
        : fallbackReason;
    }
    if (input.query || source === 'execute_sql') {
      return 'Fills a verification gap not covered directly by a Skill; check the target time range, thread, and referenced entities.';
    }
    if (
      source.includes('invoke_skill') ||
      source.includes('skill') ||
      source.includes(':')
    ) {
      return 'Structured Skill evidence used for filtering, deeper analysis, or a conclusion.';
    }
    const layerReasons: Record<string, string> = {
      overview: 'Overview evidence used to identify obvious anomalies.',
      list: 'Candidate-list evidence used to choose a session, frame, or event for deeper analysis.',
      session: 'Session or range evidence used to explain one time interval.',
      deep: 'Deep evidence used to verify a frame, thread, or call-chain root cause.',
      diagnosis:
        'Diagnostic evidence used directly by conclusions and recommendations.',
    };
    return (
      layerReasons[layer] ||
      'Intermediate evidence connecting timeline activity to the final conclusion.'
    );
  }

  if (/洞见摘要|__synthesize_summary__|insight/.test(identity)) {
    return '压缩本轮启动的关键指标、异常提示和候选方向，用来决定后续优先下钻哪些问题。';
  }
  if (/启动数据质量|startup_quality/.test(identity)) {
    return '核对采样完整性、缺失项和质量警告，用来判断本轮结论是否可靠、是否需要降级为假设。';
  }
  if (/证据矩阵|evidence matrix/.test(identity)) {
    return '汇总本阶段命中的规则、证据和归因标签，用来把根因树里的判断落到可核对的证据记录。';
  }
  if (/主线程可操作热点|actionable_main_thread_slices/.test(identity)) {
    return '定位启动窗口内主线程最值得优化的热点 slice，用来判断耗时是否集中在 App/业务负载而不是框架包裹。';
  }
  if (/热点\s*slice\s*线程状态|hot_slice_states/.test(identity)) {
    return '拆分热点 slice 的 Running、Sleep、Runnable 或阻塞占比，用来区分 CPU 执行、主动等待、调度等待和锁/IO 阻塞。';
  }
  if (/主线程耗时操作|main_thread_slices/.test(identity)) {
    return '按耗时聚合启动期间主线程操作，用来先圈出影响启动墙钟时间的最大候选阶段。';
  }
  if (/主线程文件\s*io|main_thread_file_io/.test(identity)) {
    return '筛出启动期间主线程文件 IO，用来判断是否存在磁盘访问拖慢启动，或证明 IO 不是主因。';
  }
  if (/主线程同步\s*binder|main_thread_sync_binder/.test(identity)) {
    return '只看主线程同步 Binder 调用，用来判断主线程是否被跨进程返回时间卡住。';
  }
  if (/启动期间\s*binder|startup_binder/.test(identity)) {
    return '汇总启动窗口内 Binder 调用耗时和次数，用来评估跨进程通信是否对启动耗时有实质贡献。';
  }
  if (/binder\s*阻塞|binder_blocking/.test(identity)) {
    return '检查主线程 Binder 等待和远端阻塞关系，用来判断慢启动是否由服务端响应或线程池排队触发。';
  }
  if (/启动期间主线程状态|main_thread_state_during_startup/.test(identity)) {
    return '汇总启动窗口主线程 Running、Sleep、D、Runnable 占比，用来区分 CPU 忙、主动等待、IO 等待和调度等待。';
  }
  if (/启动期间类加载|class_loading/.test(identity)) {
    return '检查启动窗口类加载记录，用来判断冷启动是否被类加载或反射初始化放大。';
  }
  if (/启动期间\s*gc|gc_during_startup/.test(identity)) {
    return '统计启动窗口 GC 类型、线程和耗时占比，用来判断内存回收是否干扰主线程启动路径。';
  }
  if (/启动期间调度延迟|sched_latency_during_startup/.test(identity)) {
    return '量化 Runnable 等待和最大调度延迟，用来判断系统调度是否让主线程迟迟拿不到 CPU。';
  }
  if (/启动延迟归因|startup_breakdown/.test(identity)) {
    return '把启动总耗时拆到阶段和候选原因，用来确定后续应下钻 bindApplication、activityStart 还是系统等待。';
  }
  if (/启动\s*#?\d*\s*详情|startup_info/.test(identity)) {
    return '校准单次启动 ID、起止时间、dur 和 TTID/TTFD，用来保证详情深钻沿用同一个启动窗口。';
  }
  if (/初始化\s*cpu\s*拓扑|init_cpu_topology/.test(identity)) {
    return '确认 CPU 核型和拓扑信息是否可用，用来判断后续大小核、频率和调度分析的可信度。';
  }
  if (/大小核占比|cpu_core_analysis/.test(identity)) {
    return '统计主线程 Running 时间落在大核/小核的比例，用来判断启动是否受小核执行或摆核策略影响。';
  }
  if (/cpu\s*频率爬升|freq_rampup/.test(identity)) {
    return '比较启动早期和稳定阶段的 CPU 频率，用来判断是否存在频率爬升过慢导致的启动拖延。';
  }
  if (/cpu\s*频率|cpu_freq_analysis/.test(identity)) {
    return '汇总启动期间 CPU 频率水平，用来判断系统算力供给是否偏低。';
  }
  if (/四大象限|quadrant_analysis/.test(identity)) {
    return '把主线程耗时拆成大核运行、小核运行、Runnable、IO 阻塞和 Sleep，用来定位根因所属象限。';
  }
  if (/主线程摆核时序|cpu_placement_timeline/.test(identity)) {
    return '按时间桶展示主线程落在大核/小核的变化，用来定位慢阶段是否伴随小核执行或频繁迁移。';
  }
  if (/binder\s*线程池|binder_pool/.test(identity)) {
    return '检查 Binder 线程池容量、占用和评估结论，用来排除或确认远端线程池饱和。';
  }
  if (/启动关键任务|critical_tasks/.test(identity)) {
    return '列出启动窗口全线程关键任务的 CPU、睡眠和摆核情况，用来识别主线程外的竞争或依赖任务。';
  }
  if (/线程阻塞关系图|thread_blocking_graph/.test(identity)) {
    return '构建线程间等待关系，用来验证是否存在锁、Binder 或线程依赖形成的阻塞链。';
  }
  if (/jit\s*影响|jit_analysis/.test(identity)) {
    return '检查 JIT/编译活动是否落在启动关键路径，用来判断代码热身是否拖慢冷启动。';
  }
  if (/检测到的慢启动原因|slow_reason_checks/.test(identity)) {
    return '列出慢启动规则命中的原因，用来确认哪些根因已经被数据满足、哪些只是候选。';
  }
  if (/问题诊断|startup_diagnosis/.test(identity)) {
    return '承接技能内置诊断输出，用来确认是否已有明确问题标签、严重度或可执行建议。';
  }
  if (/启动事件|startup_overview|get_startups/.test(identity)) {
    return '确定本轮分析对应的启动窗口、TTID/TTFD 和边界时间，避免后续表格查错时间段。';
  }

  if (
    /slice_name/.test(joinedColumns) &&
    /state_pct|state_dur_ms/.test(joinedColumns)
  ) {
    return '验证目标 slice 在不同线程状态下的耗时分布，用来判断这段时间是在真正运行还是在等待。';
  }
  if (
    /slice_name/.test(joinedColumns) &&
    /self_ms|self_percent/.test(joinedColumns)
  ) {
    return '核对热点 slice 的自耗时贡献，用来判断优化应落到哪个函数、任务或业务标签。';
  }
  if (/slice_name/.test(joinedColumns) && /dur_ms/.test(joinedColumns)) {
    return '列出目标时间窗内命中的 slice 及耗时，用来验证结论里提到的具体事件是否真实存在。';
  }
  if (/state/.test(joinedColumns) && /dur|pct|percent/.test(joinedColumns)) {
    return '汇总线程状态耗时占比，用来判断瓶颈更像 CPU 忙、调度等待、睡眠等待还是不可中断阻塞。';
  }
  if (/reason|severity|evidence/.test(joinedColumns)) {
    return '汇总诊断规则的命中原因、严重度和证据文本，用来决定根因优先级。';
  }

  if (fallbackReason && !isLowSignalReason(fallbackReason)) {
    return fallbackReason;
  }
  if (input.query || source === 'execute_sql') {
    if (/webview|p2_10/.test(identity)) {
      return '验证启动和 TTID 差值区间内是否存在 WebView/渲染相关 slice，用来排除 WebView 启动路径误判。';
    }
    return '补齐 Skill 未直接覆盖的验证点；重点看结果是否命中目标时间窗、目标线程和结论提到的实体。';
  }
  if (
    source.includes('invoke_skill') ||
    source.includes('skill') ||
    source.includes(':')
  ) {
    return 'Skill 返回的结构化证据，用来支撑后续筛选、下钻或结论判断。';
  }

  switch (layer) {
    case 'overview':
      return '概览层数据，用来快速判断是否存在明显异常。';
    case 'list':
      return '候选列表数据，用来从会话、帧或事件中筛选需要下钻的对象。';
    case 'session':
      return '会话/区间层数据，用来解释单个时间段的行为。';
    case 'deep':
      return '下钻层数据，用来验证具体帧、线程或调用链的根因。';
    case 'diagnosis':
      return '诊断层数据，用来直接支撑结论和建议。';
  }

  if (source === 'summary' || /overview|概览|summary|摘要|统计/.test(title)) {
    return '汇总数据，用来建立本轮分析的基线判断。';
  }
  return '中间证据表，用来连接时间线动作和最终结论。';
}

function inferDataMeaning(title: string, columns: string[]): string {
  const text = `${title} ${columns.join(' ')}`.toLowerCase();
  if (uiOutputLanguage() === 'en') {
    if (/insight|summary/.test(text)) {
      return 'Use the summary metrics and anomaly signals to choose the highest-priority investigation direction.';
    }
    if (/quality|warning|issue_code/.test(text)) {
      return 'Use quality status and issue codes to judge whether the trace can support a firm conclusion.';
    }
    if (/evidence|reason|severity/.test(text)) {
      return 'Each row is a diagnostic rule or evidence match; inspect its reason, severity, and actionability.';
    }
    if (/binder|ipc/.test(text)) {
      return 'Each row represents a Binder or IPC call, or an aggregation of cross-process latency.';
    }
    if (/cpu|freq|core|sched|runnable/.test(text)) {
      return 'Each row represents CPU frequency, core placement, execution, or scheduling-wait evidence.';
    }
    if (/memory|gc|lmk/.test(text)) {
      return 'Each row represents memory pressure, GC, or LMK evidence.';
    }
    if (/io|file|database|sqlite/.test(text)) {
      return 'Each row represents I/O, file-system, or database activity.';
    }
    if (/slice_name|dur_ms|frame|jank/.test(text)) {
      return 'Each row is a matching slice or frame record; inspect its name, duration, timestamp, and state.';
    }
    return 'Each row is an evidence record; columns identify the metrics, entities, and timestamps used by this step.';
  }

  if (/洞见摘要|insight/.test(text)) {
    return '看摘要里的启动类型、总耗时、主要异常和候选瓶颈，确定本轮分析的优先方向。';
  }
  if (/启动数据质量/.test(text)) {
    return '看 warning_count、issue_codes 和 quality_status，判断当前 trace 数据是否足够支撑结论。';
  }
  if (/证据矩阵|evidence matrix/.test(text)) {
    return '看规则/证据编号、命中条件、严重度和建议，确认根因树的每个判断是否有对应证据。';
  }
  if (/主线程可操作热点|actionable_main_thread_slices/.test(text)) {
    return '看 slice_name 定位对象，看 self_ms/total_ms/avg_ms 衡量贡献，看 self_percent 判断是否值得优先优化。';
  }
  if (/热点\s*slice\s*线程状态|hot_slice_states/.test(text)) {
    return '每行是一个热点 slice 的一种线程状态；Running 占比高指向 CPU 执行，Sleep/D/Runnable 占比高指向等待或调度问题。';
  }
  if (/主线程文件\s*io/.test(text)) {
    return '每行是一类主线程文件 IO；看 total_dur_ms 和 percent_of_startup 判断磁盘访问是否值得进入根因。';
  }
  if (/binder/.test(text) && /call_count|aidl_name|server_process/.test(text)) {
    return '每行是一类 Binder 调用聚合；看 server_process、call_count、total_dur_ms 和主线程调用数判断 IPC 影响。';
  }
  if (/启动期间主线程状态/.test(text)) {
    return '每行是一种主线程状态；看 percent、total_dur_ms 和 blocked_functions 判断主线程是在跑、睡眠、可运行等待还是不可中断等待。';
  }
  if (/启动期间\s*gc/.test(text)) {
    return '每行是一类 GC 聚合；看 is_main_thread、total_dur_ms 和 percent_of_startup 判断 GC 是否干扰启动。';
  }
  if (/启动期间调度延迟/.test(text)) {
    return '每行是一类调度等待聚合；看 total_wait_ms、avg_wait_ms、max_wait_ms 和 severe_delays 判断调度压力。';
  }
  if (/大小核占比/.test(text)) {
    return '看 big_core_pct、little_core_pct 和 total_running_ms，判断主线程执行时间主要落在哪类 CPU 核。';
  }
  if (/cpu\s*频率爬升/.test(text)) {
    return '看 early_avg_freq_mhz、steady_avg_freq_mhz 和 rampup_pct，判断启动早期是否频率供给不足。';
  }
  if (/cpu\s*频率/.test(text)) {
    return '看 avg_freq_mhz、max_freq_mhz 和 core_type，判断启动期间 CPU 频率是否偏低。';
  }
  if (/四大象限/.test(text)) {
    return '看 q1/q2/q3/q4a/q4b 的毫秒和占比，把慢启动归到大核运行、小核运行、调度等待、IO 或 Sleep。';
  }
  if (/主线程摆核时序/.test(text)) {
    return '每行是一个时间桶；看 big_core_pct 和 used_cpus，定位慢阶段是否伴随小核执行或迁移。';
  }
  if (/启动关键任务/.test(text)) {
    return '每行是一个关键线程任务；看 running_pct、big_core_pct、migrations 和 sleeping_ms 判断竞争与依赖。';
  }
  if (/检测到的慢启动原因|reason_id/.test(text)) {
    return '每行是一条慢启动规则命中；看 reason、severity、evidence 和 suggestion 判断是否进入最终建议。';
  }
  if (/slice_name/.test(text) && /state_pct|state_dur_ms/.test(text)) {
    return '每行把一个 slice 拆到一个线程状态；重点看 state、state_dur_ms 和 state_pct。';
  }
  if (/slice_name/.test(text) && /dur_ms/.test(text)) {
    return '每行是一段命中的 trace slice；重点看 slice_name、dur_ms 和 ts，确认事件名称、耗时和发生时间。';
  }
  if (/reason|severity|evidence/.test(text)) {
    return '每行是一条诊断规则或证据命中；重点看原因、严重度、证据字段和是否可操作。';
  }
  if (/startup|launch|启动/.test(text)) {
    return '每行通常对应一次启动、启动阶段或启动相关候选事件。';
  }
  if (/frame|jank|doframe|帧|掉帧|卡顿/.test(text)) {
    return '每行通常对应一帧、一个掉帧事件或一组帧级统计。';
  }
  if (/thread|utid|tid|runnable|sched|线程|调度/.test(text)) {
    return '每行通常对应一个线程、线程状态片段或调度统计。';
  }
  if (/binder|ipc/.test(text)) {
    return '每行通常对应一次 Binder/IPC 调用或聚合后的跨进程延迟。';
  }
  if (/cpu|freq|core|cluster|小核|大核/.test(text)) {
    return '每行通常对应 CPU 频率、核型分布或调度供给指标。';
  }
  if (/memory|gc|lmk|内存/.test(text)) {
    return '每行通常对应内存、GC 或 LMK 压力相关指标。';
  }
  if (/io|file|database|sqlite|文件|数据库/.test(text)) {
    return '每行通常对应一次 I/O、文件或数据库操作统计。';
  }
  return '每行是一条命中的证据记录；列是本步骤用于判断的指标、实体或时间字段。';
}

function isGenericSqlTitle(title: string): boolean {
  return /^sql\s+query(?:\s*\(\s*\d+\s*rows?\s*\))?$/i.test(
    normalizeFlowLine(title),
  );
}

function inferDataSourceTitle(input: {
  source?: string;
  title?: string;
  columns?: string[];
  query?: string;
}): string {
  const rawTitle = normalizeFlowLine(input.title || '');
  if (rawTitle && !isGenericSqlTitle(rawTitle)) return rawTitle;

  const columns = (input.columns || []).map((col) => col.toLowerCase());
  const text = columns.join(' ');
  if (/slice_name/.test(text) && /state_pct|state_dur_ms/.test(text)) {
    return uiText(
      'SQL 结果 · Slice 线程状态分布',
      'SQL result · Slice thread-state distribution',
    );
  }
  if (/slice_name/.test(text) && /self_ms|self_percent/.test(text)) {
    return uiText(
      'SQL 结果 · 主线程热点 Slice',
      'SQL result · Main-thread hot slices',
    );
  }
  if (/slice_name/.test(text) && /dur_ms/.test(text)) {
    return uiText(
      'SQL 结果 · Slice 命中明细',
      'SQL result · Matching slice details',
    );
  }
  if (/reason|severity|evidence/.test(text)) {
    return uiText(
      'SQL 结果 · 诊断规则命中',
      'SQL result · Diagnostic rule matches',
    );
  }
  if (/state/.test(text) && /dur|pct|percent/.test(text)) {
    return uiText(
      'SQL 结果 · 线程状态分布',
      'SQL result · Thread-state distribution',
    );
  }
  if (/count|total|avg|max|min/.test(text) && /dur|ms/.test(text)) {
    return uiText(
      'SQL 结果 · 耗时聚合统计',
      'SQL result · Duration aggregates',
    );
  }
  if (/process|thread|pid|tid|utid/.test(text)) {
    return uiText(
      'SQL 结果 · 线程/进程明细',
      'SQL result · Thread/process details',
    );
  }
  return uiText('SQL 结果 · 数据验证', 'SQL result · Data verification');
}

function isLowSignalReason(reason: string): boolean {
  const text = normalizeFlowLine(reason).toLowerCase();
  if (!text) return true;
  return [
    /执行当前\s*trace\s*sql，?验证本阶段的具体数据点/,
    /run sql on the current trace to verify this phase of evidence/,
    /调用 skill .+，?收集本阶段结构化证据/,
    /run skill .+ to collect structured evidence for this phase/,
    /临时 sql 查询，用来验证模型提出的具体数据点/,
  ].some((pattern) => pattern.test(text));
}

function readPlanPhaseAttribution(
  source: Record<string, unknown>,
): DataSourceContext['planPhaseAttribution'] | undefined {
  const value = source.planPhaseAttribution;
  switch (value) {
    case 'active':
    case 'inferred':
    case 'missing':
    case 'ambiguous':
    case 'unexpected_tool':
    case 'none':
      return value;
    default:
      return undefined;
  }
}

function compactEvidenceRef(value: string | undefined): string {
  if (!value) return '';
  if (value.length <= 56) return value;
  const parts = value.split(':').filter(Boolean);
  const tail = parts.slice(-3).join(':');
  return tail ? `...${tail}` : `${value.slice(0, 24)}...${value.slice(-16)}`;
}

function readEnvelopeTraceSide(
  envelope: DataEnvelope,
): 'current' | 'reference' | undefined {
  const envelopeRecord = asRecord(envelope);
  const provenance = asRecord(envelopeRecord.traceProvenance);
  return (
    normalizeTraceSide(envelope.meta?.traceSide) ||
    normalizeTraceSide(envelopeRecord.traceSide) ||
    normalizeTraceSide(provenance.traceSide)
  );
}

function readEnvelopePaneSide(
  envelope: DataEnvelope,
): TracePaneSide | undefined {
  const envelopeRecord = asRecord(envelope);
  const metaRecord = asRecord(envelope.meta as unknown);
  const provenance = asRecord(envelopeRecord.traceProvenance);
  return (
    normalizePaneSide(metaRecord.paneSide) ||
    normalizePaneSide(envelopeRecord.paneSide) ||
    normalizePaneSide(provenance.paneSide)
  );
}

function readEnvelopeTraceId(envelope: DataEnvelope): string | undefined {
  const envelopeRecord = asRecord(envelope);
  const provenance = asRecord(envelopeRecord.traceProvenance);
  return (
    readStringField(
      envelope.meta as unknown as Record<string, unknown>,
      'traceId',
    ) ||
    readStringField(envelopeRecord, 'traceId') ||
    readStringField(provenance, 'traceId') ||
    undefined
  );
}

function stableEnvelopeContentHash(envelope: DataEnvelope): string {
  const stableContent = JSON.stringify(
    {
      source: envelope.meta?.source,
      skillId: envelope.meta?.skillId,
      stepId: envelope.meta?.stepId,
      title: envelope.display?.title,
      data: envelope.data,
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  );
  let hash = 0;
  for (let i = 0; i < stableContent.length; i++) {
    hash = ((hash << 5) - hash + stableContent.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function dataEnvelopeDeduplicationKey(
  envelope: DataEnvelope,
  eventId?: string,
  occurrenceIndex = 0,
): string {
  const envelopeRecord = asRecord(envelope);
  const sql = readStringField(envelopeRecord, 'sql');
  const evidenceRefId = envelope.meta?.evidenceRefId;
  if (evidenceRefId) {
    if (envelope.meta?.sourceToolCallId) {
      return [evidenceRefId, envelope.meta.sourceToolCallId].join(':tool:');
    }
    const occurrence = [
      eventId,
      occurrenceIndex,
      envelope.meta?.timestamp,
      stableEnvelopeContentHash(envelope),
    ]
      .filter(
        (part) => part !== undefined && part !== null && String(part) !== '',
      )
      .join(':');
    return [evidenceRefId, occurrence || 'stable'].join(':occurrence:');
  }
  return [
    envelope.meta?.source || 'data_envelope',
    envelope.meta?.skillId || 'unknown_skill',
    envelope.meta?.stepId || 'unknown_step',
    readEnvelopeTraceSide(envelope) || 'trace',
    readEnvelopeTraceId(envelope) || 'trace_id',
    sql || envelope.meta?.timestamp || '',
  ].join(':');
}

function normalizeDataSourceKind(value: unknown): DataSourceContext['kind'] {
  switch (value) {
    case 'summary':
    case 'metric':
    case 'chart':
    case 'text':
    case 'timeline':
    case 'diagnostic':
      return value;
    case 'table':
    default:
      return 'table';
  }
}

function envelopeColumnsForContext(envelope: DataEnvelope): string[] {
  const payloadColumns = envelope.data?.columns;
  if (Array.isArray(payloadColumns)) {
    return payloadColumns.map((col) => String(col));
  }
  const displayColumns = envelope.display?.columns;
  if (Array.isArray(displayColumns)) {
    return displayColumns
      .map((column) => asRecord(column).name)
      .filter(
        (name): name is string => typeof name === 'string' && name.length > 0,
      );
  }
  return [];
}

function registerEnvelopeSourceContext(
  ctx: SSEHandlerContext,
  envelope: DataEnvelope,
  title: string,
  extra: Partial<{
    rowCount: number;
    columns: string[];
    query: string;
    kind: DataSourceContext['kind'];
  }> = {},
): DataSourceContext {
  const envelopeRecord = asRecord(envelope);
  const metaRecord = asRecord(envelope.meta as unknown);
  const sql =
    extra.query || readStringField(envelopeRecord, 'sql') || undefined;
  const rows = envelope.data?.rows;
  const rowCount =
    extra.rowCount ?? (Array.isArray(rows) ? rows.length : undefined);
  const source = [
    envelope.meta.skillId || envelope.meta.source,
    envelope.meta.stepId,
  ]
    .filter(Boolean)
    .join('#');

  return registerDataSourceContext(ctx, {
    title,
    source: source || envelope.meta.source || 'data_envelope',
    layer: envelope.display.layer,
    kind: extra.kind || normalizeDataSourceKind(envelope.display.format),
    rowCount,
    columns: extra.columns || envelopeColumnsForContext(envelope),
    query: sql,
    evidenceRefId: readStringField(metaRecord, 'evidenceRefId') || undefined,
    traceSide: readEnvelopeTraceSide(envelope),
    paneSide: readEnvelopePaneSide(envelope),
    traceId: readEnvelopeTraceId(envelope),
    queryHash: readStringField(metaRecord, 'queryHash') || undefined,
    sourceToolCallId:
      readStringField(metaRecord, 'sourceToolCallId') || undefined,
    paramsHash: readStringField(metaRecord, 'paramsHash') || undefined,
    planPhaseId: readStringField(metaRecord, 'planPhaseId') || undefined,
    planPhaseTitle: readStringField(metaRecord, 'planPhaseTitle') || undefined,
    planPhaseGoal: readStringField(metaRecord, 'planPhaseGoal') || undefined,
    planPhaseAttribution: readPlanPhaseAttribution(metaRecord),
    planPhaseWarning:
      readStringField(metaRecord, 'planPhaseWarning') || undefined,
    producerReason: readStringField(metaRecord, 'producerReason') || undefined,
    toolNarration: readStringField(metaRecord, 'toolNarration') || undefined,
    queryReviewPurpose: envelope.meta.queryReview?.purpose,
  });
}

function registerDataSourceContext(
  ctx: SSEHandlerContext,
  input: {
    title: string;
    source?: string;
    layer?: string;
    kind?: DataSourceContext['kind'];
    rowCount?: number;
    columns?: string[];
    query?: string;
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
    planPhaseAttribution?: DataSourceContext['planPhaseAttribution'];
    planPhaseWarning?: string;
    producerReason?: string;
    toolNarration?: string;
    queryReviewPurpose?: string;
  },
): DataSourceContext {
  const flow = ctx.streamingFlow;
  flow.dataSourceOrdinal = (flow.dataSourceOrdinal || 0) + 1;
  flow.dataSourceKindOrdinals ||= {};
  const isDiagnostic = input.kind === 'diagnostic';
  const title = inferDataSourceTitle(input);
  const producerReason = normalizeFlowLine(input.producerReason || '');
  const toolNarration = normalizeFlowLine(input.toolNarration || '');
  const queryReviewPurpose = normalizeFlowLine(input.queryReviewPurpose || '');
  const fallbackReason = !isLowSignalReason(queryReviewPurpose)
    ? queryReviewPurpose
    : !isLowSignalReason(producerReason)
      ? producerReason
      : toolNarration;
  const reason = isDiagnostic
    ? uiText(
        '失败诊断：该步骤未产出可用数据，只用于解释失败和指导重试，不能作为结论证据。',
        'Failure diagnostic: this step produced no usable data. It explains the failure and guides a retry, but is not conclusion evidence.',
      )
    : inferDataSourceReason({...input, title}, fallbackReason);
  const meaning = isDiagnostic
    ? uiText(
        '包含失败工具、错误信息、原始 SQL 或上下文；它说明数据缺失原因，不证明性能结论。',
        'Contains the failed tool, error, raw SQL, or context. It explains missing data but does not prove a performance conclusion.',
      )
    : inferDataMeaning(title, input.columns || []);
  const refPrefix =
    input.kind === 'summary'
      ? uiText('摘要', 'Summary')
      : input.kind === 'metric'
        ? uiText('指标', 'Metric')
        : input.kind === 'chart'
          ? uiText('图', 'Chart')
          : input.kind === 'text'
            ? uiText('文本', 'Text')
            : input.kind === 'diagnostic'
              ? uiText('诊断', 'Diagnostic')
              : input.kind === 'timeline'
                ? uiText('时间线', 'Timeline')
                : uiText('表', 'Table');
  const refKind = input.kind || 'table';
  const refOrdinal = (flow.dataSourceKindOrdinals[refKind] || 0) + 1;
  flow.dataSourceKindOrdinals[refKind] = refOrdinal;
  const sourceContext: DataSourceContext = {
    ref: `${refPrefix} ${refOrdinal}`,
    title: title || uiText('数据表', 'Data table'),
    source:
      normalizeFlowLine(input.source || input.layer || 'analysis') ||
      'analysis',
    reason,
    meaning,
    kind: input.kind,
    rowCount: input.rowCount,
    phase: input.layer ? `DataEnvelope.${input.layer}` : undefined,
    evidenceRefId: input.evidenceRefId,
    traceSide: input.traceSide,
    paneSide: input.paneSide,
    traceId: input.traceId,
    queryHash: input.queryHash,
    sourceToolCallId: input.sourceToolCallId,
    paramsHash: input.paramsHash,
    planPhaseId: input.planPhaseId,
    planPhaseTitle: input.planPhaseTitle,
    planPhaseGoal: input.planPhaseGoal,
    planPhaseAttribution: input.planPhaseAttribution,
    planPhaseWarning: input.planPhaseWarning,
    producerReason: input.producerReason,
    toolNarration: input.toolNarration,
  };
  flow.dataSourceRefs.push(sourceContext);
  return sourceContext;
}

/**
 * Process a progress event - shows analysis phase updates.
 */
export function handleProgressEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const phase = normalizeFlowLine(readStringField(payload, 'phase'));
  const phaseMessage = normalizeFlowLine(readStringField(payload, 'message'));

  if (readStringField(payload, 'phase') === 'analysis_plan') {
    const confirmed = uiText('分析计划已确认', 'Analysis plan confirmed');
    pushStreamingPhase(ctx, phaseMessage || confirmed);
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: formatAnalysisPlanMessage(
        payload.plan,
        readStringField(payload, 'message'),
      ),
      timestamp: Date.now(),
      flowTag: 'progress_note',
    });
    return {loadingPhase: phaseMessage || confirmed};
  }

  if (phaseMessage) {
    pushStreamingPhase(ctx, phaseMessage);
    return {loadingPhase: phaseMessage};
  }

  if (phase) {
    pushStreamingPhase(ctx, uiText(`阶段: ${phase}`, `Phase: ${phase}`));
    return {loadingPhase: phase};
  }
  return {};
}

function formatAnalysisPlanMessage(
  plan: unknown,
  fallbackMessage?: string,
): string {
  if (!isRecord(plan)) {
    return uiText(
      `### 🧭 分析计划已确认\n\n${fallbackMessage || '先收集证据，再给根因假设。'}`,
      `### 🧭 Analysis plan confirmed\n\n${fallbackMessage || 'Collect evidence before proposing root-cause hypotheses.'}`,
    );
  }

  const planRecord = plan;

  const lines: string[] = [
    uiText('### 🧭 分析计划已确认', '### 🧭 Analysis plan confirmed'),
  ];

  const objective = readStringField(planRecord, 'objective').trim();
  if (objective) {
    lines.push('', uiText(`目标: ${objective}`, `Objective: ${objective}`));
  }

  const mode = readStringField(planRecord, 'mode').trim();
  if (mode) {
    lines.push('', uiText(`模式: \`${mode}\``, `Mode: \`${mode}\``));
  }

  const strategy = asRecord(planRecord.strategy);
  if (Object.keys(strategy).length > 0) {
    const strategyName =
      readStringField(strategy, 'name') ||
      readStringField(strategy, 'id') ||
      'unknown';
    lines.push(
      '',
      uiText(`策略: **${strategyName}**`, `Strategy: **${strategyName}**`),
    );
  }

  const rawSteps = Array.isArray(planRecord.steps) ? planRecord.steps : [];
  const steps = rawSteps.map((step) => asRecord(step));
  if (steps.length > 0) {
    lines.push('', uiText('**步骤**', '**Steps**'));
    const sorted = [...steps].sort(
      (a, b) => readNumberField(a, 'order', 0) - readNumberField(b, 'order', 0),
    );
    for (const step of sorted) {
      const order = readNumberField(step, 'order', 0);
      const title = readStringField(step, 'title', uiText('步骤', 'Step'));
      const action = readStringField(step, 'action');
      lines.push(`${order}. **${title}**: ${action}`);
    }
  }

  const evidence = Array.isArray(planRecord.evidence)
    ? planRecord.evidence
    : [];
  if (evidence.length > 0) {
    lines.push('', uiText('**证据清单**', '**Evidence checklist**'));
    for (const item of evidence) {
      lines.push(`- ${String(item)}`);
    }
  }

  lines.push(
    '',
    uiText(
      '说明: 先收集证据，再给根因假设。',
      'Note: collect evidence before proposing root-cause hypotheses.',
    ),
  );
  return lines.join('\n');
}

/**
 * Normalize markdown spacing to avoid excessive vertical gaps in chat bubbles.
 */
function normalizeMarkdownSpacing(content: string): string {
  return (
    content
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      // Collapse 3+ blank lines (including whitespace-only lines) into 1 blank line.
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n')
      .trim()
  );
}

function normalizeColumnDefinitions(
  columns: unknown,
): SqlColumnDefinition[] | undefined {
  if (!Array.isArray(columns)) return undefined;

  const definitions = columns
    .map((col): SqlColumnDefinition | null => {
      if (typeof col === 'string') {
        return {name: col};
      }
      if (isRecord(col) && typeof col.name === 'string') {
        const normalized: SqlColumnDefinition = {name: col.name};
        if (typeof col.label === 'string') normalized.label = col.label;
        if (typeof col.type === 'string') normalized.type = col.type;
        if (typeof col.format === 'string') normalized.format = col.format;
        if (typeof col.clickAction === 'string') {
          normalized.clickAction = col.clickAction;
        }
        if (typeof col.durationColumn === 'string') {
          normalized.durationColumn = col.durationColumn;
        }
        if (
          col.unit === 'ns' ||
          col.unit === 'us' ||
          col.unit === 'ms' ||
          col.unit === 's'
        ) {
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
  ctx: SSEHandlerContext,
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
    const sourceContext = registerDataSourceContext(ctx, {
      title: uiText('SQL 查询结果', 'SQL query result'),
      source: 'execute_sql',
      rowCount,
      columns: columns.map((col) => String(col)),
      query: sql,
    });
    pushStreamingTool(ctx, uiText('执行 SQL 查询', 'Execute SQL query'));
    pushStreamingOutput(
      ctx,
      uiText(
        `SQL 结果返回 ${rowCount} 行`,
        `SQL result returned ${rowCount} rows`,
      ),
    );
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: uiText(
        `📊 查询到 **${rowCount}** 条记录`,
        `📊 Found **${rowCount}** records`,
      ),
      timestamp: Date.now(),
      sqlResult: {
        columns,
        rows,
        rowCount,
        query: sql,
        hideQuery: Boolean(sql),
        sectionTitle: sourceContext.title,
        expandableData,
        summary,
        sourceContext,
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const section = eventPayload(data);
  if (Object.keys(section).length > 0) {
    const sectionTitle = readStringField(
      section,
      'sectionTitle',
      'Skill Section',
    );
    const rowCount = readNumberField(section, 'rowCount', 0);
    const sectionIndex = readNumberField(section, 'sectionIndex', 0);
    const totalSections = readNumberField(section, 'totalSections', 0);
    const columns = Array.isArray(section.columns) ? section.columns : [];
    const rows = Array.isArray(section.rows) ? section.rows : [];
    const expandableData = readExpandableData(section.expandableData);
    const summary = readLegacySummary(section.summary);
    const normalizedColumns = columns.map((col) => String(col));
    const hasTableShape = normalizedColumns.length > 0 || rows.length > 0;
    const sourceContext = hasTableShape
      ? registerDataSourceContext(ctx, {
          title: sectionTitle,
          source: 'skill_section',
          rowCount,
          columns: normalizedColumns,
        })
      : undefined;
    pushStreamingOutput(
      ctx,
      uiText(
        `${sectionTitle} (${rowCount} 行)`,
        `${sectionTitle} (${rowCount} rows)`,
      ),
    );
    // Show progress for this section - use sectionTitle for compact display
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: hasTableShape
        ? '' // No message content, title is in table header
        : uiText(
            `📊 ${sectionTitle}：0 行，未返回可展示列`,
            `📊 ${sectionTitle}: 0 rows; no displayable columns were returned`,
          ),
      timestamp: Date.now(),
      sqlResult: hasTableShape
        ? {
            columns,
            rows,
            rowCount,
            query: '', // No SQL display
            sectionTitle: `${sectionTitle} (${sectionIndex}/${totalSections})`,
            expandableData,
            summary,
            sourceContext,
          }
        : undefined,
    });
  }
  return {};
}

/**
 * Process skill_diagnostics event - shows diagnostic messages.
 */
export function handleSkillDiagnosticsEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const diagnostics = Array.isArray(payload.diagnostics)
    ? payload.diagnostics.map((item) => asRecord(item))
    : [];
  if (diagnostics.length > 0) {
    const criticalItems = diagnostics.filter(
      (d) => readStringField(d, 'severity') === 'critical',
    );
    const warningItems = diagnostics.filter(
      (d) => readStringField(d, 'severity') === 'warning',
    );
    const infoItems = diagnostics.filter(
      (d) => readStringField(d, 'severity') === 'info',
    );

    let content = uiText(
      '**🔍 诊断结果**\n\n',
      '**🔍 Diagnostic results**\n\n',
    );
    if (criticalItems.length > 0) {
      content += uiText('🔴 **严重问题:**\n', '🔴 **Critical issues:**\n');
      criticalItems.forEach((d) => {
        content += `- ${readStringField(d, 'message')}\n`;
        const suggestions = readStringArrayField(d, 'suggestions');
        if (suggestions.length > 0) {
          content += uiText(
            `  *建议: ${suggestions.join('; ')}*\n`,
            `  *Suggestions: ${suggestions.join('; ')}*\n`,
          );
        }
      });
      content += '\n';
    }
    if (warningItems.length > 0) {
      content += uiText('🟡 **警告:**\n', '🟡 **Warnings:**\n');
      warningItems.forEach((d) => {
        content += `- ${readStringField(d, 'message')}\n`;
      });
      content += '\n';
    }
    if (infoItems.length > 0) {
      content += uiText('🔵 **提示:**\n', '🔵 **Information:**\n');
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
    pushStreamingOutput(
      ctx,
      uiText(
        `诊断输出 ${diagnostics.length} 条`,
        `${diagnostics.length} diagnostic items`,
      ),
    );
  }
  return {};
}

/**
 * Process skill_layered_result event - displays multi-layer analysis results.
 * Handles overview (L1), list (L2), and deep (L4) layer data.
 */
export function handleSkillLayeredResultEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const result = asRecord(payload.result);
  const resultLayers = asRecord(result.layers);
  const directLayers = asRecord(payload.layers);
  const layeredResult =
    Object.keys(resultLayers).length > 0 ? resultLayers : directLayers;
  if (Object.keys(layeredResult).length === 0) return {};

  // Deduplication check
  const resultMetadata = asRecord(result.metadata);
  const skillId =
    readStringField(payload, 'skillId') ||
    readStringField(resultMetadata, 'skillId') ||
    'unknown';
  const deduplicationKey = `skill_layered_result:${skillId}`;
  if (ctx.displayedSkillProgress.has(deduplicationKey)) {
    if (DEBUG_SSE) {
      console.log(
        '[SSEHandlers] Skipping duplicate skill_layered_result:',
        deduplicationKey,
      );
    }
    return {};
  }
  ctx.displayedSkillProgress.add(deduplicationKey);

  if (DEBUG_SSE) {
    console.log('[SSEHandlers] skill_layered_result received:', payload);
  }
  const layers = layeredResult;
  const metadata =
    Object.keys(resultMetadata).length > 0
      ? resultMetadata
      : {
          skillName:
            readStringField(payload, 'skillName') ||
            readStringField(payload, 'skillId'),
        };

  pushStreamingOutput(
    ctx,
    uiText(
      `技能结果: ${readStringField(metadata, 'skillName', skillId)}`,
      `Skill result: ${readStringField(metadata, 'skillName', skillId)}`,
    ),
  );

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
  const conclusionCandidate =
    result.conclusion ?? extractConclusionFromOverview(overview);
  const conclusion = asRecord(conclusionCandidate);
  if (
    readStringField(conclusion, 'category') &&
    readStringField(conclusion, 'category') !== 'UNKNOWN'
  ) {
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
  ctx: SSEHandlerContext,
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (
    obj: unknown,
  ): obj is {data: unknown[]; display?: Record<string, unknown>} => {
    const record = asRecord(obj);
    return Array.isArray(record.data);
  };

  // Helper to extract data from StepResult
  const extractData = (obj: unknown): Record<string, unknown>[] | null => {
    if (isStepResult(obj)) {
      return obj.data.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      );
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
              ...rowColumns.filter(
                (name) => !displayColumnDefs.some((def) => def.name === name),
              ),
            ]
          : rowColumns;
        const filteredColumnDefs = displayColumnDefs
          ? displayColumnDefs.filter((def) => orderedColumns.includes(def.name))
          : undefined;
        const rows = dataArray.map((item) =>
          orderedColumns.map((col) => item[col]),
        );
        const sourceContext = registerDataSourceContext(ctx, {
          title,
          source: readStringField(metadata, 'skillName') || 'skill_overview',
          layer: 'overview',
          rowCount: rows.length,
          columns: orderedColumns,
        });

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
            sourceContext,
          },
        });
      }
    } else if (isRecord(val)) {
      // Nested object: display as single-row table
      const objColumns = Object.keys(val);
      const objRow = objColumns.map((col) => val[col]);
      const sourceContext = registerDataSourceContext(ctx, {
        title: formatLayerName(key),
        source: readStringField(metadata, 'skillName') || 'skill_overview',
        layer: 'overview',
        rowCount: 1,
        columns: objColumns,
      });

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
          sourceContext,
        },
      });
    }
  }
}

/**
 * Build chart data from step result.
 */
function buildChartData(
  obj: unknown,
  title: string,
): Message['chartData'] | null {
  const dataArray = asRecord(obj).data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!isRecord(firstRow)) return null;

  const keys = Object.keys(firstRow);
  const labelKey = keys.find(
    (k) =>
      k.toLowerCase().includes('label') ||
      k.toLowerCase().includes('name') ||
      k.toLowerCase().includes('type'),
  );
  const valueKey = keys.find(
    (k) =>
      k.toLowerCase().includes('value') ||
      k.toLowerCase().includes('count') ||
      k.toLowerCase().includes('total'),
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
function buildMetricData(
  obj: unknown,
  title: string,
): Message['metricData'] | null {
  const dataArray = asRecord(obj).data;
  if (!Array.isArray(dataArray) || dataArray.length === 0) return null;

  const firstRow = dataArray[0];
  if (!isRecord(firstRow)) return null;

  const keys = Object.keys(firstRow);
  const valueKey = keys.find(
    (k) =>
      k.toLowerCase().includes('value') ||
      k.toLowerCase().includes('total') ||
      k.toLowerCase().includes('avg'),
  );

  if (valueKey) {
    const value = firstRow[valueKey];
    const rawStatus = firstRow.status;
    const status =
      rawStatus === 'good' ||
      rawStatus === 'warning' ||
      rawStatus === 'critical'
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
  ctx: SSEHandlerContext,
): void {
  // Helper to check if object is a StepResult format
  const isStepResult = (
    obj: unknown,
  ): obj is {data: unknown; display?: unknown} => {
    const record = asRecord(obj);
    if (!('data' in record)) return false;
    if (Array.isArray(record.data)) return true;
    const dataRecord = asRecord(record.data);
    if (
      Object.keys(dataRecord).length > 0 &&
      (Array.isArray(dataRecord.columns) || Array.isArray(dataRecord.rows))
    ) {
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
  const findFrameDetail = (
    frameId: string | number,
    sessionId?: string | number,
  ): Record<string, unknown> | null => {
    if (!deep || !isRecord(deep)) return null;

    const sessionKeys =
      sessionId !== undefined
        ? [String(sessionId), `session_${sessionId}`]
        : [];
    const frameKeys = [String(frameId), `frame_${frameId}`];

    for (const [sid, frames] of Object.entries(deep)) {
      if (sessionId !== undefined) {
        const sessionMatches = sessionKeys.some((sk) => sid === sk);
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

      const metadataCandidates = [
        displayConfig.metadataFields,
        displayConfig.metadata_columns,
      ];
      for (const candidate of metadataCandidates) {
        if (Array.isArray(candidate)) {
          metadataColumns = candidate
            .map((item) => (typeof item === 'string' ? item : ''))
            .filter((item) => item.length > 0);
          if (metadataColumns.length > 0) break;
        }
      }

      const hiddenCandidates = [
        displayConfig.hidden_columns,
        displayConfig.hiddenColumns,
      ];
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
          displayColumnDefs.flatMap((def) =>
            def?.clickAction === 'navigate_range' &&
            typeof def?.durationColumn === 'string' &&
            def.durationColumn.length > 0
              ? [def.durationColumn]
              : [],
          ),
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
          displayColumnDefs.flatMap((def) =>
            def?.clickAction === 'navigate_range' &&
            typeof def?.durationColumn === 'string' &&
            def.durationColumn.length > 0
              ? [def.durationColumn]
              : [],
          ),
        );
        hiddenColumns = hiddenColumns.filter((name) => !durationDeps.has(name));
      }

      if (isDataPayloadFormat(stepData)) {
        // NEW DataPayload format
        const allColumns = stepData.columns || [];
        const allRows = (stepData.rows || []).filter((row): row is unknown[] =>
          Array.isArray(row),
        );
        preBindedExpandableData = readExpandableData(stepData.expandableData);
        summaryReport = stepData.summary;

        items = allRows.map((row) => {
          const obj: Record<string, unknown> = {};
          allColumns.forEach((col: string, i: number) => {
            obj[col] = row[i];
          });
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
          rows = allRows.map((row) => visibleIndices.map((idx) => row[idx]));
        } else {
          columns = allColumns;
          rows = allRows.map((row) => row.map((val) => val));
        }

        if (displayColumnDefs && displayColumnDefs.length > 0) {
          const ordered = [
            ...displayColumnDefs
              .map((def) => def.name)
              .filter((name: string) => columns.includes(name)),
            ...columns.filter(
              (name) => !displayColumnDefs!.some((def) => def.name === name),
            ),
          ];

          const indexMap = new Map(
            columns.map((name: string, idx: number) => [name, idx]),
          );
          columns = ordered;
          rows = rows.map((row) =>
            ordered.map((name: string) => row[indexMap.get(name) ?? -1]),
          );

          filteredColumnDefs = displayColumnDefs.filter((def) =>
            columns.includes(def.name),
          );
        }
      } else {
        // Legacy format: data is array of row objects
        items = Array.isArray(stepData)
          ? stepData.filter((item): item is Record<string, unknown> =>
              isRecord(item),
            )
          : [];
      }
    } else if (Array.isArray(value)) {
      items = value.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      );
    }

    // Skip if no data
    if (items.length === 0 && rows.length === 0) continue;

    // Build columns/rows from items if needed
    if (columns.length === 0 && items.length > 0) {
      const allColumns = Object.keys(items[0] || {});
      const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
      const visibleColumns = allColumns.filter(
        (col) => !columnsToHide.has(col),
      );
      if (displayColumnDefs && displayColumnDefs.length > 0) {
        columns = [
          ...displayColumnDefs
            .map((def) => def.name)
            .filter((name: string) => visibleColumns.includes(name)),
          ...visibleColumns.filter(
            (name) => !displayColumnDefs!.some((def) => def.name === name),
          ),
        ];
        filteredColumnDefs = displayColumnDefs.filter((def) =>
          columns.includes(def.name),
        );
      } else {
        columns = visibleColumns;
      }
      rows = items.map((item) => columns.map((col) => item[col]));
    }

    // Build expandable data
    let expandableData: SqlResultData['expandableData'] | undefined;
    if (preBindedExpandableData && preBindedExpandableData.length > 0) {
      expandableData = preBindedExpandableData;
    } else if (isExpandable && deep) {
      const generatedExpandableData: NonNullable<
        SqlResultData['expandableData']
      > = [];
      for (const item of items) {
        const rawFrameId = item.frame_id ?? item.frameId ?? item.id;
        if (typeof rawFrameId !== 'string' && typeof rawFrameId !== 'number') {
          continue;
        }

        const rawSessionId = item.session_id ?? item.sessionId;
        const sessionId =
          typeof rawSessionId === 'string' || typeof rawSessionId === 'number'
            ? rawSessionId
            : undefined;

        const frameDetail = findFrameDetail(rawFrameId, sessionId);
        if (!frameDetail) continue;

        const sections = convertToExpandableSections(frameDetail.data);
        const detailItem = isRecord(frameDetail.item) ? frameDetail.item : item;
        generatedExpandableData.push({
          item: detailItem,
          result: {success: true, sections},
        });
      }

      expandableData =
        generatedExpandableData.length > 0
          ? generatedExpandableData
          : undefined;
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
    const sourceContext = registerDataSourceContext(ctx, {
      title: displayTitle,
      source: key,
      layer: 'list',
      rowCount: rows.length,
      columns,
    });

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
        sectionTitle: uiText(
          `📋 ${displayTitle} (${rows.length}条)`,
          `📋 ${displayTitle} (${rows.length} items)`,
        ),
        expandableData,
        metadata:
          Object.keys(extractedMetadata).length > 0
            ? extractedMetadata
            : undefined,
        summaryReport: readSummaryReport(summaryReport),
        sourceContext,
      },
    });
  }
}

/**
 * Render conclusion card from analysis result.
 */
function renderConclusionCard(
  conclusion: Record<string, unknown>,
  ctx: SSEHandlerContext,
): void {
  const category = readStringField(conclusion, 'category', 'UNKNOWN');
  const component = readStringField(conclusion, 'component', 'unknown');
  const summary = readStringField(
    conclusion,
    'summary',
    uiText('暂无总结', 'No summary available'),
  );
  const suggestion = readStringField(conclusion, 'suggestion');
  const evidence = readStringArrayField(conclusion, 'evidence');
  const confidencePercent = Math.round(
    readNumberField(conclusion, 'confidence', 0.5) * 100,
  );

  const categoryEmoji =
    category === 'APP'
      ? '📱'
      : category === 'SYSTEM'
        ? '⚙️'
        : category === 'MIXED'
          ? '🔄'
          : '❓';
  const confidenceBar =
    '█'.repeat(Math.floor(confidencePercent / 10)) +
    '░'.repeat(10 - Math.floor(confidencePercent / 10));

  let conclusionContent = uiText(
    `## 🎯 分析结论\n\n`,
    `## 🎯 Analysis conclusion\n\n`,
  );
  conclusionContent += uiText(
    `**问题分类:** ${categoryEmoji} **${translateCategory(category)}**\n`,
    `**Category:** ${categoryEmoji} **${translateCategory(category)}**\n`,
  );
  conclusionContent += uiText(
    `**问题组件:** \`${translateComponent(component)}\`\n`,
    `**Component:** \`${translateComponent(component)}\`\n`,
  );
  conclusionContent += uiText(
    `**置信度:** ${confidenceBar} ${confidencePercent}%\n\n`,
    `**Confidence:** ${confidenceBar} ${confidencePercent}%\n\n`,
  );
  conclusionContent += uiText(
    `### 📋 根因分析\n${summary}\n\n`,
    `### 📋 Root-cause analysis\n${summary}\n\n`,
  );

  if (suggestion) {
    conclusionContent += uiText(
      `### 💡 优化建议\n${suggestion}\n\n`,
      `### 💡 Recommendations\n${suggestion}\n\n`,
    );
  }

  if (evidence.length > 0) {
    conclusionContent += uiText(`### 📊 证据\n`, `### 📊 Evidence\n`);
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
    const sourceContext = registerDataSourceContext(ctx, {
      title: uiText('分析摘要', 'Analysis summary'),
      source: 'summary',
      kind: 'summary',
      rowCount: summaryTableData.rows.length,
      columns: summaryTableData.columns,
    });
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      sqlResult: {
        columns: summaryTableData.columns,
        rows: summaryTableData.rows,
        rowCount: summaryTableData.rows.length,
        sectionTitle: uiText('📝 分析摘要', '📝 Analysis summary'),
        sourceContext,
      },
    });
  } else {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: uiText(
        `**📝 分析摘要:** ${summary}`,
        `**📝 Analysis summary:** ${summary}`,
      ),
      timestamp: Date.now(),
    });
  }
}

function conclusionNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value.replace(/[%％]/g, '').trim());
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function conclusionText(value: unknown): string {
  return String(value ?? '').trim();
}

function normalizeClaimSourceRef(value: string): string {
  const text = normalizeFlowLine(value).replace(/：/g, ':').toLowerCase();
  const localized = text.match(
    /^(表|摘要|指标|图|文本|时间线|诊断)\s*([0-9]+)/,
  );
  if (localized) return `${localized[1]} ${Number(localized[2])}`;
  const english = text.match(
    /^(table|summary|metric|chart|figure|text|timeline|diagnostic|diagnosis)\s*#?\s*([0-9]+)/,
  );
  if (english) {
    const prefixMap: Record<string, string> = {
      table: '表',
      summary: '摘要',
      metric: '指标',
      chart: '图',
      figure: '图',
      text: '文本',
      timeline: '时间线',
      diagnostic: '诊断',
      diagnosis: '诊断',
    };
    return `${prefixMap[english[1]]} ${Number(english[2])}`;
  }
  return text;
}

function sourceRefMatches(contextRef: string, sourceRef: string): boolean {
  return (
    contextRef === sourceRef ||
    normalizeClaimSourceRef(contextRef) === normalizeClaimSourceRef(sourceRef)
  );
}

function claimValueMatches(actual: unknown, expected: unknown): boolean {
  if (expected === undefined || expected === null) return false;
  const actualNumber = conclusionNumber(actual);
  const expectedNumber = conclusionNumber(expected);
  if (actualNumber !== undefined && expectedNumber !== undefined) {
    return Math.abs(actualNumber - expectedNumber) <= 1e-9;
  }
  return String(actual ?? '') === String(expected);
}

type ParsedClaimNumber = {
  value: number;
  integerLiteral: boolean;
  tolerance: number;
};

type ClaimValueComparison = {
  matches: boolean;
  approximate?: boolean;
};

function parseClaimNumberLiteral(
  value: unknown,
): ParsedClaimNumber | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const raw = String(value).replace(/,/g, '').replace(/％/g, '%').trim();
  const match = raw.match(
    /^([+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?)\s*(?:%|ms|s|ns|us|µs|fps|hz|mhz|ghz|帧|次|行)?$/i,
  );
  if (!match) return undefined;
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed)) return undefined;

  const literal = match[1].toLowerCase();
  const mantissa = literal.split('e')[0];
  const decimalPart = mantissa.includes('.') ? mantissa.split('.')[1] : '';
  const integerLiteral = decimalPart.length === 0;
  const tolerance =
    decimalPart.length > 0
      ? 0.5 * Math.pow(10, -decimalPart.length) + 1e-9
      : 0.5 + 1e-9;
  return {value: parsed, integerLiteral, tolerance};
}

function compareClaimValue(
  actual: unknown,
  expected: unknown,
): ClaimValueComparison {
  if (claimValueMatches(actual, expected)) return {matches: true};

  const actualParsed = parseClaimNumberLiteral(actual);
  const expectedParsed = parseClaimNumberLiteral(expected);
  if (actualParsed && expectedParsed) {
    const tolerance =
      expectedParsed.integerLiteral &&
      Number.isInteger(actualParsed.value) &&
      Number.isInteger(expectedParsed.value)
        ? 1e-9
        : expectedParsed.tolerance;
    if (Math.abs(actualParsed.value - expectedParsed.value) <= tolerance) {
      return {matches: true, approximate: true};
    }
  }

  return {matches: false};
}

function sourceContextMatchesClaim(
  context: DataSourceContext | undefined,
  evidenceRefId: string,
  sourceRef: string,
  sourceToolCallId: string,
): boolean {
  if (!context) return false;
  if (!evidenceRefId && !sourceRef && !sourceToolCallId) return false;
  if (evidenceRefId && context.evidenceRefId !== evidenceRefId) return false;
  if (sourceToolCallId && context.sourceToolCallId !== sourceToolCallId) {
    return false;
  }
  // evidenceRefId and sourceToolCallId are machine identifiers. sourceRef is
  // an LLM-visible label such as "表 1" or "摘要 2", so it must not veto an
  // otherwise exact machine-id match when ref numbering changes.
  if (
    !evidenceRefId &&
    !sourceToolCallId &&
    sourceRef &&
    !sourceRefMatches(context.ref, sourceRef)
  ) {
    return false;
  }
  return true;
}

function findClaimSource(
  ctx: SSEHandlerContext | undefined,
  evidenceRefId: string,
  sourceRef: string,
  sourceToolCallId: string,
): {
  source?: DataSourceContext;
  sqlResult?: SqlResultData;
  ambiguous?: boolean;
} {
  if (!ctx) return {};

  const sources = ctx.streamingFlow.dataSourceRefs.filter((ref) =>
    sourceContextMatchesClaim(ref, evidenceRefId, sourceRef, sourceToolCallId),
  );
  const messages = ctx.getMessages().filter((msg) => {
    const context = msg.sqlResult?.sourceContext || msg.sourceContext;
    return sourceContextMatchesClaim(
      context,
      evidenceRefId,
      sourceRef,
      sourceToolCallId,
    );
  });
  return {
    source: sources[0],
    sqlResult: messages[0]?.sqlResult,
    ambiguous: sources.length > 1 || messages.length > 1,
  };
}

function parseClaimSelectorScalar(value: string): string | number | boolean {
  const text = normalizeFlowLine(value).replace(/^['"]|['"]$/g, '');
  if (/^(true|false)$/i.test(text)) return /^true$/i.test(text);
  const numeric = Number(text);
  if (
    Number.isFinite(numeric) &&
    /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(text)
  ) {
    return numeric;
  }
  return text;
}

function parseClaimRowSelectorString(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) return {};
  if (text.startsWith('{')) {
    try {
      return asRecord(JSON.parse(text));
    } catch {
      return {};
    }
  }

  const selector: Record<string, unknown> = {};
  for (const part of text.split(/[,，]/)) {
    const match = part.trim().match(/^([^=：:]+)\s*(?:=|:|：)\s*(.+)$/);
    if (!match) continue;
    const key = normalizeFlowLine(match[1]);
    if (!key) continue;
    selector[key] = parseClaimSelectorScalar(match[2]);
  }
  return selector;
}

function readClaimRowSelector(
  ref: Record<string, unknown>,
): Record<string, unknown> {
  const value = readAliasedValue(ref, CONTRACT_ALIASES.claimRef.rowSelector);
  if (typeof value === 'string') return parseClaimRowSelectorString(value);
  return readAliasedRecord(ref, CONTRACT_ALIASES.claimRef.rowSelector);
}

function normalizeClaimColumnName(value: string): string {
  return normalizeFlowLine(value).toLowerCase();
}

function resolveClaimColumn(
  sqlResult: SqlResultData,
  column: string,
): {index?: number; status?: string} {
  const exactIndex = sqlResult.columns.indexOf(column);
  if (exactIndex >= 0) return {index: exactIndex};

  const normalizedColumn = normalizeClaimColumnName(column);
  const normalizedMatches = sqlResult.columns
    .map((name, index) => ({name, index}))
    .filter(
      ({name}) => normalizeClaimColumnName(String(name)) === normalizedColumn,
    );
  if (normalizedMatches.length === 1) {
    return {index: normalizedMatches[0].index};
  }
  if (normalizedMatches.length > 1) return {status: '未核验: 列名不唯一'};

  const labelMatches = (sqlResult.columnDefinitions || [])
    .map((definition, index) => ({definition, index}))
    .filter(
      ({definition}) =>
        typeof definition.label === 'string' &&
        normalizeClaimColumnName(definition.label) === normalizedColumn &&
        sqlResult.columns.includes(definition.name),
    );
  if (labelMatches.length === 1) {
    return {index: sqlResult.columns.indexOf(labelMatches[0].definition.name)};
  }
  if (labelMatches.length > 1) return {status: '未核验: 列标签不唯一'};

  return {status: '未通过: 列不存在'};
}

function rowMatchesSelector(
  row: unknown[],
  sqlResult: SqlResultData,
  selector: Record<string, unknown>,
): boolean {
  for (const [column, expected] of Object.entries(selector)) {
    const resolvedColumn = resolveClaimColumn(sqlResult, column);
    if (resolvedColumn.index === undefined) return false;
    if (!claimValueMatches(row[resolvedColumn.index], expected)) return false;
  }
  return true;
}

function resolveClaimRow(
  sqlResult: SqlResultData,
  rowIndexValue: unknown,
  rowIndex: number | undefined,
  rowSelector: Record<string, unknown>,
): {row?: unknown[]; rowLabel?: string; status?: string} {
  const hasRowIndex =
    rowIndexValue !== undefined &&
    rowIndexValue !== null &&
    conclusionText(rowIndexValue) !== '';
  if (hasRowIndex) {
    if (rowIndex === undefined || !Number.isInteger(rowIndex) || rowIndex < 0) {
      return {
        rowLabel: rowIndex !== undefined ? `row ${rowIndex}` : '',
        status: '未通过: 行号无效',
      };
    }
    const row = sqlResult.rows[rowIndex];
    if (!row && sqlResult.preview && rowIndex < sqlResult.preview.totalRows) {
      return {rowLabel: `row ${rowIndex}`, status: '未核验: 预览数据不足'};
    }
    return row
      ? {row, rowLabel: `row ${rowIndex}`}
      : {rowLabel: `row ${rowIndex}`, status: '未通过: 行不存在'};
  }

  const selectorEntries = Object.entries(rowSelector);
  if (selectorEntries.length === 0) return {};
  if (sqlResult.preview && sqlResult.preview.totalRows > sqlResult.rows.length) {
    return {status: '未核验: 预览数据不足，无法核对完整表格的 rowSelector'};
  }

  const matches = sqlResult.rows
    .map((row, idx) => ({row, idx}))
    .filter(({row}) => rowMatchesSelector(row, sqlResult, rowSelector));
  const selectorLabel = `rowSelector ${selectorEntries.map(([key, value]) => `${key}=${String(value)}`).join(', ')}`;
  if (matches.length === 0) {
    return {rowLabel: selectorLabel, status: '未通过: rowSelector 未命中'};
  }
  if (matches.length > 1) {
    return {rowLabel: selectorLabel, status: '未核验: rowSelector 不唯一'};
  }
  return {
    row: matches[0].row,
    rowLabel: `${selectorLabel} -> row ${matches[0].idx}`,
  };
}

type ClaimReferenceAudit = {
  label: string;
  rowLabel: string;
  column: string;
  status: string;
  sourceRefMismatch: boolean;
};

function auditClaimReference(
  ref: Record<string, unknown>,
  ctx: SSEHandlerContext | undefined,
): ClaimReferenceAudit {
  const evidenceRefId = conclusionText(
    readAliasedValue(ref, CONTRACT_ALIASES.claimRef.evidenceRefId),
  );
  const sourceRef = conclusionText(
    readAliasedValue(ref, CONTRACT_ALIASES.claimRef.sourceRef),
  );
  const sourceToolCallId = conclusionText(
    readAliasedValue(ref, CONTRACT_ALIASES.claimRef.sourceToolCallId),
  );
  const rowIndexValue = readAliasedValue(
    ref,
    CONTRACT_ALIASES.claimRef.rowIndex,
  );
  const rowIndex = conclusionNumber(rowIndexValue);
  const rowSelector = readClaimRowSelector(ref);
  const column = conclusionText(
    readAliasedValue(ref, CONTRACT_ALIASES.claimRef.column),
  );
  const expectedValue = readAliasedValue(ref, CONTRACT_ALIASES.claimRef.value);
  const hasExpectedValue =
    expectedValue !== undefined &&
    expectedValue !== null &&
    `${expectedValue}` !== '';
  const matched = findClaimSource(
    ctx,
    evidenceRefId,
    sourceRef,
    sourceToolCallId,
  );
  const sourceRefMismatch = Boolean(
    sourceRef &&
      matched.source &&
      !sourceRefMatches(matched.source.ref, sourceRef),
  );
  const label =
    sourceRef && !sourceRefMismatch
      ? sourceRef
      : matched.source?.ref ||
        sourceRef ||
        (evidenceRefId ? compactEvidenceRef(evidenceRefId) : '');
  const resolvedRow = matched.sqlResult
    ? resolveClaimRow(matched.sqlResult, rowIndexValue, rowIndex, rowSelector)
    : {};

  let status = '';
  if (!evidenceRefId && !sourceRef && !sourceToolCallId) {
    status = '未核验: 未提供 evidenceRef/sourceRef/toolCallId';
  } else if (matched.ambiguous) {
    status = '未核验: 来源不唯一';
  } else if (!matched.source && !matched.sqlResult) {
    status = '未核验: 未找到来源';
  } else if (!matched.sqlResult) {
    status =
      rowIndex !== undefined ||
      Object.keys(rowSelector).length > 0 ||
      column ||
      expectedValue !== undefined
        ? '未核验: 来源不是表格数据'
        : '已找到来源';
  } else if (resolvedRow.status) {
    status = resolvedRow.status;
  } else if (resolvedRow.row) {
    const row = resolvedRow.row;
    if (column) {
      const resolvedColumn = resolveClaimColumn(matched.sqlResult, column);
      if (resolvedColumn.index === undefined) {
        status = resolvedColumn.status || '未通过: 列不存在';
      } else if (!hasExpectedValue) {
        status = '未核验: 未提供期望值';
      } else {
        const comparison = compareClaimValue(
          row[resolvedColumn.index],
          expectedValue,
        );
        if (!comparison.matches) {
          status = `未通过: 值不匹配，实际 ${String(row[resolvedColumn.index] ?? '')}`;
        } else {
          status = comparison.approximate ? '已核对: 近似匹配' : '已核对';
        }
      }
    } else {
      status = expectedValue !== undefined ? '未核验: 未提供列名' : '已核对';
    }
  } else {
    status =
      column || expectedValue !== undefined
        ? '未核验: 未提供行号或 rowSelector'
        : '已找到来源';
  }

  return {
    label: label || '未命名来源',
    rowLabel:
      resolvedRow.rowLabel || (rowIndex !== undefined ? `row ${rowIndex}` : ''),
    column,
    status,
    sourceRefMismatch: sourceRefMismatch && Boolean(matched.source),
  };
}

function compactClaimAuditStatus(statuses: string[]): string {
  const failed = statuses.find((status) => status.startsWith('未通过'));
  if (failed) return failed;
  const unverified = statuses.find((status) => status.startsWith('未核验'));
  if (unverified) return unverified;
  if (statuses.some((status) => status.includes('近似匹配'))) {
    return '已核对（含近似匹配）';
  }
  if (statuses.some((status) => status === '已找到来源')) return '已找到来源';
  return '已核对';
}

function renderClaimReferencesSummary(
  references: Record<string, unknown>[],
  ctx: SSEHandlerContext | undefined,
): string {
  const groups = new Map<
    string,
    {
      label: string;
      rows: Set<string>;
      columns: Set<string>;
      statuses: string[];
      mismatchCount: number;
      referenceCount: number;
    }
  >();

  for (const ref of references) {
    const audit = auditClaimReference(ref, ctx);
    const key = [audit.label, audit.rowLabel].join('\0');
    if (!groups.has(key)) {
      groups.set(key, {
        label: audit.label,
        rows: new Set(),
        columns: new Set(),
        statuses: [],
        mismatchCount: 0,
        referenceCount: 0,
      });
    }
    const group = groups.get(key)!;
    if (audit.rowLabel) group.rows.add(audit.rowLabel);
    if (audit.column) {
      for (const column of audit.column
        .split(/[,，]/)
        .map((part) => normalizeFlowLine(part))
        .filter(Boolean)) {
        group.columns.add(column);
      }
    }
    group.statuses.push(audit.status);
    if (audit.sourceRefMismatch) group.mismatchCount += 1;
    group.referenceCount += 1;
  }

  const maxGroups = 4;
  const rendered = [...groups.values()].slice(0, maxGroups).map((group) => {
    const rows = [...group.rows];
    const columns = [...group.columns];
    const rowText =
      rows.length > 0
        ? `，${rows.slice(0, 2).join(' / ')}${rows.length > 2 ? ` 等 ${rows.length} 行` : ''}`
        : '';
    const columnText =
      columns.length > 0
        ? `，列 ${columns.slice(0, 6).join('/')}${columns.length > 6 ? ` 等 ${columns.length} 列` : ''}`
        : '';
    const status = compactClaimAuditStatus(group.statuses);
    const mismatchText =
      group.mismatchCount > 0 ? '，source_ref 已按系统来源校正' : '';
    return `${group.label}${rowText}${columnText}，${status}${mismatchText}`;
  });

  if (groups.size > maxGroups) {
    rendered.push(`另有 ${groups.size - maxGroups} 个来源组未展开`);
  }
  return rendered.join('；');
}

function renderConclusionClaimsSection(
  contract: ConclusionContract | Record<string, unknown> | null | undefined,
  ctx?: SSEHandlerContext,
): string {
  if (!contract || typeof contract !== 'object') return '';
  const contractRecord = asRecord(contract);
  const claims = readAliasedRecordArray(
    contractRecord,
    CONTRACT_ALIASES.root.claims,
  );
  if (claims.length === 0) return '';

  const lines: string[] = ['## 逐句数据引用（系统核对结果）'];
  const maxClaims = 20;
  claims.slice(0, maxClaims).forEach((item, idx: number) => {
    const claimId =
      conclusionText(readAliasedValue(item, CONTRACT_ALIASES.claim.id)) ||
      `Q${idx + 1}`;
    const conclusionId = conclusionText(
      readAliasedValue(item, CONTRACT_ALIASES.claim.conclusionId),
    );
    const claimText =
      conclusionText(readAliasedValue(item, CONTRACT_ALIASES.claim.text)) ||
      '未命名结论片段';
    const references = readAliasedRecordArray(
      item,
      CONTRACT_ALIASES.claim.references,
    );
    const refText =
      references.length > 0
        ? renderClaimReferencesSummary(references, ctx)
        : '未提供行/列引用';
    const cid = conclusionId ? ` / ${conclusionId}` : '';
    lines.push(`- ${claimId}${cid}: ${claimText}（${refText}）`);
  });
  if (claims.length > maxClaims) {
    lines.push(
      `- 其余 ${claims.length - maxClaims} 条 claim 未展开；完整结构化引用仍保留在结果快照中。`,
    );
  }
  return lines.join('\n');
}

function verificationInline(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'NULL';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return '[unavailable]'; }
  }
  return String(value).replace(/\s+/g, ' ').trim();
}

function verificationFields(
  item: Record<string, unknown>,
  fields: readonly string[],
): string {
  return fields.flatMap(key => item[key] === undefined
    ? [] : [`${key}=${verificationInline(item[key])}`]).join(', ');
}

function groupByClaimId(items: unknown[]): Map<string, Record<string, unknown>[]> {
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const value of items) {
    const item = asRecord(value);
    const claimId = conclusionText(readAliasedValue(item, CONTRACT_ALIASES.claim.id)) || 'unknown';
    const group = grouped.get(claimId) ?? [];
    group.push(item);
    grouped.set(claimId, group);
  }
  return grouped;
}

function renderVerificationReference(
  lines: string[],
  label: string,
  value: unknown,
): void {
  const item = asRecord(value);
  const aliased = [
    ['evidenceRefId', CONTRACT_ALIASES.claimRef.evidenceRefId],
    ['sourceRef', CONTRACT_ALIASES.claimRef.sourceRef],
    ['sourceToolCallId', CONTRACT_ALIASES.claimRef.sourceToolCallId],
    ['rowIndex', CONTRACT_ALIASES.claimRef.rowIndex],
    ['rowSelector', CONTRACT_ALIASES.claimRef.rowSelector],
    ['column', CONTRACT_ALIASES.claimRef.column],
    ['value', CONTRACT_ALIASES.claimRef.value],
  ] as const;
  const aliasDetail = aliased.flatMap(([key, aliases]) => {
    const field = readAliasedValue(item, aliases);
    return field === undefined ? [] : [`${key}=${verificationInline(field)}`];
  });
  const directDetail = verificationFields(item, [
    'artifactId', 'sourceArtifactId', 'anchorId', 'actualValue', 'displayValue',
    'unit', 'isSqlNull', 'status', 'message',
  ]);
  const detail = [...aliasDetail, ...(directDetail ? [directDetail] : [])].join(', ');
  lines.push(`  - ${label}: ${detail || uiText('无已知定位字段', 'no known location fields')}`);
}

function renderVerificationAnchor(
  lines: string[],
  anchorValue: unknown,
  label: string,
): void {
  const anchor = asRecord(anchorValue);
  lines.push(`  - ${label}: ${verificationFields(anchor, [
    'version', 'anchorId', 'evidenceRefId', 'missing', 'missingReason', 'confidence',
    'claimBoundary', 'evidenceScope', 'rootCauseBoundary',
  ])}`);
  const context = asRecord(anchor.context);
  const contextText = verificationFields(context, [
    'captureId', 'traceId', 'traceSide', 'paneSide', 'toolCallId', 'sourceToolCallId',
    'producerKind', 'skillId', 'stepId', 'queryHash', 'queryReviewId',
    'sqlTextRef', 'paramsHash', 'artifactId', 'sourceArtifactId', 'planPhaseId',
  ]);
  if (contextText) lines.push(`    - context: ${contextText}`);
  const timeRange = asRecord(anchor.timeRange);
  const timeRangeText = verificationFields(timeRange, ['startTs', 'endTs', 'unit', 'source']);
  if (timeRangeText) lines.push(`    - timeRange: ${timeRangeText}`);
  const scope = asRecord(anchor.scopeProvenance);
  if (Object.keys(scope).length > 0) {
    lines.push(`    - scope: ${verificationFields(scope, ['version', 'invalid'])}`);
    const entries = Array.isArray(scope.entries) ? scope.entries : [];
    entries.forEach((entry, index) => {
      const item = asRecord(entry);
      lines.push(`      - entry ${index + 1}: ${verificationFields(item, [
        'role', 'sourceStepId', 'fields', 'availability', 'reason',
      ])}`);
      for (const key of ['scope', 'relativeTo']) {
        const processScope = asRecord(item[key]);
        if (Object.keys(processScope).length > 0) lines.push(`        - ${key}: ${verificationFields(processScope, [
          'mode', 'traceId', 'traceSide', 'upid', 'requestedName', 'identityRefId',
        ])}`);
      }
    });
  }
  const identity = asRecord(anchor.identity);
  const identityText = verificationFields(identity, [
    'identityRefId', 'status', 'role', 'packageName', 'processName', 'threadName',
    'upid', 'utid', 'pid', 'tid', 'confidence', 'warnings',
  ]);
  if (identityText) lines.push(`    - identity: ${identityText}`);
  const cells = Array.isArray(anchor.cells) ? anchor.cells : [];
  cells.forEach((cell, index) => renderVerificationReference(lines, `cell ${index + 1}`, cell));
}

function renderIdentityResolution(
  lines: string[],
  value: unknown,
  index: number,
): void {
  const identity = asRecord(value);
  const identityRefId = readStringField(identity, 'identityRefId') || String(index + 1);
  lines.push('', `### identity ${identityRefId}`);
  lines.push(`- ${verificationFields(identity, ['version', 'status', 'warnings', 'recommendedParams'])}`);

  const target = asRecord(identity.target);
  if (Object.keys(target).length > 0) {
    lines.push(`  - target: ${verificationFields(target, [
      'traceId', 'traceSide', 'packageName', 'processName', 'threadName',
      'role', 'upid', 'utid', 'pid', 'tid', 'timeRange', 'source',
    ])}`);
  }
  const processes = Array.isArray(identity.processes) ? identity.processes : [];
  processes.forEach((process, processIndex) => lines.push(
    `  - process ${processIndex + 1}: ${verificationFields(asRecord(process), [
      'upid', 'pid', 'processName', 'packageName', 'startTs', 'endTs',
      'matchSources', 'confidence',
    ])}`,
  ));
  const threads = Array.isArray(identity.threads) ? identity.threads : [];
  threads.forEach((thread, threadIndex) => lines.push(
    `  - thread ${threadIndex + 1}: ${verificationFields(asRecord(thread), [
      'utid', 'tid', 'threadName', 'role', 'owningUpid', 'processName',
      'activeRange', 'matchSources', 'confidence',
    ])}`,
  ));
}

function readCodeAwareRecordArray(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown>[] {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is Record<string, unknown> =>
        isRecord(item),
      );
    }
  }
  return [];
}

function formatCodeLineRange(value: unknown): string {
  if (Array.isArray(value) && value.length >= 2) {
    const start = conclusionNumber(value[0]);
    const end = conclusionNumber(value[1]);
    if (start !== undefined && end !== undefined) {
      return `${Math.round(start)}-${Math.round(end)}`;
    }
  }
  const record = asRecord(value);
  const start = conclusionNumber(record.start ?? record.startLine);
  const end = conclusionNumber(record.end ?? record.endLine);
  if (start === undefined && end === undefined) return '';
  if (start !== undefined && end !== undefined) {
    return `${Math.round(start)}-${Math.round(end)}`;
  }
  return String(Math.round(start ?? end ?? 0));
}

function renderCodeAwareVerificationDetails(
  contract: Record<string, unknown>,
): string[] {
  const refs = readCodeAwareRecordArray(contract, [
    'codeReferences',
    'code_refs',
    'codeRefs',
  ]);
  const patches = readCodeAwareRecordArray(contract, [
    'patchProposals',
    'patch_proposals',
    'patches',
  ]);
  const lines: string[] = [];
  if (refs.length > 0) {
    lines.push('', uiText('## 代码引用', '## Code references'));
    refs.forEach((ref, index) => {
      const chunkId = conclusionText(
        ref.chunkId || ref.chunk_id || `ref-${index + 1}`,
      );
      const filePath = conclusionText(ref.filePath || ref.file_path);
      const lineRange = formatCodeLineRange(ref.lineRange || ref.line_range);
      const symbol = conclusionText(ref.symbol);
      const codebaseId = conclusionText(ref.codebaseId || ref.codebase_id);
      const location = [filePath, lineRange ? `L${lineRange}` : '']
        .filter(Boolean)
        .join(':');
      const meta = [
        location || uiText('仅元数据', 'metadata-only'),
        symbol ? uiText(`符号 ${symbol}`, `symbol ${symbol}`) : '',
        codebaseId
          ? uiText(`代码库 ${codebaseId}`, `codebase ${codebaseId}`)
          : '',
      ].filter(Boolean);
      lines.push(
        `- \`${chunkId}\`${meta.length > 0 ? ` - ${meta.join('；')}` : ''}`,
      );
    });
  }
  if (patches.length > 0) {
    lines.push('', uiText('## 补丁建议', '## Patch proposals'));
    patches.forEach((patch, index) => {
      const id = conclusionText(
        patch.id || patch.patchId || patch.patch_id || `patch-${index + 1}`,
      );
      const status = conclusionText(
        patch.status || patch.patchStatus || patch.patch_status,
      ) || 'unverified';
      const rationale = conclusionText(
        patch.rationale || patch.reason || patch.summary,
      );
      const copyHint = status === 'verified'
        ? uiText('已通过后端应用检查', 'verified by backend apply-check')
        : status === 'sketch'
          ? uiText('仅为草案；没有可复制的 diff', 'sketch only; no copyable diff')
          : uiText('尚未验证；没有可复制的 diff', 'unverified; no copyable diff');
      lines.push(
        `- \`${id}\` - ${status} (${copyHint})${rationale ? `: ${rationale}` : ''}`,
      );
    });
  }
  return lines;
}

function renderServerVerificationDetails(
  payload: AnalysisCompletedPayload | undefined,
): string | undefined {
  if (!payload) return undefined;
  const supports = payload.claimSupport ?? [];
  const verifier = asRecord(payload.claimVerificationResult);
  const results = Array.isArray(verifier.claimResults) ? verifier.claimResults : [];
  const issues = Array.isArray(verifier.issues) ? verifier.issues : [];
  const identities = payload.identityResolutions ?? [];
  const contract = asRecord(payload.conclusionContract);
  const contractClaims = readAliasedRecordArray(contract, CONTRACT_ALIASES.root.claims);
  const codeAwareDetails = renderCodeAwareVerificationDetails(contract);
  if (supports.length === 0 && results.length === 0 && issues.length === 0 &&
      Object.keys(verifier).length === 0 &&
      contractClaims.length === 0 && identities.length === 0 &&
      codeAwareDetails.length === 0 &&
      !payload.partial && !payload.terminationMessage) return undefined;

  const supportGroups = groupByClaimId(supports);
  const resultGroups = groupByClaimId(results);
  const contractGroups = groupByClaimId(contractClaims);
  const issueGroups = groupByClaimId(issues);
  const claimIds = [...new Set([
    ...contractGroups.keys(), ...supportGroups.keys(), ...resultGroups.keys(), ...issueGroups.keys(),
  ])];
  const lines = [uiText('## 服务器核验详情', '## Server verification details')];
  lines.push(`- ${uiText('结果状态', 'Result status')}: ${analysisCompletedResultStatus(payload)}`);
  if (payload.terminationReason) lines.push(`- terminationReason: ${payload.terminationReason}`);
  if (payload.terminationMessage) lines.push(`- terminationMessage: ${payload.terminationMessage}`);
  if (Object.keys(verifier).length > 0) {
    lines.push(`- verifier: ${verificationFields(verifier, [
      'schemaVersion', 'status', 'policy', 'passed', 'notCheckedReason', 'notCheckedDetail',
      'checkedClaimCount', 'unsupportedClaimCount',
    ])}`);
  }

  for (const claimId of claimIds) {
    const claimSupports = supportGroups.get(claimId) ?? [];
    const claimResults = resultGroups.get(claimId) ?? [];
    const declaredClaims = contractGroups.get(claimId) ?? [];
    const duplicate = claimSupports.length > 1 || claimResults.length > 1 || declaredClaims.length > 1;
    const texts = [...new Set([...claimSupports, ...declaredClaims]
      .map(item => conclusionText(readAliasedValue(item, CONTRACT_ALIASES.claim.text)))
      .filter(Boolean))];
    const conflicting = texts.length > 1;
    lines.push('', `### ${claimId}`);
    lines.push(`- ${uiText('结论文本', 'Claim text')}: ${texts.length === 1
      ? texts[0] : uiText('服务器投影中不可唯一确定', 'not uniquely available from server projection')}`);
    const status = duplicate || conflicting
      ? 'unverified'
      : claimResults.length === 1
        ? readStringField(claimResults[0], 'status', 'not_checked')
        : 'not_checked';
    lines.push(`- status: ${status}`);
    if (duplicate || conflicting) {
      lines.push(`- integrity: duplicate_or_conflicting_claim_id; status=unverified`);
    }
    claimSupports.forEach((support, supportIndex) => {
      lines.push(`- support ${supportIndex + 1}: ${verificationFields(support, [
        'kind', 'supportLevel', 'bindingEligibility', 'relationEvaluation',
        'inferenceReason',
      ])}`);
      const semantics = asRecord(support.semantics);
      if (Object.keys(semantics).length > 0) {
        lines.push(`  - semantics: ${verificationFields(semantics, [
          'predicate', 'polarity', 'discourse', 'quantifier', 'modality', 'conditions',
        ])}`);
        const scope = asRecord(semantics.scope);
        if (Object.keys(scope).length > 0) {
          lines.push(`  - semantics scope: ${verificationFields(scope, ['population', 'timeRangeNs'])}`);
          for (const role of ['subjectRefs', 'objectRefs'] as const) {
            const refs = Array.isArray(scope[role]) ? scope[role] as unknown[] : [];
            refs.forEach((ref, index) => renderVerificationReference(lines, `${role} ${index + 1}`, ref));
          }
        }
        const source = asRecord(semantics.source);
        if (Object.keys(source).length > 0) lines.push(`  - source location: ${verificationFields(source, ['sourceReferenceId', 'filePath', 'lineRange'])}`);
        const numeric = asRecord(semantics.numeric);
        if (Object.keys(numeric).length > 0) lines.push(`  - numeric proposition: ${verificationFields(numeric, ['operator', 'value', 'unit'])}`);
      }
      (Array.isArray(support.anchors) ? support.anchors : []).forEach((anchor, index) =>
        renderVerificationAnchor(lines, anchor, `anchor ${index + 1}`));
      (Array.isArray(support.relationAnchors) ? support.relationAnchors : []).forEach((anchor, index) =>
        renderVerificationAnchor(lines, anchor, `relation anchor ${index + 1}`));
      (Array.isArray(support.relations) ? support.relations : []).forEach((relation, index) => {
        const item = asRecord(relation);
        lines.push(`  - relation ${index + 1}: ${verificationFields(item, [
          'id', 'kind', 'direction', 'verificationStatus', 'reasonCode',
          'subjectAnchorId', 'objectAnchorId', 'proofAnchorId', 'relationAnchorId',
          'directEvidenceAnchorIds', 'proofBindings', 'metricColumn', 'value',
          'isSqlNull', 'unit', 'deltaDirection', 'supportLevel', 'reason',
        ])}`);
      });
    });
    declaredClaims.forEach((claim) => {
      const declaration = [
        ['conclusionId', CONTRACT_ALIASES.claim.conclusionId],
        ['kind', ['kind']],
        ['supportLevel', ['supportLevel']],
      ] as const;
      const declarationText = declaration.flatMap(([key, aliases]) => {
        const value = readAliasedValue(claim, aliases);
        return value === undefined ? [] : [`${key}=${verificationInline(value)}`];
      }).join(', ');
      if (declarationText) lines.push(`  - declaration: ${declarationText}`);
      readAliasedRecordArray(claim, CONTRACT_ALIASES.claim.references).forEach((ref, index) =>
        renderVerificationReference(lines, `declared reference ${index + 1}`, ref));
      (Array.isArray(claim.artifactRefs) ? claim.artifactRefs : []).forEach((ref, index) =>
        renderVerificationReference(lines, `artifact reference ${index + 1}`, ref));
      (Array.isArray(claim.relationRefs) ? claim.relationRefs : []).forEach((ref, index) =>
        lines.push(`  - relationRef ${index + 1}: ${verificationInline(ref)}`));
      const semantics = asRecord(claim.semantics);
      if (Object.keys(semantics).length > 0) {
        lines.push(`  - declared semantics: ${verificationFields(semantics, [
          'predicate', 'polarity', 'discourse', 'quantifier', 'modality', 'conditions',
        ])}`);
        const scope = asRecord(semantics.scope);
        if (Object.keys(scope).length > 0) {
          lines.push(`  - declared scope: ${verificationFields(scope, ['population', 'timeRangeNs'])}`);
          for (const role of ['subjectRefs', 'objectRefs'] as const) {
            const refs = Array.isArray(scope[role]) ? scope[role] as unknown[] : [];
            refs.forEach((ref, index) => renderVerificationReference(lines, `declared ${role} ${index + 1}`, ref));
          }
        }
        const source = asRecord(semantics.source);
        if (Object.keys(source).length > 0) lines.push(`  - declared source location: ${verificationFields(source, ['sourceReferenceId', 'filePath', 'lineRange'])}`);
        const numeric = asRecord(semantics.numeric);
        if (Object.keys(numeric).length > 0) lines.push(`  - declared numeric proposition: ${verificationFields(numeric, ['operator', 'value', 'unit'])}`);
      }
    });
    claimResults.forEach((result, resultIndex) => {
      lines.push(`- verifier result ${resultIndex + 1}: ${duplicate
        ? 'unverified (duplicate claimId)' : verificationFields(result, ['status'])}`);
      const referenceCells = Array.isArray(result.referenceCells) ? result.referenceCells : [];
      referenceCells.forEach((ref, index) =>
        renderVerificationReference(lines, `reference cell ${index + 1}`, ref));
      const referenceResults = Array.isArray(result.referenceResults) ? result.referenceResults : [];
      referenceResults.forEach((ref, index) =>
        renderVerificationReference(lines, `reference result ${index + 1}`, ref));
      const proof = asRecord(result.deterministicProof);
      if (Object.keys(proof).length > 0) {
        lines.push(`  - deterministic proof: ${verificationFields(proof, ['kind', 'status', 'reason', 'anchorIds', 'evidenceRefIds'])}`);
        const nativeRows = Array.isArray(proof.nativeRows) ? proof.nativeRows : [];
        nativeRows.forEach((row, index) => lines.push(`    - native row ${index + 1} (${uiText('仅身份元数据，不单独构成证明', 'identity metadata only; not proof by itself')}): ${verificationFields(asRecord(row), [
          'anchorId', 'evidenceRefId', 'captureId', 'traceId', 'traceSide',
          'relation', 'idColumn', 'id', 'schemaFingerprint',
        ])}`));
      }
      const coverage = asRecord(result.propositionCoverage);
      if (Object.keys(coverage).length > 0) lines.push(`  - proposition coverage: ${verificationFields(coverage, ['status', 'covered', 'uncovered', 'reason'])}`);
    });
    (issueGroups.get(claimId) ?? []).forEach((issue, index) =>
      lines.push(`- issue ${index + 1}: ${verificationFields(issue, ['severity', 'code', 'message', 'evidenceRefId'])}`));
  }
  identities.forEach((identity, index) => renderIdentityResolution(lines, identity, index));
  lines.push(...codeAwareDetails);
  return lines.join('\n');
}

function renderServerVerificationNotice(
  payload: AnalysisCompletedPayload | undefined,
): string | undefined {
  if (!payload) return undefined;
  const status = analysisCompletedResultStatus(payload);
  if (status !== 'partial' && status !== 'failed' && status !== 'quota_exceeded') {
    return undefined;
  }
  const reason = payload.terminationMessage || payload.terminationReason ||
    uiText('结果仍不完整或尚未通过核验。', 'The result is incomplete or has not passed verification.');
  return [
    uiText('> **结果完整性提示**', '> **Result completeness notice**'),
    ...reason.split(/\r?\n/).filter(Boolean).map(line => `> ${line}`),
  ].join('\n');
}

function sameServerVerificationBinding(
  left: Message['serverVerificationBinding'],
  right: Message['serverVerificationBinding'],
): boolean {
  return Boolean(left && right && left.candidateRef === right.candidateRef &&
    left.runId === right.runId && left.attemptId === right.attemptId &&
    left.conclusionFingerprint === right.conclusionFingerprint);
}

function buildVisibleConclusionContent(
  content: string,
  _payload?: AnalysisCompletedPayload,
): string {
  return content;
}

function buildVisibleConclusionContentWithReportAppendix(
  content: string,
  contract: ConclusionContract | Record<string, unknown> | null | undefined,
  ctx: SSEHandlerContext,
  resultSnapshotId?: string,
  payload?: AnalysisCompletedPayload,
): string {
  void contract;
  void ctx;
  void resultSnapshotId;
  return buildVisibleConclusionContent(content, payload);
}

function renderConclusionContract(
  contract: ConclusionContract | Record<string, unknown> | null | undefined,
  ctx?: SSEHandlerContext,
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

  const conclusions = readAliasedRecordArray(
    contractRecord,
    CONTRACT_ALIASES.root.conclusions,
  );
  const clusters = readAliasedRecordArray(
    contractRecord,
    CONTRACT_ALIASES.root.clusters,
  );
  const evidenceChain = readAliasedRecordArray(
    contractRecord,
    CONTRACT_ALIASES.root.evidenceChain,
  );
  const claims = readAliasedRecordArray(
    contractRecord,
    CONTRACT_ALIASES.root.claims,
  );
  const uncertainties = readAliasedUnknownArray(
    contractRecord,
    CONTRACT_ALIASES.root.uncertainties,
  );
  const nextSteps = readAliasedUnknownArray(
    contractRecord,
    CONTRACT_ALIASES.root.nextSteps,
  );
  const metadata = readAliasedRecord(
    contractRecord,
    CONTRACT_ALIASES.root.metadata,
  );

  const resolveClusterHeading = (): string => {
    const sceneId = toText(
      readAliasedValue(contractRecord, CONTRACT_ALIASES.root.sceneId) ??
        readAliasedValue(metadata, CONTRACT_ALIASES.metadata.sceneId),
    ).toLowerCase();
    return sceneId === 'jank'
      ? uiText('## 掉帧聚类（先看大头）', '## Jank clusters (largest first)')
      : uiText('## 聚类（先看大头）', '## Clusters (largest first)');
  };

  const resolveClusterLimit = (): number | undefined => {
    const clusterPolicy = readAliasedRecord(
      metadata,
      CONTRACT_ALIASES.metadata.clusterPolicy,
    );
    const maxClusters = toNumber(
      readAliasedValue(clusterPolicy, CONTRACT_ALIASES.metadata.maxClusters) ??
        readAliasedValue(metadata, CONTRACT_ALIASES.metadata.maxClusters),
    );
    if (maxClusters === undefined || maxClusters <= 0) return undefined;
    return Math.round(maxClusters);
  };

  const hasSignal =
    conclusions.length > 0 ||
    clusters.length > 0 ||
    evidenceChain.length > 0 ||
    claims.length > 0 ||
    uncertainties.length > 0 ||
    nextSteps.length > 0;
  if (!hasSignal) return null;

  const lines: string[] = [];
  lines.push(
    uiText('## 结论（按可能性排序）', '## Conclusions (ordered by likelihood)'),
  );
  if (conclusions.length === 0) {
    lines.push(
      uiText(
        '1. 结论信息缺失（证据不足）',
        '1. Conclusion unavailable (insufficient evidence)',
      ),
    );
  } else {
    conclusions.forEach((item, idx: number) => {
      const statement = toText(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.statement),
      );
      const trigger = toText(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.trigger),
      );
      const supply = toText(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.supply),
      );
      const amplification = toText(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.amplification),
      );
      let resolved = statement;
      if (!resolved && (trigger || supply || amplification)) {
        const parts: string[] = [];
        if (trigger)
          {parts.push(
            uiText(
              `触发因子（直接原因）: ${trigger}`,
              `Trigger (direct cause): ${trigger}`,
            ),
          );}
        if (supply)
          {parts.push(
            uiText(
              `供给约束（资源瓶颈）: ${supply}`,
              `Supply constraint (resource bottleneck): ${supply}`,
            ),
          );}
        if (amplification)
          {parts.push(
            uiText(
              `放大路径（问题放大环节）: ${amplification}`,
              `Amplification path: ${amplification}`,
            ),
          );}
        resolved = parts.join(uiText('；', '; '));
      }
      const confidence = toPercent(
        readAliasedValue(item, CONTRACT_ALIASES.conclusion.confidence),
      );
      const suffix =
        confidence !== undefined
          ? uiText(
              `（置信度: ${Math.round(confidence)}%）`,
              ` (confidence: ${Math.round(confidence)}%)`,
            )
          : '';
      lines.push(
        `${idx + 1}. ${resolved || uiText('结论信息缺失', 'Conclusion unavailable')}${suffix}`,
      );
    });
  }
  lines.push('');

  lines.push(resolveClusterHeading());
  if (clusters.length === 0) {
    lines.push(uiText('- 暂无', '- None'));
  } else {
    const clusterLimit = resolveClusterLimit();
    const clusterItems =
      clusterLimit !== undefined ? clusters.slice(0, clusterLimit) : clusters;
    clusterItems.forEach((item) => {
      const cluster = toText(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.cluster),
      );
      const description = toText(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.description),
      );
      const frames = toNumber(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.frames),
      );
      const percentage = toPercent(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.percentage),
      );
      const label = description
        ? `${cluster || 'K?'}: ${description}`
        : cluster || 'K?';
      const metrics: string[] = [];
      if (frames !== undefined)
        {metrics.push(
          uiText(`${Math.round(frames)}帧`, `${Math.round(frames)} frames`),
        );}
      if (percentage !== undefined) metrics.push(`${percentage.toFixed(1)}%`);
      const frameRefs = readFrameRefs(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.frameRefs),
      );
      const omittedFrames = toNumber(
        readAliasedValue(item, CONTRACT_ALIASES.cluster.omittedFrames),
      );
      const frameRefText =
        frameRefs.length > 0
          ? uiText(
              `；帧: ${frameRefs.join(' / ')}`,
              `; frames: ${frameRefs.join(' / ')}`,
            )
          : '';
      const omittedHint =
        omittedFrames && omittedFrames > 0
          ? uiText(
              `（其余 ${Math.round(omittedFrames)} 帧省略）`,
              ` (${Math.round(omittedFrames)} additional frames omitted)`,
            )
          : '';
      lines.push(
        uiText(
          `- ${label}${metrics.length > 0 ? `（${metrics.join(', ')}）` : ''}${frameRefText}${omittedHint}`,
          `- ${label}${metrics.length > 0 ? ` (${metrics.join(', ')})` : ''}${frameRefText}${omittedHint}`,
        ),
      );
    });
  }
  lines.push('');

  lines.push(
    uiText(
      '## 证据链（对应上述结论）',
      '## Evidence chain (mapped to the conclusions above)',
    ),
  );
  if (evidenceChain.length === 0) {
    lines.push(
      uiText('- 证据链信息缺失', '- Evidence-chain information is missing'),
    );
  } else {
    evidenceChain.forEach((item, idx: number) => {
      const cid = toText(
        readAliasedValue(item, CONTRACT_ALIASES.evidence.conclusionId) ||
          `C${idx + 1}`,
      );
      const evidence = readAliasedValue(
        item,
        CONTRACT_ALIASES.evidence.evidence,
      );
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
            readAliasedValue(item, CONTRACT_ALIASES.evidence.data),
        );
        if (text) lines.push(`- ${cid}: ${text}`);
      }
    });
  }
  lines.push('');

  const claimsSection = renderConclusionClaimsSection(contractRecord, ctx);
  if (claimsSection) {
    lines.push(claimsSection);
    lines.push('');
  }

  lines.push(
    uiText('## 不确定性与反例', '## Uncertainties and counterexamples'),
  );
  if (uncertainties.length === 0) {
    lines.push(uiText('- 暂无', '- None'));
  } else {
    uncertainties.forEach((item: unknown) => {
      const text = toText(item);
      if (text) lines.push(`- ${text}`);
    });
  }
  lines.push('');

  lines.push(
    uiText(
      '## 下一步（最高信息增益）',
      '## Next steps (highest information gain)',
    ),
  );
  if (nextSteps.length === 0) {
    lines.push(uiText('- 暂无', '- None'));
  } else {
    nextSteps.forEach((item: unknown) => {
      const text = toText(item);
      if (text) lines.push(`- ${text}`);
    });
  }

  const metadataConfidence = readAliasedValue(
    metadata,
    CONTRACT_ALIASES.metadata.confidencePercent,
  );
  const metadataRounds = readAliasedValue(
    metadata,
    CONTRACT_ALIASES.metadata.rounds,
  );
  const confidence = toPercent(
    metadataConfidence ??
      readAliasedValue(contractRecord, CONTRACT_ALIASES.root.confidence),
  );
  const rounds = toNumber(
    metadataRounds ??
      readAliasedValue(contractRecord, CONTRACT_ALIASES.root.rounds),
  );
  if (confidence !== undefined || rounds !== undefined) {
    lines.push('');
    lines.push(uiText('## 分析元数据', '## Analysis metadata'));
    if (confidence !== undefined)
      {lines.push(
        uiText(
          `- 置信度: ${Math.round(confidence)}%`,
          `- Confidence: ${Math.round(confidence)}%`,
        ),
      );}
    if (rounds !== undefined)
      {lines.push(
        uiText(
          `- 分析轮次: ${Math.round(rounds)}`,
          `- Analysis rounds: ${Math.round(rounds)}`,
        ),
      );}
  }

  return lines.join('\n');
}

/**
 * Process analysis_completed event - final analysis result.
 */
function updateCurrentAnswerSourceEnrichment(
  ctx: SSEHandlerContext,
  update: Message['analysisSourceEnrichment'],
): void {
  const messageId = ctx.streamingAnswer.messageId;
  if (!messageId || !update) return;
  if (!ctx.getMessages().some((message) => message.id === messageId)) return;
  ctx.updateMessage(messageId, {analysisSourceEnrichment: update}, {persist: true});
}

export function handleAnalysisCompletedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const architecture = readStringField(eventRecord, 'architecture');
  const rawPayload = asRecord(eventRecord.data);
  if (rawPayload.sceneTimeline) ctx.onSceneTimelineReceived?.(rawPayload.sceneTimeline, true);
  const payload = toAnalysisCompletedPayload(eventRecord.data);
  const sourceEnrichmentPending = payload?.sourceEnrichmentPending === true;
  const rawConclusionContract = rawPayload.conclusionContract;
  const conclusionContract =
    payload?.conclusionContract ??
    (isRecord(rawConclusionContract) ? rawConclusionContract : undefined);
  const contractContent = renderConclusionContract(conclusionContract, ctx);
  if (payload) {
    payload.hasResultContent = Boolean(payload.answer || payload.conclusion || contractContent);
    payload.effectiveResultStatus = analysisCompletedResultStatus(payload, ctx.streamingFlow);
  }
  if (DEBUG_SSE) {
    console.log(
      '[SSEHandlers] analysis_completed received, architecture:',
      architecture || 'unknown',
    );
  }

  mergeConversationTimelineFromAnalysisCompleted(rawPayload, ctx);

  // Investigation coverage does not change the runtime's completion status or
  // the signed answer. Old results remain explicitly unassessed.
  if (payload?.hasResultContent) {
    const assurance = asRecord(rawPayload.deliveryAssurance);
    const label = (status: unknown): string => {
      switch (status) {
        case 'passed': return uiText('已核验', 'Checked');
        case 'not_applicable': return uiText('本轮不适用', 'Not applicable to this turn');
        case 'coverage_incomplete': return uiText('仍有必需维度缺失', 'Required dimensions remain incomplete');
        case 'unavailable': return uiText('核验不可用', 'Assessment unavailable');
        case 'failed': return uiText('未通过核验', 'Assessment failed');
        default: return uiText('尚未核验', 'Not checked');
      }
    };
    const notice = `${uiText('系统调查覆盖', 'System investigation coverage')}: ${label(assurance.investigation)}; ` +
      `${uiText('系统证据覆盖', 'System evidence coverage')}: ${label(assurance.investigationEvidence)}`;
    if (isConversationTimelineEnabled(ctx)) {
      if (!ctx.streamingFlow.conversationSteps.some(step => step.text === notice)) {
        pushConversationStep(ctx, 'result', 'agent', notice);
      }
    } else if (!ctx.streamingFlow.phases.includes(notice)) {
      pushStreamingPhase(ctx, notice);
    }
  }

  // Guard against duplicate conclusion handling — but still extract reportUrl
  // (agentv3 sends 'conclusion' first, then 'analysis_completed' carries reportUrl)
  if (ctx.completionHandled) {
    if (DEBUG_SSE) {
      console.log(
        '[SSEHandlers] Completion already handled, extracting reportUrl only',
      );
    }
    const reportUrl = payload?.reportUrl;
    const resultSnapshotId = payload?.resultSnapshotId;
    const canonicalConclusion = payload?.conclusion || payload?.answer;
    const canonicalContent = canonicalConclusion
      ? buildVisibleConclusionContentWithReportAppendix(
          canonicalConclusion,
          conclusionContract,
          ctx,
          resultSnapshotId,
          payload,
        )
      : undefined;
    const serverVerificationDetails = renderServerVerificationDetails(payload);
    const serverVerificationNotice = renderServerVerificationNotice(payload);
    if (
      reportUrl ||
      resultSnapshotId ||
      conclusionContract ||
      canonicalContent ||
      payload?.smartScenePreview ||
      payload?.quickRun ||
      payload?.analysisReceipt ||
      payload?.sourceUseReceipt ||
      payload?.uiActionProposals?.length ||
      serverVerificationDetails ||
      serverVerificationNotice
    ) {
      // Attach reportUrl to the existing answer/conclusion message. If the
      // final payload includes narrative text, treat it as canonical and
      // replace any earlier streamed placeholder tokens.
      const answerMsgId = ctx.streamingAnswer.messageId;
      if (answerMsgId) {
        const existing = ctx
          .getMessages()
          .find((msg) => msg.id === answerMsgId);
        const exactMetadataBackfill = !canonicalContent && sameServerVerificationBinding(
          existing?.serverVerificationBinding,
          payload?.serverVerificationBinding,
        );
        ctx.updateMessage(
          answerMsgId,
          {
            ...(reportUrl ? {reportUrl: `${ctx.backendUrl}${reportUrl}`} : {}),
            ...(payload?.smartScenePreview
              ? {smartScenePreview: payload.smartScenePreview}
              : {}),
            ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
            ...(payload?.analysisReceipt
              ? {analysisReceipt: payload.analysisReceipt}
              : {}),
            ...(payload?.sourceUseReceipt
              ? {sourceUseReceipt: payload.sourceUseReceipt}
              : {}),
            ...uiActionProposalMessageUpdate(payload),
            ...(canonicalContent
              ? {
                  content: canonicalContent,
                  serverVerificationDetails,
                  serverVerificationNotice,
                  serverVerificationBinding: payload?.serverVerificationBinding,
                }
              : existing
                ? {
                    content: buildVisibleConclusionContentWithReportAppendix(
                      existing.content,
                      conclusionContract,
                      ctx,
                      resultSnapshotId,
                      payload,
                    ),
                    ...(exactMetadataBackfill &&
                        (serverVerificationDetails || serverVerificationNotice)
                      ? {
                          serverVerificationDetails,
                          serverVerificationNotice,
                        }
                      : {}),
                  }
                : {}),
          },
          {persist: true},
        );
      } else {
        // Without an explicit current-run message identity, never attach
        // terminal metadata to an arbitrary prior assistant message.
        if (canonicalContent) {
          const messageId = ctx.generateId();
          ctx.addMessage({
            id: messageId,
            role: 'assistant',
            content: canonicalContent,
            serverVerificationDetails,
            serverVerificationNotice,
            serverVerificationBinding: payload?.serverVerificationBinding,
            timestamp: Date.now(),
            flowTag: 'answer_stream',
            ...(reportUrl ? {reportUrl: `${ctx.backendUrl}${reportUrl}`} : {}),
            ...(payload?.smartScenePreview
              ? {smartScenePreview: payload.smartScenePreview}
              : {}),
            ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
            ...(payload?.analysisReceipt
              ? {analysisReceipt: payload.analysisReceipt}
              : {}),
            ...(payload?.sourceUseReceipt
              ? {sourceUseReceipt: payload.sourceUseReceipt}
              : {}),
            ...uiActionProposalMessageUpdate(payload),
          });
          ctx.streamingAnswer.messageId = messageId;
          ctx.streamingAnswer.content = canonicalContent;
          ctx.streamingAnswer.pending = '';
          ctx.streamingAnswer.status = 'completed';
        } else {
          // Preserve the legacy report-metadata backfill, but never put a
          // source-use receipt on a message without a current-run identity.
          const messages = ctx.getMessages();
          for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i];
            if (
              message.role !== 'assistant' ||
              message.flowTag === 'streaming_flow' ||
              message.sqlResult ||
              message.content.trim().length === 0
            ) {
              continue;
            }
            ctx.updateMessage(message.id, {
              ...(reportUrl && !message.reportUrl
                ? {reportUrl: `${ctx.backendUrl}${reportUrl}`}
                : {}),
              ...(payload?.smartScenePreview
                ? {smartScenePreview: payload.smartScenePreview}
                : {}),
              ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
              ...(payload?.analysisReceipt
                ? {analysisReceipt: payload.analysisReceipt}
                : {}),
              ...uiActionProposalMessageUpdate(payload),
            }, {persist: true});
            break;
          }
        }
      }
    } else if (payload?.reportError) {
      console.warn(
        '[SSEHandlers] HTML report generation failed:',
        payload.reportError,
      );
    }
    if (sourceEnrichmentPending) {
      updateCurrentAnswerSourceEnrichment(ctx, {status: 'running'});
    }
    settleAnalysisCompletedStreams(ctx, payload);
    return {isTerminal: !sourceEnrichmentPending, stopLoading: true};
  }

  // Support both 'answer' (legacy) and 'conclusion' (agent-driven),
  // and fall back to structured conclusionContract when narrative text is absent.
  const narrativeContent = payload?.answer || payload?.conclusion;
  const answerContent = narrativeContent || contractContent;

  if (answerContent) {
    ctx.setCompletionHandled(true);
    // Keep the in-flight context object consistent as well (unit tests and
    // any caller that reuses the same context instance for multiple events).
    ctx.completionHandled = true;
    pushStreamingOutput(
      ctx,
      analysisCompletedResultStatus(payload) === 'completed'
        ? uiText('最终结论已生成', 'Final conclusion generated')
        : uiText('本轮输出已保留，完整性与核验状态见提示', 'Run output retained; see completeness and verification notices'),
    );

    // Build content with agent-driven metadata if available
    const content = buildVisibleConclusionContentWithReportAppendix(
      answerContent,
      conclusionContract,
      ctx,
      payload?.resultSnapshotId,
      payload,
    );
    const serverVerificationDetails = renderServerVerificationDetails(payload);
    const serverVerificationNotice = renderServerVerificationNotice(payload);

    const reportUrl = payload?.reportUrl;
    if (!reportUrl && payload?.reportError) {
      console.warn(
        '[SSEHandlers] HTML report generation failed:',
        payload.reportError,
      );
    }

    const streamedAnswerMessageId = ctx.streamingAnswer.messageId;
    const hasStreamedAnswer = Boolean(
      streamedAnswerMessageId &&
        ctx
          .getMessages()
          .some(
            (m) =>
              m.id === streamedAnswerMessageId &&
              String(m.content || '').trim().length > 0,
          ),
    );

    if (hasStreamedAnswer && streamedAnswerMessageId) {
      completeStreamingAnswer(ctx);
      ctx.streamingAnswer.content = content;
      ctx.streamingAnswer.pending = '';
      ctx.streamingAnswer.status = 'completed';
      ctx.updateMessage(
        streamedAnswerMessageId,
        {
          content,
          serverVerificationDetails,
          serverVerificationNotice,
          serverVerificationBinding: payload?.serverVerificationBinding,
          timestamp: Date.now(),
          reportUrl: reportUrl ? `${ctx.backendUrl}${reportUrl}` : undefined,
          flowTag: 'answer_stream',
          ...(payload?.smartScenePreview
            ? {smartScenePreview: payload.smartScenePreview}
            : {}),
          ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
          ...(payload?.analysisReceipt
            ? {analysisReceipt: payload.analysisReceipt}
            : {}),
          ...(payload?.sourceUseReceipt
            ? {sourceUseReceipt: payload.sourceUseReceipt}
            : {}),
          ...uiActionProposalMessageUpdate(payload),
        },
        {persist: true},
      );
    } else {
      const messageId = ctx.generateId();
      ctx.addMessage({
          id: messageId,
          role: 'assistant',
          content: content,
          serverVerificationDetails,
          serverVerificationNotice,
          serverVerificationBinding: payload?.serverVerificationBinding,
          timestamp: Date.now(),
          flowTag: 'answer_stream',
          reportUrl: reportUrl ? `${ctx.backendUrl}${reportUrl}` : undefined,
          ...(payload?.smartScenePreview
            ? {smartScenePreview: payload.smartScenePreview}
            : {}),
          ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
          ...(payload?.analysisReceipt
            ? {analysisReceipt: payload.analysisReceipt}
            : {}),
          ...(payload?.sourceUseReceipt
            ? {sourceUseReceipt: payload.sourceUseReceipt}
            : {}),
          ...uiActionProposalMessageUpdate(payload),
      });
      ctx.streamingAnswer.messageId = messageId;
      ctx.streamingAnswer.content = content;
      ctx.streamingAnswer.pending = '';
      ctx.streamingAnswer.status = 'completed';
    }
  }

  // When conclusion is empty (e.g. timeout) but answer was streamed,
  // still attach the reportUrl to the streamed answer message.
  if (!answerContent) {
    const reportUrl = payload?.reportUrl;
    const streamedAnswerMessageId = ctx.streamingAnswer.messageId;
    const serverVerificationDetails = renderServerVerificationDetails(payload);
    const serverVerificationNotice = renderServerVerificationNotice(payload);
    if (
      (reportUrl ||
        payload?.quickRun ||
        payload?.analysisReceipt ||
        payload?.sourceUseReceipt ||
        payload?.uiActionProposals?.length ||
        serverVerificationDetails ||
        serverVerificationNotice) &&
      streamedAnswerMessageId
    ) {
      const streamedMsg = ctx
        .getMessages()
        .find(
          (m) =>
            m.id === streamedAnswerMessageId &&
            String(m.content || '').trim().length > 0,
        );
      if (streamedMsg) {
        completeStreamingAnswer(ctx);
        const exactMetadataBackfill = sameServerVerificationBinding(
          streamedMsg.serverVerificationBinding,
          payload?.serverVerificationBinding,
        );
        ctx.updateMessage(
          streamedAnswerMessageId,
          {
            ...(reportUrl ? {reportUrl: `${ctx.backendUrl}${reportUrl}`} : {}),
            ...(payload?.quickRun ? {quickRun: payload.quickRun} : {}),
            ...(payload?.analysisReceipt
              ? {analysisReceipt: payload.analysisReceipt}
              : {}),
            ...(payload?.sourceUseReceipt
              ? {sourceUseReceipt: payload.sourceUseReceipt}
              : {}),
            ...(exactMetadataBackfill &&
                (serverVerificationDetails || serverVerificationNotice)
              ? {serverVerificationDetails, serverVerificationNotice}
              : {}),
            ...uiActionProposalMessageUpdate(payload),
          },
          {persist: true},
        );
      }
    }
  }

  // Show error summary if there were any non-fatal errors
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  if (ctx.streamingAnswer.status === 'streaming') {
    completeStreamingAnswer(ctx);
  }

  if (sourceEnrichmentPending) {
    updateCurrentAnswerSourceEnrichment(ctx, {status: 'running'});
  }
  settleAnalysisCompletedStreams(ctx, payload);
  return {isTerminal: !sourceEnrichmentPending, stopLoading: true};
}

export function handleAnalysisSourceEnrichmentEvent(
  eventType: string,
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = asRecord(eventRecord.data ?? eventRecord);
  if (eventType === 'analysis_source_enrichment_started') {
    updateCurrentAnswerSourceEnrichment(ctx, {status: 'running'});
    return {};
  }
  if (eventType === 'analysis_source_enrichment_completed') {
    const message = readStringField(payload, 'message');
    const metrics = asRecord(payload.metrics);
    updateCurrentAnswerSourceEnrichment(ctx, {
      status: 'completed',
      message,
      metrics: {
        searchCalls: readNumberField(metrics, 'searchCalls'),
        readCalls: readNumberField(metrics, 'readCalls'),
        durationMs: readNumberField(metrics, 'durationMs'),
      },
    });
    return {isTerminal: true, stopLoading: true};
  }
  if (eventType === 'analysis_source_enrichment_failed') {
    updateCurrentAnswerSourceEnrichment(ctx, {
      status: 'failed',
      errorCode: readStringField(payload, 'errorCode', 'analysis_source_enrichment_failed'),
    });
    return {isTerminal: true, stopLoading: true};
  }
  updateCurrentAnswerSourceEnrichment(ctx, {status: 'cancelled'});
  return {isTerminal: true, stopLoading: true};
}

export function handleAnalysisCancelledEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = asRecord(eventRecord.data ?? eventRecord);
  const reason =
    readStringField(payload, 'reason') ||
    readStringField(eventRecord, 'reason');

  cancelStreamingFlow(ctx);
  if (ctx.streamingAnswer.status === 'streaming') {
    completeStreamingAnswer(ctx);
  }

  const isDefaultUserCancellation =
    reason === 'Analysis cancelled by user' || reason === 'Aborted by user';
  const message =
    reason && !isDefaultUserCancellation
      ? uiText(`分析已取消：${reason}`, `Analysis cancelled: ${reason}`)
      : uiText('分析已取消。', 'Analysis cancelled.');
  const lastMessage = ctx.getMessages()[ctx.getMessages().length - 1];
  if (
    !lastMessage ||
    lastMessage.role !== 'assistant' ||
    lastMessage.content !== message
  ) {
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: message,
      timestamp: Date.now(),
    });
  }

  return {isTerminal: true, stopLoading: true};
}

export function handleDegradedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = toDegradedPayload(
    eventRecord.data ?? eventRecord.content ?? eventRecord,
  );
  const message =
    payload.message ||
    payload.terminationReason ||
    payload.fallback ||
    payload.code ||
    uiText(
      '本次分析结果已标记为 partial，结论可能不完整。',
      'This analysis is marked partial, so the conclusion may be incomplete.',
    );
  pushStreamingPhase(
    ctx,
    uiText(
      `结果完整性提示: ${message}`,
      `Result completeness notice: ${message}`,
    ),
  );
  return {
    loadingPhase: uiText(
      '结果已标记为部分完成',
      'Result marked partially complete',
    ),
  };
}

/**
 * Process hypothesis_generated event - initial hypotheses from AI.
 */
export function handleHypothesisGeneratedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const hypotheses = readStringArrayField(payload, 'hypotheses');
  if (hypotheses.length > 0) {
    const evidenceBased = readBooleanField(payload, 'evidenceBased', false);
    const evidenceSummary = readStringArrayField(payload, 'evidenceSummary');
    pushStreamingThought(
      ctx,
      uiText(
        `形成 ${hypotheses.length} 个待验证假设`,
        `Formed ${hypotheses.length} hypotheses to verify`,
      ),
    );
    for (const hypothesis of hypotheses.slice(0, 3)) {
      pushStreamingThought(ctx, hypothesis);
    }

    let content = '';
    if (evidenceBased) {
      content += uiText(
        `### 🧪 基于证据形成了 ${hypotheses.length} 个待验证假设\n`,
        `### 🧪 Formed ${hypotheses.length} evidence-based hypotheses to verify\n`,
      );
      if (evidenceSummary.length > 0) {
        content += uiText(
          '\n**首轮证据摘要**\n',
          '\n**Initial evidence summary**\n',
        );
        for (const item of evidenceSummary) {
          content += `- ${item}\n`;
        }
      }
      content += uiText('\n**待验证假设**\n', '\n**Hypotheses to verify**\n');
      for (let i = 0; i < hypotheses.length; i++) {
        const h = hypotheses[i];
        content += `${i + 1}. ${h}\n`;
      }
      content += uiText(
        '\n_下一步将继续验证并收敛假设。_',
        '\n_Next, the analysis will verify and narrow these hypotheses._',
      );
    } else {
      content += uiText(
        `### 🧪 生成了 ${hypotheses.length} 个分析假设\n`,
        `### 🧪 Generated ${hypotheses.length} analysis hypotheses\n`,
      );
      for (let i = 0; i < hypotheses.length; i++) {
        const h = hypotheses[i];
        content += `${i + 1}. ${h}\n`;
      }
      content += uiText(
        '\n_AI 将验证这些假设..._',
        '\n_AI will verify these hypotheses..._',
      );
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const round = readNumberField(payload, 'round', 1);
    const maxRounds = readNumberField(payload, 'maxRounds', 5);
    const message =
      readStringField(payload, 'message') ||
      uiText(`分析轮次 ${round}`, `Analysis round ${round}`);
    pushStreamingPhase(ctx, `${message} (${round}/${maxRounds})`);

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: `⏳ 🔄 ${message} (${round}/${maxRounds})`,
      timestamp: Date.now(),
      flowTag: 'progress_note',
    });
  }
  return {};
}

/**
 * Process agent_task_dispatched event - tasks sent to domain agents.
 */
export function handleAgentTaskDispatchedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const taskCount = readNumberField(payload, 'taskCount', 0);
    const agents = readStringArrayField(payload, 'agents');
    const message =
      readStringField(payload, 'message') ||
      uiText(`派发 ${taskCount} 个任务`, `Dispatch ${taskCount} tasks`);
    const agentText = agents.length > 0 ? ` -> ${agents.join(', ')}` : '';
    pushStreamingTool(ctx, `${message}${agentText}`);

    let content = `⏳ 🤖 ${message}`;
    if (agents.length > 0) {
      content += uiText(
        `\n\n派发给: ${agents.map((a: string) => `\`${a}\``).join(', ')}`,
        `\n\nDispatched to: ${agents.map((a: string) => `\`${a}\``).join(', ')}`,
      );
    }

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
      flowTag: 'progress_note',
    });
  }
  return {};
}

/**
 * Process synthesis_complete event - feedback synthesis complete.
 */
export function handleSynthesisCompleteEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const confirmedFindings = readNumberField(payload, 'confirmedFindings', 0);
    const updatedHypotheses = readNumberField(payload, 'updatedHypotheses', 0);
    const message =
      readStringField(payload, 'message') ||
      uiText('综合分析结果', 'Synthesize analysis results');
    pushStreamingPhase(ctx, message);
    pushStreamingOutput(
      ctx,
      uiText(
        `确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`,
        `Confirmed ${confirmedFindings} findings and updated ${updatedHypotheses} hypotheses`,
      ),
    );

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: uiText(
        `⏳ 📝 ${message}\n\n确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`,
        `⏳ 📝 ${message}\n\nConfirmed ${confirmedFindings} findings and updated ${updatedHypotheses} hypotheses`,
      ),
      timestamp: Date.now(),
      flowTag: 'progress_note',
    });
  }
  return {};
}

/**
 * Process strategy_decision event - next iteration strategy decided.
 */
export function handleStrategyDecisionEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  if (Object.keys(payload).length > 0) {
    const strategy = readStringField(payload, 'strategy') || 'continue';
    const confidence = readNumberField(payload, 'confidence', 0);
    const message =
      readStringField(payload, 'message') ||
      uiText(`策略: ${strategy}`, `Strategy: ${strategy}`);
    pushStreamingPhase(
      ctx,
      uiText(
        `${message} (置信度 ${(confidence * 100).toFixed(0)}%)`,
        `${message} (confidence ${(confidence * 100).toFixed(0)}%)`,
      ),
    );

    const strategyEmoji =
      strategy === 'conclude'
        ? '✅'
        : strategy === 'deep_dive'
          ? '🔍'
          : strategy === 'pivot'
            ? '↩️'
            : '➡️';

    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: uiText(
        `⏳ ${strategyEmoji} ${message} (置信度: ${(confidence * 100).toFixed(0)}%)`,
        `⏳ ${strategyEmoji} ${message} (confidence: ${(confidence * 100).toFixed(0)}%)`,
      ),
      timestamp: Date.now(),
      flowTag: 'progress_note',
    });
  }
  return {};
}

/**
 * Process data event - v2.0 DataEnvelope format.
 */
export function handleDataEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  if (Object.keys(eventRecord).length === 0) return {};

  if (DEBUG_SSE) {
    console.log(
      '[SSEHandlers] v2.0 data event received:',
      eventRecord.id,
      eventRecord.envelope,
    );
  }

  const rawEnvelope = eventRecord.envelope;
  const envelopeCandidates = Array.isArray(rawEnvelope)
    ? rawEnvelope
    : rawEnvelope
      ? [rawEnvelope]
      : [];

  for (let i = 0; i < envelopeCandidates.length; i++) {
    const candidate = envelopeCandidates[i];
    if (!isDataEnvelope(candidate)) {
      console.warn('[SSEHandlers] Invalid DataEnvelope:', candidate);
      continue;
    }

    const envelope = candidate;
    const deduplicationKey = dataEnvelopeDeduplicationKey(
      envelope,
      readStringField(eventRecord, 'id'),
      i,
    );

    if (ctx.displayedSkillProgress.has(deduplicationKey)) {
      if (DEBUG_SSE) {
        console.log(
          '[SSEHandlers] Skipping duplicate data envelope:',
          deduplicationKey,
        );
      }
      continue;
    }
    ctx.displayedSkillProgress.add(deduplicationKey);
    pushStreamingOutput(ctx, describeEnvelopeOutput(envelope));

    renderDataEnvelope(envelope, ctx);

    // Trigger track overlay when overlay-eligible data arrives
    if (
      envelope.meta.stepId &&
      !envelope.display.preview &&
      envelope.data.columns?.length &&
      envelope.data.rows?.length &&
      ctx.onOverlayDataReceived
    ) {
      const overlayId = STEP_TO_OVERLAY.get(envelope.meta.stepId);
      if (overlayId) {
        ctx.onOverlayDataReceived(
          overlayId,
          envelope.data.columns,
          envelope.data.rows,
        );
      }
    }
  }

  return {};
}

/**
 * Render a DataEnvelope based on its display format.
 */
function renderDataEnvelope(
  envelope: DataEnvelope,
  ctx: SSEHandlerContext,
): void {
  const format = envelope.display.format || 'table';
  const payload = envelope.data;
  const title = envelope.display.title;
  const envelopeRecord = asRecord(envelope);
  const sql = readStringField(envelopeRecord, 'sql');

  switch (format) {
    case 'text':
      if (payload.text) {
        const isDiagnostic = envelope.meta.type === 'diagnostic';
        const sourceContext = registerEnvelopeSourceContext(
          ctx,
          envelope,
          title,
          {
            kind: isDiagnostic ? 'diagnostic' : 'text',
          },
        );
        const notice = isDiagnostic
          ? uiText(
              '> 这是失败诊断，不是可引用的数据表或性能证据。需要修正 SQL/工具参数后重试。',
              '> This is a failure diagnostic, not a citable data table or performance evidence. Correct the SQL or tool parameters and retry.',
            )
          : '';
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: [`**${title}**`, notice, String(payload.text)]
            .filter(Boolean)
            .join('\n\n'),
          timestamp: Date.now(),
          sourceContext,
        });
      }
      break;

    case 'summary':
      if (payload.summary) {
        const sourceContext = registerEnvelopeSourceContext(
          ctx,
          envelope,
          payload.summary.title || title,
          {
            kind: 'summary',
          },
        );
        const sections: string[] = [`## 📊 ${payload.summary.title || title}`];

        const normalizedBody = normalizeMarkdownSpacing(
          String(payload.summary.content || ''),
        );
        if (normalizedBody) {
          sections.push(normalizedBody);
        }

        if (payload.summary.metrics && payload.summary.metrics.length > 0) {
          const metricLines: string[] = [
            uiText('### 关键指标', '### Key metrics'),
          ];
          for (const metric of payload.summary.metrics) {
            const icon =
              metric.severity === 'critical'
                ? '🔴'
                : metric.severity === 'warning'
                  ? '🟡'
                  : '🟢';
            const unit = metric.unit || '';
            metricLines.push(
              `${icon} **${metric.label}:** ${metric.value}${unit}`,
            );
          }
          sections.push(metricLines.join('\n'));
        }

        const summaryContent = sections.join('\n\n');

        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: summaryContent,
          timestamp: Date.now(),
          sourceContext,
        });
      }
      break;

    case 'metric':
      if (payload.summary && payload.summary.metrics) {
        const sourceContext = registerEnvelopeSourceContext(
          ctx,
          envelope,
          title,
          {
            kind: 'metric',
          },
        );
        let metricContent = `### 📈 ${title}\n\n`;
        for (const metric of payload.summary.metrics) {
          const icon =
            metric.severity === 'critical'
              ? '🔴'
              : metric.severity === 'warning'
                ? '🟡'
                : '🟢';
          const unit = metric.unit || '';
          metricContent += `| ${icon} ${metric.label} | **${metric.value}${unit}** |\n`;
        }
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: metricContent,
          timestamp: Date.now(),
          sourceContext,
        });
      }
      break;

    case 'chart':
      if (payload.chart) {
        const chartConfig = asRecord(payload.chart);
        const chartColumns = Array.isArray(chartConfig.columns)
          ? chartConfig.columns
          : [];
        const chartRows = Array.isArray(chartConfig.rows)
          ? chartConfig.rows
          : [];
        const chartData = Array.isArray(chartConfig.data)
          ? chartConfig.data
          : [];
        const sourceContext = registerEnvelopeSourceContext(
          ctx,
          envelope,
          title,
          {
            kind: 'chart',
            rowCount:
              chartRows.length > 0
                ? chartRows.length
                : chartData.length || undefined,
            columns: chartColumns.map((column) => String(column)),
          },
        );

        if (chartColumns.length > 0 && chartRows.length > 0) {
          // Render chart data as a markdown table
          const header = chartColumns.map(String).join(' | ');
          const separator = chartColumns.map(() => '---').join(' | ');
          const rowLines = chartRows
            .slice(0, 10)
            .map((r: unknown) =>
              Array.isArray(r) ? r.map(String).join(' | ') : String(r),
            )
            .join(' |\n| ');
          const chartContent = `### \uD83D\uDCC9 ${title}\n\n| ${header} |\n| ${separator} |\n| ${rowLines} |`;
          ctx.addMessage({
            id: ctx.generateId(),
            role: 'assistant',
            content: chartContent,
            timestamp: Date.now(),
            sourceContext,
          });
        } else if (chartData.length > 0) {
          // Try to render from data array (objects with label/value)
          const firstItem = asRecord(chartData[0]);
          const dataKeys = Object.keys(firstItem);
          if (dataKeys.length > 0) {
            const header = dataKeys.join(' | ');
            const separator = dataKeys.map(() => '---').join(' | ');
            const rowLines = chartData
              .slice(0, 10)
              .map((item: unknown) => {
                const rec = asRecord(item);
                return dataKeys.map((k) => String(rec[k] ?? '')).join(' | ');
              })
              .join(' |\n| ');
            const chartContent = `### \uD83D\uDCC9 ${title}\n\n| ${header} |\n| ${separator} |\n| ${rowLines} |`;
            ctx.addMessage({
              id: ctx.generateId(),
              role: 'assistant',
              content: chartContent,
              timestamp: Date.now(),
              sourceContext,
            });
          } else {
            ctx.addMessage({
              id: ctx.generateId(),
              role: 'assistant',
              content: uiText(
                `### 📉 ${title}\n\n*[图表数据已记录，但数据不是可表格化的对象数组]*`,
                `### 📉 ${title}\n\n*[Chart data was recorded, but it is not an array of objects that can be rendered as a table]*`,
              ),
              timestamp: Date.now(),
              sourceContext,
            });
          }
        } else {
          let chartContent = `### 📉 ${title}\n\n`;
          chartContent += uiText(
            `**图表类型:** ${readStringField(chartConfig, 'type', 'unknown')}\n\n`,
            `**Chart type:** ${readStringField(chartConfig, 'type', 'unknown')}\n\n`,
          );
          chartContent += uiText(
            '*[图表渲染暂未实现，数据已记录]*\n',
            '*[Chart rendering is not implemented yet; data was recorded]*\n',
          );
          if (DEBUG_SSE) {
            console.log(
              '[SSEHandlers] Chart data received but no renderable data:',
              chartConfig,
            );
          }
          ctx.addMessage({
            id: ctx.generateId(),
            role: 'assistant',
            content: chartContent,
            timestamp: Date.now(),
            sourceContext,
          });
        }
      }
      break;

    case 'timeline':
      const timelineSourceContext = registerEnvelopeSourceContext(
        ctx,
        envelope,
        title,
        {
          kind: 'timeline',
        },
      );
      ctx.addMessage({
        id: ctx.generateId(),
        role: 'assistant',
        content: uiText(
          `### ⏱️ ${title}\n\n*[时间线渲染暂未实现]*\n`,
          `### ⏱️ ${title}\n\n*[Timeline rendering is not implemented yet]*\n`,
        ),
        timestamp: Date.now(),
        sourceContext: timelineSourceContext,
      });
      break;

    case 'table':
    default:
      const rawResult = envelopeToSqlQueryResult(envelope);
      let filteredColumns = rawResult.columns;
      let filteredRows = rawResult.rows;
      let filteredColumnDefs = rawResult.columnDefinitions;

      if (
        rawResult.columnDefinitions &&
        Array.isArray(rawResult.columnDefinitions)
      ) {
        const hiddenFromDefs = rawResult.columnDefinitions
          .filter((c) => c.hidden === true)
          .map((c) => c.name);
        const metadataFields = envelope.display.metadataFields || [];
        const columnsToHide = new Set([...hiddenFromDefs, ...metadataFields]);

        if (columnsToHide.size > 0 && rawResult.columns.length > 0) {
          const visibleIndices: number[] = [];
          filteredColumns = rawResult.columns.filter(
            (col: string, idx: number) => {
              if (!columnsToHide.has(col)) {
                visibleIndices.push(idx);
                return true;
              }
              return false;
            },
          );

          filteredRows = rawResult.rows.map((row) =>
            visibleIndices.map((idx) => row[idx]),
          );

          filteredColumnDefs = rawResult.columnDefinitions.filter(
            (def) => !columnsToHide.has(def.name),
          );
        }
      }

      if (filteredColumns.length > 0 || filteredRows.length === 0) {
        const sourceContext = registerEnvelopeSourceContext(
          ctx,
          envelope,
          title,
          {
            kind: 'table',
            rowCount: rawResult.rowCount,
            columns: filteredColumns,
            query: sql,
          },
        );
        ctx.addMessage({
          id: ctx.generateId(),
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
          sqlResult: {
            columns: filteredColumns,
            rows: filteredRows,
            rowCount: rawResult.rowCount,
            preview: rawResult.preview,
            query: sql || undefined,
            hideQuery: Boolean(sql),
            columnDefinitions: filteredColumnDefs,
            sectionTitle: sourceContext.title || title,
            group: envelope.display.group,
            collapsible: envelope.display.collapsible,
            defaultCollapsed: envelope.display.defaultCollapsed,
            maxVisibleRows: envelope.display.maxVisibleRows,
            queryReview: rawResult.queryReview,
            expandableData: rawResult.expandableData, // 【修复】传递 expandableData 用于行展开功能
            sourceContext,
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
  ctx: SSEHandlerContext,
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
    if (DEBUG_SSE) {
      console.log('[SSEHandlers] Skill error collected:', errorInfo);
    }
    ctx.collectedErrors.push(errorInfo);
    pushStreamingOutput(
      ctx,
      uiText(
        `步骤错误: ${errorInfo.skillId}${errorInfo.stepId ? `/${errorInfo.stepId}` : ''}`,
        `Step error: ${errorInfo.skillId}${errorInfo.stepId ? `/${errorInfo.stepId}` : ''}`,
      ),
    );
  }
  return {};
}

/**
 * Process error event - fatal error occurred.
 */
export function handleErrorEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  failStreamingAnswer(ctx);

  const payload = eventPayload(data);
  const error =
    readStringField(payload, 'error') || readStringField(payload, 'message');

  if (error) {
    failStreamingFlow(ctx, error);
    ctx.addMessage({
      id: ctx.generateId(),
      role: 'assistant',
      content: uiText(`**错误:** ${error}`, `**Error:** ${error}`),
      timestamp: Date.now(),
    });
  } else {
    failStreamingFlow(ctx, uiText('分析失败', 'Analysis failed'));
  }

  // Show collected errors summary if any
  if (ctx.collectedErrors.length > 0) {
    showErrorSummary(ctx);
  }

  return {isTerminal: true, stopLoading: true};
}

/**
 * Show a summary of all collected errors from the analysis.
 */
function showErrorSummary(ctx: SSEHandlerContext): void {
  if (ctx.collectedErrors.length === 0) return;

  // Group errors by skillId
  const errorsBySkill = new Map<
    string,
    Array<{stepId?: string; error: string}>
  >();
  for (const err of ctx.collectedErrors) {
    if (!errorsBySkill.has(err.skillId)) {
      errorsBySkill.set(err.skillId, []);
    }
    errorsBySkill
      .get(err.skillId)!
      .push({stepId: err.stepId, error: err.error});
  }

  let summaryContent = uiText(
    `### ⚠️ 分析过程中遇到 ${ctx.collectedErrors.length} 个错误\n\n`,
    `### ⚠️ The analysis encountered ${ctx.collectedErrors.length} errors\n\n`,
  );

  for (const [skillId, errors] of errorsBySkill) {
    summaryContent += `**Skill: ${skillId}**\n`;
    for (const err of errors) {
      const stepInfo = err.stepId ? ` (step: ${err.stepId})` : '';
      summaryContent += `- ${err.error}${stepInfo}\n`;
    }
    summaryContent += '\n';
  }

  summaryContent += uiText(
    '\n*这些错误不影响其他分析结果的展示，但可能导致部分数据缺失。*',
    '\n*These errors do not prevent other results from being displayed, but some data may be missing.*',
  );

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
// Agent-Driven Architecture v2.0 - Circuit Breaker Event Handler
// =============================================================================

/**
 * Process circuit_breaker event as a non-blocking status update.
 */
export function handleCircuitBreakerEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const breakerData = eventPayload(data);
  if (DEBUG_SSE) {
    console.log('[SSEHandlers] circuit_breaker received:', breakerData);
  }

  const reason = readStringField(
    breakerData,
    'reason',
    uiText('分析保护机制已触发', 'Analysis guardrail triggered'),
  );
  const agentId = readStringField(breakerData, 'agentId', 'agent');

  pushStreamingPhase(
    ctx,
    uiText(
      `保护机制触发: ${reason}`,
      `Analysis guardrail triggered: ${reason}`,
    ),
  );
  ctx.addMessage({
    id: ctx.generateId(),
    role: 'system',
    content: uiText(
      `⚠️ **分析保护机制触发**\n\n${reason}\n\n_来源: ${agentId}_`,
      `⚠️ **Analysis guardrail triggered**\n\n${reason}\n\n_Source: ${agentId}_`,
    ),
    timestamp: Date.now(),
    flowTag: 'progress_note',
  });

  return {};
}

/**
 * Process strategy_selected event - strategy was matched.
 */
export function handleStrategySelectedEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const strategyData = eventPayload(data);
  if (DEBUG_SSE) {
    console.log('[SSEHandlers] strategy_selected received:', strategyData);
  }

  if (Object.keys(strategyData).length === 0) return {};

  const selectionMethod = readStringField(
    strategyData,
    'selectionMethod',
    'keyword',
  );
  const strategyName = readStringField(strategyData, 'strategyName', 'unknown');
  const confidencePercent = Math.round(
    readNumberField(strategyData, 'confidence', 0) * 100,
  );
  const reasoning = readStringField(
    strategyData,
    'reasoning',
    uiText('开始执行分析流水线...', 'Starting the analysis pipeline...'),
  );
  const methodEmoji = selectionMethod === 'llm' ? '🧠' : '🔑';
  pushStreamingPhase(
    ctx,
    uiText(
      `选择策略 ${strategyName} (${confidencePercent}%, ${selectionMethod})`,
      `Selected strategy ${strategyName} (${confidencePercent}%, ${selectionMethod})`,
    ),
  );

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: uiText(
      `⏳ ${methodEmoji} 选择策略: **${strategyName}** (${confidencePercent}%)\n\n_${reasoning}_`,
      `⏳ ${methodEmoji} Selected strategy: **${strategyName}** (${confidencePercent}%)\n\n_${reasoning}_`,
    ),
    timestamp: Date.now(),
    flowTag: 'progress_note',
  });

  return {};
}

/**
 * Process strategy_fallback event - no strategy matched, using hypothesis-driven.
 */
export function handleStrategyFallbackEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const fallbackData = eventPayload(data);
  if (DEBUG_SSE) {
    console.log('[SSEHandlers] strategy_fallback received:', fallbackData);
  }

  if (Object.keys(fallbackData).length === 0) return {};
  const reason = readStringField(
    fallbackData,
    'reason',
    uiText('未命中预设策略', 'No predefined strategy matched'),
  );
  pushStreamingPhase(
    ctx,
    uiText(
      `回退到假设驱动分析: ${reason}`,
      `Falling back to hypothesis-driven analysis: ${reason}`,
    ),
  );

  ctx.addMessage({
    id: ctx.generateId(),
    role: 'assistant',
    content: uiText(
      `⏳ 🔄 使用假设驱动分析\n\n_${reason || '未匹配到预设策略，启动自适应分析...'}_`,
      `⏳ 🔄 Using hypothesis-driven analysis\n\n_${reason || 'No predefined strategy matched; starting adaptive analysis...'}_`,
    ),
    timestamp: Date.now(),
    flowTag: 'progress_note',
  });

  return {};
}

/**
 * Process focus_updated event - user focus tracking updated.
 */
export function handleFocusUpdatedEvent(
  data: RawSSEEvent,
  _ctx: SSEHandlerContext,
): SSEHandlerResult {
  // Focus updates are typically silent - just log for debugging
  if (DEBUG_SSE) {
    console.log('[SSEHandlers] focus_updated:', eventPayload(data));
  }
  return {};
}

/**
 * Process thought / worker_thought event - progressive reasoning output.
 */
export function handleThoughtEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
  source: 'assistant' | 'worker',
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = eventPayload(data);
  const content = normalizeFlowLine(
    readStringField(payload, 'thought') ||
      readStringField(payload, 'content') ||
      readStringField(payload, 'message') ||
      readStringField(eventRecord, 'thought') ||
      readStringField(eventRecord, 'content') ||
      readStringField(eventRecord, 'message'),
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const task = asRecord(payload.task);
  const phase = normalizeFlowLine(
    payload.phase || payload.type || 'task_dispatched',
  );
  const agentId = normalizeFlowLine(
    payload.agentId || payload.agent || 'agent',
  );
  const taskId = normalizeFlowLine(payload.taskId || payload.task_id || '');
  const title = normalizeFlowLine(
    payload.taskTitle ||
      task.title ||
      task.description ||
      payload.message ||
      '',
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const response = asRecord(payload.response);
  const agentId = normalizeFlowLine(
    payload.agentId || payload.agent || 'agent',
  );
  const taskId = normalizeFlowLine(payload.taskId || payload.task_id || '');
  const summary = normalizeFlowLine(
    payload.message ||
      payload.summary ||
      response.summary ||
      response.conclusion ||
      uiText('任务完成', 'Task completed'),
  );

  const taskSuffix = taskId ? ` (#${taskId})` : '';
  pushStreamingTool(
    ctx,
    uiText(
      `${agentId} 完成任务${taskSuffix}`,
      `${agentId} completed task${taskSuffix}`,
    ),
  );
  pushStreamingOutput(ctx, `${agentId}: ${summary}`);
  return {};
}

/**
 * Process tool_call event - generic tool/task lifecycle updates.
 */
export function handleToolCallEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const phase = normalizeFlowLine(
    readStringField(payload, 'phase', 'task_dispatched'),
  ).toLowerCase();
  const isCompletedPhase =
    phase.includes('completed') ||
    phase.includes('done') ||
    phase.includes('finished');
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const findingsRaw = Array.isArray(payload.findings) ? payload.findings : [];
  if (findingsRaw.length === 0) return {};

  pushStreamingOutput(
    ctx,
    uiText(
      `新增发现 ${findingsRaw.length} 条`,
      `${findingsRaw.length} new findings`,
    ),
  );
  for (const item of findingsRaw.slice(0, 2)) {
    const finding = asRecord(item);
    const title = normalizeFlowLine(
      readStringField(finding, 'title') ||
        readStringField(finding, 'description'),
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const stageName = normalizeFlowLine(readStringField(payload, 'stageName'));
  const stageIndex = readNumberField(payload, 'stageIndex', -1);
  const totalStages = readNumberField(payload, 'totalStages', 0);
  const skipped = readBooleanField(payload, 'skipped', false);
  const skipReason = normalizeFlowLine(readStringField(payload, 'skipReason'));

  if (!stageName && stageIndex < 0) return {};

  const stageSeq =
    stageIndex >= 0 && totalStages > 0
      ? ` (${stageIndex + 1}/${totalStages})`
      : '';
  const label = skipped
    ? uiText('跳过阶段', 'Skipped stage')
    : uiText('进入阶段', 'Entered stage');
  const detail = stageName ? ` ${stageName}` : '';
  const reason = skipped && skipReason ? `: ${skipReason}` : '';
  pushStreamingPhase(ctx, `${label}${detail}${stageSeq}${reason}`);
  return {};
}

function toConversationPhase(
  value: string,
): ConversationStepTimelineItem['phase'] {
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

function toConversationRole(
  value: string,
): ConversationStepTimelineItem['role'] {
  return value === 'system' ? 'system' : 'agent';
}

/**
 * Process conversation_step event - strict ordinal conversational timeline.
 */
export function handleConversationStepEvent(
  data: RawSSEEvent,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventRecord = asRecord(data);
  const payload = eventPayload(data);
  const content = asRecord(payload.content);

  const text = normalizeFlowLine(
    readStringField(content, 'text') ||
      readStringField(payload, 'text') ||
      readStringField(payload, 'message'),
  );
  if (!text) return {};

  const eventId = normalizeFlowLine(
    readStringField(payload, 'eventId') || readStringField(eventRecord, 'id'),
  );
  if (eventId && ctx.streamingFlow.conversationSeenEventIds.has(eventId)) {
    return {};
  }
  if (eventId) {
    ctx.streamingFlow.conversationSeenEventIds.add(eventId);
    if (ctx.streamingFlow.conversationSeenEventIds.size > 512) {
      const first = ctx.streamingFlow.conversationSeenEventIds
        .values()
        .next().value;
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
    const eventTimestamp =
      readNumberField(asRecord(data), 'timestamp', 0) ||
      readNumberField(payload, 'timestamp', 0);
    flow.conversationPendingSteps[ordinal] = {
      ordinal,
      phase: toConversationPhase(
        normalizeFlowLine(
          readStringField(payload, 'phase', 'progress'),
        ).toLowerCase(),
      ),
      role: toConversationRole(
        normalizeFlowLine(
          readStringField(payload, 'role', 'agent'),
        ).toLowerCase(),
      ),
      text,
      timestamp: eventTimestamp > 0 ? eventTimestamp : Date.now(),
      sourceEventType:
        normalizeFlowLine(readStringField(asRecord(payload.source), 'eventType')) ||
        undefined,
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
  ctx: SSEHandlerContext,
): void {
  const timeline = Array.isArray(source.conversationTimeline)
    ? source.conversationTimeline
    : [];
  if (timeline.length === 0) return;

  for (const entry of timeline) {
    const step = asRecord(entry);
    const stepEvent = {
      id: readStringField(step, 'eventId') || undefined,
      timestamp: readNumberField(step, 'timestamp', 0) || undefined,
      data: {
        eventId: readStringField(step, 'eventId'),
        ordinal: readNumberField(step, 'ordinal', -1),
        phase: readStringField(step, 'phase', 'progress'),
        role: readStringField(step, 'role', 'agent'),
        timestamp: readNumberField(step, 'timestamp', 0) || undefined,
        content: {
          text: readStringField(step, 'text'),
        },
        source: {
          eventType: readStringField(step, 'sourceEventType') || undefined,
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const payload = eventPayload(data);
  const rawToken = payload.token ?? payload.delta ?? '';
  const token = String(rawToken || '');
  const done = payload.done === true;

  if (token) {
    const answer = ctx.streamingAnswer;
    if (answer.status === 'idle') {
      ensureAnswerTimelineStarted(ctx);
      pushStreamingOutput(
        ctx,
        uiText('最终回答生成中...', 'Generating final answer...'),
      );
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
    syncAnswerStreamToConversationTimeline(ctx);
  }

  if (done) {
    syncAnswerStreamToConversationTimeline(ctx, {
      force: true,
      completed: true,
    });
    pushStreamingOutput(ctx, uiText('最终回答已输出', 'Final answer emitted'));
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
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  const eventData = asRecord(data);
  if (DEBUG_SSE) console.log('[SSEHandlers] SSE event:', eventType, eventData);

  const flowStatusBeforeEvent = ctx.streamingFlow.status;
  const result = handleSSEEventInner(eventType, eventData, ctx);

  // ── Cross-component shared state updates (F3: Status Bar, etc.) ───
  // Centralized here so all SSE paths feed the same state (Codex #3).
  if (result.loadingPhase) {
    updateAISharedState({currentPhase: result.loadingPhase});
  }
  if (eventType === 'error' || eventType === 'skill_error') {
    updateAISharedState({status: 'error'});
  } else if (eventType === 'analysis_cancelled') {
    updateAISharedState({
      status: 'cancelled',
      currentPhase: '',
      lastAnalysisTime: Date.now(),
    });
  } else if (eventType === 'analysis_completed') {
    const payload = toAnalysisCompletedPayload(eventData.data);
    const terminalStatus = analysisCompletedResultStatus(payload, ctx.streamingFlow);
    updateAISharedState({
      status:
        terminalStatus === 'failed'
          ? 'error'
          : terminalStatus === 'cancelled'
            ? 'cancelled'
            : terminalStatus === 'quota_exceeded'
              ? 'quota_exceeded'
              : terminalStatus === 'partial'
                ? 'partial'
                : 'completed',
      lastAnalysisTime: Date.now(),
    });
  } else if (eventType === 'end' && flowStatusBeforeEvent === 'running' &&
      ctx.streamingFlow.status === 'partial') {
    updateAISharedState({status: 'partial', lastAnalysisTime: Date.now()});
  }

  return result;
}

function handleSSEEventInner(
  eventType: string,
  eventData: Record<string, unknown>,
  ctx: SSEHandlerContext,
): SSEHandlerResult {
  switch (eventType) {
    case 'connected':
      return {};

    case 'conversation_step':
      return handleConversationStepEvent(eventData, ctx);

    case 'progress':
      return handleProgressEvent(eventData, ctx);

    case 'sql_generated':
      // SQL was generated - don't show raw SQL to user
      pushStreamingTool(
        ctx,
        uiText('SQL 已生成，等待执行', 'SQL generated; waiting to execute'),
      );
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

    case 'scene_timeline_updated':
      ctx.onSceneTimelineReceived?.(asRecord(eventData.data).sceneTimeline ?? eventData.data, false);
      return {};

    case 'analysis_completed':
      return handleAnalysisCompletedEvent(eventData, ctx);

    case 'analysis_source_enrichment_started':
    case 'analysis_source_enrichment_completed':
    case 'analysis_source_enrichment_failed':
    case 'analysis_source_enrichment_cancelled':
      return handleAnalysisSourceEnrichmentEvent(eventType, eventData, ctx);

    case 'analysis_cancelled':
      return handleAnalysisCancelledEvent(eventData, ctx);

    case 'degraded':
      return handleDegradedEvent(eventData, ctx);

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

    case 'architecture_detected': {
      const archPayload = eventPayload(eventData);
      const arch = asRecord(archPayload.architecture);
      if (Object.keys(arch).length > 0) {
        const archType = readStringField(arch, 'type', 'unknown');
        const flutter = asRecord(arch.flutter);
        const compose = readBooleanField(arch, 'compose', false);
        const webview = asRecord(arch.webview);
        const archDesc =
          archType +
          (Object.keys(flutter).length > 0
            ? ` (Flutter ${readStringField(flutter, 'engine', '')})`
            : '') +
          (compose ? ' (Compose)' : '') +
          (Object.keys(webview).length > 0
            ? ` (WebView ${readStringField(webview, 'engine', '')})`
            : '');
        const confidence = readNumberField(arch, 'confidence', 0);
        pushStreamingPhase(
          ctx,
          uiText(
            `检测到渲染架构: ${archDesc} (置信度: ${Math.round(confidence * 100)}%)`,
            `Detected rendering architecture: ${archDesc} (confidence: ${Math.round(confidence * 100)}%)`,
          ),
        );
      }
      return {};
    }

    case 'conclusion': {
      // agentv3 sends 'conclusion' when the SDK result arrives (answer done).
      // 'analysis_completed' follows later with reportUrl after HTML report generation.
      // So conclusion is near-terminal: stop loading but keep connection open.
      const conclusionPayload = eventPayload(eventData);
      const conclusionText = readStringField(conclusionPayload, 'conclusion');
      if (DEBUG_SSE) console.log('[SSEHandlers] CONCLUSION event received');

      // The answer is ready to read, but analysis_completed still owns the
      // final completeness and verification verdict for the process view.
      if (ctx.streamingAnswer.status === 'streaming') {
        completeStreamingAnswer(ctx);
      }

      if (conclusionText) {
        const content = buildVisibleConclusionContentWithReportAppendix(
          conclusionText,
          undefined,
          ctx,
        );
        const streamedAnswerMessageId = ctx.streamingAnswer.messageId;
        const hasStreamedAnswerMessage = Boolean(
          streamedAnswerMessageId &&
            ctx.getMessages().some((msg) => msg.id === streamedAnswerMessageId),
        );
        if (hasStreamedAnswerMessage && streamedAnswerMessageId) {
          ctx.streamingAnswer.content = content;
          ctx.streamingAnswer.pending = '';
          ctx.streamingAnswer.status = 'completed';
          ctx.updateMessage(
            streamedAnswerMessageId,
            {
              content,
              serverVerificationDetails: undefined,
              serverVerificationNotice: undefined,
              serverVerificationBinding: undefined,
              timestamp: Date.now(),
              flowTag: 'answer_stream',
            },
            {persist: true},
          );
        } else {
          const messageId = ctx.generateId();
          ctx.addMessage({
            id: messageId,
            role: 'assistant',
            content,
            serverVerificationDetails: undefined,
            serverVerificationNotice: undefined,
            serverVerificationBinding: undefined,
            timestamp: Date.now(),
            flowTag: 'answer_stream',
          });
          ctx.streamingAnswer.messageId = messageId;
          ctx.streamingAnswer.content = content;
          ctx.streamingAnswer.pending = '';
          ctx.streamingAnswer.status = 'completed';
        }
      }

      if (conclusionText || ctx.streamingAnswer.content.length > 0) {
        ctx.setCompletionHandled(true);
      }
      // Not terminal — analysis_completed with reportUrl still follows
      return {stopLoading: true};
    }

    case 'sub_agent_started': {
      const subPayload = eventPayload(eventData);
      const agentName = readStringField(subPayload, 'agentName') || 'sub-agent';
      const desc = readStringField(subPayload, 'description') || agentName;
      const msg =
        readStringField(subPayload, 'message') ||
        uiText(
          `委托子代理 [${agentName}]: ${desc}`,
          `Delegated to sub-agent [${agentName}]: ${desc}`,
        );
      // Track sub-agent card state
      ctx.streamingFlow.subAgents.push({
        agentName,
        description: desc,
        status: 'running',
        startedAt: Date.now(),
      });
      pushStreamingTool(ctx, msg);
      // Also push to conversation timeline if enabled
      if (isConversationTimelineEnabled(ctx)) {
        pushConversationStep(
          ctx,
          'tool',
          'system',
          uiText(
            `🤖 委托 ${agentName}: ${desc}`,
            `🤖 Delegated to ${agentName}: ${desc}`,
          ),
        );
      }
      refreshSubAgentCards(ctx);
      return {};
    }

    case 'sub_agent_completed': {
      const subPayload = eventPayload(eventData);
      const agentName = readStringField(subPayload, 'agentName') || 'sub-agent';
      const msg =
        readStringField(subPayload, 'message') ||
        uiText(
          `子代理 [${agentName}] 完成证据收集`,
          `Sub-agent [${agentName}] completed evidence collection`,
        );
      // Update sub-agent card state
      const card = ctx.streamingFlow.subAgents.find(
        (a) => a.agentName === agentName && a.status === 'running',
      );
      if (card) {
        card.status = 'completed';
        card.completedAt = Date.now();
        const usage = subPayload.usage ?? subPayload;
        const toolUses = readNumberField(
          usage as Record<string, unknown>,
          'tool_uses',
          -1,
        );
        if (toolUses >= 0) card.toolUses = toolUses;
      }
      pushStreamingTool(ctx, msg);
      if (isConversationTimelineEnabled(ctx)) {
        const dur = card
          ? `${Math.round((Date.now() - card.startedAt) / 1000)}s`
          : '';
        pushConversationStep(
          ctx,
          'result',
          'system',
          uiText(
            `✅ ${agentName} 完成${dur ? ` (${dur})` : ''}`,
            `✅ ${agentName} completed${dur ? ` (${dur})` : ''}`,
          ),
        );
      }
      refreshSubAgentCards(ctx);
      return {};
    }

    case 'circuit_breaker':
      return handleCircuitBreakerEvent(eventData, ctx);

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
      if (DEBUG_SSE) {
        console.log('[SSEHandlers] incremental_scope:', eventData.data);
      }
      {
        const payload = asRecord(eventData.data);
        const scopeType = payload.scopeType;
        if (typeof scopeType === 'string' && scopeType) {
          pushStreamingPhase(
            ctx,
            uiText(`增量范围: ${scopeType}`, `Incremental scope: ${scopeType}`),
          );
        }
      }
      return {};

    case 'error':
      return handleErrorEvent(eventData, ctx);

    case 'skill_error':
      return handleSkillErrorEvent(eventData, ctx);

    case 'end':
      if (ctx.streamingFlow.status === 'running') {
        partialStreamingFlow(ctx, uiText(
          '未收到最终完成与核验状态，请保留当前结果并重试。',
          'Final completion and verification status was not received. Retain this output and retry.',
        ));
      }
      if (ctx.streamingAnswer.status === 'streaming') {
        completeStreamingAnswer(ctx);
      }
      return {stopLoading: true};

    default:
      if (DEBUG_SSE) {
        console.warn(`[SSEHandlers] Unhandled event type: ${eventType}`);
      }
      return {};
  }
}
