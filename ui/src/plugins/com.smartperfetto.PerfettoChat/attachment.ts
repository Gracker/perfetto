// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Trace} from '../../public/trace';
import {
  backendUploadSnapshotMatchesIdentity, getBackendUploadState, subscribeBackendUploadState,
} from '../../core/backend_upload_state';
import {getBackendUploadIdentityKey} from '../../core/backend_uploader';
import {getLocalTraceAssetSource} from '../../core/trace_asset_source';
import type {ChatClient} from './client';

export async function getCurrentAsset(
  trace: Trace, client: ChatClient, uploadId: string, signal: AbortSignal,
): Promise<string> {
  const source = getLocalTraceAssetSource(trace.traceInfo);
  if (!source) throw new Error('TRACE_SOURCE_UNSUPPORTED');
  const backendKey = getBackendUploadIdentityKey(client.scope.backend, source.sourceKey);
  const snapshot = await new Promise<ReturnType<typeof getBackendUploadState>>((resolve, reject) => {
    const cleanup = () => {
      unsubscribe();
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(signal.reason); };
    const changed = (next: ReturnType<typeof getBackendUploadState>) => {
      if (!backendUploadSnapshotMatchesIdentity(next, backendKey, source.sourceKey) ||
          next.uploadToken !== source.uploadToken) {
        cleanup();
        reject(new Error('TRACE_UNAVAILABLE'));
      } else if (next.state !== 'uploading') {
        cleanup();
        resolve(next);
      }
    };
    const unsubscribe = subscribeBackendUploadState(changed);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    else changed(getBackendUploadState());
  });
  if (snapshot.assetTraceId) return snapshot.assetTraceId;
  if (snapshot.state === 'ready' && snapshot.traceId) return snapshot.traceId;
  // The health check precedes POST, so this is the only failure proving
  // that the uploader did not start transmitting this file.
  if (snapshot.errorCode !== 'BACKEND_UNAVAILABLE') throw new Error('TRACE_UPLOAD_UNCONFIRMED');
  const body = new FormData();
  body.append('file', await trace.getTraceFile(), trace.traceInfo.traceTitle);
  signal.throwIfAborted();
  const response = await client.request('/trace-assets', {
    method: 'POST', body, signal, headers: {'X-Perfetto-Chat-Upload-Id': uploadId},
  });
  const value = await response.json() as {traceId?: string};
  if (!value.traceId) throw new Error('TRACE_UNAVAILABLE');
  return value.traceId;
}
