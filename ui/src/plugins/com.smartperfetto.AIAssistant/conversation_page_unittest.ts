// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  invalidateSmartPerfettoAuthSession,
  type SmartPerfettoAuthSession,
} from '../../core/smartperfetto_auth';
import {ConversationPage} from './conversation_page';
import {sessionManager} from './session_manager';
import {DEFAULT_SETTINGS} from './types';
import {loadPersistedTracePairWorkspace} from './trace_pair_workspace_persistence';

function installOidcSession(
  userId = 'user-a',
  workspaceId = 'workspace-a',
): SmartPerfettoAuthSession {
  window.__SMARTPERFETTO_CONFIG__ = {
    oidcEnabled: true,
    backendUrl: 'http://backend',
  };
  const session: SmartPerfettoAuthSession = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: userId, email: `${userId}@example.test`},
    tenant: {id: 'tenant-a', name: 'Tenant A'},
    workspace: {id: workspaceId, name: workspaceId, kind: 'personal'},
    csrfToken: 'csrf-a',
  };
  window.__SMARTPERFETTO_AUTH_SESSION__ = session;
  return session;
}

function startResponse(sessionId = 'session-a', runId = 'run-a'): Response {
  return new Response(JSON.stringify({
    sessionId,
    runId,
    isNewSession: true,
    traceContextAttached: false,
  }), {
    status: 202,
    headers: {'content-type': 'application/json'},
  });
}

function streamResponse(message = 'answer-a'): Response {
  const payload = JSON.stringify({
    outcome: {kind: 'answered', message},
  });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `event: run_completed\ndata: ${payload}\n\n`,
      ));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {'content-type': 'text/event-stream'},
  });
}

function sourceEnrichmentStreamResponse(): {
  response: Response;
  completeSource(): void;
} {
  const encoder = new TextEncoder();
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(
        'event: run_completed\ndata: {"type":"run_completed","enrichmentPending":true,"outcome":{"kind":"answered","message":"primary answer"}}\n\n',
      ));
      controller.enqueue(encoder.encode(
        'event: source_enrichment_started\ndata: {"type":"source_enrichment_started"}\n\n',
      ));
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: {'content-type': 'text/event-stream'},
    }),
    completeSource() {
      streamController.enqueue(encoder.encode(
        'event: source_enrichment_completed\ndata: {"type":"source_enrichment_completed","message":"source supplement","evidence":[{"id":"source-1","label":"Foo.kt:L10-L12"}],"metrics":{"searchCalls":1,"readCalls":2,"durationMs":40}}\n\n',
      ));
      streamController.close();
    },
  };
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((done) => { resolve = done; }),
    resolve,
  };
}

function createPage(): any {
  const page = new ConversationPage() as any;
  page.oncreate();
  return page;
}

