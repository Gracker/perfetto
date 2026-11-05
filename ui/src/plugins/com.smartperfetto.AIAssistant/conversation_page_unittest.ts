// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import m from 'mithril';
import type {App} from '../../public/app';

import {
  invalidateSmartPerfettoAuthSession,
  type SmartPerfettoAuthSession,
} from '../../core/smartperfetto_auth';
import {ConversationPage} from './conversation_page';
import {AssistantWorkOverview} from './assistant_work_overview';
import {clearConversationRuntimeIdentities, loadConversationStore, saveConversationStore} from './conversation_store';
import {sessionManager} from './session_manager';
import {DEFAULT_SETTINGS} from './types';
import {loadPersistedTracePairWorkspace} from './trace_pair_workspace_persistence';
import {saveAnalysisContext, loadAnalysisContext, analysisAuthorizationKey} from './analysis_context';
import {getSmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';

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

let renderRoot: HTMLElement;

function renderPage(page: ConversationPage): HTMLElement {
  m.render(renderRoot, page.view({attrs: {app: {} as App}} as m.Vnode<{app: App}>));
  return renderRoot;
}

function renderedMessages(): string[] {
  return Array.from(renderRoot.querySelectorAll('.ai-conversation-page-message-content'),
    (element) => element.textContent?.trim() ?? '');
}

beforeEach(() => {
  renderRoot = document.createElement('div');
  clearConversationRuntimeIdentities();
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
  m.render(renderRoot, null);
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
    renderPage(page);
    expect(renderedMessages()).toEqual(['Explain scheduling latency.', 'trace-free answer']);
    expect(renderRoot.querySelector('.ai-answer-verification-pending')).toBeNull();
    page.onremove();
  });

  it('shows the provisional answer in memory and stores it once, with the verdict, under the run id', async () => {
    const encoder = new TextEncoder();
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(
          'event: provisional_answer\ndata: {"type":"provisional_answer","message":"answer body","verification":"pending"}\n\n',
        ));
      },
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(startResponse())
      .mockResolvedValueOnce(new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}})));
    const page = createPage();
    expect(renderPage(page).querySelector('.ai-conversation-page-empty')).not.toBeNull();
    page.input = 'trace 时长';
    const send = page.send();
    await vi.waitFor(() => expect(page.provisionalAnswer?.message.content).toBe('answer body'));
    expect(page.store.messages.filter((message: {role: string}) => message.role === 'assistant')).toEqual([]);
    renderPage(page);
    expect(renderedMessages()).toEqual(['trace 时长', 'answer body']);
    expect(renderRoot.querySelectorAll('.ai-answer-verification-pending')).toHaveLength(1);
    const pendingArticle = renderRoot.querySelector('.ai-conversation-page-message-assistant');
    streamController.enqueue(encoder.encode(
      'event: run_completed\ndata: {"type":"run_completed","outcome":{"kind":"answered","message":"answer body"}}\n\n',
    ));
    streamController.close();
    await send;
    expect(page.provisionalAnswer).toBeUndefined();
    expect(page.store.messages.filter((message: {role: string}) => message.role === 'assistant')).toEqual([
      expect.objectContaining({id: 'conversation-session-a-run-a-assistant', content: 'answer body'}),
    ]);
    renderPage(page);
    expect(renderedMessages()).toEqual(['trace 时长', 'answer body']);
    expect(renderRoot.querySelector('.ai-answer-verification-pending')).toBeNull();
    expect(renderRoot.querySelector('.ai-conversation-page-message-assistant')).toBe(pendingArticle);
    page.onremove();
  });

  it('a new message first ends the previous review and keeps an unverdicted answer before the new question', async () => {
    const encoder = new TextEncoder();
    let firstStream!: ReadableStreamDefaultController<Uint8Array>;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/conversation') && calls.filter(call => call === 'start').length === 0) {
        calls.push('start');
        return startResponse('session-a', 'run-a');
      }
      if (url.includes('/stream') && url.includes('run-a')) {
        calls.push('stream-a');
        return new Response(new ReadableStream<Uint8Array>({start(controller) {
          firstStream = controller;
          controller.enqueue(encoder.encode(
            'event: provisional_answer\ndata: {"type":"provisional_answer","message":"first answer","verification":"pending"}\n\n'));
        }}), {status: 200, headers: {'content-type': 'text/event-stream'}});
      }
      if (url.endsWith('/cancel')) {
        calls.push('cancel-a');
        // The run could not settle with a verdict: its stream ends without run_completed.
        firstStream.close();
        return new Response(JSON.stringify({success: true, runId: 'run-a', status: 'cancelled'}), {status: 200});
      }
      if (url.endsWith('/conversation')) {
        calls.push('start-b');
        return startResponse('session-a', 'run-b');
      }
      calls.push('stream-b');
      return streamResponse('second answer');
    }));
    const page = createPage();
    page.input = 'trace 时长';
    const first = page.send();
    await vi.waitFor(() => expect(page.provisionalAnswer?.message.content).toBe('first answer'));
    renderPage(page);
    expect(renderedMessages()).toEqual(['trace 时长', 'first answer']);
    page.input = '应用包名';
    await page.send();
    await first.catch(() => undefined);
    expect(calls.indexOf('cancel-a')).toBeGreaterThan(-1);
    expect(calls.indexOf('cancel-a')).toBeLessThan(calls.indexOf('start-b'));
    expect(page.store.messages.map((message: {role: string; content: string; turn?: {partial: boolean}}) =>
      [message.role, message.content, message.turn?.partial ?? null])).toEqual([
      ['user', 'trace 时长', null],
      ['assistant', 'first answer', true],
      ['user', '应用包名', null],
      ['assistant', 'second answer', null],
    ]);
    renderPage(page);
    expect(renderedMessages()[1]).toContain('first answer');
    expect(renderedMessages().slice(2)).toEqual(['应用包名', 'second answer']);
    expect(renderRoot.querySelector('.ai-answer-verification-pending')).toBeNull();
    page.onremove();
  });

  it.each(['closed', 'failed'])('renders before delivery and after a provisional stream is %s', async (ending) => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn()
      .mockResolvedValueOnce(startResponse())
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({
        start(controller) { stream = controller; },
      }), {status: 200, headers: {'content-type': 'text/event-stream'}}));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    try {
      page.input = 'question before delivery';
      const send = page.send();
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      renderPage(page);
      expect(renderedMessages()).toEqual(['question before delivery']);
      stream.enqueue(new TextEncoder().encode(
        'event: provisional_answer\ndata: {"type":"provisional_answer","message":"unfinished answer","verification":"pending"}\n\n',
      ));
      await vi.waitFor(() => expect(page.provisionalAnswer).toBeDefined());
      renderPage(page);
      expect(renderedMessages()).toEqual(['question before delivery', 'unfinished answer']);
      if (ending === 'closed') stream.close();
      else stream.error(new Error('stream interrupted'));
      await send;
      renderPage(page);
      expect(renderedMessages()[1]).toContain('unfinished answer');
      expect(renderRoot.querySelectorAll('.ai-conversation-page-message-assistant')).toHaveLength(1);
      expect(renderRoot.querySelector('.ai-answer-verification-pending')).toBeNull();
      expect(page.store.messages[1].turn.partial).toBe(true);
    } finally {
      page.onremove();
    }
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

