// Copyright (C) 2019 The Android Open Source Project
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

import protos from '../protos';
import {fetchWithTimeout} from '../base/http_utils';
import {reportError} from '../base/logging';
import {assertExists} from '../base/assert';
import {EngineBase} from '../trace_processor/engine';

const RPC_CONNECT_TIMEOUT_MS = 2000;
const SMARTPERFETTO_LEASE_HEARTBEAT_INTERVAL_MS = 30_000;
const SMARTPERFETTO_LEASE_RECOVERY_EVENT =
  'smartperfetto-lease-recovery-required';

type SmartPerfettoLeaseVisibility = 'visible' | 'hidden' | 'offline';

export interface HttpRpcState {
  connected: boolean;
  status?: protos.StatusResult;
  failure?: string;
}

export interface HttpRpcTarget {
  mode: 'direct-port' | 'backend-lease-proxy';
  targetOwner?: 'user' | 'smartperfetto-backend';
  host?: string;
  port?: string;
  leaseId?: string;
  leaseMode?: 'shared' | 'isolated' | string;
  leaseModeReason?: string;
  leaseQueueLength?: number;
  statusUrl: string;
  websocketUrl: string;
  heartbeatUrl?: string;
  displayName?: string;
  headers?: HeadersInit;
  credentials?: RequestCredentials;
}

function directPortTarget(port: string): HttpRpcTarget {
  const host = '127.0.0.1';
  return {
    mode: 'direct-port',
    targetOwner: 'user',
    host,
    port,
    statusUrl: `http://${host}:${port}/status`,
    websocketUrl: `ws://${host}:${port}/websocket`,
    displayName: `${host}:${port}`,
  };
}

export class HttpRpcEngine extends EngineBase {
  readonly mode = 'HTTP_RPC';
  readonly id: string;
  private requestQueue = new Array<Uint8Array>();
  private websocket?: WebSocket;
  private connected = false;
  private disposed = false;
  private queue: Blob[] = [];
  private isProcessingQueue = false;

  // Can be changed by frontend/index.ts when passing ?rpc_port=1234 .
  static rpcPort = '9001';
  private static rpcTarget?: HttpRpcTarget;
  private static leaseHeartbeatTarget?: HttpRpcTarget;
  private static leaseHeartbeatTimer?: ReturnType<typeof setInterval>;
  private static leaseHeartbeatInFlight = false;
  private static leaseHeartbeatListenersInstalled = false;
  private static leaseRecoveryReloadScheduled = false;

  constructor(id: string) {
    super();
    this.id = id;
  }

  rpcSendRequestBytes(data: Uint8Array): void {
    if (this.websocket === undefined) {
      if (this.disposed) return;
      const wsUrl = HttpRpcEngine.getCurrentTarget().websocketUrl;
      this.websocket = new WebSocket(wsUrl);
      this.websocket.onopen = () => this.onWebsocketConnected();
      this.websocket.onmessage = (e) => this.onWebsocketMessage(e);
      this.websocket.onclose = (e) => this.onWebsocketClosed(e);
      this.websocket.onerror = (e) =>
        super.fail(
          `WebSocket error rs=${(e.target as WebSocket)?.readyState} (ERR:ws)`,
        );
    }

    if (this.connected) {
      this.websocket.send(data);
    } else {
      this.requestQueue.push(data); // onWebsocketConnected() will flush this.
    }
  }

  private onWebsocketConnected() {
    for (;;) {
      const queuedMsg = this.requestQueue.shift();
      if (queuedMsg === undefined) break;
      assertExists(this.websocket).send(queuedMsg);
    }
    this.connected = true;
  }

  private onWebsocketClosed(e: CloseEvent) {
    if (this.disposed) return;
    if (e.code === 1006 && this.connected) {
      // On macbooks the act of closing the lid / suspending often causes socket
      // disconnections. Try to gracefully re-connect.
      console.log('Websocket closed, reconnecting');
      this.websocket = undefined;
      this.connected = false;
      this.rpcSendRequestBytes(new Uint8Array()); // Triggers a reconnection.
    } else {
      super.fail(`Websocket closed (${e.code}: ${e.reason}) (ERR:ws)`);
    }
  }

