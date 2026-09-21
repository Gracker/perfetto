// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
import {afterEach, describe, expect, it, vi} from 'vitest';
import {StoryController, StoryControllerCancelledError, StoryControllerInvalidatedError, type StoryControllerContext} from './story_controller';

function context(fetchBackend: StoryControllerContext['fetchBackend']) {
  return {getBackendTraceId: vi.fn(() => 'trace-a'), getBackendUrl: vi.fn(() => 'http://backend.example'),
    fetchBackend} satisfies StoryControllerContext;
}
const receipt = () => new Response(JSON.stringify({success: true, sessionId: 'session-a', analysisId: 'session-a', runId: 'run-a'}), {status: 200});
const cancelled = () => new Response(JSON.stringify({success: true, runId: 'run-a', status: 'cancelled'}), {status: 200});

describe('StoryController lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());
  it('invalidates a pending read-only preview', async () => {
    const ctx = context(vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once: true});
    })));
    const ctrl = new StoryController(ctx); const preview = ctrl.preview('trace-a'); ctrl.dispose();
    await expect(preview).rejects.toBeInstanceOf(StoryControllerInvalidatedError);
  });
  it('reserves one POST synchronously, snapshots provider and reopening attaches', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    const ctrl = new StoryController(context(fetch));
    const first = ctrl.start({providerId: 'selected-provider'}); const second = ctrl.start({providerId: 'other'});
    expect(first).toBe(second); expect(fetch).toHaveBeenCalledOnce();
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body).providerId).toBe('selected-provider');
    resolve(receipt()); await first; await ctrl.start();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('waits for an admitted POST receipt before cancelling the exact run', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((url: string, _init?: RequestInit) => url.endsWith('/cancel')
      ? Promise.resolve(cancelled()) : new Promise<Response>(done => { resolve = done; }));
    const ctrl = new StoryController(context(fetch)); const run = ctrl.start();
    await ctrl.cancel(); expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1]?.signal).toBeUndefined();
    resolve(receipt()); await expect(run).rejects.toBeInstanceOf(StoryControllerCancelledError);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain('/session-a/cancel');
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toEqual({runId: 'run-a'});
  });
  it('on disposal still collects the old receipt and cancels without touching a new UI', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((url: string, _init?: RequestInit) => url.endsWith('/cancel')
      ? Promise.resolve(cancelled()) : new Promise<Response>(done => { resolve = done; }));
    const ctx = context(fetch); const ctrl = new StoryController(ctx); const run = ctrl.start();
    ctrl.dispose(); ctx.getBackendTraceId.mockReturnValue('trace-b'); resolve(receipt());
    await expect(run).rejects.toBeInstanceOf(StoryControllerInvalidatedError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('attaches the admitted run when a pre-receipt stop fails instead of losing its identity', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn((url: string) => url.endsWith('/cancel')
      ? Promise.resolve(new Response(JSON.stringify({error: 'temporarily unavailable'}), {status: 503}))
      : new Promise<Response>(done => {resolve = done;}));
    const ctrl = new StoryController(context(fetch)); const run = ctrl.start(); await ctrl.cancel(); resolve(receipt());
    await expect(run).resolves.toMatchObject({sessionId: 'session-a', runId: 'run-a', cancellationError: 'temporarily unavailable'});
  });
  it('only explicit rerun after terminal creates a new POST', async () => {
    const fetch = vi.fn(async () => receipt()); const ctrl = new StoryController(context(fetch));
    await ctrl.start(); await ctrl.start({forceRefresh: true}); expect(fetch).toHaveBeenCalledOnce();
    ctrl.markTerminal('run-a'); await ctrl.start(); expect(fetch).toHaveBeenCalledOnce();
    await ctrl.start({forceRefresh: true}); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not turn a rejected or mismatched cancellation into successful cancellation', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('/cancel')
      ? new Response(JSON.stringify({runId: 'other-run', status: 'cancelled'}), {status: 200}) : receipt());
    const ctrl = new StoryController(context(fetch)); await ctrl.start();
    await expect(ctrl.cancel()).rejects.toThrow('matching run');
  });
});
