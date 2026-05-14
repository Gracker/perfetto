// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';

import {latestSnapshotFromAnalysisCompletedEvent} from './analysis_result_snapshot_state';
import type {LatestAnalysisSnapshot} from './types';

describe('analysis result snapshot state', () => {
  const current: LatestAnalysisSnapshot = {
    snapshotId: 'analysis-result-old',
    status: 'ready',
    sceneType: 'startup',
    metricCount: 3,
    evidenceRefCount: 1,
    traceId: 'trace-old',
    sessionId: 'session-old',
    runId: 'run-old',
    visibility: 'private',
    createdAt: 1,
  };

  it('updates stale current snapshot from analysis_completed resultSnapshotId', () => {
    expect(
      latestSnapshotFromAnalysisCompletedEvent({
        eventData: {
          data: {
            resultSnapshotId: 'analysis-result-new',
            partial: false,
          },
        },
        current,
        traceId: 'trace-new',
        sessionId: 'session-new',
        runId: 'run-new',
        now: 123,
      }),
    ).toEqual({
      snapshotId: 'analysis-result-new',
      status: 'ready',
      sceneType: 'general',
      metricCount: 0,
      evidenceRefCount: 0,
      traceId: 'trace-new',
      sessionId: 'session-new',
      runId: 'run-new',
      visibility: 'private',
      createdAt: 123,
    });
  });

  it('marks partial completed analysis snapshots as partial', () => {
    expect(
      latestSnapshotFromAnalysisCompletedEvent({
        eventData: {
          data: {
            resultSnapshotId: 'analysis-result-partial',
            partial: true,
          },
        },
        now: 456,
      })?.status,
    ).toBe('partial');
  });

  it('does not rewrite state when analysis_completed repeats the current snapshot', () => {
    expect(
      latestSnapshotFromAnalysisCompletedEvent({
        eventData: {
          data: {
            resultSnapshotId: current.snapshotId,
          },
        },
        current,
      }),
    ).toBeNull();
  });
});
