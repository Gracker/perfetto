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

import {TraceSource} from './trace_source';
import {
  backendUploadSourceKey,
  shouldProbeHttpRpcForTraceSource,
} from './load_trace';
import {HttpRpcTarget} from '../trace_processor/http_rpc_engine';

const backendLeaseTarget: HttpRpcTarget = {
  mode: 'backend-lease-proxy',
  targetOwner: 'smartperfetto-backend',
  leaseId: 'lease-a',
  statusUrl: 'http://backend/api/tp/lease-a/status',
  websocketUrl: 'ws://backend/api/tp/lease-a/websocket',
};

const backendDirectTarget: HttpRpcTarget = {
  mode: 'direct-port',
  targetOwner: 'smartperfetto-backend',
  port: '9817',
  statusUrl: 'http://127.0.0.1:9817/status',
  websocketUrl: 'ws://127.0.0.1:9817/websocket',
};

const userDirectTarget: HttpRpcTarget = {
  mode: 'direct-port',
  targetOwner: 'user',
  port: '9001',
  statusUrl: 'http://127.0.0.1:9001/status',
  websocketUrl: 'ws://127.0.0.1:9001/websocket',
};

describe('shouldProbeHttpRpcForTraceSource', () => {
  it('does not use backend lease targets for normal file trace loads', () => {
    const traceSource = {type: 'FILE'} as TraceSource;

    expect(
      shouldProbeHttpRpcForTraceSource(
        'USE_HTTP_RPC_IF_AVAILABLE',
        traceSource,
        backendLeaseTarget,
      ),
    ).toBe(false);
  });

  it('does not use backend-owned direct port targets for normal file trace loads', () => {
    const traceSource = {type: 'FILE'} as TraceSource;

    expect(
      shouldProbeHttpRpcForTraceSource(
        'USE_HTTP_RPC_IF_AVAILABLE',
        traceSource,
        backendDirectTarget,
      ),
    ).toBe(false);
  });

  it('still probes user-owned direct port targets for normal file trace loads', () => {
    const traceSource = {type: 'FILE'} as TraceSource;

    expect(
      shouldProbeHttpRpcForTraceSource(
        'USE_HTTP_RPC_IF_AVAILABLE',
        traceSource,
        userDirectTarget,
      ),
    ).toBe(true);
  });

  it('always probes HTTP_RPC trace sources when RPC mode is enabled', () => {
    const traceSource = {type: 'HTTP_RPC'} as TraceSource;

    expect(
      shouldProbeHttpRpcForTraceSource(
        'USE_HTTP_RPC_IF_AVAILABLE',
        traceSource,
        backendLeaseTarget,
      ),
    ).toBe(true);
  });
});

describe('backendUploadSourceKey', () => {
  it('keeps the same File object stable for duplicate lifecycle calls', () => {
    const file = {name: 'trace.perfetto', size: 42, lastModified: 1000};
    const traceSource = {type: 'FILE', file} as TraceSource;

    expect(backendUploadSourceKey(traceSource)).toBe(
      backendUploadSourceKey(traceSource),
    );
  });

  it('distinguishes different File objects even when metadata matches', () => {
    const fileA = {name: 'trace.perfetto', size: 42, lastModified: 1000};
    const fileB = {name: 'trace.perfetto', size: 42, lastModified: 1000};

    expect(
      backendUploadSourceKey({type: 'FILE', file: fileA} as TraceSource),
    ).not.toBe(
      backendUploadSourceKey({type: 'FILE', file: fileB} as TraceSource),
    );
  });

});
