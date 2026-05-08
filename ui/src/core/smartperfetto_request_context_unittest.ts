// Copyright (C) 2024 SmartPerfetto

import {beforeEach, describe, expect, it} from '@jest/globals';

import {
  buildSmartPerfettoContextHeaders,
  getSmartPerfettoWindowId,
} from './smartperfetto_request_context';

beforeEach(() => {
  sessionStorage.clear();
});

describe('SmartPerfetto frontend request context', () => {
  it('creates and reuses a stable per-window id', () => {
    const first = getSmartPerfettoWindowId();
    const second = getSmartPerfettoWindowId();

    expect(first).toMatch(/^win-/);
    expect(second).toBe(first);
    expect(sessionStorage.getItem('smartperfetto-window-id')).toBe(first);
  });

  it('injects X-Window-Id into backend request headers', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');

    expect(
      buildSmartPerfettoContextHeaders({'Content-Type': 'application/json'}),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-Window-Id': 'window-a',
    });
  });

  it('does not replace an explicit window header', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');

    expect(buildSmartPerfettoContextHeaders({'x-window-id': 'window-b'})).toEqual({
      'x-window-id': 'window-b',
    });
  });
});
