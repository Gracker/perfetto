// SPDX-License-Identifier: AGPL-3.0-or-later

import type {TraceSource} from '../../core/trace_source';
import {
  backendUploadSourceKey,
  getBackendUploadIdentityKey,
  type BackendUploadResult,
} from '../../core/backend_uploader';
import {
  backendUploadSnapshotMatchesIdentity,
  getBackendUploadState,
  invalidateBackendUploadState,
  subscribeBackendUploadState,
  type BackendUploadSnapshot,
} from '../../core/backend_upload_state';
import {
  getSmartPerfettoAuthSession,
  isSmartPerfettoOidcMode,
} from '../../core/smartperfetto_auth';
import {AnalysisBackendConnection} from './analysis_backend_connection';

export class AnalysisBackendConnectionOwner {
  readonly connection: AnalysisBackendConnection;

  private readonly sourceKey: string;
  private unsubscribeUpload?: () => void;
  private activeBackendIdentityKey = '';
  private activeUploadToken?: string;
  private connectedUploadToken?: string;
  private handleSnapshot?: (snapshot: BackendUploadSnapshot) => void;
  private readonly handleAuthSessionChanged = (): void => {
    if (this.disposed) return;
    if (!getSmartPerfettoAuthSession()) {
      this.invalidateActiveUploadState();
      this.activeBackendIdentityKey = '';
      this.activeUploadToken = undefined;
      this.connectedUploadToken = undefined;
      this.connection.invalidateForAuth();
      return;
    }
    this.activeBackendIdentityKey = '';
    this.activeUploadToken = undefined;
    this.connectedUploadToken = undefined;
    this.connection.prepareForTrace();
    this.handleSnapshot?.(getBackendUploadState());
  };
  private disposed = false;

  constructor(
    private readonly backendUrl: string,
    source: TraceSource,
  ) {
    this.connection = new AnalysisBackendConnection(backendUrl);
    this.sourceKey = backendUploadSourceKey(source);
  }

  start(): void {
    if (this.disposed || this.unsubscribeUpload) return;
    if (!isSmartPerfettoOidcMode()) return;

    this.connection.prepareForTrace();
    this.handleSnapshot = (snapshot: BackendUploadSnapshot): void => {
      if (this.disposed) return;
      const backendIdentityKey = getBackendUploadIdentityKey(
        this.backendUrl,
        this.sourceKey,
      );
      if (backendIdentityKey !== this.activeBackendIdentityKey) {
        this.activeBackendIdentityKey = backendIdentityKey;
        this.activeUploadToken = undefined;
        this.connectedUploadToken = undefined;
        this.connection.prepareForTrace();
      }
      if (
        !backendUploadSnapshotMatchesIdentity(
          snapshot,
          backendIdentityKey,
          this.sourceKey,
        )
      ) {
        return;
      }

      const uploadToken = snapshot.uploadToken ?? '';
      if (uploadToken) this.activeUploadToken = uploadToken;

      if (snapshot.state === 'uploading' || snapshot.state === 'idle') {
        if (this.connection.getSnapshot().state === 'no_trace') {
          this.connection.prepareForTrace();
        }
        return;
      }

      if (uploadToken && uploadToken === this.connectedUploadToken) return;
      this.connectedUploadToken = uploadToken;

      const upload = this.toUploadResult(snapshot);
      void this.connection.connectOidc(upload);
    };

    this.unsubscribeUpload = subscribeBackendUploadState(this.handleSnapshot);
    window.addEventListener(
      'smartperfetto-auth-session-changed',
      this.handleAuthSessionChanged,
    );
    this.handleSnapshot(getBackendUploadState());
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeUpload?.();
    this.unsubscribeUpload = undefined;
    this.handleSnapshot = undefined;
    window.removeEventListener(
      'smartperfetto-auth-session-changed',
      this.handleAuthSessionChanged,
    );
    this.invalidateActiveUploadState();
    this.connection.dispose();
  }

  private invalidateActiveUploadState(): void {
    if (!this.activeBackendIdentityKey) return;
    const current = getBackendUploadState();
    if (
      this.activeUploadToken &&
      current.uploadToken === this.activeUploadToken &&
      backendUploadSnapshotMatchesIdentity(
        current,
        this.activeBackendIdentityKey,
        this.sourceKey,
      )
    ) {
      invalidateBackendUploadState(
        this.activeBackendIdentityKey,
        this.sourceKey,
      );
    }
  }

  private toUploadResult(snapshot: BackendUploadSnapshot): BackendUploadResult {
    return {
      success: snapshot.state === 'ready',
      traceId: snapshot.traceId,
      port: snapshot.port,
      leaseId: snapshot.leaseId,
      leaseMode: snapshot.leaseMode,
      leaseModeReason: snapshot.leaseModeReason,
      leaseQueueLength: snapshot.leaseQueueLength,
      rpcTarget: snapshot.rpcTarget,
      error: snapshot.error,
      errorCode: snapshot.errorCode as BackendUploadResult['errorCode'],
    };
  }
}