beforeEach(() => {
  installOidcSession();
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(sessionManager, 'loadSettings').mockReturnValue({
    ...DEFAULT_SETTINGS,
    backendUrl: 'http://backend',
    backendApiKey: '',
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  localStorage.clear();
  sessionStorage.clear();
});

describe('ConversationPage OIDC lifecycle', () => {
  it('opens an empty dual-trace launcher without an active trace in local mode', () => {
    window.__SMARTPERFETTO_CONFIG__ = {
      oidcEnabled: false,
      backendUrl: 'http://backend',
    };
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    const page = createPage();

    page.openTracePairWorkspace();

    expect(page.tracePairWorkspaceController.getState()).toMatchObject({
      open: true,
      pageTrace: null,
      currentTrace: null,
      referenceTrace: null,
    });
    page.onremove();
  });

  it('uploads two new pane files and hands the persisted pair to the main viewer', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {
      oidcEnabled: false,
      backendUrl: 'http://backend',
    };
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        trace: {id: 'baseline-id', leaseId: 'baseline-lease'},
      }), {status: 200, headers: {'content-type': 'application/json'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        trace: {id: 'comparison-id', leaseId: 'comparison-lease'},
      }), {status: 200, headers: {'content-type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    const app = {navigate: vi.fn()};
    page.openTracePairWorkspace();

    await Promise.all([
      page.tracePairWorkspaceController.uploadTrace(
        'first',
        new File(['baseline'], 'baseline.pftrace'),
      ),
      page.tracePairWorkspaceController.uploadTrace(
        'second',
        new File(['comparison'], 'comparison.pftrace'),
      ),
    ]);
    page.launchTracePairAnalysis(app);

    expect(page.tracePairWorkspaceController.getState()).toMatchObject({
      open: false,
      currentTrace: {id: 'baseline-id'},
      referenceTrace: {id: 'comparison-id'},
    });
    expect(loadPersistedTracePairWorkspace('http://backend')).toMatchObject({
      open: true,
      baseline: {id: 'baseline-id'},
      comparison: {id: 'comparison-id'},
    });
    expect(app.navigate).toHaveBeenCalledWith(
      expect.stringContaining(
        'smartperfettoWorkspaceTraceId=baseline-id',
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    page.onremove();
  });

  it('completes a no-trace OIDC conversation with the same page authority', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(startResponse())
      .mockResolvedValueOnce(streamResponse('trace-free answer'));
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'Explain scheduling latency.';

    await page.send();

    expect(page.store.sessionId).toBe('session-a');
    expect(page.store.messages.map((message: any) => message.content)).toEqual([
      'Explain scheduling latency.',
      'trace-free answer',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    page.onremove();
  });

  it('shows the primary answer before source enrichment completes', async () => {
    const stream = sourceEnrichmentStreamResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(startResponse())
      .mockResolvedValueOnce(stream.response);
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'Analyze startup.';

    const send = page.send();
    await vi.waitFor(() => expect(page.store.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: 'assistant',
        content: 'primary answer',
        sourceEnrichment: {status: 'running'},
      }),
    ])));

    stream.completeSource();
    await send;
    expect(page.store.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        content: 'primary answer',
        sourceEnrichment: expect.objectContaining({
          status: 'completed',
          message: 'source supplement',
        }),
      }),
    ]));
    page.onremove();
  });

  it('rejects a late start completion after logout', async () => {
    const pendingStart = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(pendingStart.promise);
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'old authority question';

    const send = page.send();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    invalidateSmartPerfettoAuthSession(false);
    pendingStart.resolve(startResponse('old-session', 'old-run'));
    await send;

    expect(page.store.sessionId).toBeUndefined();
    expect(page.store.messages.some(
      (message: any) => message.content === 'late answer',
    )).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    page.onremove();
  });

  it('cancels a run whose receipt arrives after page removal', async () => {
    const pendingStart = deferredResponse();
    const fetchMock = vi.fn()
      .mockImplementationOnce((_input: unknown, init?: RequestInit) => {
        const signal = init?.signal;
        return signal
          ? Promise.race([
              pendingStart.promise,
              new Promise<Response>((_resolve, reject) => {
                signal.addEventListener('abort', () => {
                  reject(new DOMException('The operation was aborted', 'AbortError'));
                }, {once: true});
              }),
            ])
          : pendingStart.promise;
      })
      .mockResolvedValueOnce(new Response('', {status: 200}));
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'page removal question';

    const send = page.send();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    page.onremove();
    pendingStart.resolve(startResponse('removed-session', 'removed-run'));
    await send;

    expect(page.activeReceipt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'http://backend/api/workspaces/workspace-a/agent/conversation/' +
        'removed-session/cancel',
    );
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({runId: 'removed-run'}),
    });
  });

  it('does not append an old stream result after switching user/workspace', async () => {
    const pendingStream = deferredResponse();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(startResponse('old-session', 'old-run'))
      .mockReturnValueOnce(pendingStream.promise);
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'old workspace question';

    const send = page.send();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    installOidcSession('user-b', 'workspace-b');
    window.dispatchEvent(new Event('smartperfetto-auth-session-changed'));
    pendingStream.resolve(streamResponse('old workspace answer'));
    await send;

    expect(page.store.messages.some(
      (message: any) => message.content === 'old workspace answer',
    )).toBe(false);
    expect(page.store.sessionId).toBeUndefined();
    page.onremove();
  });

  it('treats a stream 401 as authority invalidation without appending an error', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(startResponse())
      .mockResolvedValueOnce(new Response('', {status: 401}));
    vi.stubGlobal('fetch', fetchMock);
    const page = createPage();
    page.input = 'expire during stream';

    await page.send();

    expect(window.__SMARTPERFETTO_AUTH_SESSION__).toBeUndefined();
    expect(page.store.messages.some(
      (message: any) => /Conversation failed|对话失败/.test(message.content),
    )).toBe(false);
    page.onremove();
  });
});
