// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  buildTraceConfigProposalPayload,
  formatTraceConfigCommand,
  parseCaptureCategories,
} from './capture_config_proposal_ui';

describe('capture config proposal UI helpers', () => {
  it('builds a side-effect-free proposal payload from form state', () => {
    const result = buildTraceConfigProposalPayload({
      request: ' debug startup jank ',
      app: ' com.example.app ',
      durationSeconds: '12',
      categories: 'gfx, view, gfx',
    });

    expect(result).toEqual({
      ok: true,
      payload: {
        request: 'debug startup jank',
        app: 'com.example.app',
        durationSeconds: 12,
        categories: ['gfx', 'view'],
      },
    });
  });

  it('rejects missing intent and invalid duration before calling the backend', () => {
    expect(buildTraceConfigProposalPayload({
      request: ' ',
      app: '',
      durationSeconds: '',
      categories: '',
    })).toEqual({ok: false, error: 'Capture intent is required'});

    expect(buildTraceConfigProposalPayload({
      request: 'startup',
      app: '',
      durationSeconds: '0',
      categories: '',
    })).toEqual({
      ok: false,
      error: 'Duration must be a positive number of seconds',
    });
  });

  it('parses category input and formats command previews', () => {
    expect(parseCaptureCategories('gfx, view, ,wm')).toEqual(['gfx', 'view', 'wm']);
    expect(formatTraceConfigCommand([
      'smp',
      'capture',
      'android',
      '--app',
      'com.example.app',
      '--out',
      '<trace.perfetto-trace>',
    ])).toBe('smp capture android --app com.example.app --out "<trace.perfetto-trace>"');
  });
});
