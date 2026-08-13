// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {beforeEach, describe, expect, it} from 'vitest';

import {
  getComparisonStateStorageKey,
  restoreComparisonState,
  saveComparisonState,
  type PersistedComparisonState,
} from './comparison_state_manager';
import {
  clearPersistedOverlays,
  getOverlayStorageKey,
  restoreOverlayTracks,
} from './track_overlay';
import {invalidateSmartPerfettoAuthSession} from '../../core/smartperfetto_auth';

function enableOidcIdentity(userId: string, workspaceId: string): void {
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: userId, email: `${userId}@example.test`},
    tenant: {id: 'tenant-oidc', name: 'Tenant'},
    workspace: {
      id: workspaceId,
      name: 'Personal Workspace',
      kind: 'personal',
    },
  };
}

function comparisonState(): PersistedComparisonState {
  return {
    primaryTraceId: 'trace-primary',
    primaryTraceName: 'primary.trace',
    primaryTraceFingerprint: 'primary-fingerprint',
    referenceTraceId: 'trace-reference',
    referenceTraceName: 'reference.trace',
    referenceTraceFingerprint: 'reference-fingerprint',
    activeView: 'primary',
    primaryBackendTraceId: 'backend-primary',
    referenceBackendTraceId: 'backend-reference',
    agentSessionId: 'agent-session-a',
    savedAt: Date.now(),
  };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('OIDC transient storage isolation', () => {
  it('keeps OIDC comparison identity in page memory instead of browser storage', () => {
    enableOidcIdentity('user-a', 'workspace-a');
    const userAKey = getComparisonStateStorageKey();
    saveComparisonState(comparisonState());

    expect(sessionStorage.getItem(userAKey)).toBeNull();
    expect(restoreComparisonState()).toMatchObject({
      primaryBackendTraceId: 'backend-primary',
      agentSessionId: 'agent-session-a',
    });

    enableOidcIdentity('user-b', 'workspace-b');
    expect(getComparisonStateStorageKey()).not.toBe(userAKey);
    expect(restoreComparisonState()).toBeNull();

    enableOidcIdentity('user-a', 'workspace-a');
    expect(restoreComparisonState()).toBeNull();
  });

  it('drops same-identity comparison state after auth generation changes', () => {
    enableOidcIdentity('user-generation', 'workspace-generation');
    saveComparisonState(comparisonState());

    invalidateSmartPerfettoAuthSession(false);
    enableOidcIdentity('user-generation', 'workspace-generation');

    expect(restoreComparisonState()).toBeNull();
  });

  it('does not restore OIDC overlays from either current or legacy session keys', async () => {
    enableOidcIdentity('user-overlay', 'workspace-overlay');
    const oidcKey = getOverlayStorageKey();
    const trace = {
      traceInfo: {uuid: 'trace-overlay'},
      currentWorkspace: {pinnedTracksNode: {children: []}},
    } as any;
    const payload = JSON.stringify({
      traceUuid: 'trace-overlay',
      overlays: {jank: {columns: ['ts', 'dur', 'name'], rows: []}},
    });
    sessionStorage.setItem(oidcKey, payload);
    sessionStorage.setItem('smartperfetto_overlay_data_v1', payload);

    await restoreOverlayTracks(trace);

    expect(sessionStorage.getItem(oidcKey)).toBeNull();
    expect(sessionStorage.getItem('smartperfetto_overlay_data_v1')).toBeNull();
    clearPersistedOverlays();
  });

  it('keeps overlay storage user-scoped in OIDC and unchanged in local mode', () => {
    expect(getOverlayStorageKey()).toBe('smartperfetto_overlay_data_v1');

    enableOidcIdentity('user-a', 'workspace-a');
    const userAKey = getOverlayStorageKey();
    expect(userAKey).toContain('tenant-oidc:user-a:workspace-a');

    enableOidcIdentity('user-b', 'workspace-b');
    expect(getOverlayStorageKey()).not.toBe(userAKey);
  });
});
