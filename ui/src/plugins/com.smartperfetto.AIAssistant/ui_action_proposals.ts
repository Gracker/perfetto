// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {Time} from '../../base/time';
import type {Trace} from '../../public/trace';
import type {Message, PinnedResult, UiActionProposalV1} from './types';

export type UiActionExecutionResult =
  | {ok: true}
  | {ok: false; error: string};

const TIMELINE_CONTEXT_NS = BigInt(10_000_000);

function parseNs(value: string): bigint | null {
  return /^(?:0|[1-9]\d{0,30})$/.test(value) ? BigInt(value) : null;
}

function traceBounds(trace: Trace): {start: bigint; end: bigint} {
  return {
    start: trace.traceInfo.start as unknown as bigint,
    end: trace.traceInfo.end as unknown as bigint,
  };
}

function validateRange(
  startNs: bigint,
  endNs: bigint,
  trace: Trace,
): UiActionExecutionResult {
  if (endNs <= startNs) {
    return {ok: false, error: 'time range end must be greater than start'};
  }
  const bounds = traceBounds(trace);
  if (startNs < bounds.start || endNs > bounds.end) {
    return {
      ok: false,
      error: `time range is outside trace bounds [${bounds.start.toString()}ns, ${bounds.end.toString()}ns]`,
    };
  }
  return {ok: true};
}

function navigationTraceId(proposal: UiActionProposalV1): string | undefined {
  switch (proposal.kind) {
    case 'navigate_timeline':
    case 'navigate_range':
      return proposal.payload.traceId?.trim();
    case 'open_evidence_table':
    case 'pin_evidence':
      return undefined;
  }
}

function validateTraceId(
  proposal: UiActionProposalV1,
  currentTraceId: string | undefined,
): UiActionExecutionResult {
  const expectedTraceId = navigationTraceId(proposal);
  if (!expectedTraceId) return {ok: true};
  if (!currentTraceId?.trim()) {
    return {ok: false, error: 'current trace id is not available for this UI action'};
  }
  if (expectedTraceId !== currentTraceId.trim()) {
    return {
      ok: false,
      error: `proposal was generated for trace ${expectedTraceId}, but current trace is ${currentTraceId.trim()}`,
    };
  }
  return {ok: true};
}

export function executeUiNavigationProposal(
  proposal: UiActionProposalV1,
  trace: Trace | undefined,
  currentTraceId?: string,
): UiActionExecutionResult {
  if (!trace) return {ok: false, error: 'trace context is not available'};
  const traceId = validateTraceId(proposal, currentTraceId);
  if (!traceId.ok) return traceId;

  if (proposal.kind === 'navigate_timeline') {
    const timestampNs = parseNs(proposal.payload.ts);
    if (timestampNs === null) return {ok: false, error: 'invalid timestamp payload'};
    const bounds = traceBounds(trace);
    if (timestampNs < bounds.start || timestampNs > bounds.end) {
      return {
        ok: false,
        error: `timestamp is outside trace bounds [${bounds.start.toString()}ns, ${bounds.end.toString()}ns]`,
      };
    }
    const startNs = timestampNs - TIMELINE_CONTEXT_NS / BigInt(2);
    const endNs = timestampNs + TIMELINE_CONTEXT_NS / BigInt(2);
    const viewStartNs = startNs > bounds.start ? startNs : bounds.start;
    const viewEndNs = endNs < bounds.end ? endNs : bounds.end;
    trace.scrollTo({
      time: {
        start: Time.fromRaw(viewStartNs),
        end: Time.fromRaw(viewEndNs),
      },
    });
    return {ok: true};
  }

  if (proposal.kind === 'navigate_range') {
    const startNs = parseNs(proposal.payload.startNs);
    const endNs = parseNs(proposal.payload.endNs);
    if (startNs === null || endNs === null) return {ok: false, error: 'invalid range payload'};
    const range = validateRange(startNs, endNs, trace);
    if (!range.ok) return range;
    const durationNs = endNs - startNs;
    const marginNs = durationNs / BigInt(20);
    const viewStartNs = startNs - marginNs;
    trace.scrollTo({
      time: {
        start: Time.fromRaw(viewStartNs > BigInt(0) ? viewStartNs : BigInt(0)),
        end: Time.fromRaw(endNs + marginNs),
        behavior: 'focus',
      },
    });
    return {ok: true};
  }

  return {ok: false, error: `proposal kind ${proposal.kind} is not a navigation action`};
}

function evidenceCandidates(proposal: UiActionProposalV1): string[] {
  const ids = new Set<string>();
  if (proposal.source.evidenceRefId) ids.add(proposal.source.evidenceRefId);
  if (proposal.source.sourceToolCallId) ids.add(proposal.source.sourceToolCallId);
  if (proposal.kind === 'open_evidence_table' && proposal.payload.evidenceRefId) {
    ids.add(proposal.payload.evidenceRefId);
  }
  if (proposal.kind === 'pin_evidence') ids.add(proposal.payload.evidenceRefId);
  return [...ids];
}

export function findUiActionEvidenceMessage(
  proposal: UiActionProposalV1,
  messages: readonly Message[],
): Message | undefined {
  const candidates = evidenceCandidates(proposal);
  if (candidates.length === 0) return undefined;
  return messages.find((message) => {
    const context = message.sqlResult?.sourceContext || message.sourceContext;
    if (!context) return false;
    return candidates.some(candidate =>
      context.evidenceRefId === candidate ||
      context.sourceToolCallId === candidate ||
      context.ref === candidate,
    );
  });
}

export function buildPinnedResultForUiAction(
  proposal: UiActionProposalV1,
  message: Message,
  id: string,
): PinnedResult | undefined {
  const sqlResult = message.sqlResult;
  if (!sqlResult) return undefined;
  const query = sqlResult.query || sqlResult.sourceContext?.title || proposal.title;
  return {
    id,
    query,
    columns: sqlResult.columns,
    rows: sqlResult.rows.slice(0, 100),
    timestamp: Date.now(),
  };
}

export function uiActionProposalIcon(kind: UiActionProposalV1['kind']): string {
  switch (kind) {
    case 'navigate_timeline':
      return 'my_location';
    case 'navigate_range':
      return 'zoom_in_map';
    case 'open_evidence_table':
      return 'table_view';
    case 'pin_evidence':
      return 'push_pin';
  }
}
