// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  TracePairContext,
  TracePairLayout,
  TracePairTraceSide,
} from './types';

export interface BuildTracePairContextInput {
  currentTraceId: string | null;
  currentTraceName: string;
  currentTraceFingerprint?: string | null;
  referenceTraceId: string | null;
  referenceTraceName?: string | null;
  activeTraceSide: TracePairTraceSide;
  layout: TracePairLayout;
  workspaceOpen: boolean;
  splitPercent: number;
  maximizedTraceSide: TracePairTraceSide | null;
  minimizedTraceSides: Set<TracePairTraceSide>;
}

export type BuildHorizontalTracePairContextInput = Omit<
  BuildTracePairContextInput,
  | 'activeTraceSide'
  | 'layout'
  | 'workspaceOpen'
  | 'splitPercent'
  | 'maximizedTraceSide'
  | 'minimizedTraceSides'
> & {
  isReferenceActive: boolean;
};

const TRACE_PAIR_ALIASES: Record<string, TracePairTraceSide> = {
  left: 'current',
  top: 'current',
  primary: 'current',
  main: 'current',
  current: 'current',
  '左': 'current',
  '左侧': 'current',
  '左边': 'current',
  '左窗口': 'current',
  '上': 'current',
  '上方': 'current',
  '上边': 'current',
  '上面': 'current',
  '上窗口': 'current',
  '主': 'current',
  '当前': 'current',
  right: 'reference',
  bottom: 'reference',
  reference: 'reference',
  baseline: 'reference',
  '右': 'reference',
  '右侧': 'reference',
  '右边': 'reference',
  '右窗口': 'reference',
  '下': 'reference',
  '下方': 'reference',
  '下边': 'reference',
  '下面': 'reference',
  '下窗口': 'reference',
  '参考': 'reference',
};

export function buildTracePairContext(
  input: BuildTracePairContextInput,
): TracePairContext | undefined {
  if (!input.currentTraceId || !input.referenceTraceId) return undefined;

  const primarySide = input.layout === 'vertical' ? 'top' : 'left';
  const referenceSide = input.layout === 'vertical' ? 'bottom' : 'right';
  const activeSide = input.activeTraceSide === 'reference'
    ? referenceSide
    : primarySide;
  const minimizedTraceSides = Array.from(input.minimizedTraceSides);

  const currentPane: TracePairContext['panes'][number] = {
    side: primarySide,
    traceSide: 'current',
    traceId: input.currentTraceId,
    traceName: input.currentTraceName,
    active: input.activeTraceSide === 'current',
    visualState: isTracePaneLive(input, 'current') ? 'live' : 'context_only',
  };
  if (input.currentTraceFingerprint) {
    currentPane.traceFingerprint = input.currentTraceFingerprint;
  }

  const referencePane: TracePairContext['panes'][number] = {
    side: referenceSide,
    traceSide: 'reference',
    traceId: input.referenceTraceId,
    traceName: input.referenceTraceName || '参考 Trace',
    active: input.activeTraceSide === 'reference',
    visualState: isTracePaneLive(input, 'reference') ? 'live' : 'context_only',
  };

  return {
    schemaVersion: 1,
    layout: input.layout,
    primarySide,
    referenceSide,
    activeSide,
    workspaceOpen: input.workspaceOpen,
    splitPercent: clampSplitPercent(input.splitPercent),
    ...(input.maximizedTraceSide
      ? {maximizedTraceSide: input.maximizedTraceSide}
      : {}),
    ...(minimizedTraceSides.length > 0 ? {minimizedTraceSides} : {}),
    aliases: {...TRACE_PAIR_ALIASES},
    panes: [currentPane, referencePane],
  };
}

export function buildHorizontalTracePairContext(
  input: BuildHorizontalTracePairContextInput,
): TracePairContext | undefined {
  return buildTracePairContext({
    ...input,
    activeTraceSide: input.isReferenceActive ? 'reference' : 'current',
    layout: 'horizontal',
    workspaceOpen: false,
    splitPercent: 50,
    maximizedTraceSide: null,
    minimizedTraceSides: new Set(),
  });
}

function isTracePaneLive(
  input: BuildTracePairContextInput,
  traceSide: TracePairTraceSide,
): boolean {
  if (!input.workspaceOpen) return traceSide === 'current';
  if (
    input.maximizedTraceSide !== null &&
    input.maximizedTraceSide !== traceSide
  ) {
    return false;
  }
  return !input.minimizedTraceSides.has(traceSide);
}

function clampSplitPercent(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.min(82, Math.max(18, Math.round(value)));
}
