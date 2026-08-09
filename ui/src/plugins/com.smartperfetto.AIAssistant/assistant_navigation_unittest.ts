// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {resolveAssistantOpenTarget} from './assistant_navigation';

describe('resolveAssistantOpenTarget', () => {
  it('opens the trace panel only for an active timeline trace', () => {
    expect(resolveAssistantOpenTarget({hasTrace: true, timelineRouteActive: true}))
      .toBe('trace_panel');
  });

  it.each([
    {hasTrace: false, timelineRouteActive: false},
    {hasTrace: false, timelineRouteActive: true},
    {hasTrace: true, timelineRouteActive: false},
  ])('opens the standalone conversation page for $hasTrace/$timelineRouteActive', (input) => {
    expect(resolveAssistantOpenTarget(input)).toBe('conversation_page');
  });
});