function seedSavedPageConversation(): void {
  saveConversationStore({backendUrl: 'http://backend', sessionId: 'saved-conversation', updatedAt: 1,
    messages: [{id: 'cached-answer', role: 'assistant', content: 'cached answer must await authorization', timestamp: 1}]});
  clearConversationRuntimeIdentities();
}

function restoredPageConversation(): Response {
  return new Response(JSON.stringify({success: true, sessionId: 'saved-conversation', status: 'idle',
    traceContext: {kind: 'none'}, historyOmittedMessages: 0, recoveryStatus: 'interrupted',
    history: [{role: 'assistant', content: 'restored answer', turnId: 'old-run', turn: {
      id: 'old-run', turnIndex: 0, partial: true, completionStatus: 'incomplete',
      terminationReason: 'turn_limit', uncertainties: ['missing evidence'], nextSteps: ['check old evidence'], evidence: [],
    }}],
  }), {status: 200});
}

describe('ConversationPage authorized restoration', () => {
  it.each([false, true])('renders restored history and clears it for New Chat (OIDC: %s)', async (oidc) => {
    if (!oidc) {
      window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false, backendUrl: 'http://backend'};
      window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    }
    seedSavedPageConversation();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(restoredPageConversation()));
    const page = createPage();
    try {
      renderPage(page);
      expect(renderedMessages()).toEqual([]);
      await page.ensureConversationRestored();
      renderPage(page);
      expect(renderedMessages()).toHaveLength(1);
      expect(renderedMessages()[0]).toContain('restored answer');
      expect(renderRoot.querySelector('.ai-answer-verification-pending')).toBeNull();
      await page.startNewConversation();
      renderPage(page);
      expect(renderedMessages()).toEqual([]);
      expect(renderRoot.querySelector('.ai-conversation-page-empty')).not.toBeNull();
    } finally {
      page.onremove();
    }
  });

  it('waits for the same restoration before sending a follow-up in the saved session', async () => {
    seedSavedPageConversation();
    const restore = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(restore.promise)
      .mockResolvedValueOnce(startResponse('saved-conversation', 'follow-up-run'))
      .mockResolvedValueOnce(streamResponse('follow-up answer'));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    expect(page.store.messages).toEqual([]);
    page.input = 'follow up on missing evidence';
    const send = page.send();
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    restore.resolve(restoredPageConversation());
    await send;
    expect(JSON.parse(String(fetch.mock.calls[1][1].body))).toMatchObject({sessionId: 'saved-conversation'});
    expect(page.store.messages[0]).toMatchObject({content: 'restored answer', turn: {partial: true}});
    page.onremove();
  });

  it('New Chat cancels a pending restore without later overwriting the new conversation', async () => {
    seedSavedPageConversation();
    const restore = deferredResponse();
    const fetch = vi.fn().mockReturnValueOnce(restore.promise)
      .mockResolvedValueOnce(startResponse('new-conversation', 'new-run'))
      .mockResolvedValueOnce(streamResponse('new answer'));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    await page.startNewConversation();
    page.input = 'new question';
    await page.send();
    restore.resolve(restoredPageConversation());
    await Promise.resolve();
    await Promise.resolve();
    expect(page.store.sessionId).toBe('new-conversation');
    expect(page.store.messages.some((message: any) => message.content === 'restored answer')).toBe(false);
    expect(JSON.parse(String(fetch.mock.calls[1][1].body)).sessionId).toBeUndefined();
    page.onremove();
  });

  it.each([404, 409])('keeps HTTP %s visible and prevents sending into an automatic replacement', async (status) => {
    seedSavedPageConversation();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({error: 'Recovery blocked'}), {status}));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    page.input = 'continue this saved conversation';
    await page.send();
    expect(page.error).toContain('Recovery blocked');
    expect(page.store.messages).toEqual([]);
    expect(page.input).toBe('continue this saved conversation');
    expect(loadConversationStore('http://backend').conversationId).toBe('saved-conversation');
    expect(fetch).toHaveBeenCalledOnce();
    page.onremove();
  });

  it('never hydrates an old owner response after the user/workspace changes', async () => {
    seedSavedPageConversation();
    const restore = deferredResponse();
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(restore.promise));
    const page = createPage();
    installOidcSession('user-b', 'workspace-b');
    window.dispatchEvent(new Event('smartperfetto-auth-session-changed'));
    restore.resolve(restoredPageConversation());
    await Promise.resolve();
    await Promise.resolve();
    expect(page.store.messages).toEqual([]);
    expect(loadConversationStore('http://backend').conversationId).toBeUndefined();
    page.onremove();
  });

  it('reconnects to the authorized active run and keeps a private restored answer during follow-up', async () => {
    seedSavedPageConversation();
    const snapshot = await restoredPageConversation().json();
    snapshot.activeRunId = 'old-run';
    snapshot.history[0].sourceDerived = true;
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot), {status: 200}))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller) { stream = controller; }}), {status: 200}))
      .mockResolvedValueOnce(startResponse('saved-conversation', 'follow-up'))
      .mockResolvedValueOnce(streamResponse('follow-up answer'));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    await vi.waitFor(() => expect(page.activeReceipt?.runId).toBe('old-run'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[1][0])).toContain('/stream?runId=old-run');
    stream.enqueue(new TextEncoder().encode('event: run_completed\ndata: {"outcome":{"kind":"answered","message":"restored answer"}}\n\n'));
    stream.close();
    await vi.waitFor(() => expect(page.activeReceipt).toBeUndefined());
    expect(page.store.messages.filter((message: any) => message.content === 'restored answer')).toHaveLength(1);
    page.input = 'continue the private answer';
    await page.send();
    expect(page.store.messages.some((message: any) => message.content === 'restored answer' && message.turn?.partial === true)).toBe(true);
    expect(loadConversationStore('http://backend').messages.some(message => message.content === 'restored answer')).toBe(false);
    page.onremove();
  });

  it.each(['rejected', 'late-terminal'])('keeps the replacement receipt after an old resumed stream is %s', async (oldExit) => {
    let oldStream!: ReadableStreamDefaultController<Uint8Array>;
    let newStream!: ReadableStreamDefaultController<Uint8Array>;
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller) { oldStream = controller; }})))
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller) { newStream = controller; }})))
      .mockResolvedValueOnce(new Response('{}', {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    await page.ensureConversationRestored();
    const authority = page.authLifecycle.capture();
    const store = {backendUrl: 'http://backend', sessionId: 'saved-chat', activeRunId: 'active-run', messages: [], updatedAt: 1};
    const oldRun = page.resumeConversationRun(store, authority);
    const oldController = page.activeController;
    const newRun = page.resumeConversationRun(store, authority);
    const replacementController = page.activeController;
    const replacementReceipt = page.activeReceipt;
    expect(oldController.signal.aborted).toBe(true);
    if (oldExit === 'rejected') oldStream.error(new Error('old stream failed'));
    else {
      oldStream.enqueue(new TextEncoder().encode(
        'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"stale-answer"}}\n\n'));
      oldStream.close();
    }
    await oldRun;
    expect(page.activeReceipt).toBe(replacementReceipt);
    expect(page.activeController).toBe(replacementController);
    expect(replacementController.signal.aborted).toBe(false);
    expect(page.error).toBe('');
    expect(page.store.messages).toEqual([]);
    await page.startNewConversation();
    expect(JSON.parse(String(fetch.mock.calls[2][1]?.body))).toEqual({runId: 'active-run'});
    newStream.close();
    await newRun;
    page.onremove();
  });

  it('keeps a running stream when only the source depth changes', async () => {
    let oldStream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller) { oldStream = controller; }}))));
    const page = createPage();
    await page.ensureConversationRestored();
    const store = {backendUrl: 'http://backend', sessionId: 'saved-conversation', activeRunId: 'active-run', messages: [], updatedAt: 1};
    saveConversationStore(store);
    const run = page.resumeConversationRun(store, page.authLifecycle.capture());
    const controller = page.activeController;
    saveAnalysisContext('http://backend', getSmartPerfettoRequestContext(), {
      codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: [], sourceDepth: 'mechanism',
    });
    await page.ensureConversationRestored();
    expect(controller.signal.aborted).toBe(false);
    oldStream.enqueue(new TextEncoder().encode(
      'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"same run"}}\n\n'));
    oldStream.close();
    await run;
    expect(page.store.messages.map((message: any) => message.content)).toContain('same run');
    page.onremove();
  });

  it('drops a still-running stream immediately while reauthorizing a changed source context', async () => {
    let oldStream!: ReadableStreamDefaultController<Uint8Array>;
    const pendingRestore = deferredResponse();
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({start(controller) { oldStream = controller; }})))
      .mockReturnValueOnce(pendingRestore.promise);
    vi.stubGlobal('fetch', fetch);
    const page = createPage();
    await page.ensureConversationRestored();
    const store = {backendUrl: 'http://backend', sessionId: 'saved-conversation', activeRunId: 'active-run', messages: [], updatedAt: 1};
    saveConversationStore(store);
    const oldRun = page.resumeConversationRun(store, page.authLifecycle.capture());
    const oldController = page.activeController;
    saveAnalysisContext('http://backend', getSmartPerfettoRequestContext(), {
      codeAwareMode: 'metadata_only', codebaseIds: ['new-source'], knowledgeSourceIds: [],
    });
    const restore = page.ensureConversationRestored();
    expect(oldController.signal.aborted).toBe(true);
    oldStream.enqueue(new TextEncoder().encode(
      'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"old primary"}}\n\n'));
    oldStream.close();
    await oldRun;
    expect(page.store.messages).toEqual([]);
    expect(page.restorePromise).toBe(restore);
    const snapshot = await restoredPageConversation().json();
    snapshot.history = [];
    pendingRestore.resolve(new Response(JSON.stringify(snapshot), {status: 200}));
    await restore;
    expect(page.store.messages).toEqual([]);
    page.onremove();
  });

});

