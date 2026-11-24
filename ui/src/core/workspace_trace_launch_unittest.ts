// SPDX-License-Identifier: Apache-2.0

import {describe, expect, it} from 'vitest';

import {
  buildWorkspaceTraceViewerHash,
  parseWorkspaceTraceLaunch,
  workspaceViewerDocumentUrl,
} from './workspace_trace_launch';

describe('workspace trace launch', () => {
  it('pins frames to the app document without forwarding top-level search or hash', () => {
    expect(workspaceViewerDocumentUrl('http://127.0.0.1:10000/?oidc=1#!/somewhere'))
      .toBe('http://127.0.0.1:10000/index.html');
    expect(workspaceViewerDocumentUrl('https://perfetto.example/tools/index.html#!/analysis'))
      .toBe('https://perfetto.example/tools/index.html');
    expect(workspaceViewerDocumentUrl('https://perfetto.example/tools;scope,ui/'))
      .toBe('https://perfetto.example/tools%3Bscope%2Cui/index.html');
  });

  it('round-trips a stored baseline trace through the top-level viewer route', () => {
    const hash = buildWorkspaceTraceViewerHash({
      id: 'trace-baseline',
      filename: 'baseline trace.pftrace',
    });

    expect(hash).toContain('#!/viewer?');
    expect(
      parseWorkspaceTraceLaunch(`http://127.0.0.1:10000/${hash}`),
    ).toEqual({
      traceId: 'trace-baseline',
      traceFileName: 'baseline trace.pftrace',
    });
  });
});
