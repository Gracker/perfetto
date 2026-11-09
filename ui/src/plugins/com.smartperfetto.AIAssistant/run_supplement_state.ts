// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Client-side ledger for supplements a user sends to a running analysis.
 *
 * Pure: the panel dispatches actions and renders the result. The state always
 * comes from typed fields on receipts and error codes, never from wording.
 *
 * `delivered` means the supplement entered the agent's context; it does not
 * claim the provider received it.
 */

import type {
  RunSupplementNotAppliedReason,
  RunSupplementReason,
  RunSupplementReceipt,
  RunSupplementState,
} from './generated/data_contract.types';

type RunSupplementFailureCode =
  | 'RUN_SUPPLEMENT_INVALID_BODY'
  | 'RUN_SUPPLEMENT_TOO_LARGE'
  | 'RUN_SUPPLEMENT_UNSUPPORTED'
  | 'RUN_SUPPLEMENT_WINDOW_CLOSED'
  | 'RUN_SUPPLEMENT_CAPACITY_EXCEEDED'
  | 'RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT'
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_ACTIVE'
  | 'CANCELLATION_IN_PROGRESS'
  /** Client-only: the POST failed without a recognized code, so its outcome is unconfirmed. */
  | 'request_failed'
  /** Client-only: the run ended or the page reloaded before any final receipt. */
  | 'outcome_unknown';

type RunSupplementHttpFailureCode = Exclude<RunSupplementFailureCode, 'outcome_unknown'>;

export interface RunSupplementEntry {
  /** The idempotency key, which is also the chat message id. */
  key: string;
  /** Backend id, known once the HTTP receipt arrives. */
  id?: string;
  state: RunSupplementState;
  reason?: RunSupplementReason;
  failureCode?: RunSupplementFailureCode;
  /** Settled locally without a backend receipt; a later backend verdict may replace it. */
  clientSettled?: boolean;
  /** The user already restarted the analysis with this supplement. */
  restartConsumed?: boolean;
}

export interface RunSupplementLedger {
  /** Set only for a run whose POST response advertised support. */
  readonly runId: string | null;
  /** The run accepts no more supplements. */
  readonly closed: boolean;
  readonly entries: readonly RunSupplementEntry[];
  /** SSE receipts that arrived before the HTTP response tied their id to a key. */
  readonly unbound: Readonly<Record<string, RunSupplementReceipt>>;
}

type RunSupplementTerminalOutcome =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'unknown';

export type RunSupplementLedgerAction =
  | {type: 'run_started'; runId: string; supported: boolean}
  | {type: 'submitted'; key: string; runId: string}
  | {type: 'http_receipt'; key: string; receipt: RunSupplementReceipt}
  | {type: 'http_error'; key: string; code: RunSupplementHttpFailureCode}
  | {type: 'sse_receipt'; receipt: RunSupplementReceipt}
  | {type: 'terminal'; runId: string; outcome: RunSupplementTerminalOutcome}
  /** `entry` is the message's copy: a message from an earlier run is not in this ledger. */
  | {type: 'restart_marked'; entry: RunSupplementEntry; consumed: boolean};

/**
 * Legal moves. Mirrors the backend channel, plus classifying -> delivered
 * because a client that missed the queued event can still see the final one.
 */
const NEXT_STATES: Readonly<
  Record<RunSupplementState, readonly RunSupplementState[]>
> = {
  classifying: [
    'queued',
    'delivered',
    'restart_required',
    'rejected',
    'not_applied',
  ],
  queued: ['delivered', 'not_applied'],
  delivered: [],
  restart_required: [],
  rejected: [],
  not_applied: [],
};

function isTerminalState(state: RunSupplementState): boolean {
  return NEXT_STATES[state].length === 0;
}

const RECEIPT_REASONS: ReadonlySet<string> = new Set<RunSupplementReason>([
  'window_closed',
  'turn_budget',
  'run_stopped',
  'run_failed',
  'classification_unavailable',
  'policy',
  'goal_changed',
  'scene_changed',
  'scope_changed',
  'trace_changed',
  'provider_changed',
  'authorization_changed',
  'needs_selection',
  'evidence_access_changed',
  'deliverable_changed',
  'budget_changed',
]);