describe('ConversationPage noninterrupting controls', () => {
  function status(epoch = 'epoch-a') {
    return {success: true, work: {sessionId: 'session-a', runId: 'run-a', phase: 'running',
      startedAt: Date.now() - 15_000, hasResult: false,
      activity: {observation: 'partial', attempted: 3, returned: 2, inFlight: 1},
      captureActivity: {observation: 'observed', tables: 2, rowSlots: 9, unavailableTables: 1}},
      context: {availability: 'available', queueEpoch: epoch, pendingCount: 0, durability: 'process_memory'}};
  }
  async function preparedPage() {
    const page = createPage(); await page.ensureConversationRestored();
    page.store = {backendUrl: 'http://backend', sessionId: 'session-a', messages: [], updatedAt: Date.now()};
    page.activeReceipt = {sessionId: 'session-a', runId: 'run-a', isNewSession: false, traceContextAttached: false};
    page.activeController = new AbortController(); page.input = 'supplemental text';
    page.sessionControlBinding = {sessionId: 'session-a', sourceKey: analysisAuthorizationKey(loadAnalysisContext('http://backend', getSmartPerfettoRequestContext()))};
    return page;
  }
  it('refreshes phase, elapsed and observed activity without changing draft or stream', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(status()))); vi.stubGlobal('fetch', fetchMock);
    const page = await preparedPage(); const stream = page.activeController;
    await page.control('status');
    expect(page.activeController).toBe(stream); expect(stream.signal.aborted).toBe(false);
    expect(page.input).toBe('supplemental text'); expect(fetchMock).toHaveBeenCalledTimes(1);
    const rendered = renderPage(page).textContent!;
    expect(rendered).toMatch(/15/); expect(rendered).toMatch(/3/); expect(rendered).toMatch(/2/);
    expect(rendered).not.toMatch(/row slots|行槽/);
    page.onremove();
  });
  it('reuses an idempotency key after unknown network outcome and never interrupts the run', async () => {
    const bodies: Array<Record<string, string>> = [];
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/status')) return new Response(JSON.stringify(status()));
      if (String(url).endsWith('/context')) {
        const body = JSON.parse(String(init?.body)); bodies.push(body);
        if (bodies.length === 1) throw new Error('response lost');
        return new Response(JSON.stringify({success: true, sessionId: 'session-a', context: {...status().context, pendingCount: 1},
          receipt: {id: body.idempotencyKey, queueEpoch: body.expectedQueueEpoch, expectedRunId: body.expectedRunId,
            status: 'accepted', appliesTo: 'next_user_turn', durability: 'process_memory'}}));
      }
      return new Response('{}');
    }); vi.stubGlobal('fetch', fetchMock);
    const page = await preparedPage(); const stream = page.activeController;
    await page.control('context'); expect(page.input).toBe('supplemental text');
    await page.control('context'); expect(bodies[0]).toEqual(bodies[1]); expect(page.input).toBe('');
    expect(page.activeController).toBe(stream); expect(stream.signal.aborted).toBe(false);
    expect(page.store.messages).toEqual([]);
    expect(Object.keys(localStorage).map(key => localStorage.getItem(key)).join('')).not.toContain('supplemental text');
    page.onremove();
  });
  it('drops a stale epoch retry identity and permits a fresh explicit submission', async () => {
    let reads = 0; const epochs: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/status')) return new Response(JSON.stringify(status(`epoch-${++reads}`)));
      if (String(url).endsWith('/context')) {
        const body = JSON.parse(String(init?.body)); epochs.push(body.expectedQueueEpoch);
        if (epochs.length === 1) return new Response(JSON.stringify({code: 'CONVERSATION_CONTEXT_EXPIRED', error: 'Expired'}), {status: 409});
        return new Response(JSON.stringify({success: true, sessionId: 'session-a', context: {...status(body.expectedQueueEpoch).context, pendingCount: 1},
          receipt: {id: body.idempotencyKey, queueEpoch: body.expectedQueueEpoch, expectedRunId: body.expectedRunId,
            status: 'accepted', appliesTo: 'next_user_turn', durability: 'process_memory'}}));
      } return new Response('{}');
    }));
    const page = await preparedPage(); await page.control('context');
    expect(page.input).toBe('supplemental text'); expect(page.contextAttempt).toBeUndefined();
    await page.control('context'); expect(epochs).toEqual(['epoch-1', 'epoch-2']);
    page.onremove();
  });
});

