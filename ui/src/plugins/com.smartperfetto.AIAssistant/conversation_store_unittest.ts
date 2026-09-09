// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  buildSmartPerfettoStorageKey,
  setSmartPerfettoWorkspaceId,
} from '../../core/smartperfetto_request_context';
import {
  appendConversationMessage,
  clearConversationRuntimeIdentities,
  loadConversationStore,
  saveConversationStore,
  clearConversationStore,
  restoreConversationStore,
  conversationMessageContent,
  conversationRecoveryNotice,
  updateConversationMessageSourceEnrichment,
} from './conversation_store';
import {invalidateSmartPerfettoAuthSession} from '../../core/smartperfetto_auth';

beforeEach(() => {
  clearConversationRuntimeIdentities();
  localStorage.clear();
  setSmartPerfettoWorkspaceId('default-workspace');
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearConversationRuntimeIdentities();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('conversation store private message persistence', () => {
  it('updates source enrichment independently from the primary message', () => {
    const backendUrl = 'http://localhost:9000';
    appendConversationMessage(backendUrl, {
      id: 'assistant-message',
      role: 'assistant',
      content: 'Primary answer',
      timestamp: Date.now(),
    });

    updateConversationMessageSourceEnrichment(backendUrl, 'assistant-message', {
      status: 'running',
    });
    expect(loadConversationStore(backendUrl).messages[0]).toMatchObject({
      content: 'Primary answer',
      sourceEnrichment: {status: 'running'},
    });

    updateConversationMessageSourceEnrichment(backendUrl, 'assistant-message', {
      status: 'completed',
      message: 'Source supplement',
      evidence: [{id: 'source-1', label: 'Foo.kt:L10-L12'}],
      metrics: {searchCalls: 1, readCalls: 2, durationMs: 40},
    });
    expect(loadConversationStore(backendUrl).messages[0]).toMatchObject({
      content: 'Primary answer',
      sourceEnrichment: {
        status: 'completed',
        message: 'Source supplement',
      },
    });
  });

  it('keeps raw private query content in memory only', () => {
    const backendUrl = 'http://localhost:9000';
    const privateCanary = 'conversation-private-canary-must-not-persist';

    const inMemory = appendConversationMessage(backendUrl, {
      id: 'private-message',
      role: 'user',
      content: privateCanary,
      timestamp: Date.now(),
      privateContent: true,
    });

    const persisted = loadConversationStore(backendUrl);
    const allStorage = Array.from({length: localStorage.length}, (_, index) => (
      localStorage.getItem(localStorage.key(index) || '') || ''
    )).join('\n');
    expect(inMemory.messages[0].content).toBe(privateCanary);
    expect(allStorage).not.toContain(privateCanary);
    expect(persisted.messages[0].content).toContain('PRIVATE_QUERY_REFERENCE');
  });

  it('persists only a scoped logical locator while keeping active OIDC bindings in memory', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'conversation-user', email: 'user@example.test'},
      tenant: {id: 'conversation-tenant', name: 'Tenant'},
      workspace: {id: 'conversation-workspace', name: 'Workspace', kind: 'personal'},
    };
    const backendUrl = 'http://localhost:9000';

    const inMemory = appendConversationMessage(backendUrl, {
      id: 'message-1',
      role: 'user',
      content: 'Explain scheduling latency.',
      timestamp: Date.now(),
    }, 'conversation-session-id');

    expect(inMemory.sessionId).toBe('conversation-session-id');
    expect(loadConversationStore(backendUrl).sessionId).toBe(
      'conversation-session-id',
    );
    const rawStorage = Array.from({length: localStorage.length}, (_, index) => (
      localStorage.getItem(localStorage.key(index) || '') || ''
    )).join('\n');
    expect(rawStorage).toContain('Explain scheduling latency.');
    expect(rawStorage).toContain('conversation-session-id');
    expect(rawStorage).not.toContain('\"sessionId\"');
    clearConversationRuntimeIdentities();
    expect(loadConversationStore(backendUrl).sessionId).toBeUndefined();
    expect(loadConversationStore(backendUrl).conversationId).toBe('conversation-session-id');

    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  });

  it('removes legacy OIDC continuation identity while retaining narrative text', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'legacy-user', email: 'user@example.test'},
      tenant: {id: 'legacy-tenant', name: 'Tenant'},
      workspace: {id: 'legacy-workspace', name: 'Workspace', kind: 'personal'},
    };
    const backendUrl = 'http://localhost:9000';
    const key = buildSmartPerfettoStorageKey(
      'smartperfetto-conversation',
      'workspace',
    );
    localStorage.setItem(key, JSON.stringify({
      backendUrl,
      sessionId: 'legacy-conversation-session',
      traceId: 'legacy-backend-trace',
      messages: [{
        id: 'legacy-message',
        role: 'assistant',
        content: 'Narrative text must remain available.',
        timestamp: Date.now(),
      }],
      updatedAt: Date.now(),
    }));

    const restored = loadConversationStore(backendUrl);

    expect(restored.sessionId).toBeUndefined();
    expect(restored.traceId).toBeUndefined();
    expect(restored.messages).toEqual([]);
    expect(localStorage.getItem(key)).toContain('Narrative text must remain available.');
    const cleaned = localStorage.getItem(key) || '';
    expect(cleaned).not.toContain('legacy-conversation-session');
    expect(cleaned).not.toContain('legacy-backend-trace');

    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  });

  it('removes OIDC runtime identity after authority invalidation', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-a', email: 'user-a@example.test'},
      tenant: {id: 'tenant-a', name: 'Tenant A'},
      workspace: {id: 'workspace-a', name: 'Workspace A', kind: 'personal'},
    };
    const backendUrl = 'http://localhost:9000';
    appendConversationMessage(backendUrl, {
      id: 'message-a',
      role: 'user',
      content: 'durable narrative',
      timestamp: Date.now(),
    }, 'runtime-session-a');
    expect(loadConversationStore(backendUrl).sessionId).toBe('runtime-session-a');

    invalidateSmartPerfettoAuthSession(false);
    clearConversationRuntimeIdentities();
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-b', email: 'user-b@example.test'},
      tenant: {id: 'tenant-a', name: 'Tenant A'},
      workspace: {id: 'workspace-b', name: 'Workspace B', kind: 'personal'},
    };

    expect(loadConversationStore(backendUrl).sessionId).toBeUndefined();
    const rawStorage = Array.from({length: localStorage.length}, (_, index) => (
      localStorage.getItem(localStorage.key(index) || '') || ''
    )).join('\n');
    expect(rawStorage).toContain('runtime-session-a');
    expect(loadConversationStore(backendUrl).conversationId).toBeUndefined();

    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  });
});

