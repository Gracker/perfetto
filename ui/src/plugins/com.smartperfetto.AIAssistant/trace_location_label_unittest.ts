// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {traceLocationLabel, traceSideLabel} from './trace_location_label';
import {setUiLanguagePreference} from './ui_language';

describe('traceLocationLabel', () => {
  beforeEach(() => setUiLanguagePreference('en'));

  it('presents compatibility trace roles as baseline and comparison', () => {
    expect(traceSideLabel('current')).toBe('Baseline trace');
    expect(traceSideLabel('reference')).toBe('Comparison trace');
    expect(traceLocationLabel('current', 'left')).toBe('Left/Baseline trace');
    expect(traceLocationLabel('reference', 'right')).toBe(
      'Right/Comparison trace',
    );
  });

  it('keeps vertical positions and semantic trace roles distinct', () => {
    expect(traceLocationLabel('current', 'top')).toBe('Top/Baseline trace');
    expect(traceLocationLabel('reference', 'bottom')).toBe(
      'Bottom/Comparison trace',
    );
  });

  it('does not invent a pane or a trace role when metadata is absent', () => {
    expect(traceLocationLabel('current', undefined)).toBe('Baseline trace');
    expect(traceLocationLabel('reference', undefined)).toBe('Comparison trace');
    expect(traceLocationLabel(undefined, 'top')).toBe('Top');
    expect(traceLocationLabel(undefined, undefined)).toBe('');
  });

  it('uses localized horizontal and vertical source labels', () => {
    setUiLanguagePreference('zh-CN');
    expect(traceLocationLabel('current', 'left')).toBe('左侧/基线 Trace');
    expect(traceLocationLabel('reference', 'right')).toBe('右侧/对比 Trace');
    expect(traceLocationLabel('current', 'top')).toBe('上方/基线 Trace');
    expect(traceLocationLabel('reference', 'bottom')).toBe('下方/对比 Trace');
    expect(traceLocationLabel('reference', undefined)).toBe('对比 Trace');
  });
});
