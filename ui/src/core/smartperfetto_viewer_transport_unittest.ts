// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {HttpRpcEngine} from '../trace_processor/http_rpc_engine';
import {
  bindBackendUploadTargetToViewer,
  isSmartPerfettoViewerRpcAllowed,
} from './smartperfetto_viewer_transport';

const backendTarget = {
  mode: 'backend-lease-proxy' as const,
  targetOwner: 'smartperfetto-backend' as const,
  leaseId: 'lease-a',
  statusUrl: 'http://backend/status',
  websocketUrl: 'ws://backend/websocket',
};

afterEach(() => {
  vi.restoreAllMocks();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  HttpRpcEngine.useDirectPort('9001');
});

describe('SmartPerfetto Viewer transport boundary', () => {
  it('blocks global Viewer RPC in OIDC mode', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};

    expect(isSmartPerfettoViewerRpcAllowed()).toBe(false);
  });

  it('keeps non-OIDC Viewer RPC behavior available', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false};

    expect(isSmartPerfettoViewerRpcAllowed()).toBe(true);
  });

  it('does not bind an OIDC backend upload target to the global Viewer', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    const setTarget = vi.spyOn(HttpRpcEngine, 'setRpcTarget');

    bindBackendUploadTargetToViewer({
      rpcTarget: backendTarget,
    });

    expect(setTarget).not.toHaveBeenCalled();
    expect(HttpRpcEngine.getCurrentTarget()).toMatchObject({
      mode: 'direct-port',
      targetOwner: 'user',
      port: '9001',
    });
  });

  it('preserves non-OIDC backend upload target binding', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false};
    const setTarget = vi.spyOn(HttpRpcEngine, 'setRpcTarget');

    bindBackendUploadTargetToViewer({
      rpcTarget: backendTarget,
    });

    expect(setTarget).toHaveBeenCalledWith(backendTarget);
  });
});