function installOwner(tenantId: string, userId: string, workspaceId: string): void {
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true, authenticated: true, authMode: 'oidc', status: 'ready',
    user: {id: userId, email: 'test@example.test'}, tenant: {id: tenantId, name: tenantId},
    workspace: {id: workspaceId, name: workspaceId, kind: 'personal'},
  };
}

function seedConversation(backendUrl = 'http://backend'): void {
  saveConversationStore({
    backendUrl, sessionId: 'logical-conversation', traceId: 'runtime-trace-handle',
    updatedAt: 1, messages: [{id: 'cached', role: 'assistant', content: 'cached text', timestamp: 1}],
  });
}

function restoredResponse(): Response {
  return new Response(JSON.stringify({
    success: true, sessionId: 'logical-conversation', status: 'idle',
    traceContext: {kind: 'none'}, historyOmittedMessages: 0,
    recoveryStatus: 'interrupted',
    history: [{role: 'assistant', content: 'authorized private answer', sourceDerived: true,
      turnId: 'turn-1', turn: {
        id: 'turn-1', turnIndex: 0, partial: true, completionStatus: 'incomplete',
        terminationReason: 'turn_limit', uncertainties: ['GPU fence unavailable'],
        nextSteps: ['Check fence evidence'], evidence: [],
      }}],
  }), {status: 200});
}

describe('conversation restoration authority', () => {
  it('isolates owner tuples even when the old colon namespace would collide', () => {
    installOwner('tenant:a', 'user', 'workspace');
    seedConversation();
    installOwner('tenant', 'a:user', 'workspace');
    expect(loadConversationStore('http://backend').conversationId).toBeUndefined();
    expect(loadConversationStore('http://backend').messages).toEqual([]);
    installOwner('tenant:a', 'user', 'workspace');
    expect(loadConversationStore('http://backend').conversationId).toBe('logical-conversation');
  });

  it('normalizes trailing slashes but never reuses another backend or workspace', () => {
    installOwner('tenant', 'user', 'workspace');
    seedConversation('http://backend///');
    expect(loadConversationStore('http://backend').conversationId).toBe('logical-conversation');
    expect(loadConversationStore('http://other').conversationId).toBeUndefined();
    installOwner('tenant', 'user', 'other-workspace');
    expect(loadConversationStore('http://backend').conversationId).toBeUndefined();
    const allStorage = Array.from({length: localStorage.length}, (_, index) => localStorage.getItem(localStorage.key(index)!)!).join('');
    expect(allStorage).not.toContain('runtime-trace-handle');
  });

  it('reauthorizes history, preserves partial metadata, and projects private bodies for storage', async () => {
    seedConversation();
    clearConversationRuntimeIdentities();
    const fetch = vi.fn().mockResolvedValue(restoredResponse());
    vi.stubGlobal('fetch', fetch);
    const restored = await restoreConversationStore({backendUrl: 'http://backend'});
    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0][0])).toContain('/conversation/logical-conversation');
    expect(restored).toMatchObject({sessionId: 'logical-conversation', recoveryStatus: 'interrupted'});
    expect(conversationMessageContent(restored.messages[0])).toContain('turn_limit');
    expect(conversationMessageContent(restored.messages[0])).toContain('GPU fence unavailable');
    expect(conversationMessageContent(restored.messages[0])).toContain('authorized private answer');
    const cached = loadConversationStore('http://backend').messages[0];
    expect(cached.content).toContain('PRIVATE_QUERY_REFERENCE');
    expect(cached.turn).toBeUndefined();
  });

  it('shares one in-flight GET and discards a late response after New Chat', async () => {
    seedConversation();
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const first = restoreConversationStore({backendUrl: 'http://backend'});
    const second = restoreConversationStore({backendUrl: 'http://backend/'});
    expect(second).toBe(first);
    clearConversationStore('http://backend');
    resolve(restoredResponse());
    await expect(first).rejects.toThrow('invalidated');
    expect(loadConversationStore('http://backend')).toMatchObject({messages: []});
    expect(loadConversationStore('http://backend').conversationId).toBeUndefined();
  });

  it('does not save a response after the selected source context changes', async () => {
    seedConversation();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(restoredResponse()));
    await expect(restoreConversationStore({backendUrl: 'http://backend'}, () => false))
      .rejects.toThrow('invalidated');
    expect(loadConversationStore('http://backend').messages[0].content).toBe('cached text');
  });
});