describe('ConversationPage context lifetime notice', () => {
  it('replaces the accepted notice when a later status read cannot find the memory queue', async () => {
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).endsWith('/status')) return new Response(JSON.stringify({success: true,
        work: {sessionId: 's', runId: 'r', phase: 'unknown', hasResult: false},
        context: ++reads === 1 ? {availability: 'available', queueEpoch: 'e', pendingCount: 0, durability: 'process_memory'}
          : {availability: 'unavailable'}}));
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({success: true, sessionId: 's',
        context: {availability: 'available', queueEpoch: 'e', pendingCount: 1, durability: 'process_memory'},
        receipt: {id: body.idempotencyKey, queueEpoch: 'e', expectedRunId: 'r', status: 'accepted',
          appliesTo: 'next_user_turn', durability: 'process_memory'}}));
    }));
    const page = createPage(); await page.ensureConversationRestored();
    page.store = {backendUrl: 'http://backend', sessionId: 's', messages: [], updatedAt: Date.now()};
    page.sessionControlBinding = {sessionId: 's', sourceKey: analysisAuthorizationKey(loadAnalysisContext('http://backend', getSmartPerfettoRequestContext()))};
    page.input = 'a note'; await page.control('context');
    page.input = 'new draft'; await page.control('status');
    expect(page.controlStatus.context.availability).toBe('unavailable');
    expect(page.controlNotice).toMatch(/不表示.*读取|does not mean.*read/);
    expect(page.input).toBe('new draft'); page.onremove();
  });
});


