// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import type {
  RunSupplementReceipt,
  RunSupplementState,
} from './generated/data_contract.types';
import {
  canSubmitRunSupplement,
  changedRunSupplementEntries,
  createRunSupplementLedger,
  isRunSupplementPending,
  isRunSupplementText,
  parseRunSupplementReceipt,
  reduceRunSupplementLedger,
  runSupplementHttpResultAction,
  runSupplementTerminalOutcome,
  settleRunSupplementEntryForStorage,
  startsConversationRound,
  type RunSupplementLedger,
} from './run_supplement_state';
import {projectMessageForStorage} from './private_message_storage';
import {analysisCompletedEventRunStatus} from './sse_event_handlers';

const RUN = 'run-1';
const KEY = 'key-1';

function receipt(
  state: RunSupplementState,
  overrides: Partial<RunSupplementReceipt> = {},
): RunSupplementReceipt {
  return {id: 'sup-1', runId: RUN, sequence: 1, state, ...overrides};
}

function withSubmission(): RunSupplementLedger {
  let ledger = reduceRunSupplementLedger(createRunSupplementLedger(), {
    type: 'run_started',
    runId: RUN,
    supported: true,
  });
  ledger = reduceRunSupplementLedger(ledger, {
    type: 'submitted',
    key: KEY,
    runId: RUN,
  });
  return ledger;
}

function entry(ledger: RunSupplementLedger) {
  return ledger.entries[0];
}

