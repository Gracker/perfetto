// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import {buildSmartPerfettoContextHeaders} from '../../core/smartperfetto_request_context';
import {buildAssistantApiV1Url} from './assistant_api_v1';
import type {
  AnalysisContextSelection,
  ConversationSourceEnrichmentUpdate,
  SelectionContext,
} from './types';

export interface ConversationEvidenceRef {
  id: string;
  label: string;
  source?: string;
}

export interface ConversationFullHandoff {
  question: string;
  scope: string;
  assumptions: string[];
  evidence: ConversationEvidenceRef[];
}

export type ConversationOutcome =
  | {kind: 'answered'; message: string; evidence?: ConversationEvidenceRef[]}
  | {kind: 'needs_user_input'; message: string; question: string; evidence?: ConversationEvidenceRef[]}
  | {kind: 'recommend_full'; message: string; handoff: ConversationFullHandoff; evidence?: ConversationEvidenceRef[]}
  | {kind: 'cancelled'; message: string; evidence?: ConversationEvidenceRef[]};

export interface ConversationRunReceipt {
  sessionId: string;
  runId: string;
  isNewSession: boolean;
  traceContextAttached: boolean;
}

export interface ConversationClientConfig {
  backendUrl: string;
  apiKey?: string;
}

export interface StartConversationInput {
  query: string;
  sessionId?: string;
  traceId?: string;
  analysisContext?: AnalysisContextSelection;
  selectionContext?: SelectionContext;
  signal?: AbortSignal;
}

export interface ParsedConversationSseEvent {
  type: string;
  data: unknown;
}

function requestHeaders(config: ConversationClientConfig): Record<string, string> {
  const headers = buildSmartPerfettoContextHeaders({'Content-Type': 'application/json'});
  const apiKey = config.apiKey?.trim();
  return apiKey
    ? {...headers, 'x-api-key': apiKey, Authorization: `Bearer ${apiKey}`}
    : headers;
}

export class ConversationClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ConversationClientError';
  }
}

export function isConversationNotFoundError(error: unknown): boolean {
  return error instanceof ConversationClientError &&
    error.status === 404 &&
    (error.code === 'CONVERSATION_NOT_FOUND' || error.message === 'Conversation not found');
}

export function conversationTraceContextChanged(
  previousTraceId: string | undefined,
  nextTraceId: string | undefined,
): boolean {
  const normalize = (value: string | undefined) => value?.trim() || undefined;
  return normalize(previousTraceId) !== normalize(nextTraceId);
}

async function readError(response: Response): Promise<ConversationClientError> {
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
  const message = typeof payload.error === 'string'
    ? payload.error
    : `HTTP ${response.status}`;
  const code = typeof payload.code === 'string' ? payload.code : undefined;
  return new ConversationClientError(message, response.status, code);
}

export async function startConversationTurn(
  config: ConversationClientConfig,
  input: StartConversationInput,
): Promise<ConversationRunReceipt> {
  const url = buildAssistantApiV1Url(config.backendUrl, '/conversation');
  const analysisContext = input.analysisContext;
  const options = {
    ...(analysisContext ? {
      codeAwareMode: analysisContext.codeAwareMode,
      codebaseIds: analysisContext.codebaseIds,
      knowledgeSourceIds: analysisContext.knowledgeSourceIds,
    } : {}),
    ...(input.selectionContext
      ? {selectionContext: input.selectionContext}
      : {}),
  };
  const response = await smartPerfettoFetch(url, {
    method: 'POST',
    headers: requestHeaders(config),
    signal: input.signal,
    body: JSON.stringify({
      query: input.query,
      ...(input.sessionId ? {sessionId: input.sessionId} : {}),
      ...(input.traceId ? {traceId: input.traceId} : {}),
      ...(Object.keys(options).length > 0 ? {options} : {}),
    }),
  });
  if (!response.ok) throw await readError(response);
  return await response.json() as ConversationRunReceipt;
}

