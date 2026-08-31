// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {
  buildSmartPerfettoStorageKey,
  setSmartPerfettoWorkspaceId,
} from '../../core/smartperfetto_request_context';
import {
  appendConversationMessage,
  clearConversationRuntimeIdentities,
  loadConversationStore,
  updateConversationMessageSourceEnrichment,
} from './conversation_store';
import {invalidateSmartPerfettoAuthSession} from '../../core/smartperfetto_auth';

beforeEach(() => {
  localStorage.clear();
  setSmartPerfettoWorkspaceId('default-workspace');
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

  it('keeps OIDC continuation identity in page memory only', () => {
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
    expect(rawStorage).not.toContain('conversation-session-id');

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
    expect(restored.messages[0].content).toBe(
      'Narrative text must remain available.',
    );
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
    expect(rawStorage).not.toContain('runtime-session-a');

    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  });
});