describe('reduceRunSupplementLedger', () => {
  it('tracks an unsupported run as no run at all', () => {
    const ledger = reduceRunSupplementLedger(createRunSupplementLedger(), {
      type: 'run_started',
      runId: RUN,
      supported: false,
    });
    expect(ledger.runId).toBeNull();
    expect(
      reduceRunSupplementLedger(ledger, {type: 'submitted', key: KEY, runId: RUN})
        .entries,
    ).toEqual([]);
  });

  it('binds the HTTP receipt and advances on SSE', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('classifying'),
    });
    expect(entry(ledger).id).toBe('sup-1');
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('queued', {disposition: 'in_place'}),
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('delivered', {disposition: 'in_place'}),
    });
    expect(entry(ledger).state).toBe('delivered');
  });

  it('accepts SSE before the HTTP response that names the id', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'sse_receipt',
      receipt: receipt('classifying'),
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('queued'),
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('delivered'),
    });
    expect(entry(ledger).state).toBe('classifying');
    expect(Object.keys(ledger.unbound)).toEqual(['sup-1']);
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('classifying'),
    });
    expect(entry(ledger).state).toBe('delivered');
    expect(ledger.unbound).toEqual({});
  });

  it('keeps the buffered receipt that is furthest along', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'sse_receipt',
      receipt: receipt('delivered'),
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('queued'),
    });
    expect(ledger.unbound['sup-1'].state).toBe('delivered');
  });

  it('never moves a state backwards', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('delivered'),
    });
    const before = ledger;
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('queued'),
    });
    expect(ledger).toBe(before);
    expect(entry(ledger).state).toBe('delivered');
  });

  it('rejects a receipt from another run', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('classifying', {runId: 'run-2'}),
    });
    expect(entry(ledger).id).toBeUndefined();
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'sse_receipt',
      receipt: receipt('delivered', {runId: 'run-2'}),
    });
    expect(ledger.unbound).toEqual({});
    expect(entry(ledger).state).toBe('classifying');
  });

  it('settles every pending supplement on a terminal event', () => {
    let ledger = withSubmission();
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'submitted',
      key: 'key-2',
      runId: RUN,
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'terminal',
      runId: RUN,
      outcome: 'cancelled',
    });
    expect(ledger.closed).toBe(true);
    expect(ledger.entries.map((item) => item.state)).toEqual([
      'not_applied',
      'not_applied',
    ]);
    expect(ledger.entries[0].reason).toBe('run_stopped');
    expect(ledger.entries.some(isRunSupplementPending)).toBe(false);
  });

  it('marks an outcome of unknown without inventing a reason', () => {
    const ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'terminal',
      runId: RUN,
      outcome: 'unknown',
    });
    expect(entry(ledger).failureCode).toBe('outcome_unknown');
    expect(entry(ledger).reason).toBeUndefined();
  });

  it('ignores a terminal event for another run', () => {
    const ledger = withSubmission();
    expect(
      reduceRunSupplementLedger(ledger, {
        type: 'terminal',
        runId: 'run-2',
        outcome: 'failed',
      }),
    ).toBe(ledger);
  });

  it('keeps a late non-terminal receipt from reopening a settled entry', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'terminal',
      runId: RUN,
      outcome: 'completed',
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('classifying'),
    });
    expect(entry(ledger).state).toBe('not_applied');
  });

  it('lets a backend verdict replace a client-only settlement', () => {
    let ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'terminal',
      runId: RUN,
      outcome: 'completed',
    });
    ledger = reduceRunSupplementLedger(ledger, {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('delivered'),
    });
    expect(entry(ledger).state).toBe('delivered');
    expect(entry(ledger).clientSettled).toBeUndefined();
  });

  it('classifies HTTP failures by code alone', () => {
    const closed = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_error',
      key: KEY,
      code: 'RUN_SUPPLEMENT_WINDOW_CLOSED',
    });
    expect(entry(closed).state).toBe('not_applied');
    expect(entry(closed).reason).toBe('window_closed');
    expect(closed.closed).toBe(true);

    const tooLarge = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_error',
      key: KEY,
      code: 'RUN_SUPPLEMENT_TOO_LARGE',
    });
    expect(entry(tooLarge).state).toBe('rejected');
    expect(tooLarge.closed).toBe(false);
  });

  it('closes the window when any supplement is not applied', () => {
    const ledger = reduceRunSupplementLedger(withSubmission(), {
      type: 'sse_receipt',
      receipt: receipt('not_applied', {reason: 'turn_budget'}),
    });
    expect(ledger.closed).toBe(true);
  });

  it('marks a restart consumed and reopens it through the reducer', () => {
    const restart = reduceRunSupplementLedger(withSubmission(), {
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('restart_required', {reason: 'scope_changed'}),
    });
    const consumed = reduceRunSupplementLedger(restart, {
      type: 'restart_marked',
      entry: entry(restart),
      consumed: true,
    });
    expect(entry(consumed).restartConsumed).toBe(true);
    expect(changedRunSupplementEntries(restart, consumed)).toEqual([entry(consumed)]);
    expect(
      reduceRunSupplementLedger(consumed, {type: 'restart_marked', entry: entry(consumed), consumed: true}),
    ).toBe(consumed);
    const reopened = reduceRunSupplementLedger(consumed, {
      type: 'restart_marked',
      entry: entry(consumed),
      consumed: false,
    });
    expect(entry(reopened).restartConsumed).toBe(false);
  });

  it('marks a restart on a message from an earlier run', () => {
    const stored = {key: 'old', state: 'restart_required' as const, reason: 'scope_changed' as const};
    const ledger = reduceRunSupplementLedger(createRunSupplementLedger(), {
      type: 'restart_marked',
      entry: stored,
      consumed: true,
    });
    expect(entry(ledger)).toEqual({...stored, restartConsumed: true});
    expect(ledger.entries.some(isRunSupplementPending)).toBe(false);
  });

  it('reports only the entries an action changed', () => {
    const previous = withSubmission();
    const next = reduceRunSupplementLedger(previous, {
      type: 'submitted',
      key: 'key-2',
      runId: RUN,
    });
    expect(changedRunSupplementEntries(previous, next).map((e) => e.key)).toEqual(['key-2']);
  });
});

describe('canSubmitRunSupplement', () => {
  const open = {
    ledger: withSubmission(),
    agentRunId: RUN,
    isLoading: true,
    cancellationPending: false,
  };

  it('opens only for the supported active run', () => {
    expect(canSubmitRunSupplement(open)).toBe(true);
    expect(canSubmitRunSupplement({...open, agentRunId: null})).toBe(false);
    expect(canSubmitRunSupplement({...open, agentRunId: 'other'})).toBe(false);
    expect(canSubmitRunSupplement({...open, isLoading: false})).toBe(false);
    expect(
      canSubmitRunSupplement({...open, cancellationPending: true}),
    ).toBe(false);
    expect(
      canSubmitRunSupplement({
        ...open,
        ledger: createRunSupplementLedger(),
      }),
    ).toBe(false);
    expect(
      canSubmitRunSupplement({
        ...open,
        ledger: {...open.ledger, closed: true},
      }),
    ).toBe(false);
  });
});