export function parseConversationSseFrames(buffer: string): {
  events: ParsedConversationSseEvent[];
  remainder: string;
} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  const remainder = frames.pop() ?? '';
  const events = frames.flatMap((frame): ParsedConversationSseEvent[] => {
    let type = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) return [];
    const raw = dataLines.join('\n');
    try {
      return [{type, data: JSON.parse(raw)}];
    } catch {
      return [{type, data: raw}];
    }
  });
  return {events, remainder};
}

export async function streamConversationRun(
  config: ConversationClientConfig,
  receipt: ConversationRunReceipt,
  options: {
    signal?: AbortSignal;
    onEvent?(event: ParsedConversationSseEvent): void;
    onPrimaryOutcome?(outcome: ConversationOutcome): void;
    onSourceEnrichment?(update: ConversationSourceEnrichmentUpdate): void;
  } = {},
): Promise<ConversationOutcome> {
  const url = buildAssistantApiV1Url(
    config.backendUrl,
    `/conversation/${encodeURIComponent(receipt.sessionId)}/stream?runId=${encodeURIComponent(receipt.runId)}`,
  );
  const response = await smartPerfettoFetch(url, {
    headers: requestHeaders(config),
    signal: options.signal,
  });
  if (!response.ok) throw await readError(response);
  if (!response.body) throw new Error('Conversation stream is unavailable');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let primaryOutcome: ConversationOutcome | undefined;
  while (true) {
    const {done, value} = await reader.read();
    buffer += decoder.decode(value, {stream: !done});
    const parsed = parseConversationSseFrames(buffer);
    buffer = parsed.remainder;
    for (const event of parsed.events) {
      options.onEvent?.(event);
      if (event.type === 'run_completed') {
        const completed = event.data as {
          outcome: ConversationOutcome;
          enrichmentPending?: boolean;
        };
        primaryOutcome = completed.outcome;
        options.onPrimaryOutcome?.(primaryOutcome);
        if (completed.enrichmentPending !== true) return primaryOutcome;
      }
      if (event.type === 'run_failed') {
        throw new Error(String((event.data as {error?: unknown}).error || 'Conversation failed'));
      }
      if (event.type === 'source_enrichment_started') {
        options.onSourceEnrichment?.({status: 'running'});
      }
      if (event.type === 'source_enrichment_completed') {
        const completed = event.data as {
          message?: unknown;
          evidence?: ConversationEvidenceRef[];
          metrics?: {searchCalls: number; readCalls: number; durationMs: number};
        };
        options.onSourceEnrichment?.({
          status: 'completed',
          message: typeof completed.message === 'string' ? completed.message : '',
          evidence: Array.isArray(completed.evidence) ? completed.evidence : [],
          metrics: completed.metrics ?? {searchCalls: 0, readCalls: 0, durationMs: 0},
        });
        if (primaryOutcome) return primaryOutcome;
      }
      if (event.type === 'source_enrichment_failed') {
        options.onSourceEnrichment?.({
          status: 'failed',
          errorCode: String((event.data as {errorCode?: unknown}).errorCode || 'source_enrichment_failed'),
        });
        if (primaryOutcome) return primaryOutcome;
      }
      if (event.type === 'source_enrichment_cancelled') {
        options.onSourceEnrichment?.({status: 'cancelled'});
        if (primaryOutcome) return primaryOutcome;
      }
    }
    if (done) break;
  }
  if (primaryOutcome) return primaryOutcome;
  throw new Error('Conversation stream ended before a result was received');
}

export async function cancelConversationRun(
  config: ConversationClientConfig,
  sessionId: string,
  runId: string,
): Promise<void> {
  const url = buildAssistantApiV1Url(
    config.backendUrl,
    `/conversation/${encodeURIComponent(sessionId)}/cancel`,
  );
  const response = await smartPerfettoFetch(url, {
    method: 'POST',
    headers: requestHeaders(config),
    body: JSON.stringify({runId}),
  });
  if (!response.ok) throw await readError(response);
}
