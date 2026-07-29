// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {buildSmartPerfettoContextHeaders} from '../../core/smartperfetto_request_context';

export type SelfEvolutionProposalStatus =
  | 'draft'
  | 'gated'
  | 'accepted'
  | 'applied'
  | 'rejected'
  | 'reverted';

export interface SelfEvolutionProposal {
  proposalId: string;
  revision: number;
  kind: string;
  tier: string;
  title: string;
  rationale: string;
  deltas: Array<{
    op: string;
    targetKind: string;
    targetId: string;
    anchor: string;
    before?: unknown;
    after?: unknown;
  }>;
  evidence: {
    labeledCount: number;
    negativeCount: number;
    distinctTraceCount: number;
    distinctSessionCount: number;
    statisticalVerdict: string;
  };
  pairedGateVerdict: string;
  expectedEffect: string;
  riskLevel: string;
  status: SelfEvolutionProposalStatus;
  gateResult?: {overallVerdict?: string};
  createdAt: string;
}

export interface SelfEvolutionOverview {
  collectedAt: number;
  config: {enabled: boolean; applyEnabled: boolean};
  requestedConfig: {enabled: boolean; applyEnabled: boolean};
  persistence: {
    persistence: 'available' | 'unavailable';
    reason: string;
    dataRoot: string;
  };
  proposalCounts: Record<SelfEvolutionProposalStatus, number>;
  overlayCounts: {
    total: number;
    effective: number;
    byActivationState: Record<string, number>;
    byValidationState: Record<string, number>;
  };
  generationHead: {
    candidateGeneration: string | null;
    publishedGeneration: string | null;
    fence: number;
    state: 'prepared' | 'published' | 'aborted' | null;
  } | null;
  latestReconciliation: SelfEvolutionReconciliation | null;
  operations: {running: number; retained: number};
  l2Judge: {
    status: 'not_configured';
    reason: 'explicit_external_judge_consent_required';
  };
  warnings: Array<{code: string; message: string}>;
  errors: Array<{code: string; message: string}>;
}

export interface SelfEvolutionOverlay {
  overlayId: string;
  activationState: string;
  validationState: string;
  effectiveEnabled: boolean;
  artifactContentHash: string;
  proposalId: string;
}

export interface SelfEvolutionReconciliation {
  contentHash: string;
  reportId: string;
  candidateGeneration: string;
  publishedGeneration: string;
  createdAt: number;
  issues: unknown[];
}

export interface SelfEvolutionOperationEvent {
  sequence: number;
  type: 'started' | 'progress' | 'completed' | 'failed';
  stage: string;
  message: string;
  createdAt: number;
  proposalId?: string;
  diagnosticCodes?: string[];
  errorCode?: string;
}

export interface SelfEvolutionSnapshot {
  overview: SelfEvolutionOverview;
  proposals: SelfEvolutionProposal[];
  overlays: SelfEvolutionOverlay[];
  reconciliation: SelfEvolutionReconciliation | null;
}