describe('ConversationPage supplemental source binding', () => {
  async function boundPage() {
    const page = createPage(); await page.ensureConversationRestored();
    const scope = getSmartPerfettoRequestContext();
    saveAnalysisContext('http://backend', scope, {codeAwareMode: 'metadata_only', codebaseIds: ['source-a'], knowledgeSourceIds: []});
    page.store = {backendUrl: 'http://backend', sessionId: 's', messages: [], updatedAt: Date.now()};
    page.sessionControlBinding = {sessionId: 's', sourceKey: analysisAuthorizationKey(loadAnalysisContext('http://backend', scope))};
    page.input = 'keep this note'; return {page, scope};
  }
  it('does not post to the old session after the user selects different sources', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const {page, scope} = await boundPage();
    saveAnalysisContext('http://backend', scope, {codeAwareMode: 'metadata_only', codebaseIds: ['source-b'], knowledgeSourceIds: []});
    await page.control('context');
    expect(fetch).not.toHaveBeenCalled(); expect(page.input).toBe('keep this note');
    expect(page.controlError).toMatch(/尚未绑定|not bound/); page.onremove();
  });
  it('does not retry an uncertain old-source note after the selection changes', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/status')) return new Response(JSON.stringify({success: true,
        work: {sessionId: 's', runId: 'r', phase: 'running', hasResult: false},
        context: {availability: 'available', queueEpoch: 'e', pendingCount: 0, durability: 'process_memory'}}));
      throw new Error('response lost');
    }); vi.stubGlobal('fetch', fetch);
    const {page, scope} = await boundPage(); await page.control('context');
    expect(fetch).toHaveBeenCalledTimes(2); const attempt = page.contextAttempt;
    saveAnalysisContext('http://backend', scope, {codeAwareMode: 'metadata_only', codebaseIds: ['source-b'], knowledgeSourceIds: []});
    await page.control('context');
    expect(fetch).toHaveBeenCalledTimes(2); expect(page.contextAttempt).toEqual(attempt);
    expect(page.input).toBe('keep this note'); page.onremove();
  });
  it('requires an explicit admitted turn before supplementing an unbound restored locator', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const page = createPage(); await page.ensureConversationRestored();
    page.store = {backendUrl: 'http://backend', sessionId: 'restored', messages: [], updatedAt: Date.now()};
    page.input = 'note'; await page.control('context');
    expect(fetch).not.toHaveBeenCalled(); expect(page.input).toBe('note'); page.onremove();
  });
});

