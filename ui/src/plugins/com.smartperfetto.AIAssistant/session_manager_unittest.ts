// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {
  type AISession,
  type AISettings,
  DEFAULT_SETTINGS,
  HISTORY_KEY,
  PENDING_BACKEND_TRACE_KEY,
  SESSIONS_KEY,
  SETTINGS_KEY,
} from './types';
import {
  SessionManager,
  getHistoryStorageKey,
  getPendingBackendTraceStorageKey,
  getSettingsStorageKey,
  getSessionsStorageKey,
} from './session_manager';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {setSmartPerfettoWorkspaceId} from '../../core/smartperfetto_request_context';

function makeSession(sessionId: string, fingerprint: string): AISession {
  return {
    sessionId,
    traceFingerprint: fingerprint,
    traceName: `${fingerprint}.perfetto-trace`,
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
    messages: [],
    pinnedResults: [],
    bookmarks: [],
  };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  setSmartPerfettoWorkspaceId('default-workspace');
});

function enableOidcSession(): void {
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: 'user-oidc', email: 'user@example.com'},
    tenant: {id: 'tenant-oidc', name: 'Tenant'},
    workspace: {
      id: 'workspace-oidc',
      name: 'Personal Workspace',
      kind: 'personal',
    },
    csrfToken: 'csrf-oidc',
  };
}

describe('SessionManager UI language settings', () => {
  it('loads explicit language preferences and normalizes invalid persisted data', () => {
    localStorage.setItem(
      getSettingsStorageKey(),
      JSON.stringify({...DEFAULT_SETTINGS, uiLanguage: 'en'}),
    );
    expect(new SessionManager().loadSettings().uiLanguage).toBe('en');

    localStorage.setItem(
      getSettingsStorageKey(),
      JSON.stringify({...DEFAULT_SETTINGS, uiLanguage: 'invalid'}),
    );
    expect(new SessionManager().loadSettings().uiLanguage).toBe('auto');
    expect(
      JSON.parse(localStorage.getItem(getSettingsStorageKey()) || '{}')
        .uiLanguage,
    ).toBe('auto');

    localStorage.setItem(
      getSettingsStorageKey(),
      JSON.stringify({...DEFAULT_SETTINGS, uiLanguage: undefined}),
    );
    expect(new SessionManager().loadSettings().uiLanguage).toBe('auto');
    expect(
      JSON.parse(localStorage.getItem(getSettingsStorageKey()) || '{}')
        .uiLanguage,
    ).toBe('auto');
  });

  it('normalizes language preferences before saving settings', () => {
    const manager = new SessionManager();
    manager.saveSettings({
      ...DEFAULT_SETTINGS,
      uiLanguage: 'invalid',
    } as unknown as AISettings);

    expect(
      JSON.parse(localStorage.getItem(getSettingsStorageKey()) || '{}')
        .uiLanguage,
    ).toBe('auto');
  });

  it('preserves the configured backend verbatim outside OIDC mode', () => {
    const manager = new SessionManager();
    manager.saveSettings({
      ...DEFAULT_SETTINGS,
      backendUrl: 'http://localhost:9002',
      backendApiKey: 'local-api-key',
    });

    expect(
      JSON.parse(localStorage.getItem(getSettingsStorageKey()) || '{}'),
    ).toMatchObject({
      backendUrl: 'http://localhost:9002',
      backendApiKey: 'local-api-key',
    });
  });
});

describe('SessionManager pending backend trace storage', () => {
  it('stores pending backend traces under a workspace and window-scoped sessionStorage key', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');
    const manager = new SessionManager();

    manager.storePendingBackendTrace('trace-a', 9814);

    const key = getPendingBackendTraceStorageKey('window-a');
    expect(key).toBe(
      'smartperfetto-pending-backend-trace:default-dev-tenant:dev-user-123:default-workspace:window-a',
    );
    expect(sessionStorage.getItem(key)).toContain('trace-a');
    expect(localStorage.getItem(PENDING_BACKEND_TRACE_KEY)).toBeNull();
    expect(manager.recoverPendingBackendTrace(9814)).toBe('trace-a');
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('does not recover another window pending trace', () => {
    const manager = new SessionManager();
    sessionStorage.setItem(
      getPendingBackendTraceStorageKey('window-a'),
      JSON.stringify({traceId: 'trace-a', port: 9815, timestamp: Date.now()}),
    );
    sessionStorage.setItem('smartperfetto-window-id', 'window-b');

    expect(manager.recoverPendingBackendTrace(9815)).toBeNull();
    expect(
      sessionStorage.getItem(getPendingBackendTraceStorageKey('window-a')),
    ).toContain('trace-a');
  });

  it('recovers pending backend traces by lease id for proxy mode', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');
    const manager = new SessionManager();

    manager.storePendingBackendTrace('trace-lease', undefined, 'lease-a');

    expect(manager.recoverPendingBackendTrace(undefined, 'lease-a')).toBe(
      'trace-lease',
    );
  });
});

