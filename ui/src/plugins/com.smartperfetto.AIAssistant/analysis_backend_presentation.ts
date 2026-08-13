// SPDX-License-Identifier: AGPL-3.0-or-later

import type {BackendUploadSnapshot} from '../../core/backend_upload_state';
import type {AnalysisBackendConnectionSnapshot} from './analysis_backend_connection';

export interface AnalysisBackendPresentation {
  traceId?: string;
  state:
    | 'idle'
    | 'preparing'
    | 'ready'
    | 'failed'
    | 'auth_expired'
    | 'trace_deleted'
    | 'lease_expired';
  error?: string;
}

export function resolveAnalysisBackendPresentation(
  oidcMode: boolean,
  upload: BackendUploadSnapshot,
  connection?: AnalysisBackendConnectionSnapshot,
): AnalysisBackendPresentation {
  if (!oidcMode) {
    return {
      traceId: upload.state === 'ready' ? upload.traceId : undefined,
      state:
        upload.state === 'uploading'
          ? 'preparing'
          : upload.state === 'failed'
            ? 'failed'
            : upload.state,
      error: upload.error,
    };
  }

  if (!connection || connection.state === 'no_trace') {
    return {state: 'idle'};
  }
  if (connection.state === 'ready') {
    return {state: 'ready', traceId: connection.traceId};
  }
  if (connection.state === 'preparing') {
    return {state: 'preparing'};
  }
  if (connection.state === 'auth_expired') {
    return {state: 'auth_expired', error: connection.detail};
  }
  if (connection.state === 'trace_deleted') {
    return {state: 'trace_deleted', error: connection.detail};
  }
  if (connection.state === 'lease_expired') {
    return {state: 'lease_expired', error: connection.detail};
  }
  return {state: 'failed', error: connection.detail};
}