describe('ConversationPage restored supplemental binding', () => {
  it('binds authorized matching sources and supplements a restored active run without starting or cancelling it', async () => {
    const scope = getSmartPerfettoRequestContext();
    saveAnalysisContext('http://backend', scope, {codeAwareMode: 'metadata_only', codebaseIds: ['source-a'],
      knowledgeSourceIds: [], sourceDepth: 'mechanism', authorizationEpoch: 4});
    saveConversationStore({backendUrl: 'http://backend', sessionId: 'restored-active', messages: [], updatedAt: 1});
    const stream = deferredResponse();
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/stream?')) return stream.promise;
      if (String(url).endsWith('/status')) return new Response(JSON.stringify({success: true,
        work: {sessionId: 'restored-active', runId: 'active-r', phase: 'running', hasResult: false},
        context: {availability: 'available', queueEpoch: 'active-epoch', pendingCount: 0, durability: 'process_memory'}}));
      if (String(url).endsWith('/context')) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({success: true, sessionId: 'restored-active',
          context: {availability: 'available', queueEpoch: 'active-epoch', pendingCount: 1, durability: 'process_memory'},
          receipt: {id: body.idempotencyKey, queueEpoch: 'active-epoch', expectedRunId: 'active-r', status: 'accepted',
            appliesTo: 'next_user_turn', durability: 'process_memory'}}));
      }
      return new Response(JSON.stringify({success: true, sessionId: 'restored-active', status: 'running',
        history: [], historyOmittedMessages: 0, traceContext: {kind: 'none'}, activeRunId: 'active-r',
        sourceSelection: {codeAwareMode: 'metadata_only', codebaseIds: ['source-a'], knowledgeSourceIds: []}}));
    }); vi.stubGlobal('fetch', fetch);
    const page = createPage(); await page.ensureConversationRestored();
    const active = page.activeController;
    page.input = 'new note'; await page.control('context');
    expect(page.input).toBe(''); expect(page.activeController).toBe(active); expect(active.signal.aborted).toBe(false);
    const requests = fetch.mock.calls;
    expect(requests.filter(([, init]) => init?.method === 'POST').map(([url]) => String(url)))
      .toEqual([expect.stringContaining('/restored-active/context')]);
    const storedConversations = Object.keys(localStorage).filter(key => key.startsWith('smartperfetto-conversation'))
      .map(key => localStorage.getItem(key)).join('');
    expect(storedConversations).not.toContain('sourceSelection'); expect(storedConversations).not.toContain('source-a');
    stream.resolve(streamResponse()); await page.runSettlement.promise; page.onremove();
  });
});

