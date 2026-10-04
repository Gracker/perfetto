// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {LatestAnalysisSnapshot} from './types';
import {uiText} from './ui_language';

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

/** The private material a snapshot's run could read; `unknown` for snapshots written before markers. */
export type AnalysisResultPrivateContext =
  | {codebase: boolean; knowledge: boolean}
  | 'unknown';

/** Read a snapshot's marker; anything unreadable is `unknown`, which restricts like private. */
export function parseAnalysisResultPrivateContext(value: unknown): AnalysisResultPrivateContext {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const {codebase, knowledge} = value as Record<string, unknown>;
    if (typeof codebase === 'boolean' && typeof knowledge === 'boolean') return {codebase, knowledge};
  }
  return 'unknown';
}

/**
 * Only a snapshot proven to have read no private source or knowledge may be
 * offered for workspace sharing; the backend refuses the rest
 * (`PRIVATE_CONTEXT_NOT_SHAREABLE`).
 */
export function analysisResultShareable(item: {
  visibility: string;
  privateContext?: AnalysisResultPrivateContext;
}): boolean {
  const context = item.privateContext;
  return item.visibility === 'private' && context !== undefined && context !== 'unknown' &&
    !context.codebase && !context.knowledge;
}

/** A visibility change the backend refused because the run read private material. */
export class PrivateContextNotShareableError extends Error {
  constructor() {
    super(uiText(
      '这次分析读取过私有源码或知识库，只对创建者可见，不能共享。',
      'This analysis read private source or knowledge; it stays with its creator and cannot be shared.',
    ));
    this.name = 'PrivateContextNotShareableError';
  }
}

/**
 * Read a visibility PATCH response: the updated snapshot payload, or a
 * thrown `PrivateContextNotShareableError` / HTTP error.
 */
export async function readAnalysisResultVisibilityResponse(response: Response): Promise<unknown> {
  if (response.status === 409) {
    const payload = await response.clone().json().catch(() => null) as {code?: unknown} | null;
    if (payload?.code === 'PRIVATE_CONTEXT_NOT_SHAREABLE') throw new PrivateContextNotShareableError();
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json() as {snapshot?: unknown}).snapshot;
}
