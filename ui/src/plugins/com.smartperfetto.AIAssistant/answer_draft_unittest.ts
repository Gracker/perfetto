// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';
import {
  classifyConversationRuntimeUpdate,
  readAnswerDraftEvent,
  reduceAnswerDraft,
  type AnswerDraftTracking,
} from './answer_draft';

const token = (text: string, attempt: number, runId = 'run-a') =>
  readAnswerDraftEvent('answer_token', {token: text, runId, attempt})!;
const reset = (attempt: number, runId = 'run-a') =>
  readAnswerDraftEvent('answer_segment_reset', {runId, attempt})!;
const start: AnswerDraftTracking = {runId: null, attempt: 0, owned: false};

describe('answer draft reducer', () => {
  it('has no draft without an identity', () => {
    expect(readAnswerDraftEvent('answer_token', {token: 'legacy'})).toBeUndefined();
    expect(readAnswerDraftEvent('answer_token', {token: 'x', runId: '', attempt: 0})).toBeUndefined();
    expect(readAnswerDraftEvent('answer_segment_reset', {runId: 'r', attempt: -1})).toBeUndefined();
    expect(readAnswerDraftEvent('progress', {runId: 'r', attempt: 0})).toBeUndefined();
    expect(classifyConversationRuntimeUpdate({type: 'answer_token', content: 'untyped'})).toEqual({kind: 'ignore'});
  });

  it('appends, restarts on a newer segment, clears on reset and drops stale or foreign events', () => {
    let step = reduceAnswerDraft(start, token('A', 0));
    expect(step).toEqual({tracking: {runId: 'run-a', attempt: 0, owned: false}, op: 'append'});
    step = reduceAnswerDraft(step.tracking, reset(1));
    expect(step.op).toBe('clear');
    expect(reduceAnswerDraft(step.tracking, token('late', 0)).op).toBe('ignore');
    expect(reduceAnswerDraft(step.tracking, token('other run', 1, 'run-b')).op).toBe('ignore');
    expect(reduceAnswerDraft(step.tracking, token('B', 2))).toEqual(
      {tracking: {runId: 'run-a', attempt: 2, owned: false}, op: 'restart'});
  });

  it('ignores every draft event once a conclusion owns the message', () => {
    const owned = {runId: 'run-a', attempt: 0, owned: true};
    expect(reduceAnswerDraft(owned, token('A', 0)).op).toBe('ignore');
    expect(reduceAnswerDraft(owned, reset(1))).toEqual({tracking: owned, op: 'ignore'});
  });
});
