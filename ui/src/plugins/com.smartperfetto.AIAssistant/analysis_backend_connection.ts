// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {BackendUploadResult} from '../../core/backend_uploader';
import {
  buildSmartPerfettoWorkspaceApiUrl,
  buildSmartPerfettoContextHeaders,
} from '../../core/smartperfetto_request_context';
import {
  getSmartPerfettoAuthSession,
  handleSmartPerfettoAuthResponse,
  invalidateSmartPerfettoAuthSession,
  isSmartPerfettoOidcMode,
  withSmartPerfettoAuth,
} from '../../core/smartperfetto_auth';
import {
  HttpRpcEngine,
  type HttpRpcTarget,
} from '../../trace_processor/http_rpc_engine';

export type AnalysisBackendConnectionState =
  | 'no_trace'
  | 'preparing'
  | 'ready'
  | 'auth_expired'
  | 'trace_deleted'
  | 'lease_expired'
  | 'backend_unavailable';

export interface AnalysisBackendConnectionSnapshot {
  state: AnalysisBackendConnectionState;
  traceId?: string;
  leaseId?: string;
  target?: HttpRpcTarget;
  detail?: string;
}

type ConnectionListener = (
  snapshot: AnalysisBackendConnectionSnapshot,
) => void;

type LeaseConnectionResponse = {
  success?: boolean;
  status?: AnalysisBackendConnectionState;
  traceId?: string;
  leaseId?: string;
  error?: string;
  message?: string;
};

const PREPARING_RETRY_DELAY_MS = 300;
const PREPARING_RETRY_MAX_DELAY_MS = 2_400;
const HEARTBEAT_INTERVAL_MS = 20_000;

export class AnalysisBackendConnection {
  private generation = 0;
  private snapshot: AnalysisBackendConnectionSnapshot = {state: 'no_trace'};
  private heartbeatTimer: number | undefined;
  private heartbeatInFlight = false;
  private heartbeatGeneration = 0;
  private preparingRetryTimer: number | undefined;
  private preparingRetryResolve?: (shouldContinue: boolean) => void;
  private readonly listeners = new Set<ConnectionListener>();

