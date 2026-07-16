// Copyright (C) 2024 SmartPerfetto

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MockedFunction} from 'vitest';

import {backendUploadSourceKey, BackendUploader} from './backend_uploader';
import {getSmartPerfettoBackendCspSources} from './smartperfetto_backend_url';

let originalFetch: typeof fetch;
let fetchMock: MockedFunction<typeof fetch>;

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
  fetchMock = vi.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  window.__SMARTPERFETTO_CONFIG__ = undefined;
});

describe('BackendUploader request context', () => {
  it('keeps a stream source stable without conflating different streams', () => {
    const streamA = {};
    const streamB = {};
    const sourceA = {type: 'STREAM', stream: streamA} as any;

    expect(backendUploadSourceKey(sourceA)).toBe(backendUploadSourceKey(sourceA));
    expect(backendUploadSourceKey(sourceA)).not.toBe(
      backendUploadSourceKey({type: 'STREAM', stream: streamB} as any),
    );
  });

  it('returns an actionable error for unsupported streaming uploads', async () => {
    await expect(new BackendUploader('http://backend').upload({
      type: 'STREAM',
      stream: {},
    } as any)).resolves.toEqual({
      success: false,
      errorCode: 'STREAM_SOURCE_UNSUPPORTED',
      error: 'Streaming traces cannot be uploaded for AI analysis. Reopen the captured trace as a file.',
    });
  });

  it('exposes the runtime backend origin for the page CSP', () => {
    window.__SMARTPERFETTO_CONFIG__ = {
      backendUrl: 'http://127.0.0.1:43123/private/base/',
    };

    expect(getSmartPerfettoBackendCspSources()).toEqual([
      'http://127.0.0.1:43123',
      'ws://127.0.0.1:43123',
    ]);
  });

  it('uses runtime-configured backend port by default', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {backendPort: '3300'};
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader().checkAvailable()).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'http://localhost:3300/',
    );
  });

  it('uses runtime-configured backend URL before deriving a host URL', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {
      backendUrl: 'https://proxy.example/base',
    };
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader().checkAvailable()).resolves.toBe(true);

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      'https://proxy.example/base/',
    );
  });

  it('sends X-Window-Id on health checks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(
      new BackendUploader('http://backend').checkAvailable(),
    ).resolves.toBe(true);

    expect(requestHeaders(0)['X-Window-Id']).toBe('window-upload');
  });

  it('sends the configured API key on health and upload requests', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({available: true}))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        trace: {id: 'trace-auth', port: 9817},
      }));
    const uploader = new BackendUploader('http://backend', 'spak_test-secret');

    await expect(uploader.checkAvailable()).resolves.toBe(true);
    await expect(uploader.upload({
      type: 'ARRAY_BUFFER',
      buffer: new Uint8Array([1]).buffer,
      fileName: 'trace.perfetto',
    } as any)).resolves.toMatchObject({success: true});

    for (const index of [0, 1]) {
      expect(requestHeaders(index)).toMatchObject({
        Authorization: 'Bearer spak_test-secret',
        'x-api-key': 'spak_test-secret',
      });
    }
  });

  it('sends X-Window-Id on file uploads', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        trace: {
          id: 'trace-a',
          port: 9817,
          leaseId: 'lease-a',
          leaseMode: 'shared',
          leaseModeReason: 'frontend_interactive',
          leaseQueueLength: 2,
          websocketCapability: {
            protocol: 'smartperfetto.tp.signed-capability',
            expiresAt: 123456,
          },
        },
      }),
    );

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
        websocketProtocols: ['smartperfetto.tp.signed-capability'],
        websocketCapabilityExpiresAt: 123456,
      },
    });
    expect(requestHeaders(0)['X-Window-Id']).toBe('window-upload');
    expect(result.rpcTarget?.headers).toMatchObject({
      'X-Window-Id': 'window-upload',
    });
  });

  it('sends X-Window-Id on URL uploads without dropping JSON content type', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        trace: {id: 'trace-url', port: 9818},
      }),
    );

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
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        trace: {
          id: 'trace-lease-only',
          leaseId: 'lease-only',
          leaseMode: 'isolated',
          leaseModeReason: 'full_analysis',
          leaseQueueLength: 0,
        },
      }),
    );

    const result = await new BackendUploader(
      'https://backend.example/base',
    ).upload({
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
        statusUrl: expect.stringContaining(
          'https://backend.example/base/api/tp/lease-only/status?',
        ),
        websocketUrl: expect.stringContaining(
          'wss://backend.example/base/api/tp/lease-only/websocket?',
        ),
        heartbeatUrl: expect.stringContaining(
          'https://backend.example/base/api/tp/lease-only/heartbeat?',
        ),
      },
    });
  });
});
