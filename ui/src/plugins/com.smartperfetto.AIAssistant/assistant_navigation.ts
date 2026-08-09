// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type AssistantOpenTarget = 'trace_panel' | 'conversation_page';

export function resolveAssistantOpenTarget(input: {
  hasTrace: boolean;
  timelineRouteActive: boolean;
}): AssistantOpenTarget {
  return input.hasTrace && input.timelineRouteActive
    ? 'trace_panel'
    : 'conversation_page';
}