  private onWebsocketMessage(e: MessageEvent) {
    const blob = assertExists(e.data as Blob);
    this.queue.push(blob);
    this.processQueue();
  }

  private async processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;
    while (this.queue.length > 0) {
      try {
        const blob = assertExists(this.queue.shift());
        const buf = await blob.arrayBuffer();
        super.onRpcResponseBytes(new Uint8Array(buf));
      } catch (e) {
        reportError(e);
      }
    }
    this.isProcessingQueue = false;
  }

  static async checkConnection(): Promise<HttpRpcState> {
    const target = HttpRpcEngine.getCurrentTarget();
    const httpRpcState: HttpRpcState = {connected: false};
    console.info(
      `It's safe to ignore the ERR_CONNECTION_REFUSED on ${target.statusUrl} below. ` +
        `That might happen while probing the external native accelerator. The ` +
        `error is non-fatal and unlikely to be the culprit for any UI bug.`,
    );
    try {
      const resp = await fetchWithTimeout(
        target.statusUrl,
        {
          method: 'post',
          cache: 'no-cache',
          headers: target.headers,
          credentials: target.credentials,
        },
        RPC_CONNECT_TIMEOUT_MS,
      );
      if (resp.status !== 200) {
        httpRpcState.failure = `${resp.status} - ${resp.statusText}`;
      } else {
        const buf = new Uint8Array(await resp.arrayBuffer());
        // Decode the response buffer first. If decoding is successful, update the connection state.
        // This ensures that the connection state is only set to true if the data is correctly parsed.
        httpRpcState.status = protos.StatusResult.decode(buf);
        httpRpcState.connected = true;
      }
    } catch (err) {
      httpRpcState.failure = `${err}`;
    }
    return httpRpcState;
  }

  static useDirectPort(port = HttpRpcEngine.rpcPort): void {
    HttpRpcEngine.stopLeaseHeartbeat();
    HttpRpcEngine.rpcPort = String(port);
    HttpRpcEngine.rpcTarget = undefined;
  }

  static setRpcTarget(target: HttpRpcTarget): void {
    HttpRpcEngine.stopLeaseHeartbeat();
    HttpRpcEngine.rpcTarget = target;
    if (
      target.mode === 'direct-port' &&
      target.port &&
      target.targetOwner !== 'smartperfetto-backend'
    ) {
      HttpRpcEngine.rpcPort = String(target.port);
      HttpRpcEngine.rpcTarget = undefined;
      return;
    }
    if (target.mode === 'direct-port' && target.port) {
      HttpRpcEngine.rpcPort = String(target.port);
    }
    HttpRpcEngine.startLeaseHeartbeat(target);
  }

  static getCurrentTarget(): HttpRpcTarget {
    return HttpRpcEngine.rpcTarget ?? directPortTarget(HttpRpcEngine.rpcPort);
  }

  static isSmartPerfettoBackendTarget(
    target: HttpRpcTarget = HttpRpcEngine.getCurrentTarget(),
  ): boolean {
    return (
      target.targetOwner === 'smartperfetto-backend' ||
      target.mode === 'backend-lease-proxy'
    );
  }

  static get hostAndPort() {
    return HttpRpcEngine.getCurrentTarget().displayName ?? 'unknown HTTP RPC target';
  }

  private static startLeaseHeartbeat(target: HttpRpcTarget): void {
    if (target.mode !== 'backend-lease-proxy' || target.heartbeatUrl === undefined) {
      return;
    }
    HttpRpcEngine.leaseHeartbeatTarget = target;
    HttpRpcEngine.leaseRecoveryReloadScheduled = false;
    HttpRpcEngine.ensureLeaseHeartbeatListeners();
    void HttpRpcEngine.sendLeaseHeartbeat();
    HttpRpcEngine.leaseHeartbeatTimer = setInterval(() => {
      void HttpRpcEngine.sendLeaseHeartbeat();
    }, SMARTPERFETTO_LEASE_HEARTBEAT_INTERVAL_MS);
  }

  private static stopLeaseHeartbeat(): void {
    if (HttpRpcEngine.leaseHeartbeatTimer !== undefined) {
      clearInterval(HttpRpcEngine.leaseHeartbeatTimer);
      HttpRpcEngine.leaseHeartbeatTimer = undefined;
    }
    HttpRpcEngine.leaseHeartbeatTarget = undefined;
    HttpRpcEngine.leaseHeartbeatInFlight = false;
    HttpRpcEngine.leaseRecoveryReloadScheduled = false;
  }

  private static ensureLeaseHeartbeatListeners(): void {
    if (HttpRpcEngine.leaseHeartbeatListenersInstalled) return;
    HttpRpcEngine.leaseHeartbeatListenersInstalled = true;
    if (typeof document !== 'undefined') {
      document.addEventListener(
        'visibilitychange',
        HttpRpcEngine.onLeaseHeartbeatSignal,
      );
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', HttpRpcEngine.onLeaseHeartbeatSignal);
      window.addEventListener('offline', HttpRpcEngine.onLeaseHeartbeatSignal);
      window.addEventListener('pageshow', HttpRpcEngine.onLeaseHeartbeatSignal);
      window.addEventListener('focus', HttpRpcEngine.onLeaseHeartbeatSignal);
    }
  }

  private static onLeaseHeartbeatSignal = () => {
    void HttpRpcEngine.sendLeaseHeartbeat();
  };

  private static leaseVisibility(): SmartPerfettoLeaseVisibility {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return 'offline';
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return 'hidden';
    }
    return 'visible';
  }

  private static async sendLeaseHeartbeat(): Promise<void> {
    const target = HttpRpcEngine.leaseHeartbeatTarget;
    if (
      target?.mode !== 'backend-lease-proxy' ||
      target.heartbeatUrl === undefined ||
      HttpRpcEngine.leaseHeartbeatInFlight
    ) {
      return;
    }

    HttpRpcEngine.leaseHeartbeatInFlight = true;
    try {
      const headers = new Headers(target.headers);
      headers.set('Content-Type', 'application/json');
      const response = await fetchWithTimeout(
        target.heartbeatUrl,
        {
          method: 'post',
          cache: 'no-cache',
          headers,
          credentials: target.credentials,
          body: JSON.stringify({visibility: HttpRpcEngine.leaseVisibility()}),
        },
        RPC_CONNECT_TIMEOUT_MS,
      );
      if (!response.ok) {
        console.warn(
          `SmartPerfetto lease heartbeat failed: ${response.status} ${response.statusText}`,
        );
        HttpRpcEngine.maybeReloadForStaleLease(response);
      }
    } catch (err) {
      if (HttpRpcEngine.leaseVisibility() !== 'offline') {
        console.warn('SmartPerfetto lease heartbeat failed:', err);
      }
    } finally {
      HttpRpcEngine.leaseHeartbeatInFlight = false;
    }
  }

  private static maybeReloadForStaleLease(response: Response): void {
    if (
      HttpRpcEngine.leaseRecoveryReloadScheduled ||
      HttpRpcEngine.leaseVisibility() !== 'visible' ||
      ![404, 409, 410].includes(response.status) ||
      typeof window === 'undefined'
    ) {
      return;
    }

    HttpRpcEngine.leaseRecoveryReloadScheduled = true;
    const event = new CustomEvent(SMARTPERFETTO_LEASE_RECOVERY_EVENT, {
      cancelable: true,
      detail: {
        leaseId: HttpRpcEngine.leaseHeartbeatTarget?.leaseId,
        status: response.status,
        statusText: response.statusText,
      },
    });
    if (!window.dispatchEvent(event)) return;
    window.location.reload();
  }

  [Symbol.dispose]() {
    this.disposed = true;
    this.connected = false;
    const websocket = this.websocket;
    this.websocket = undefined;
    websocket?.close();
  }
}
