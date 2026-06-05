// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {
  buildAgentSseStreamInit,
  buildAgentSseStreamUrl,
} from './agent_sse_transport';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('Agent SSE transport', () => {
  it('builds the agent stream URL without cursor query params', () => {
    expect(buildAgentSseStreamUrl('http://backend/', 'session-a')).toBe(
      'http://backend/api/workspaces/default-workspace/agent/session-a/stream',
    );
  });

  it('sends replay cursor through Last-Event-ID header', () => {
    const controller = new AbortController();

    expect(buildAgentSseStreamInit(controller.signal, 42)).toEqual({
      signal: controller.signal,
      headers: {'Last-Event-ID': '42'},
    });
  });

  it('omits Last-Event-ID on fresh streams', () => {
    const controller = new AbortController();

    expect(buildAgentSseStreamInit(controller.signal, null)).toEqual({
      signal: controller.signal,
      headers: {},
    });
  });
});