  constructor(private readonly backendUrl: string) {}

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): AnalysisBackendConnectionSnapshot {
    return this.snapshot;
  }

  isReady(): boolean {
    return this.snapshot.state === 'ready';
  }

  prepareForTrace(): void {
    this.generation++;
    this.stopPreparingRetry();
    this.stopHeartbeat();
    this.publish({state: 'preparing'});
  }

  invalidateForAuth(): void {
    this.generation++;
    this.stopPreparingRetry();
    this.stopHeartbeat();
    this.publish({state: 'auth_expired'});
  }

  resetForTrace(): void {
    this.generation++;
    this.stopPreparingRetry();
    this.stopHeartbeat();
    this.publish({state: 'no_trace'});
  }

  dispose(): void {
    this.generation++;
    this.stopPreparingRetry();
    this.stopHeartbeat();
    this.listeners.clear();
  }

  connectLocal(upload: BackendUploadResult): void {
    this.generation++;
    this.stopPreparingRetry();
    this.stopHeartbeat();
    if (!upload.success || !upload.traceId) {
      this.publish({
        state: 'backend_unavailable',
        detail: upload.error ?? 'Backend trace upload failed',
      });
      return;
    }
    if (upload.rpcTarget) {
      HttpRpcEngine.setRpcTarget(upload.rpcTarget);
    } else if (upload.port) {
      HttpRpcEngine.useDirectPort(String(upload.port));
    }
    this.publish({
      state: 'ready',
      traceId: upload.traceId,
      leaseId: upload.leaseId,
      target: upload.rpcTarget,
    });
  }

  async connectOidc(upload: BackendUploadResult): Promise<void> {
    const generation = ++this.generation;
    this.stopPreparingRetry();
    this.stopHeartbeat();

    if (!isSmartPerfettoOidcMode() || !getSmartPerfettoAuthSession()) {
      this.publish({state: 'auth_expired'});
      return;
    }
    if (
      !upload.success ||
      !upload.traceId ||
      !upload.leaseId ||
      upload.rpcTarget?.mode !== 'backend-lease-proxy'
    ) {
      this.publish({
        state: 'backend_unavailable',
        traceId: upload.traceId,
        leaseId: upload.leaseId,
        target: upload.rpcTarget,
        detail: upload.error ?? 'OIDC upload did not create a lease target',
      });
      return;
    }

    const candidate = {
      traceId: upload.traceId,
      leaseId: upload.leaseId,
      target: upload.rpcTarget,
    };
    this.publish({state: 'preparing', ...candidate});

    let preparingAttempt = 0;
    while (generation === this.generation) {
      const response = await this.readLeaseConnection(
        upload.leaseId,
        generation,
      );
      if (generation !== this.generation) return;
      const state = response.status ?? 'backend_unavailable';
      if (state === 'preparing') {
        const delayMs = Math.min(
          PREPARING_RETRY_DELAY_MS * 2 ** preparingAttempt,
          PREPARING_RETRY_MAX_DELAY_MS,
        );
        preparingAttempt++;
        if (!await this.waitForPreparingRetry(generation, delayMs)) return;
        continue;
      }
      if (state === 'auth_expired') {
        this.invalidateForAuth();
        return;
      }
      if (state !== 'ready') {
        this.publish({
          state,
          traceId: response.traceId ?? candidate.traceId,
          leaseId: response.leaseId ?? candidate.leaseId,
          target: candidate.target,
          detail: response.error ?? response.message,
        });
        return;
      }

      this.startHeartbeat(candidate.target, generation);
      this.publish({state: 'ready', ...candidate});
      return;
    }
  }

  private async readLeaseConnection(
    leaseId: string,
    generation: number,
  ): Promise<LeaseConnectionResponse> {
    const url = buildSmartPerfettoWorkspaceApiUrl(
      this.backendUrl,
      'traces',
      `/leases/${encodeURIComponent(leaseId)}/connection`,
    );
    try {
      const response = await fetch(
        url,
        withSmartPerfettoAuth({
          method: 'GET',
          cache: 'no-cache',
          headers: buildSmartPerfettoContextHeaders(),
        }),
      );
      if (response.status === 401) {
        if (generation === this.generation) {
          invalidateSmartPerfettoAuthSession();
        }
        return {status: 'auth_expired', leaseId};
      }
      handleSmartPerfettoAuthResponse(response);
      if (!response.ok) {
        return {
          status: 'backend_unavailable',
          leaseId,
          error: `HTTP ${response.status}`,
        };
      }
      return (await response.json()) as LeaseConnectionResponse;
    } catch (error) {
      return {
        status: 'backend_unavailable',
        leaseId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private startHeartbeat(target: HttpRpcTarget, generation: number): void {
    this.stopHeartbeat();
    if (!target.heartbeatUrl || !target.leaseId) return;
    this.heartbeatGeneration = generation;
    void this.sendHeartbeat(target, generation);
    this.heartbeatTimer = window.setInterval(() => {
      void this.sendHeartbeat(target, generation);
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    this.heartbeatGeneration++;
    if (this.heartbeatTimer !== undefined) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    this.heartbeatInFlight = false;
  }

  private stopPreparingRetry(): void {
    if (this.preparingRetryTimer !== undefined) {
      window.clearTimeout(this.preparingRetryTimer);
      this.preparingRetryTimer = undefined;
    }
    const resolve = this.preparingRetryResolve;
    this.preparingRetryResolve = undefined;
    resolve?.(false);
  }

  private waitForPreparingRetry(
    generation: number,
    delayMs: number,
  ): Promise<boolean> {
    this.stopPreparingRetry();
    if (generation !== this.generation) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.preparingRetryResolve = resolve;
      this.preparingRetryTimer = window.setTimeout(() => {
        this.preparingRetryTimer = undefined;
        this.preparingRetryResolve = undefined;
        resolve(generation === this.generation);
      }, delayMs);
    });
  }

  private async sendHeartbeat(
    target: HttpRpcTarget,
    generation: number,
  ): Promise<void> {
    if (
      generation !== this.generation ||
      generation !== this.heartbeatGeneration ||
      this.heartbeatInFlight ||
      this.snapshot.leaseId !== target.leaseId
    ) {
      return;
    }
    this.heartbeatInFlight = true;
    try {
      const headers = new Headers(buildSmartPerfettoContextHeaders(target.headers));
      headers.set('Content-Type', 'application/json');
      const response = await fetch(
        target.heartbeatUrl!,
        withSmartPerfettoAuth({
          method: 'POST',
          cache: 'no-cache',
          headers,
          credentials: target.credentials ?? 'include',
          body: JSON.stringify({visibility: 'visible'}),
        }),
      );
      if (generation !== this.generation) return;
      if (response.status === 401) {
        invalidateSmartPerfettoAuthSession();
        this.invalidateForAuth();
        return;
      }
      if (response.ok) return;

      const refreshed = await this.readLeaseConnection(
        target.leaseId!,
        generation,
      );
      if (generation !== this.generation) return;
      if (refreshed.status === 'ready') {
        this.publish({...this.snapshot, state: 'ready'});
        return;
      }
      this.stopHeartbeat();
      this.publish({
        ...this.snapshot,
        state:
          refreshed.status ??
          (response.status === 409 || response.status === 410
            ? 'lease_expired'
            : 'backend_unavailable'),
        traceId: refreshed.traceId ?? this.snapshot.traceId,
        leaseId: refreshed.leaseId ?? this.snapshot.leaseId,
        detail: refreshed.error ?? `HTTP ${response.status}`,
      });
    } catch (error) {
      if (generation !== this.generation) return;
      this.stopHeartbeat();
      this.publish({
        ...this.snapshot,
        state: 'backend_unavailable',
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      if (generation === this.generation) this.heartbeatInFlight = false;
    }
  }

  private publish(snapshot: AnalysisBackendConnectionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener(snapshot);
  }

}