const HTTP_FAILURE_OUTCOMES: Readonly<
  Record<
    RunSupplementHttpFailureCode,
    {
      state: 'rejected' | 'not_applied';
      reason?: RunSupplementNotAppliedReason;
      closesWindow: boolean;
    }
  >
> = {
  RUN_SUPPLEMENT_INVALID_BODY: {state: 'rejected', closesWindow: false},
  RUN_SUPPLEMENT_TOO_LARGE: {state: 'rejected', closesWindow: false},
  RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT: {state: 'rejected', closesWindow: false},
  request_failed: {state: 'rejected', closesWindow: false},
  RUN_SUPPLEMENT_UNSUPPORTED: {state: 'rejected', closesWindow: true},
  RUN_SUPPLEMENT_CAPACITY_EXCEEDED: {state: 'rejected', closesWindow: true},
  RUN_NOT_FOUND: {state: 'rejected', closesWindow: true},
  RUN_SUPPLEMENT_WINDOW_CLOSED: {
    state: 'not_applied',
    reason: 'window_closed',
    closesWindow: true,
  },
  RUN_NOT_ACTIVE: {
    state: 'not_applied',
    reason: 'window_closed',
    closesWindow: true,
  },
  CANCELLATION_IN_PROGRESS: {
    state: 'not_applied',
    reason: 'run_stopped',
    closesWindow: true,
  },
};

const TERMINAL_OUTCOME_REASONS: Readonly<
  Record<
    Exclude<RunSupplementTerminalOutcome, 'unknown'>,
    RunSupplementNotAppliedReason
  >
> = {
  completed: 'window_closed',
  cancelled: 'run_stopped',
  failed: 'run_failed',
};

export function createRunSupplementLedger(): RunSupplementLedger {
  return {runId: null, closed: false, entries: [], unbound: {}};
}

export function isRunSupplementPending(entry: RunSupplementEntry): boolean {
  return !isTerminalState(entry.state);
}

/** Recognized failure codes pass through; anything else is an unconfirmed failure. */
function normalizeHttpFailureCode(code: unknown): RunSupplementHttpFailureCode {
  return typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(HTTP_FAILURE_OUTCOMES, code)
    ? (code as RunSupplementHttpFailureCode)
    : 'request_failed';
}

/** Validate an untrusted receipt from either the HTTP response or the SSE stream. */
export function parseRunSupplementReceipt(
  value: unknown,
): RunSupplementReceipt | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const receipt = value as Record<string, unknown>;
  const {id, runId, sequence, state, reason, disposition} = receipt;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof runId !== 'string' || !runId) return undefined;
  if (typeof sequence !== 'number' || !Number.isInteger(sequence)) {
    return undefined;
  }
  if (
    typeof state !== 'string' ||
    !Object.prototype.hasOwnProperty.call(NEXT_STATES, state)
  ) {
    return undefined;
  }
  if (
    reason !== undefined &&
    (typeof reason !== 'string' || !RECEIPT_REASONS.has(reason))
  ) {
    return undefined;
  }
  if (
    disposition !== undefined &&
    disposition !== 'in_place' &&
    disposition !== 'restart_required'
  ) {
    return undefined;
  }
  return receipt as unknown as RunSupplementReceipt;
}

/** The action a finished POST maps to; `body` is undefined when it was unreadable. */
export function runSupplementHttpResultAction(
  key: string,
  ok: boolean,
  body: unknown,
): RunSupplementLedgerAction {
  const result = body as {receipt?: unknown; code?: unknown} | null | undefined;
  const receipt = ok ? parseRunSupplementReceipt(result?.receipt) : undefined;
  return receipt
    ? {type: 'http_receipt', key, receipt}
    : {type: 'http_error', key, code: normalizeHttpFailureCode(result?.code)};
}

/**
 * Which terminal stream event, if any, ends the run this ledger follows.
 * `completedRunStatus` is the status the `analysis_completed` owner resolved.
 */
