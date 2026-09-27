// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Display-only answer draft. A draft-capable backend runtime streams the
 * model's answer text as `answer_token` events stamped with `runId` and a
 * monotone `attempt`, and revokes what it showed with `answer_segment_reset`
 * whenever that text turns out not to be the answer (a tool call follows, a
 * continuation or retry replaces it). The draft is replaced by the provisional
 * or final answer, is never stored, and is never replayed on reconnect.
 */

interface AnswerDraftIdentity {
  runId: string;
  attempt: number;
}

/** One draft event with its identity parsed once; without an identity there is no draft. */
export type AnswerDraftEvent =
  | {kind: 'token'; identity: AnswerDraftIdentity; text: string}
  | {kind: 'reset'; identity: AnswerDraftIdentity};

export function readAnswerDraftEvent(type: unknown, payload: unknown): AnswerDraftEvent | undefined {
  if (type !== 'answer_token' && type !== 'answer_segment_reset') return undefined;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const {runId, attempt} = record;
  if (typeof runId !== 'string' || runId.length === 0 || !Number.isSafeInteger(attempt) || (attempt as number) < 0) {
    return undefined;
  }
  const identity = {runId, attempt: attempt as number};
  if (type === 'answer_segment_reset') return {kind: 'reset', identity};
  const text = typeof record.token === 'string' ? record.token : typeof record.delta === 'string' ? record.delta : '';
  return {kind: 'token', identity, text};
}

/** What one draft owner has accepted so far. */
export interface AnswerDraftTracking {
  runId: string | null;
  attempt: number;
  /** A provisional or final conclusion owns the message; no draft event touches it. */
  owned: boolean;
}

/**
 * `append`: add the token to the draft. `restart`: a later segment — clear the
 * draft, then append. `clear`: remove the draft. `ignore`: an earlier segment,
 * another run, or a message a conclusion already owns.
 */
export type AnswerDraftOp = 'append' | 'restart' | 'clear' | 'ignore';

/** The one draft rule, shared by the agent stream and the conversation panel. */
export function reduceAnswerDraft(
  tracking: AnswerDraftTracking,
  event: AnswerDraftEvent,
): {tracking: AnswerDraftTracking; op: AnswerDraftOp} {
  const {identity} = event;
  if (tracking.owned || (tracking.runId !== null && tracking.runId !== identity.runId) ||
    identity.attempt < tracking.attempt) {
    return {tracking, op: 'ignore'};
  }
  const newer = identity.attempt > tracking.attempt;
  const next = {...tracking, runId: identity.runId, attempt: identity.attempt};
  if (event.kind === 'reset') return {tracking: next, op: 'clear'};
  return {tracking: next, op: newer ? 'restart' : 'append'};
}

export type ConversationRuntimeUpdateAction =
  | {kind: 'draft'; event: AnswerDraftEvent}
  | {kind: 'loading_phase'; phase: string}
  | {kind: 'ignore'};

/**
 * Classify a conversation `runtime_update`. Answer events become draft events
 * only with the draft identity; the loading label is read only from `progress`
 * updates, never from an arbitrary string or message payload.
 */
export function classifyConversationRuntimeUpdate(update: unknown): ConversationRuntimeUpdateAction {
  if (!update || typeof update !== 'object' || Array.isArray(update)) return {kind: 'ignore'};
  const {type, content} = update as {type?: unknown; content?: unknown};
  const event = readAnswerDraftEvent(type, content);
  if (event) return event.kind === 'token' && !event.text ? {kind: 'ignore'} : {kind: 'draft', event};
  if (type === 'progress' && content && typeof content === 'object' && !Array.isArray(content)) {
    const message = (content as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return {kind: 'loading_phase', phase: message};
  }
  return {kind: 'ignore'};
}
