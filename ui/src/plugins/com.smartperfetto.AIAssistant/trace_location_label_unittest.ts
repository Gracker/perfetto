// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {traceLocationLabel, traceSideLabel} from './trace_location_label';

describe('traceLocationLabel', () => {
  it('presents compatibility trace roles as baseline and comparison', () => {
    expect(traceSideLabel('current')).toBe('Baseline trace');
    expect(traceSideLabel('reference')).toBe('Comparison trace');
    expect(traceLocationLabel('current', 'left')).toBe('Left/Baseline trace');
    expect(traceLocationLabel('reference', 'right')).toBe(
      'Right/Comparison trace',
    );
  });
});
