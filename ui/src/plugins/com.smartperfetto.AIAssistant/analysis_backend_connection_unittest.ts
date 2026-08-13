// SPDX-License-Identifier: AGPL-3.0-or-later

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {BackendUploadResult} from '../../core/backend_uploader';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AnalysisBackendConnection} from './analysis_backend_connection';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

function oidcUpload(
  traceId = 'trace-current-page',
  leaseId = 'lease-current-page',
): BackendUploadResult {
  return {
    success: true,
    traceId,
    leaseId,
    rpcTarget: {
      mode: 'backend-lease-proxy',
      targetOwner: 'smartperfetto-backend',
      leaseId,
      statusUrl: `http://backend/api/tp/${leaseId}/status`,
      websocketUrl: `ws://backend/api/tp/${leaseId}/websocket`,
      heartbeatUrl: `http://backend/api/tp/${leaseId}/heartbeat`,
      credentials: 'include',
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('AnalysisBackendConnection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
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
    HttpRpcEngine.useDirectPort('9001');

  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    HttpRpcEngine.useDirectPort('9001');
  });

  it('keeps the WASM viewer target untouched while connecting an OIDC lease', async () => {
    const upload = oidcUpload();
    fetchMock.mockResolvedValue(jsonResponse({
      success: true,
      traceId: upload.traceId,
      leaseId: upload.leaseId,
      status: 'ready',
    }));
    const setTarget = vi.spyOn(HttpRpcEngine, 'setRpcTarget');
    const checkTarget = vi.spyOn(HttpRpcEngine, 'checkTargetConnection');
    const connection = new AnalysisBackendConnection('http://backend');

    await connection.connectOidc(upload);
    await flushAsyncWork();

    expect(connection.getSnapshot()).toMatchObject({
      state: 'ready',
      traceId: upload.traceId,
      leaseId: upload.leaseId,
    });
    expect(setTarget).not.toHaveBeenCalled();
    expect(checkTarget).not.toHaveBeenCalled();
    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'direct-port',
      port: '9001',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toContain(
      '/api/workspaces/workspace-a/traces/leases/lease-current-page/connection',
    );
    connection.dispose();
  });

  it('maps a scoped status 401 to auth_expired', async () => {
    const upload = oidcUpload();
    fetchMock.mockResolvedValue(jsonResponse({error: 'unauthorized'}, 401));
    const connection = new AnalysisBackendConnection('http://backend');

    await connection.connectOidc(upload);

    expect(connection.getSnapshot()).toEqual({state: 'auth_expired'});
    expect(window.__SMARTPERFETTO_AUTH_SESSION__).toBeUndefined();
    connection.dispose();
  });

  it('suppresses an old connection completion after a new page trace starts', async () => {
    let resolveFirstStatus!: (response: Response) => void;
    const firstStatus = new Promise<Response>((resolve) => {
      resolveFirstStatus = resolve;
    });
    fetchMock.mockReturnValueOnce(firstStatus).mockResolvedValue(
      jsonResponse({status: 'ready', traceId: 'trace-new', leaseId: 'lease-new'}),
    );
    const connection = new AnalysisBackendConnection('http://backend');

    const first = connection.connectOidc(oidcUpload());
    await flushAsyncWork();
    await connection.connectOidc(oidcUpload('trace-new', 'lease-new'));
    resolveFirstStatus(jsonResponse({
      status: 'lease_expired',
      traceId: 'trace-current-page',
      leaseId: 'lease-current-page',
    }));

    expect(connection.getSnapshot()).toMatchObject({
      state: 'ready',
      traceId: 'trace-new',
      leaseId: 'lease-new',
    });
    await expect(first).resolves.toBeUndefined();
    connection.dispose();
  });

  it('keeps polling a preparing lease until it becomes ready', async () => {
    const upload = oidcUpload();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({status: 'preparing'}))
      .mockResolvedValueOnce(jsonResponse({
        status: 'ready',
        traceId: upload.traceId,
        leaseId: upload.leaseId,
      }))
      .mockResolvedValue(jsonResponse({success: true}));
    const connection = new AnalysisBackendConnection('http://backend');

    const connecting = connection.connectOidc(upload);
    await vi.advanceTimersByTimeAsync(10_000);
    await connecting;

    const connectionRequests = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/connection'),
    );
    expect(connectionRequests).toHaveLength(7);
    expect(connection.getSnapshot()).toMatchObject({
      state: 'ready',
      traceId: upload.traceId,
      leaseId: upload.leaseId,
    });
    connection.dispose();
  });

  it('stops preparing polling when the connection is disposed', async () => {
    const upload = oidcUpload();
    fetchMock.mockResolvedValue(jsonResponse({status: 'preparing'}));
    const connection = new AnalysisBackendConnection('http://backend');

    const connecting = connection.connectOidc(upload);
    await flushAsyncWork();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    connection.dispose();
    await connecting;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reconciles a heartbeat lease failure without reloading the page', async () => {
    const upload = oidcUpload();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status: 'ready',
        traceId: upload.traceId,
        leaseId: upload.leaseId,
      }))
      .mockResolvedValueOnce(jsonResponse({error: 'expired'}, 409))
      .mockResolvedValueOnce(jsonResponse({
        status: 'lease_expired',
        traceId: upload.traceId,
        leaseId: upload.leaseId,
      }));
    const connection = new AnalysisBackendConnection('http://backend');

    await connection.connectOidc(upload);
    await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(connection.getSnapshot()).toMatchObject({state: 'lease_expired'});
    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'direct-port',
      port: '9001',
    });
    connection.dispose();
  });
});
