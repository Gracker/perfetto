// Copyright (C) 2024 SmartPerfetto

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';

import {BackendUploader} from './backend_uploader';

let originalFetch: typeof fetch;
let fetchMock: jest.MockedFunction<typeof fetch>;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function requestHeaders(callIndex: number): Record<string, string> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return init.headers as Record<string, string>;
}

beforeEach(() => {
  sessionStorage.clear();
  sessionStorage.setItem('smartperfetto-window-id', 'window-upload');
  originalFetch = globalThis.fetch;
  fetchMock = jest.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.__SMARTPERFETTO_CONFIG__ = undefined;
});

describe('BackendUploader request context', () => {
  it('uses runtime-configured backend port by default', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {backendPort: '3300'};
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader().checkAvailable()).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0][0])).toContain('http://localhost:3300/');
  });

  it('uses runtime-configured backend URL before deriving a host URL', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {backendUrl: 'https://proxy.example/base'};
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader().checkAvailable()).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0][0])).toContain('https://proxy.example/base/');
  });

  it('sends X-Window-Id on health checks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader('http://backend').checkAvailable()).resolves.toBe(true);

    expect(requestHeaders(0)['X-Window-Id']).toBe('window-upload');
  });

  it('sends X-Window-Id on file uploads', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      trace: {
        id: 'trace-a',
        port: 9817,
        leaseId: 'lease-a',
        leaseMode: 'shared',
        leaseModeReason: 'frontend_interactive',
        leaseQueueLength: 2,
      },
    }));

    const result = await new BackendUploader('http://backend').upload({
      type: 'ARRAY_BUFFER',
      buffer: new Uint8Array([1, 2, 3]).buffer,
      fileName: 'trace.perfetto',
    } as any);

    expect(result).toMatchObject({
      success: true,
      traceId: 'trace-a',
      port: 9817,
      leaseId: 'lease-a',
      leaseMode: 'shared',
      leaseModeReason: 'frontend_interactive',
      leaseQueueLength: 2,
      rpcTarget: {
        mode: 'backend-lease-proxy',
        leaseId: 'lease-a',
        leaseMode: 'shared',
        leaseModeReason: 'frontend_interactive',
        leaseQueueLength: 2,
        statusUrl: expect.stringContaining('/api/tp/lease-a/status?'),
        websocketUrl: expect.stringContaining('/api/tp/lease-a/websocket?'),
        heartbeatUrl: expect.stringContaining('/api/tp/lease-a/heartbeat?'),
      },
    });
    expect(requestHeaders(0)['X-Window-Id']).toBe('window-upload');
  });

  it('sends X-Window-Id on URL uploads without dropping JSON content type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      trace: {id: 'trace-url', port: 9818},
    }));

    const result = await new BackendUploader('http://backend').upload({
      type: 'URL',
      url: 'https://example.com/trace.perfetto',
    } as any);

    expect(result).toMatchObject({
      success: true,
      traceId: 'trace-url',
      port: 9818,
      rpcTarget: {
        mode: 'direct-port',
        targetOwner: 'smartperfetto-backend',
        port: '9818',
        statusUrl: 'http://127.0.0.1:9818/status',
        websocketUrl: 'ws://127.0.0.1:9818/websocket',
      },
    });
    expect(requestHeaders(0)).toMatchObject({
      'Content-Type': 'application/json',
      'X-Window-Id': 'window-upload',
    });
  });

  it('accepts lease-only upload responses for backend proxy mode', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      trace: {
        id: 'trace-lease-only',
        leaseId: 'lease-only',
        leaseMode: 'isolated',
        leaseModeReason: 'full_analysis',
        leaseQueueLength: 0,
      },
    }));

    const result = await new BackendUploader('https://backend.example/base').upload({
      type: 'ARRAY_BUFFER',
      buffer: new Uint8Array([1]).buffer,
      fileName: 'trace.perfetto',
    } as any);

    expect(result).toMatchObject({
      success: true,
      traceId: 'trace-lease-only',
      leaseId: 'lease-only',
      leaseMode: 'isolated',
      rpcTarget: {
        displayName: 'backend isolated lease lease-on',
        statusUrl: expect.stringContaining('https://backend.example/base/api/tp/lease-only/status?'),
        websocketUrl: expect.stringContaining('wss://backend.example/base/api/tp/lease-only/websocket?'),
        heartbeatUrl: expect.stringContaining('https://backend.example/base/api/tp/lease-only/heartbeat?'),
      },
    });
  });
});
