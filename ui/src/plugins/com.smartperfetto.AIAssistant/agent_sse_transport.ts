// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {buildAssistantApiV1Url} from './assistant_api_v1';

export function buildAgentSseStreamUrl(
  backendUrl: string,
  sessionId: string,
): string {
  return buildAssistantApiV1Url(backendUrl, `/${sessionId}/stream`);
}

export function buildAgentSseStreamInit(
  signal: AbortSignal,
  lastEventId: number | null,
): RequestInit {
  const headers: Record<string, string> = {};
  if (lastEventId !== null && Number.isFinite(lastEventId)) {
    headers['Last-Event-ID'] = String(Math.max(0, Math.floor(lastEventId)));
  }
  return {
    signal,
    headers,
  };
}