describe('input and receipt helpers', () => {
  it('excludes blank text and slash commands', () => {
    expect(isRunSupplementText('look at binder')).toBe(true);
    expect(isRunSupplementText('   ')).toBe(false);
    expect(isRunSupplementText('/sql select 1')).toBe(false);
  });

  it('validates receipts field by field', () => {
    expect(parseRunSupplementReceipt(receipt('queued'))).toBeDefined();
    expect(parseRunSupplementReceipt({...receipt('queued'), state: 'nope'})).toBeUndefined();
    expect(parseRunSupplementReceipt({...receipt('queued'), reason: 'nope'})).toBeUndefined();
    expect(parseRunSupplementReceipt({...receipt('queued'), sequence: 'x'})).toBeUndefined();
    expect(parseRunSupplementReceipt(undefined)).toBeUndefined();
  });

  it('converts a finished POST into one action', () => {
    expect(runSupplementHttpResultAction(KEY, true, {receipt: receipt('queued')})).toEqual({
      type: 'http_receipt',
      key: KEY,
      receipt: receipt('queued'),
    });
    expect(runSupplementHttpResultAction(KEY, false, {code: 'RUN_NOT_ACTIVE', receipt: receipt('queued')})).toEqual({
      type: 'http_error',
      key: KEY,
      code: 'RUN_NOT_ACTIVE',
    });
  });

  it.each([
    ['an unknown code', false, {code: 'SOMETHING'}],
    ['a client-only code', false, {code: 'outcome_unknown'}],
    ['an inherited property name', false, {code: 'toString'}],
    ['an unreadable body', false, undefined],
    ['a null body', false, null],
    ['a 202 with an invalid receipt', true, {receipt: {id: 'x'}}],
  ])('treats %s as an unconfirmed failure', (_label, ok, body) => {
    expect(runSupplementHttpResultAction(KEY, ok, body)).toEqual({
      type: 'http_error',
      key: KEY,
      code: 'request_failed',
    });
  });

  it('maps stream events to terminal outcomes', () => {
    expect(runSupplementTerminalOutcome('progress')).toBeUndefined();
    expect(runSupplementTerminalOutcome('analysis_cancelled')).toBe('cancelled');
    expect(runSupplementTerminalOutcome('error')).toBe('failed');
    expect(runSupplementTerminalOutcome('end')).toBe('unknown');
    expect(runSupplementTerminalOutcome('analysis_completed', 'completed')).toBe('completed');
    expect(runSupplementTerminalOutcome('analysis_completed', 'cancelled')).toBe('cancelled');
    expect(runSupplementTerminalOutcome('analysis_completed', 'failed')).toBe('failed');
    expect(runSupplementTerminalOutcome('analysis_completed', 'quota_exceeded')).toBe('failed');
  });

  it('takes the completed status from the stream handler that owns it', () => {
    const outcome = (data: unknown) =>
      runSupplementTerminalOutcome(
        'analysis_completed',
        analysisCompletedEventRunStatus('analysis_completed', data),
      );
    expect(outcome({data: {terminalRunStatus: 'cancelled'}})).toBe('cancelled');
    expect(outcome({data: {success: true}})).toBe('completed');
    // No terminalRunStatus: an explicit failure is a failed run.
    expect(outcome({data: {success: false}})).toBe('failed');
    expect(analysisCompletedEventRunStatus('progress', {data: {success: false}})).toBeUndefined();
  });

  it('does not count a supplement as a conversation round', () => {
    expect(startsConversationRound({role: 'user'})).toBe(true);
    expect(startsConversationRound({role: 'assistant'})).toBe(false);
    expect(startsConversationRound({role: 'user', flowTag: 'run_supplement'})).toBe(false);
  });

  it('stores a pending supplement as settled and leaves settled ones alone', () => {
    const pending = entry(withSubmission());
    const stored = settleRunSupplementEntryForStorage(pending);
    expect(stored.state).toBe('not_applied');
    expect(stored.failureCode).toBe('outcome_unknown');
    const delivered = {...pending, state: 'delivered' as const};
    expect(settleRunSupplementEntryForStorage(delivered)).toBe(delivered);
    const projected = projectMessageForStorage({
      content: 'raw',
      privateContent: true,
      runSupplement: pending,
    });
    expect(projected.content).not.toBe('raw');
    expect(projected.runSupplement?.state).toBe('not_applied');
  });
});
