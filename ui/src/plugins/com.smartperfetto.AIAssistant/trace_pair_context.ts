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
  referenceTraceFallbackName?: string;
  activeTraceSide: TracePairTraceSide;
  currentPane: 'first' | 'second';
  layout: TracePairLayout;
  workspaceOpen: boolean;
  splitPercent: number;
  maximizedTraceSide: TracePairTraceSide | null;
  minimizedTraceSides: Set<TracePairTraceSide>;
}

export type BuildHorizontalTracePairContextInput = Omit<
  BuildTracePairContextInput,
  | 'activeTraceSide'
  | 'currentPane'
  | 'layout'
  | 'workspaceOpen'
  | 'splitPercent'
  | 'maximizedTraceSide'
  | 'minimizedTraceSides'
> & {
  isReferenceActive: boolean;
};

const TRACE_PAIR_SEMANTIC_ALIASES: Record<string, TracePairTraceSide> = {
  primary: 'current',
  main: 'current',
  current: 'current',
  '主': 'current',
  '当前': 'current',
  reference: 'reference',
  baseline: 'reference',
  '参考': 'reference',
};

const FIRST_PANE_ALIASES = [
  'left',
  'top',
  '左',
  '左侧',
  '左边',
  '左窗口',
  '上',
  '上方',
  '上边',
  '上面',
  '上窗口',
] as const;

const SECOND_PANE_ALIASES = [
  'right',
  'bottom',
  '右',
  '右侧',
  '右边',
  '右窗口',
  '下',
  '下方',
  '下边',
  '下面',
  '下窗口',
] as const;

export function buildTracePairContext(
  input: BuildTracePairContextInput,
): TracePairContext | undefined {
  if (!input.currentTraceId || !input.referenceTraceId) return undefined;

  const firstSide = input.layout === 'vertical' ? 'top' : 'left';
  const secondSide = input.layout === 'vertical' ? 'bottom' : 'right';
  const primarySide = input.currentPane === 'first' ? firstSide : secondSide;
  const referenceSide = input.currentPane === 'first' ? secondSide : firstSide;
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
    traceName:
      input.referenceTraceName ||
      input.referenceTraceFallbackName ||
      'Reference Trace',
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
    aliases: buildTracePairAliases(input.currentPane),
    panes: [currentPane, referencePane],
  };
}

export function buildHorizontalTracePairContext(
  input: BuildHorizontalTracePairContextInput,
): TracePairContext | undefined {
  return buildTracePairContext({
    ...input,
    activeTraceSide: input.isReferenceActive ? 'reference' : 'current',
    currentPane: 'first',
    layout: 'horizontal',
    workspaceOpen: false,
    splitPercent: 50,
    maximizedTraceSide: null,
    minimizedTraceSides: new Set(),
  });
}

function buildTracePairAliases(
  currentPane: 'first' | 'second',
): Record<string, TracePairTraceSide> {
  const firstTraceSide = currentPane === 'first' ? 'current' : 'reference';
  const secondTraceSide = currentPane === 'first' ? 'reference' : 'current';
  const aliases = {...TRACE_PAIR_SEMANTIC_ALIASES};
  for (const alias of FIRST_PANE_ALIASES) aliases[alias] = firstTraceSide;
  for (const alias of SECOND_PANE_ALIASES) aliases[alias] = secondTraceSide;
  return aliases;
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