describe('conversation completion notices', () => {
  it('reports recovery persistence failure without marking the received answer incomplete', () => {
    const content = conversationMessageContent({
      id: 'answer', role: 'assistant', timestamp: 1, content: 'Received answer', recoveryStatus: 'unavailable',
    });
    expect(content).toContain('Received answer');
    expect(content).not.toMatch(/结果完整性提示|Result completeness notice/);
    expect(content).toMatch(/后端重启|backend restart/);
  });
});

describe('conversation history permission omissions', () => {
  it('retains only the unavailable count without restoring cached denied source bodies', async () => {
    saveConversationStore({backendUrl: 'http://backend', sessionId: 'logical-conversation', updatedAt: 1,
      messages: [{id: 'denied-source', role: 'assistant', content: 'denied source canary', timestamp: 1}]});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, sessionId: 'logical-conversation', status: 'idle',
      traceContext: {kind: 'none'}, history: [], historyOmittedMessages: 0,
      historyUnavailableMessages: 2, recoveryStatus: 'available',
    }), {status: 200})));
    const restored = await restoreConversationStore({backendUrl: 'http://backend'});
    expect(restored.messages).toEqual([]);
    expect(restored.historyUnavailableMessages).toBe(2);
    const cached = loadConversationStore('http://backend');
    expect(cached.messages).toEqual([]);
    expect(cached.historyUnavailableMessages).toBe(2);
    const notice = conversationRecoveryNotice(restored.recoveryStatus, restored.historyUnavailableMessages);
    expect(notice).toMatch(/部分来源历史当前不可读取|Some source history is currently unavailable/);
    expect(notice).not.toContain('denied source canary');
    const allStorage = Array.from({length: localStorage.length}, (_, index) => localStorage.getItem(localStorage.key(index)!)!).join('');
    expect(allStorage).not.toContain('denied source canary');
  });
});

describe('restored conversation mutation and projection', () => {
  it('keeps authorized private body and turn metadata through append and enrichment', async () => {
    seedConversation();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(restoredResponse()));
    const restored = await restoreConversationStore({backendUrl: 'http://backend'});
    const appended = appendConversationMessage('http://backend', {
      id: 'follow-up', role: 'user', content: 'follow up', timestamp: 2,
    }, restored.sessionId);
    expect(appended.messages[0]).toMatchObject({content: 'authorized private answer', turn: {partial: true}});
    const updated = updateConversationMessageSourceEnrichment('http://backend', restored.messages[0].id, {status: 'running'});
    expect(updated.messages[0]).toMatchObject({content: 'authorized private answer', turn: {partial: true}});
    expect(loadConversationStore('http://backend').messages[0].content).toContain('PRIVATE_QUERY_REFERENCE');
  });

  it('hydrates the backend boolean recommendation separately from its handoff object', async () => {
    seedConversation();
    const snapshot = await restoredResponse().json();
    snapshot.recommendedFullAnalysis = true;
    snapshot.fullHandoff = {question: 'check scheduling', scope: 'main thread', assumptions: ['trace required'], evidence: []};
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(snapshot), {status: 200})));
    const restored = await restoreConversationStore({backendUrl: 'http://backend'});
    expect(restored.messages[0].fullHandoff).toEqual(snapshot.fullHandoff);
    expect(restored.messages[0].fullHandoff?.assumptions.join('; ')).toBe('trace required');
  });

  it('keeps completeness notices off user questions and localizes a known interruption', () => {
    const turn = {id: 'interrupted', turnIndex: 0, partial: true, completionStatus: 'incomplete' as const,
      terminationMessage: 'conversation_run_interrupted_before_final_commit', uncertainties: [], nextSteps: [], evidence: []};
    expect(conversationMessageContent({id: 'question', role: 'user', content: 'My question', timestamp: 1, turn})).toBe('My question');
    const answer = conversationMessageContent({id: 'answer', role: 'assistant', content: 'Partial answer', timestamp: 1, turn});
    expect(answer).not.toContain('conversation_run_interrupted_before_final_commit');
    expect(answer).toMatch(/保存最终结论前被中断|interrupted before its final conclusion was saved/);
  });
});
