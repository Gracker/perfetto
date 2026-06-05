// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  extractAnalysisResultRefs,
  findAnalysisResultByRef,
  formatAnalysisResultRef,
  isAnalysisResultComparisonRequest,
  resolveAnalysisResultComparisonRequest,
} from './analysis_result_references';
import type {
  AnalysisResultPickerItem,
  AnalysisResultWindowState,
} from './types';

function result(id: string, createdAt: number): AnalysisResultPickerItem {
  return {
    id,
    traceId: `trace-${id}`,
    sessionId: `session-${id}`,
    runId: `run-${id}`,
    visibility: 'private',
    sceneType: 'startup',
    title: `Result ${id}`,
    userQuery: '分析启动',
    traceLabel: `Trace ${id}`,
    status: 'ready',
    createdAt,
    metrics: [],
    evidenceRefs: [],
  };
}

describe('analysis result references', () => {
  const current = result(
    'analysis-result-11111111-aaaa-bbbb-cccc-111111111111',
    200,
  );
  const other = result(
    'analysis-result-22222222-aaaa-bbbb-cccc-222222222222',
    100,
  );

  it('formats stable short refs for persisted snapshot ids', () => {
    expect(formatAnalysisResultRef(current.id)).toBe('AR-11111111');
  });

  it('extends short refs when the default prefix would collide', () => {
    const colliding = result(
      'analysis-result-11111111-dddd-eeee-ffff-111111111111',
      150,
    );

    expect(formatAnalysisResultRef(current.id, [current.id, colliding.id])).toBe(
      'AR-11111111a',
    );
    expect(
      findAnalysisResultByRef([current, colliding], 'AR-11111111'),
    ).toBeNull();
    expect(
      findAnalysisResultByRef([current, colliding], 'AR-11111111a')?.id,
    ).toBe(current.id);
  });

  it('resolves an exact compact ref before treating it as a prefix', () => {
    const shorter = result('analysis-result-abcdef12', 160);
    const longer = result(
      'analysis-result-abcdef12-9999-aaaa-bbbb-cccccccccccc',
      150,
    );

    expect(formatAnalysisResultRef(shorter.id, [shorter.id, longer.id])).toBe(
      'AR-abcdef12',
    );
    expect(findAnalysisResultByRef([shorter, longer], 'AR-abcdef12')?.id).toBe(
      shorter.id,
    );
  });

  it('extracts explicit short and full snapshot refs from chat input', () => {
    expect(
      extractAnalysisResultRefs(`对比 AR-11111111 和 ${other.id}`),
    ).toEqual(['ar-11111111', other.id.toLowerCase()]);
  });

  it('matches explicit short refs back to picker items', () => {
    expect(findAnalysisResultByRef([current, other], 'AR-22222222')?.id).toBe(
      other.id,
    );
  });

  it('recognizes cross-window result comparison phrasing', () => {
    expect(isAnalysisResultComparisonRequest('对比一下另外一份')).toBe(true);
    expect(isAnalysisResultComparisonRequest('分析一下当前 trace')).toBe(false);
  });

  it('resolves current window latest result against another active window result', () => {
    const windows: AnalysisResultWindowState[] = [
      {
        windowId: 'current-window',
        latestSnapshotId: current.id,
        updatedAt: 1,
        expiresAt: 2,
      },
      {
        windowId: 'other-window',
        latestSnapshotId: other.id,
        updatedAt: 1,
        expiresAt: 2,
      },
    ];

    const resolved = resolveAnalysisResultComparisonRequest({
      query: '对比一下另外一份',
      results: [current, other],
      currentSnapshotId: current.id,
      activeWindowStates: windows,
      currentWindowId: 'current-window',
    });

    expect(resolved).toEqual({
      kind: 'resolved',
      resolution: {
        baselineId: current.id,
        candidateIds: [other.id],
        source: 'active_window',
      },
    });
  });

  it('asks for selection when multiple other active window results match', () => {
    const third = result(
      'analysis-result-33333333-aaaa-bbbb-cccc-333333333333',
      50,
    );
    const resolved = resolveAnalysisResultComparisonRequest({
      query: '对比一下另外一份',
      results: [current, other, third],
      currentSnapshotId: current.id,
      activeWindowStates: [
        {
          windowId: 'other-a',
          latestSnapshotId: other.id,
          updatedAt: 1,
          expiresAt: 2,
        },
        {
          windowId: 'other-b',
          latestSnapshotId: third.id,
          updatedAt: 1,
          expiresAt: 2,
        },
      ],
      currentWindowId: 'current-window',
    });

    expect(resolved).toEqual({
      kind: 'needs_selection',
      selection: {
        baselineId: current.id,
        candidateIds: [other.id, third.id],
        reason: 'ambiguous_candidates',
      },
    });
  });

  it('does not auto-compare a stale single historical result without active window evidence', () => {
    const resolved = resolveAnalysisResultComparisonRequest({
      query: '对比一下另外一份',
      results: [current, other],
      currentSnapshotId: current.id,
      activeWindowStates: [],
      currentWindowId: 'current-window',
    });

    expect(resolved).toEqual({
      kind: 'needs_selection',
      selection: {
        baselineId: current.id,
        candidateIds: [other.id],
        reason: 'ambiguous_candidates',
      },
    });
  });
});
