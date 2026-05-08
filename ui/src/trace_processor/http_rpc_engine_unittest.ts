// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {HttpRpcEngine} from './http_rpc_engine';

let originalFetch: typeof fetch;
let fetchMock: jest.MockedFunction<typeof fetch>;

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
  } as Response;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setDocumentVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value,
  });
}

function setNavigatorOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    value,
  });
}

function heartbeatBody(callIndex: number): unknown {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

describe('HttpRpcEngine target selection', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn() as jest.MockedFunction<typeof fetch>;
    fetchMock.mockResolvedValue(okResponse());
    globalThis.fetch = fetchMock;
    setDocumentVisibility('visible');
    setNavigatorOnline(true);
    HttpRpcEngine.useDirectPort('9001');
  });

  afterEach(() => {
    HttpRpcEngine.useDirectPort('9001');
    globalThis.fetch = originalFetch;
    setDocumentVisibility('visible');
    setNavigatorOnline(true);
  });

  it('uses direct port targets by default', () => {
    HttpRpcEngine.useDirectPort('9817');

    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'direct-port',
      port: '9817',
      statusUrl: 'http://127.0.0.1:9817/status',
      websocketUrl: 'ws://127.0.0.1:9817/websocket',
    });
    expect(HttpRpcEngine.hostAndPort).toBe('127.0.0.1:9817');
  });

  it('uses backend lease proxy targets when configured', () => {
    HttpRpcEngine.setRpcTarget({
      mode: 'backend-lease-proxy',
      leaseId: 'lease-a',
      leaseMode: 'shared',
      leaseQueueLength: 4,
      statusUrl: 'http://backend/api/tp/lease-a/status',
      websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
      displayName: 'backend shared lease lease-a',
    });

    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'backend-lease-proxy',
      leaseId: 'lease-a',
      leaseMode: 'shared',
      leaseQueueLength: 4,
      statusUrl: 'http://backend/api/tp/lease-a/status',
      websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
    });
    expect(HttpRpcEngine.hostAndPort).toBe('backend shared lease lease-a');
  });

  it('sends a frontend lease heartbeat when a backend lease target is configured', async () => {
    HttpRpcEngine.setRpcTarget({
      mode: 'backend-lease-proxy',
      leaseId: 'lease-a',
      statusUrl: 'http://backend/api/tp/lease-a/status',
      websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
      heartbeatUrl: 'http://backend/api/tp/lease-a/heartbeat',
      headers: {'X-Window-Id': 'window-a'},
      credentials: 'include',
    });
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/tp/lease-a/heartbeat');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('post');
    expect(init.credentials).toBe('include');
    expect((init.headers as Headers).get('X-Window-Id')).toBe('window-a');
    expect((init.headers as Headers).get('Content-Type')).toBe('application/json');
    expect(heartbeatBody(0)).toEqual({visibility: 'visible'});
  });

  it('updates frontend lease heartbeat visibility from page and network state', async () => {
    HttpRpcEngine.setRpcTarget({
      mode: 'backend-lease-proxy',
      leaseId: 'lease-a',
      statusUrl: 'http://backend/api/tp/lease-a/status',
      websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
      heartbeatUrl: 'http://backend/api/tp/lease-a/heartbeat',
    });
    await flushAsyncWork();
    fetchMock.mockClear();

    setDocumentVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await flushAsyncWork();
    expect(heartbeatBody(0)).toEqual({visibility: 'hidden'});

    fetchMock.mockClear();
    setNavigatorOnline(false);
    window.dispatchEvent(new Event('offline'));
    await flushAsyncWork();
    expect(heartbeatBody(0)).toEqual({visibility: 'offline'});
  });

  it('stops frontend lease heartbeat when switching back to direct port mode', async () => {
    HttpRpcEngine.setRpcTarget({
      mode: 'backend-lease-proxy',
      leaseId: 'lease-a',
      statusUrl: 'http://backend/api/tp/lease-a/status',
      websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
      heartbeatUrl: 'http://backend/api/tp/lease-a/heartbeat',
    });
    await flushAsyncWork();
    fetchMock.mockClear();

    HttpRpcEngine.useDirectPort('9817');
    window.dispatchEvent(new Event('focus'));
    await flushAsyncWork();

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