export function runSupplementTerminalOutcome(
  eventType: string,
  completedRunStatus?: 'completed' | 'failed' | 'cancelled' | 'quota_exceeded',
): RunSupplementTerminalOutcome | undefined {
  switch (eventType) {
    case 'analysis_cancelled':
      return 'cancelled';
    case 'error':
      return 'failed';
    case 'end':
      return 'unknown';
    case 'analysis_completed':
      if (completedRunStatus === 'cancelled') return 'cancelled';
      return completedRunStatus === 'failed' || completedRunStatus === 'quota_exceeded'
        ? 'failed'
        : 'completed';
    default:
      return undefined;
  }
}

/** The single place an entry changes state; fields of the previous state do not carry over. */
function entryInState(
  entry: Pick<RunSupplementEntry, 'key' | 'id'>,
  next: Omit<RunSupplementEntry, 'key' | 'id'>,
): RunSupplementEntry {
  return {
    key: entry.key,
    ...(entry.id === undefined ? {} : {id: entry.id}),
    state: next.state,
    ...(next.reason === undefined ? {} : {reason: next.reason}),
    ...(next.failureCode === undefined ? {} : {failureCode: next.failureCode}),
    ...(next.clientSettled === undefined ? {} : {clientSettled: next.clientSettled}),
  };
}

/** Advance an entry by one backend receipt, keeping the state monotonic. */
function applyReceipt(
  entry: RunSupplementEntry,
  receipt: RunSupplementReceipt,
): RunSupplementEntry {
  const overridesClientSettle =
    entry.clientSettled === true && isTerminalState(receipt.state);
  if (
    !overridesClientSettle &&
    !NEXT_STATES[entry.state].includes(receipt.state)
  ) {
    return entry.id === receipt.id ? entry : {...entry, id: receipt.id};
  }
  return entryInState(
    {key: entry.key, id: receipt.id},
    {state: receipt.state, reason: receipt.reason},
  );
}

function withEntry(
  ledger: RunSupplementLedger,
  next: RunSupplementEntry,
): RunSupplementEntry[] {
  return ledger.entries.map((entry) => (entry.key === next.key ? next : entry));
}

function handleHttpError(
  ledger: RunSupplementLedger,
  key: string,
  code: RunSupplementHttpFailureCode,
): RunSupplementLedger {
  const entry = ledger.entries.find((candidate) => candidate.key === key);
  if (!entry || !isRunSupplementPending(entry)) return ledger;
  const outcome = HTTP_FAILURE_OUTCOMES[code];
  return {
    ...ledger,
    closed: ledger.closed || outcome.closesWindow,
    entries: withEntry(
      ledger,
      entryInState(entry, {
        state: outcome.state,
        reason: outcome.reason,
        failureCode: code,
      }),
    ),
  };
}

function handleHttpReceipt(
  ledger: RunSupplementLedger,
  key: string,
  receipt: RunSupplementReceipt,
): RunSupplementLedger {
  const entry = ledger.entries.find((candidate) => candidate.key === key);
  if (!entry || ledger.runId !== receipt.runId) return ledger;
  const buffered = ledger.unbound[receipt.id] as
    | RunSupplementReceipt
    | undefined;
  let next = applyReceipt(entry, receipt);
  if (buffered !== undefined) next = applyReceipt(next, buffered);
  if (next === entry && buffered === undefined) return ledger;
  const unbound = {...ledger.unbound};
  delete unbound[receipt.id];
  return {
    ...ledger,
    closed: ledger.closed || next.state === 'not_applied',
    entries: withEntry(ledger, next),
    unbound,
  };
}

function handleSseReceipt(
  ledger: RunSupplementLedger,
  receipt: RunSupplementReceipt,
): RunSupplementLedger {
  if (receipt.runId !== ledger.runId) return ledger;
  const closed = ledger.closed || receipt.state === 'not_applied';
  const entry = ledger.entries.find((candidate) => candidate.id === receipt.id);
  if (entry) {
    const next = applyReceipt(entry, receipt);
    if (next === entry && closed === ledger.closed) return ledger;
    return {...ledger, closed, entries: withEntry(ledger, next)};
  }
  const existing = ledger.unbound[receipt.id] as
    | RunSupplementReceipt
    | undefined;
  if (
    existing !== undefined &&
    !NEXT_STATES[existing.state].includes(receipt.state)
  ) {
    return closed === ledger.closed ? ledger : {...ledger, closed};
  }
  return {
    ...ledger,
    closed,
    unbound: {...ledger.unbound, [receipt.id]: receipt},
  };
}

