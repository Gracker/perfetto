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
});

describe('BackendUploader request context', () => {
  it('sends X-Window-Id on health checks', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({available: true}));

    await expect(new BackendUploader('http://backend').checkAvailable()).resolves.toBe(true);

    expect(requestHeaders(0)['X-Window-Id']).toBe('window-upload');
  });

  it('sends X-Window-Id on file uploads', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      success: true,
      trace: {id: 'trace-a', port: 9817},
    }));

    const result = await new BackendUploader('http://backend').upload({
      type: 'ARRAY_BUFFER',
      buffer: new Uint8Array([1, 2, 3]).buffer,
      fileName: 'trace.perfetto',
    } as any);

    expect(result).toMatchObject({success: true, traceId: 'trace-a', port: 9817});
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

    expect(result).toMatchObject({success: true, traceId: 'trace-url', port: 9818});
    expect(requestHeaders(0)).toMatchObject({
      'Content-Type': 'application/json',
      'X-Window-Id': 'window-upload',
    });
  });
});
