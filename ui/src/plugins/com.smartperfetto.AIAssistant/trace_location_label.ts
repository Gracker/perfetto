// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TracePaneSide, TracePairTraceSide} from './types';
import {uiText} from './ui_language';

export function normalizeTraceSide(
  value: unknown,
): TracePairTraceSide | undefined {
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

export function traceSideLabel(
  traceSide: TracePairTraceSide | undefined,
): string {
  if (traceSide === 'current') return uiText('当前 Trace', 'Current trace');
  if (traceSide === 'reference') {
    return uiText('参考 Trace', 'Reference trace');
  }
  return '';
}

export function paneSideLabel(paneSide: TracePaneSide | undefined): string {
  if (paneSide === 'left') return uiText('左侧', 'Left');
  if (paneSide === 'right') return uiText('右侧', 'Right');
  if (paneSide === 'top') return uiText('上方', 'Top');
  if (paneSide === 'bottom') return uiText('下方', 'Bottom');
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
