// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {AISession, PENDING_BACKEND_TRACE_KEY} from './types';
import {
  SessionManager,
  getPendingBackendTraceStorageKey,
  getSessionsStorageKey,
} from './session_manager';
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
    expect(merged.byTrace['trace-a'].map(s => s.sessionId)).toEqual([
      'session-a',
    ]);
    expect(merged.byTrace['trace-b'].map(s => s.sessionId)).toEqual([
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
});
