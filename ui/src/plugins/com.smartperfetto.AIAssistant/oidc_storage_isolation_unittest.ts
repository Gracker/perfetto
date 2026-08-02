// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {beforeEach, describe, expect, it} from 'vitest';

import {
  getComparisonStateStorageKey,
  restoreComparisonState,
  saveComparisonState,
  type PersistedComparisonState,
} from './comparison_state_manager';
import {getOverlayStorageKey} from './track_overlay';

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
  it('keeps comparison state inside the authenticated workspace namespace', () => {
    enableOidcIdentity('user-a', 'workspace-a');
    const userAKey = getComparisonStateStorageKey();
    saveComparisonState(comparisonState());

    enableOidcIdentity('user-b', 'workspace-b');
    expect(getComparisonStateStorageKey()).not.toBe(userAKey);
    expect(restoreComparisonState()).toBeNull();

    enableOidcIdentity('user-a', 'workspace-a');
    expect(restoreComparisonState()).toMatchObject({
      primaryBackendTraceId: 'backend-primary',
      agentSessionId: 'agent-session-a',
    });
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
