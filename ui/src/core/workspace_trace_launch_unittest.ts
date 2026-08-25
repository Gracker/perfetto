// SPDX-License-Identifier: Apache-2.0

import {describe, expect, it} from 'vitest';

import {
  buildWorkspaceTraceViewerHash,
  parseWorkspaceTraceLaunch,
} from './workspace_trace_launch';

describe('workspace trace launch', () => {
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
