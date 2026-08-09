// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {parseConversationSseFrames} from './conversation_client';

describe('parseConversationSseFrames', () => {
  it('parses complete events and preserves an incomplete tail', () => {
    expect(parseConversationSseFrames(
      'event: connected\ndata: {"runId":"run-1"}\n\n' +
      'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"ok"}}\n',
    )).toEqual({
      events: [{type: 'connected', data: {runId: 'run-1'}}],
      remainder: 'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"ok"}}\n',
    });
  });

  it('supports CRLF and multi-line data', () => {
    expect(parseConversationSseFrames(
      'event: note\r\ndata: first\r\ndata: second\r\n\r\n',
    ).events).toEqual([{type: 'note', data: 'first\nsecond'}]);
  });
});
