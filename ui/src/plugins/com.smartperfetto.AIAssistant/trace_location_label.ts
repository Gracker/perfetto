// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TracePaneSide, TracePairTraceSide} from './types';

export function normalizeTraceSide(value: unknown): TracePairTraceSide | undefined {
  return value === 'current' || value === 'reference' ? value : undefined;
}

export function normalizePaneSide(value: unknown): TracePaneSide | undefined {
  switch (value) {
    case 'left':
    case 'right':
    case 'top':
    case 'bottom':
      return value;
    default:
      return undefined;
  }
}

export function traceSideLabel(traceSide: TracePairTraceSide | undefined): string {
  if (traceSide === 'current') return '当前 Trace';
  if (traceSide === 'reference') return '参考 Trace';
  return '';
}

export function paneSideLabel(paneSide: TracePaneSide | undefined): string {
  if (paneSide === 'left') return '左侧';
  if (paneSide === 'right') return '右侧';
  if (paneSide === 'top') return '上方';
  if (paneSide === 'bottom') return '下方';
  return '';
}

export function traceLocationLabel(
  traceSide: TracePairTraceSide | undefined,
  paneSide: TracePaneSide | undefined,
): string {
  const pane = paneSideLabel(paneSide);
  const trace = traceSideLabel(traceSide);
  if (pane && trace) return `${pane}/${trace}`;
  return pane || trace;
}