function handleTerminal(
  ledger: RunSupplementLedger,
  runId: string,
  outcome: RunSupplementTerminalOutcome,
): RunSupplementLedger {
  if (runId !== ledger.runId) return ledger;
  const hasPending = ledger.entries.some(isRunSupplementPending);
  if (!hasPending && ledger.closed) return ledger;
  const entries = ledger.entries.map((entry) =>
    isRunSupplementPending(entry)
      ? entryInState(entry, {
          state: 'not_applied',
          clientSettled: true,
          ...(outcome === 'unknown'
            ? {failureCode: 'outcome_unknown' as const}
            : {reason: TERMINAL_OUTCOME_REASONS[outcome]}),
        })
      : entry,
  );
  return {...ledger, closed: true, entries};
}

function handleRestartMarked(
  ledger: RunSupplementLedger,
  entry: RunSupplementEntry,
  consumed: boolean,
): RunSupplementLedger {
  if ((entry.restartConsumed === true) === consumed) return ledger;
  const marked: RunSupplementEntry = {...entry, restartConsumed: consumed};
  const tracked = ledger.entries.some((candidate) => candidate.key === entry.key);
  return {
    ...ledger,
    entries: tracked ? withEntry(ledger, marked) : [...ledger.entries, marked],
  };
}

/** Reducer for every supplement event; returns the same object when nothing changed. */
export function reduceRunSupplementLedger(
  ledger: RunSupplementLedger,
  action: RunSupplementLedgerAction,
): RunSupplementLedger {
  switch (action.type) {
    case 'run_started':
      return action.supported
        ? {...createRunSupplementLedger(), runId: action.runId}
        : createRunSupplementLedger();
    case 'submitted':
      if (
        action.runId !== ledger.runId ||
        ledger.closed ||
        ledger.entries.some((entry) => entry.key === action.key)
      ) {
        return ledger;
      }
      return {
        ...ledger,
        entries: [
          ...ledger.entries,
          {key: action.key, state: 'classifying'},
        ],
      };
    case 'http_receipt':
      return handleHttpReceipt(ledger, action.key, action.receipt);
    case 'http_error':
      return handleHttpError(ledger, action.key, action.code);
    case 'sse_receipt':
      return handleSseReceipt(ledger, action.receipt);
    case 'terminal':
      return handleTerminal(ledger, action.runId, action.outcome);
    case 'restart_marked':
      return handleRestartMarked(ledger, action.entry, action.consumed);
  }
}

/** Entries a transition changed, so the panel updates only those messages. */
export function changedRunSupplementEntries(
  previous: RunSupplementLedger,
  next: RunSupplementLedger,
): RunSupplementEntry[] {
  return next.entries.filter((entry) => !previous.entries.includes(entry));
}

/** Whether the composer may take a supplement for this run right now. */
export function canSubmitRunSupplement(input: {
  ledger: RunSupplementLedger;
  agentRunId: string | null;
  isLoading: boolean;
  cancellationPending: boolean;
}): boolean {
  const {ledger, agentRunId, isLoading, cancellationPending} = input;
  return (
    isLoading &&
    !cancellationPending &&
    !ledger.closed &&
    agentRunId !== null &&
    ledger.runId === agentRunId
  );
}

/** Slash commands stay disabled for supplements: they would run as commands. */
export function isRunSupplementText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && !trimmed.startsWith('/');
}

/** A stored message can never read as still pending; the outcome is unknown after a reload. */
export function settleRunSupplementEntryForStorage(
  entry: RunSupplementEntry,
): RunSupplementEntry {
  return isRunSupplementPending(entry)
    ? entryInState(entry, {
        state: 'not_applied',
        clientSettled: true,
        failureCode: 'outcome_unknown',
      })
    : entry;
}

export function isRunSupplementMessage(message: {flowTag?: string}): boolean {
  return message.flowTag === 'run_supplement';
}

/** A question that opens a conversation round; a supplement belongs to the round it was sent in. */
export function startsConversationRound(message: {
  role: string;
  flowTag?: string;
}): boolean {
  return message.role === 'user' && !isRunSupplementMessage(message);
}
