// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  buildHorizontalTracePairContext,
  buildTracePairContext,
} from './trace_pair_context';
import type {TracePairTraceSide} from './types';

describe('buildHorizontalTracePairContext', () => {
  it('returns undefined until both trace ids are available', () => {
    expect(buildHorizontalTracePairContext({
      currentTraceId: 'trace-current',
      currentTraceName: 'current.trace',
      referenceTraceId: null,
      referenceTraceName: null,
      isReferenceActive: false,
    })).toBeUndefined();
  });

  it('maps visual panes and spoken aliases to canonical trace roles', () => {
    const context = buildHorizontalTracePairContext({
      currentTraceId: 'trace-current',
      currentTraceName: 'current.trace',
      currentTraceFingerprint: 'fingerprint-current',
      referenceTraceId: 'trace-reference',
      referenceTraceName: 'reference.trace',
      isReferenceActive: false,
    });

    expect(context).toEqual({
      schemaVersion: 1,
      layout: 'horizontal',
      primarySide: 'left',
      referenceSide: 'right',
      activeSide: 'left',
      workspaceOpen: false,
      splitPercent: 50,
      aliases: expect.objectContaining({
        left: 'current',
        top: 'current',
        '左侧': 'current',
        '左边': 'current',
        '左窗口': 'current',
        '上方': 'current',
        '上边': 'current',
        '上面': 'current',
        '上窗口': 'current',
        right: 'reference',
        bottom: 'reference',
        '右侧': 'reference',
        '右边': 'reference',
        '右窗口': 'reference',
        '下方': 'reference',
        '下边': 'reference',
        '下面': 'reference',
        '下窗口': 'reference',
      }),
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          traceId: 'trace-current',
          traceName: 'current.trace',
          traceFingerprint: 'fingerprint-current',
          active: true,
          visualState: 'live',
        },
        {
          side: 'right',
          traceSide: 'reference',
          traceId: 'trace-reference',
          traceName: 'reference.trace',
          active: false,
          visualState: 'context_only',
        },
      ],
    });
  });
});

describe('buildTracePairContext', () => {
  it('marks both panes live when the same-page workspace is open', () => {
    const context = buildTracePairContext({
      currentTraceId: 'trace-current',
      currentTraceName: 'current.trace',
      referenceTraceId: 'trace-reference',
      referenceTraceName: 'reference.trace',
      activeTraceSide: 'reference',
      currentPane: 'first',
      layout: 'vertical',
      workspaceOpen: true,
      splitPercent: 61.2,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set<TracePairTraceSide>(),
    });

    expect(context).toMatchObject({
      schemaVersion: 1,
      layout: 'vertical',
      primarySide: 'top',
      referenceSide: 'bottom',
      activeSide: 'bottom',
      workspaceOpen: true,
      splitPercent: 61,
      panes: [
        {
          side: 'top',
          traceSide: 'current',
          active: false,
          visualState: 'live',
        },
        {
          side: 'bottom',
          traceSide: 'reference',
          active: true,
          visualState: 'live',
        },
      ],
    });
  });

  it('keeps minimized panes as context-only while preserving mapping', () => {
    const context = buildTracePairContext({
      currentTraceId: 'trace-current',
      currentTraceName: 'current.trace',
      referenceTraceId: 'trace-reference',
      referenceTraceName: 'reference.trace',
      activeTraceSide: 'current',
      currentPane: 'first',
      layout: 'horizontal',
      workspaceOpen: true,
      splitPercent: 12,
      maximizedTraceSide: 'current',
      minimizedTraceSides: new Set<TracePairTraceSide>(['reference']),
    });

    expect(context).toMatchObject({
      layout: 'horizontal',
      splitPercent: 18,
      maximizedTraceSide: 'current',
      minimizedTraceSides: ['reference'],
      panes: [
        {
          side: 'left',
          traceSide: 'current',
          visualState: 'live',
        },
        {
          side: 'right',
          traceSide: 'reference',
          visualState: 'context_only',
        },
      ],
    });
  });

  it('maps current and reference roles after the panes are swapped', () => {
    const context = buildTracePairContext({
      currentTraceId: 'trace-current',
      currentTraceName: 'current.trace',
      referenceTraceId: 'trace-reference',
      referenceTraceName: 'reference.trace',
      activeTraceSide: 'current',
      currentPane: 'second',
      layout: 'horizontal',
      workspaceOpen: true,
      splitPercent: 50,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set<TracePairTraceSide>(),
    });

    expect(context).toMatchObject({
      primarySide: 'right',
      referenceSide: 'left',
      activeSide: 'right',
      aliases: {
        left: 'reference',
        current: 'current',
        right: 'current',
        reference: 'reference',
        '左窗口': 'reference',
        '右窗口': 'current',
      },
      panes: [
        {side: 'right', traceSide: 'current'},
        {side: 'left', traceSide: 'reference'},
      ],
    });
  });
});