export interface SelfEvolutionApi {
  snapshot(): Promise<SelfEvolutionSnapshot>;
  startCuration(): Promise<{operationId: string}>;
  streamOperation(
    operationId: string,
    onEvent: (event: SelfEvolutionOperationEvent) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  gate(proposalId: string): Promise<SelfEvolutionProposal>;
  accept(proposalId: string): Promise<SelfEvolutionProposal>;
  reject(proposalId: string): Promise<SelfEvolutionProposal>;
  exportContribution(proposalId: string): Promise<{
    artifactId: string;
    archiveContentHash: string;
    contentHash: string;
    deidentified: boolean;
  }>;
  apply(proposalId: string, actionId: string): Promise<unknown>;
  revert(proposalId: string, actionId: string): Promise<unknown>;
}

interface ParsedSseChunk {
  events: SelfEvolutionOperationEvent[];
  remainder: string;
}

const MAX_SSE_BUFFER_BYTES = 1024 * 1024;

export function buildSelfEvolutionApiUrl(
  backendUrl: string,
  path: string,
): string {
  const base = String(backendUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path}`;
  return `${base}/api/admin/self-evolution${suffix}`;
}

export function parseSelfEvolutionSseChunk(
  previous: string,
  chunk: string,
): ParsedSseChunk {
  const normalized = `${previous}${chunk}`.replace(/\r\n/g, '\n');
  if (normalized.length > MAX_SSE_BUFFER_BYTES) {
    throw new Error('self_evolution_event_stream_too_large');
  }
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const events: SelfEvolutionOperationEvent[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (!data) continue;
    const parsed = JSON.parse(data) as SelfEvolutionOperationEvent;
    if (
      typeof parsed.sequence !== 'number' ||
      !['started', 'progress', 'completed', 'failed'].includes(parsed.type)
    ) {
      throw new Error('self_evolution_event_stream_invalid');
    }
    events.push(parsed);
  }
  return {events, remainder};
}

export function createSelfEvolutionApi(
  backendUrl: string,
  apiKey?: string,
  fetchImpl: typeof fetch = fetch,
): SelfEvolutionApi {
  const request = async <T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> => {
    const response = await fetchImpl(
      buildSelfEvolutionApiUrl(backendUrl, path),
      {
        ...options,
        headers: headers(apiKey, options.headers),
      },
    );
    return readJsonOrThrow<T>(response);
  };
  const proposalAction = (
    proposalId: string,
    action: string,
    body: object = {},
  ) => request<SelfEvolutionProposal>(
    `/proposals/${encodeURIComponent(proposalId)}/${action}`,
    {method: 'POST', body: JSON.stringify(body)},
  );

  return {
    async snapshot() {
      const [overview, proposals, overlays, reconciliation] =
        await Promise.all([
          request<SelfEvolutionOverview>('/overview'),
          request<{proposals: SelfEvolutionProposal[]}>('/proposals'),
          request<{overlays: SelfEvolutionOverlay[]}>('/overlays'),
          request<{report: SelfEvolutionReconciliation | null}>(
            '/reconciliation',
          ),
        ]);
      return {
        overview,
        proposals: proposals.proposals,
        overlays: overlays.overlays,
        reconciliation: reconciliation.report,
      };
    },
    startCuration: () =>
      request<{operationId: string}>('/operations/curation', {
        method: 'POST',
        body: '{}',
      }),
    async streamOperation(operationId, onEvent, signal) {
      const response = await fetchImpl(
        buildSelfEvolutionApiUrl(
          backendUrl,
          `/operations/${encodeURIComponent(operationId)}/events`,
        ),
        {
          headers: headers(apiKey, {'Accept': 'text/event-stream'}),
          signal,
        },
      );
      if (!response.ok || !response.body) {
        await readJsonOrThrow(response);
        throw new Error('self_evolution_event_stream_unavailable');
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let remainder = '';
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          const parsed = parseSelfEvolutionSseChunk(
            remainder,
            decoder.decode(result.value, {stream: true}),
          );
          remainder = parsed.remainder;
          for (const event of parsed.events) onEvent(event);
        }
        const parsed = parseSelfEvolutionSseChunk(
          remainder,
          `${decoder.decode()}\n\n`,
        );
        for (const event of parsed.events) onEvent(event);
      } finally {
        reader.releaseLock();
      }
    },
    gate: (proposalId) => proposalAction(proposalId, 'gate'),
    accept: (proposalId) => proposalAction(proposalId, 'accept'),
    reject: (proposalId) => proposalAction(proposalId, 'reject'),
    exportContribution: (proposalId) =>
      request(
        `/proposals/${encodeURIComponent(proposalId)}/export`,
        {method: 'POST', body: '{}'},
      ),
    apply: (proposalId, actionId) =>
      request(
        `/proposals/${encodeURIComponent(proposalId)}/apply`,
        {method: 'POST', body: JSON.stringify({actionId})},
      ),
    revert: (proposalId, actionId) =>
      request(
        `/proposals/${encodeURIComponent(proposalId)}/revert`,
        {method: 'POST', body: JSON.stringify({actionId})},
      ),
  };
}

function headers(
  apiKey?: string,
  initial?: HeadersInit,
): Record<string, string> {
  const next = new Headers(initial);
  if (!next.has('Content-Type')) {
    next.set('Content-Type', 'application/json');
  }
  if (apiKey) next.set('Authorization', `Bearer ${apiKey}`);
  return buildSmartPerfettoContextHeaders(next);
}

async function readJsonOrThrow<T = unknown>(
  response: Response,
): Promise<T> {
  let body: {success?: boolean; error?: string} | null = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok || body?.success === false) {
    throw new Error(
      body?.error ?? `self_evolution_request_failed:${response.status}`,
    );
  }
  return body as T;
}
