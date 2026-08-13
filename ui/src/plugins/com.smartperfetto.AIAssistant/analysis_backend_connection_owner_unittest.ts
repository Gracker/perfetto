// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  backendUploadSourceKey,
  getBackendUploadIdentityKey,
  setDefaultBackendUrl,
} from '../../core/backend_uploader';
import {
  getBackendUploadState,
  setBackendUploadState,
} from '../../core/backend_upload_state';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AnalysisBackendConnectionOwner} from './analysis_backend_connection_owner';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

describe('AnalysisBackendConnectionOwner', () => {
  const source = {
    type: 'ARRAY_BUFFER' as const,
    buffer: new Uint8Array([1, 2, 3]).buffer,
    fileName: 'current.trace',
    title: 'current.trace',
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-a', email: 'user-a@example.test'},
      tenant: {id: 'tenant-a', name: 'Tenant A'},
      workspace: {id: 'workspace-a', name: 'Workspace A', kind: 'personal'},
      csrfToken: 'csrf-a',
    };
    setDefaultBackendUrl('http://backend');
    setBackendUploadState({state: 'idle'});
    HttpRpcEngine.useDirectPort('9001');

  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    setBackendUploadState({state: 'idle'});
    HttpRpcEngine.useDirectPort('9001');
  });

  it('promotes only the matching upload candidate through the scoped connection', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      status: 'ready',
      traceId: 'trace-current',
      leaseId: 'lease-current',
    }));
    const owner = new AnalysisBackendConnectionOwner('http://backend', source);
    owner.start();

    setBackendUploadState({
      backendIdentityKey: 'other-identity',
      uploadToken: 'other-upload',
      sourceKey: 'other-source',
      state: 'ready',
      traceId: 'trace-other',
      leaseId: 'lease-other',
    });
    expect(owner.connection.getSnapshot().state).toBe('preparing');

    const sourceKey = backendUploadSourceKey(source);
    setBackendUploadState({
      backendIdentityKey: getBackendUploadIdentityKey('http://backend', sourceKey),
      uploadToken: 'current-upload',
      sourceKey,
      state: 'ready',
      traceId: 'trace-current',
      leaseId: 'lease-current',
      rpcTarget: {
        mode: 'backend-lease-proxy',
        targetOwner: 'smartperfetto-backend',
        leaseId: 'lease-current',
        statusUrl: 'http://backend/status',
        websocketUrl: 'ws://backend/websocket',
        heartbeatUrl: 'http://backend/heartbeat',
        credentials: 'include',
      },
    });
    await vi.waitFor(() => {
      expect(owner.connection.getSnapshot()).toMatchObject({
        state: 'ready',
        traceId: 'trace-current',
        leaseId: 'lease-current',
      });
    });
    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'direct-port',
      targetOwner: 'user',
      port: '9001',
    });

    owner.dispose();
    expect(getBackendUploadState()).toMatchObject({state: 'idle'});
    expect(getBackendUploadState().uploadToken).toMatch(/^invalidated-/);
  });

  it('does not invalidate a newer candidate created after the owner upload', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({status: 'ready'}));
    const owner = new AnalysisBackendConnectionOwner('http://backend', source);
    owner.start();
    const sourceKey = backendUploadSourceKey(source);
    const backendIdentityKey = getBackendUploadIdentityKey('http://backend', sourceKey);
    const rpcTarget = {
      mode: 'backend-lease-proxy' as const,
      targetOwner: 'smartperfetto-backend' as const,
      leaseId: 'lease-owner',
      statusUrl: 'http://backend/status',
      websocketUrl: 'http://backend/websocket',
      heartbeatUrl: 'http://backend/heartbeat',
      credentials: 'include' as const,
    };

    setBackendUploadState({
      backendIdentityKey,
      uploadToken: 'owner-upload',
      sourceKey,
      state: 'ready',
      traceId: 'trace-owner',
      leaseId: 'lease-owner',
      rpcTarget,
    });
    await vi.waitFor(() => {
      expect(owner.connection.getSnapshot().state).toBe('ready');
    });

    // Model a stale lifecycle callback that has stopped receiving updates but
    // has not reached its final trace teardown yet.
    (owner as any).unsubscribeUpload?.();

    setBackendUploadState({
      backendIdentityKey,
      uploadToken: 'newer-upload',
      sourceKey,
      state: 'ready',
      traceId: 'trace-newer',
      leaseId: 'lease-newer',
      rpcTarget: {...rpcTarget, leaseId: 'lease-newer'},
    });
    owner.dispose();

    expect(getBackendUploadState()).toMatchObject({
      uploadToken: 'newer-upload',
      traceId: 'trace-newer',
      state: 'ready',
    });
  });

  it('invalidates an in-flight upload when its trace owner is disposed', () => {
    const owner = new AnalysisBackendConnectionOwner('http://backend', source);
    owner.start();
    const sourceKey = backendUploadSourceKey(source);
    const backendIdentityKey = getBackendUploadIdentityKey('http://backend', sourceKey);

    setBackendUploadState({
      backendIdentityKey,
      uploadToken: 'uploading-owner-token',
      sourceKey,
      state: 'uploading',
    });
    owner.dispose();

    expect(getBackendUploadState()).toMatchObject({
      backendIdentityKey,
      sourceKey,
      state: 'idle',
    });
    expect(getBackendUploadState().uploadToken).toMatch(/^invalidated-/);
  });

  it('invalidates the scoped connection and upload candidate when auth expires', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      status: 'preparing',
      traceId: 'trace-current',
      leaseId: 'lease-current',
    }));
    const owner = new AnalysisBackendConnectionOwner('http://backend', source);
    owner.start();
    const sourceKey = backendUploadSourceKey(source);
    setBackendUploadState({
      backendIdentityKey: getBackendUploadIdentityKey('http://backend', sourceKey),
      uploadToken: 'current-upload',
      sourceKey,
      state: 'ready',
      traceId: 'trace-current',
      leaseId: 'lease-current',
      rpcTarget: {
        mode: 'backend-lease-proxy',
        targetOwner: 'smartperfetto-backend',
        leaseId: 'lease-current',
        statusUrl: 'http://backend/status',
        websocketUrl: 'ws://backend/websocket',
        heartbeatUrl: 'http://backend/heartbeat',
        credentials: 'include',
      },
    });
    await vi.waitFor(() => {
      expect(owner.connection.getSnapshot().state).toBe('preparing');
    });

    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    window.dispatchEvent(new Event('smartperfetto-auth-session-changed'));

    expect(owner.connection.getSnapshot()).toEqual({state: 'auth_expired'});
    expect(getBackendUploadState()).toMatchObject({state: 'idle'});
    expect(getBackendUploadState().uploadToken).toMatch(/^invalidated-/);
    owner.dispose();
  });
});