describe('SessionManager OIDC storage isolation', () => {
  it('does not import unscoped local-mode data into a new OIDC identity', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-oidc');
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({...DEFAULT_SETTINGS, backendUrl: 'http://legacy-backend', uiLanguage: 'en'}),
    );
    localStorage.setItem(HISTORY_KEY, JSON.stringify([{role: 'user', content: 'legacy'}]));
    localStorage.setItem(
      SESSIONS_KEY,
      JSON.stringify({byTrace: {legacy: [makeSession('legacy-session', 'legacy')]}}),
    );
    localStorage.setItem('ai-analysis-mode', 'full');
    sessionStorage.setItem(
      `${PENDING_BACKEND_TRACE_KEY}:window-oidc`,
      JSON.stringify({traceId: 'legacy-window-trace', port: 9814, timestamp: Date.now()}),
    );
    localStorage.setItem(
      PENDING_BACKEND_TRACE_KEY,
      JSON.stringify({traceId: 'legacy-trace', port: 9814, timestamp: Date.now()}),
    );
    enableOidcSession();

    const manager = new SessionManager();
    expect(manager.loadSettings().backendUrl).not.toBe('http://legacy-backend');
    expect(manager.loadSettings().uiLanguage).toBe('auto');
    expect(manager.loadLegacyHistory()).toBeNull();
    expect(manager.loadAnalysisMode()).toBe('conversation');
    expect(manager.loadSessionsStorage()).toEqual({byTrace: {}});
    expect(manager.recoverPendingBackendTrace(9814)).toBeNull();
  });

  it('forces the runtime backend and removes backend credentials from scoped settings', () => {
    enableOidcSession();
    localStorage.setItem(
      getSettingsStorageKey(),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        backendUrl: 'https://untrusted.example.test',
        backendApiKey: 'stale-api-key',
        uiLanguage: 'en',
      }),
    );

    const manager = new SessionManager();
    const loaded = manager.loadSettings();
    expect(loaded.backendUrl).toBe(getDefaultSmartPerfettoBackendUrl());
    expect(loaded.backendApiKey).toBe('');
    expect(loaded.uiLanguage).toBe('en');

    manager.saveSettings({
      ...loaded,
      backendUrl: 'https://another-untrusted.example.test',
      backendApiKey: 'must-not-persist',
    });
    const persisted = JSON.parse(
      localStorage.getItem(getSettingsStorageKey()) || '{}',
    );
    expect(persisted.backendUrl).toBe(getDefaultSmartPerfettoBackendUrl());
    expect(persisted.backendApiKey).toBe('');
  });
});

describe('SessionManager analysis mode', () => {
  it('defaults new workspaces to conversation mode', () => {
    expect(new SessionManager().loadAnalysisMode()).toBe('conversation');
  });

  it('persists and restores the last explicitly selected mode', () => {
    const manager = new SessionManager();
    manager.saveAnalysisMode('full');
    expect(new SessionManager().loadAnalysisMode()).toBe('full');
  });
});

describe('SessionManager private message persistence', () => {
  it('projects marked private user content in legacy history and AISession storage', () => {
    const privateCanary = 'private-query-canary-must-not-persist';
    const privateMessage = {
      id: 'private-user-message',
      role: 'user' as const,
      content: privateCanary,
      timestamp: Date.now(),
      privateContent: true,
    };
    const manager = new SessionManager();

    manager.saveHistory([privateMessage], null, 'trace-private');
    const session = makeSession('private-session', 'trace-private');
    session.messages = [privateMessage];
    manager.saveSessionsStorage({byTrace: {'trace-private': [session]}});

    const legacyRaw = localStorage.getItem(getHistoryStorageKey()) || '';
    const sessionsRaw = localStorage.getItem(getSessionsStorageKey()) || '';
    expect(legacyRaw).not.toContain(privateCanary);
    expect(sessionsRaw).not.toContain(privateCanary);
    expect(legacyRaw).toContain('PRIVATE_QUERY_REFERENCE');
    expect(sessionsRaw).toContain('PRIVATE_QUERY_REFERENCE');
  });
});