describe('ConversationPage work overview continuation', () => {
  function selectedDetail(source = 'off') {
    return new Response(JSON.stringify({success: true, sessionId: 'selected-conversation', status: 'completed',
      traceContext: {kind: 'attached', traceId: 'selected-trace'}, history: [{role: 'assistant', content: 'Selected answer'}],
      historyOmittedMessages: 0, sourceSelection: {codeAwareMode: source, codebaseIds: source === 'off' ? [] : ['private-source'], knowledgeSourceIds: []}}));
  }
  it('keeps an explicit attached Trace, draft and source binding until the next user turn', async () => {
    const posts: any[] = [];
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/stream?')) return streamResponse();
      if (init?.method === 'POST') {posts.push(JSON.parse(String(init.body))); return startResponse('selected-conversation', 'next-run');}
      return selectedDetail();
    }); vi.stubGlobal('fetch', fetch);
    const page = createPage(); await page.ensureConversationRestored(); page.input = 'Keep my draft';
    await page.continueWorkConversation('selected-conversation', new AbortController().signal);
    expect(posts).toEqual([]); expect(page.input).toBe('Keep my draft'); expect(page.store.traceId).toBe('selected-trace');
    expect(renderPage(page).textContent).toMatch(/已附加 Trace|attached trace/);
    expect(page.sessionControlBinding.sessionId).toBe('selected-conversation'); await page.send();
    expect(posts).toEqual([expect.objectContaining({query: 'Keep my draft', sessionId: 'selected-conversation', traceId: 'selected-trace'})]);
    expect(Object.keys(localStorage).filter(key => key.startsWith('smartperfetto-conversation')).map(key => localStorage.getItem(key)).join(''))
      .not.toContain('sourceSelection'); page.onremove();
  });
  it('refuses continuation while a run or uncertain note is active without cancelling either', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const page = createPage(); await page.ensureConversationRestored(); page.input = 'draft';
    page.contextAttempt = {request: {text: 'uncertain note'}};
    await expect(page.continueWorkConversation('selected-conversation', new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); expect(page.contextAttempt.request.text).toBe('uncertain note'); expect(page.input).toBe('draft');
    page.contextAttempt = undefined; page.activeReceipt = {sessionId: 'current', runId: 'current-run'};
    await expect(page.continueWorkConversation('selected-conversation', new AbortController().signal)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled(); page.activeReceipt = undefined; page.onremove();
  });
  it('preserves current context and draft when selected sources do not match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => selectedDetail('metadata_only')));
    const page = createPage(); await page.ensureConversationRestored();
    page.store = {backendUrl: 'http://backend', sessionId: 'current', messages: [], updatedAt: 1}; page.input = 'draft';
    await expect(page.continueWorkConversation('selected-conversation', new AbortController().signal)).rejects.toThrow(/来源|sources/);
    expect(page.store.sessionId).toBe('current'); expect(page.input).toBe('draft');
    expect(loadAnalysisContext('http://backend', getSmartPerfettoRequestContext()).codebaseIds).toEqual([]); page.onremove();
  });
  it('does not bind a selected conversation after its explicit open is closed', async () => {
    const pending = deferredResponse(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const page = createPage(); await page.ensureConversationRestored(); page.input = 'draft';
    const controller = new AbortController(); const opening = page.continueWorkConversation('selected-conversation', controller.signal);
    controller.abort(); pending.resolve(selectedDetail());
    await expect(opening).rejects.toThrow(); expect(page.store.sessionId).toBeUndefined(); expect(page.input).toBe('draft'); page.onremove();
  });
  it.each(['abort', '503'])('keeps an explicit continuation when the old initial restore fails late (%s)', async (failure) => {
    saveConversationStore({backendUrl: 'http://backend', sessionId: 'old-conversation', messages: [], updatedAt: 1});
    let rejectOld!: (error: Error) => void; let resolveOld!: (response: Response) => void;
    const pending = new Promise<Response>((resolve, reject) => {resolveOld = resolve; rejectOld = reject;});
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(selectedDetail()));
    const page = createPage(); const oldRestore = page.ensureConversationRestored().catch(() => undefined);
    page.input = 'Preserved draft';
    await page.continueWorkConversation('selected-conversation', new AbortController().signal);
    if (failure === 'abort') rejectOld(new DOMException('Aborted', 'AbortError'));
    else resolveOld(new Response('', {status: 503}));
    await oldRestore;
    expect(page.store).toMatchObject({sessionId: 'selected-conversation', traceId: 'selected-trace',
      sourceSelection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []}});
    expect(page.sessionControlBinding.sessionId).toBe('selected-conversation');
    expect(page.explicitContinuationSessionId).toBe('selected-conversation');
    expect(page.input).toBe('Preserved draft'); page.onremove();
  });
  it.each(['owner', 'source'])('invalidates a captured overview authority before redraw on %s change', async (change) => {
    const page = createPage(); await page.ensureConversationRestored();
    const tree = page.view({attrs: {app: {} as App}});
    const overview = tree.children.find((child: any) => child.tag === AssistantWorkOverview);
    expect(overview.attrs.isCurrent()).toBe(true);
    if (change === 'owner') installOidcSession('user-b');
    else saveAnalysisContext('http://backend', getSmartPerfettoRequestContext(), {
      codeAwareMode: 'metadata_only', codebaseIds: ['new-source'], knowledgeSourceIds: [],
    });
    expect(overview.attrs.isCurrent()).toBe(false); page.onremove();
  });
});
