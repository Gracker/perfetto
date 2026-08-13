// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';

import {
  ConversationClientError,
  type ConversationRunReceipt,
} from './conversation_client';
import {
  ConversationStartInvalidatedError,
  ConversationStartQueue,
} from './conversation_start_queue';

function deferredReceipt(): {
  promise: Promise<ConversationRunReceipt>;
  resolve: (receipt: ConversationRunReceipt) => void;
} {
  let resolve!: (receipt: ConversationRunReceipt) => void;
  return {
    promise: new Promise<ConversationRunReceipt>((done) => { resolve = done; }),
    resolve,
  };
}

function receipt(sessionId: string, runId: string): ConversationRunReceipt {
  return {sessionId, runId, isNewSession: true, traceContextAttached: false};
}

describe('ConversationStartQueue', () => {
  it('waits for the first receipt before starting the next turn in that session', async () => {
    let sessionId: string | undefined;
    const first = deferredReceipt();
    const start = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(receipt('session-1', 'run-2'));
    const queue = new ConversationStartQueue(
      () => sessionId,
      (value) => { sessionId = value; },
      start,
    );

    const firstStart = queue.enqueue({backendUrl: 'http://backend'}, {query: 'first'});
    const secondStart = queue.enqueue({backendUrl: 'http://backend'}, {query: 'second'});
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    first.resolve(receipt('session-1', 'run-1'));
    await firstStart;
    await secondStart;

    expect(start).toHaveBeenNthCalledWith(2, {backendUrl: 'http://backend'}, {
      query: 'second',
      sessionId: 'session-1',
    });
  });

  it('does not let a stale receipt restore a session after reset', async () => {
    let sessionId: string | undefined = 'old-session';
    const first = deferredReceipt();
    const start = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(receipt('new-session', 'run-2'));
    const queue = new ConversationStartQueue(
      () => sessionId,
      (value) => { sessionId = value; },
      start,
    );

    const staleStart = queue.enqueue({backendUrl: 'http://backend'}, {query: 'stale'});
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    queue.reset();
    const newStart = queue.enqueue({backendUrl: 'http://backend'}, {query: 'new'});
    first.resolve(receipt('old-session', 'run-1'));
    await expect(staleStart).rejects.toBeInstanceOf(
      ConversationStartInvalidatedError,
    );
    await newStart;

    expect(start).toHaveBeenNthCalledWith(2, {backendUrl: 'http://backend'}, {query: 'new'});
    expect(sessionId).toBe('new-session');
  });

  it('drops queued work deterministically after invalidation', async () => {
    let sessionId: string | undefined = 'old-session';
    const first = deferredReceipt();
    const start = vi.fn().mockImplementationOnce(() => first.promise);
    const queue = new ConversationStartQueue(
      () => sessionId,
      (value) => { sessionId = value; },
      start,
    );

    const inFlight = queue.enqueue(
      {backendUrl: 'http://backend'},
      {query: 'first'},
    );
    const queued = queue.enqueue(
      {backendUrl: 'http://backend'},
      {query: 'second'},
    );
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    queue.reset({persist: false});
    first.resolve(receipt('old-session', 'run-1'));

    await expect(inFlight).rejects.toBeInstanceOf(
      ConversationStartInvalidatedError,
    );
    await expect(queued).rejects.toBeInstanceOf(
      ConversationStartInvalidatedError,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(sessionId).toBe('old-session');
  });


  it('starts a fresh backend session when the persisted session no longer exists', async () => {
    let sessionId: string | undefined = 'expired-session';
    const start = vi.fn()
      .mockRejectedValueOnce(new ConversationClientError(
        'Conversation not found',
        404,
        'CONVERSATION_NOT_FOUND',
      ))
      .mockResolvedValueOnce(receipt('replacement-session', 'run-1'));
    const queue = new ConversationStartQueue(
      () => sessionId,
      (value) => { sessionId = value; },
      start,
    );

    await expect(queue.enqueue(
      {backendUrl: 'http://backend'},
      {query: 'continue'},
    )).resolves.toEqual(receipt('replacement-session', 'run-1'));

    expect(start).toHaveBeenNthCalledWith(1, {backendUrl: 'http://backend'}, {
      query: 'continue',
      sessionId: 'expired-session',
    });
    expect(start).toHaveBeenNthCalledWith(2, {backendUrl: 'http://backend'}, {
      query: 'continue',
    });
    expect(sessionId).toBe('replacement-session');
  });
});