describe('SessionManager session storage CAS', () => {
  it('merges stale read-modify-write saves instead of overwriting concurrent sessions', () => {
    const firstWindow = new SessionManager();
    const secondWindow = new SessionManager();

    const firstSnapshot = firstWindow.loadSessionsStorage();
    const secondSnapshot = secondWindow.loadSessionsStorage();

    firstSnapshot.byTrace['trace-a'] = [makeSession('session-a', 'trace-a')];
    firstWindow.saveSessionsStorage(firstSnapshot);

    secondSnapshot.byTrace['trace-b'] = [makeSession('session-b', 'trace-b')];
    secondWindow.saveSessionsStorage(secondSnapshot);

    const merged = new SessionManager().loadSessionsStorage();
    expect(merged.byTrace['trace-a'].map((s) => s.sessionId)).toEqual([
      'session-a',
    ]);
    expect(merged.byTrace['trace-b'].map((s) => s.sessionId)).toEqual([
      'session-b',
    ]);

    const raw = localStorage.getItem(getSessionsStorageKey());
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw || '{}')._meta.revision).toBeGreaterThanOrEqual(2);
  });

  it('keeps cached sessions isolated by workspace', () => {
    setSmartPerfettoWorkspaceId('workspace-a');
    const firstWorkspace = new SessionManager();
    const firstStorage = firstWorkspace.loadSessionsStorage();
    firstStorage.byTrace['trace-a'] = [makeSession('session-a', 'trace-a')];
    firstWorkspace.saveSessionsStorage(firstStorage);
    const workspaceAKey = getSessionsStorageKey();

    setSmartPerfettoWorkspaceId('workspace-b');
    const secondWorkspace = new SessionManager();
    const secondStorage = secondWorkspace.loadSessionsStorage();
    secondStorage.byTrace['trace-b'] = [makeSession('session-b', 'trace-b')];
    secondWorkspace.saveSessionsStorage(secondStorage);
    const workspaceBKey = getSessionsStorageKey();

    expect(
      JSON.parse(localStorage.getItem(workspaceAKey) || '{}').byTrace,
    ).toEqual({
      'trace-a': [expect.objectContaining({sessionId: 'session-a'})],
    });
    expect(
      JSON.parse(localStorage.getItem(workspaceBKey) || '{}').byTrace,
    ).toEqual({
      'trace-b': [expect.objectContaining({sessionId: 'session-b'})],
    });
  });

  it('clears stale raw trace comparison identity when a session returns to single trace', () => {
    const manager = new SessionManager();
    const session = manager.createSession(
      'trace-a',
      'current.trace',
      'backend-a',
    );

    manager.updateSession('trace-a', session.sessionId, {
      type: 'comparison',
      referenceBackendTraceId: 'backend-b',
      referenceTraceName: 'reference.trace',
      tracePairLayout: 'vertical',
      tracePairSplitPercent: 67,
      tracePairActiveTraceSide: 'reference',
      tracePairCurrentPane: 'second',
    });
    expect(manager.loadSession(session.sessionId)).toEqual(
      expect.objectContaining({
        type: 'comparison',
        referenceBackendTraceId: 'backend-b',
        tracePairLayout: 'vertical',
        tracePairCurrentPane: 'second',
      }),
    );

    manager.updateSession('trace-a', session.sessionId, {
      type: 'single',
      referenceBackendTraceId: undefined,
      referenceTraceName: undefined,
      tracePairLayout: undefined,
      tracePairSplitPercent: undefined,
      tracePairActiveTraceSide: undefined,
      tracePairCurrentPane: undefined,
    });

    const restored = manager.loadSession(session.sessionId);
    expect(restored).toEqual(expect.objectContaining({type: 'single'}));
    expect(restored).not.toHaveProperty('referenceBackendTraceId');
    expect(restored).not.toHaveProperty('tracePairLayout');
    expect(restored).not.toHaveProperty('tracePairCurrentPane');
  });
});
