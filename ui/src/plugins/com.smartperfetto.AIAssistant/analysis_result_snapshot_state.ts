// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {LatestAnalysisSnapshot} from './types';

export function latestSnapshotFromAnalysisCompletedEvent(input: {
  eventData?: unknown;
  current?: LatestAnalysisSnapshot | null;
  traceId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  now?: number;
}): LatestAnalysisSnapshot | null {
  const event =
    input.eventData && typeof input.eventData === 'object'
      ? input.eventData as Record<string, unknown>
      : null;
  const payload =
    event?.data && typeof event.data === 'object'
      ? event.data as Record<string, unknown>
      : null;
  const snapshotId =
    typeof payload?.resultSnapshotId === 'string'
      ? payload.resultSnapshotId
      : '';
  if (!snapshotId || input.current?.snapshotId === snapshotId) return null;

  return {
    snapshotId,
    status: payload?.partial === true ? 'partial' : 'ready',
    sceneType: 'general',
    metricCount: 0,
    evidenceRefCount: 0,
    traceId: input.traceId || undefined,
    sessionId: input.sessionId || undefined,
    runId: input.runId || undefined,
    visibility: 'private',
    createdAt: input.now ?? Date.now(),
  };
}
