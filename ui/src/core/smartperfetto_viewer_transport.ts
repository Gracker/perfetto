// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import type {BackendUploadResult} from './backend_uploader';
import {isSmartPerfettoOidcMode} from './smartperfetto_auth';
import {HttpRpcEngine} from '../trace_processor/http_rpc_engine';

/**
 * OIDC keeps the browser Viewer on its page-local WASM engine. Only legacy
 * local/API-key modes may bind a backend upload target to the global Viewer.
 */
export function isSmartPerfettoViewerRpcAllowed(): boolean {
  return !isSmartPerfettoOidcMode();
}

export function bindBackendUploadTargetToViewer(
  upload: Pick<BackendUploadResult, 'rpcTarget' | 'port'>,
): boolean {
  if (!isSmartPerfettoViewerRpcAllowed()) return false;
  if (upload.rpcTarget) {
    HttpRpcEngine.setRpcTarget(upload.rpcTarget);
    return true;
  }
  if (upload.port) {
    HttpRpcEngine.useDirectPort(String(upload.port));
    return true;
  }
  return false;
}
