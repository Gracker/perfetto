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
    await expect(staleStart).resolves.toEqual(receipt('old-session', 'run-1'));
    await newStart;

    expect(start).toHaveBeenNthCalledWith(2, {backendUrl: 'http://backend'}, {query: 'new'});
    expect(sessionId).toBe('new-session');
  });

  it('returns a receipt that arrives after reset so the caller can cancel it', async () => {
    let sessionId: string | undefined = 'old-session';
    const started = deferredReceipt();
    const queue = new ConversationStartQueue(
      () => sessionId,
      (value) => { sessionId = value; },
      vi.fn().mockImplementationOnce(() => started.promise),
    );

    const inFlight = queue.enqueue(
      {backendUrl: 'http://backend'},
      {query: 'stale'},
    );
    await Promise.resolve();
    queue.reset();
    const lateReceipt = receipt('old-session', 'run-1');
    started.resolve(lateReceipt);

    await expect(inFlight).resolves.toEqual(lateReceipt);
    expect(sessionId).toBeUndefined();
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

    await expect(inFlight).resolves.toEqual(receipt('old-session', 'run-1'));
    await expect(queued).rejects.toBeInstanceOf(
      ConversationStartInvalidatedError,
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(sessionId).toBe('old-session');
  });


  it.each([401, 404, 409])('never replaces a saved session after HTTP %s', async (status) => {
    let sessionId: string | undefined = 'saved-session';
    const error = new ConversationClientError('Saved conversation unavailable', status, 'CONVERSATION_NOT_FOUND');
    const start = vi.fn().mockRejectedValue(error);
    const queue = new ConversationStartQueue(
      () => sessionId, value => { sessionId = value; }, start,
    );
    await expect(queue.enqueue({backendUrl: 'http://backend'}, {query: 'continue'})).rejects.toBe(error);
    expect(start).toHaveBeenCalledOnce();
    expect(sessionId).toBe('saved-session');
  });

  it('waits for restored identity before starting and rejects pending work after reset', async () => {
    let sessionId: string | undefined;
    let finishRestore!: () => void;
    const restoration = new Promise<void>(done => { finishRestore = done; });
    const start = vi.fn().mockResolvedValue(receipt('restored-session', 'run-1'));
    const queue = new ConversationStartQueue(
      () => sessionId, value => { sessionId = value; }, start, () => restoration,
    );
    const operation = queue.enqueue({backendUrl: 'http://backend'}, {query: 'continue'});
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    sessionId = 'restored-session';
    finishRestore();
    await operation;
    expect(start).toHaveBeenCalledWith({backendUrl: 'http://backend'}, {query: 'continue', sessionId: 'restored-session'});
  });

  it('cancels a send queued behind restoration when New Chat invalidates it', async () => {
    let finishRestore!: () => void;
    const restoration = new Promise<void>(done => { finishRestore = done; });
    const start = vi.fn();
    const queue = new ConversationStartQueue(() => undefined, () => {}, start, () => restoration);
    const operation = queue.enqueue({backendUrl: 'http://backend'}, {query: 'old question'});
    await Promise.resolve();
    queue.reset();
    finishRestore();
    await expect(operation).rejects.toBeInstanceOf(ConversationStartInvalidatedError);
    expect(start).not.toHaveBeenCalled();
  });
});
