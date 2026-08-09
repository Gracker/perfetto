// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {resolveChatInputKeyAction} from './chat_input';

describe('resolveChatInputKeyAction', () => {
  it('does not submit Enter while an IME composition is active', () => {
    expect(
      resolveChatInputKeyAction(
        {key: 'Enter', shiftKey: false, isComposing: true, keyCode: 13},
        false,
      ),
    ).toBe('ignore');
    expect(
      resolveChatInputKeyAction(
        {key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13},
        true,
      ),
    ).toBe('ignore');
  });

  it('does not submit legacy IME Enter events with keyCode 229', () => {
    expect(
      resolveChatInputKeyAction(
        {key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229},
        false,
      ),
    ).toBe('ignore');
  });

  it('submits ordinary Enter and preserves Shift+Enter as a newline', () => {
    expect(
      resolveChatInputKeyAction(
        {key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13},
        false,
      ),
    ).toBe('submit');
    expect(
      resolveChatInputKeyAction(
        {key: 'Enter', shiftKey: true, isComposing: false, keyCode: 13},
        false,
      ),
    ).toBe('newline');
  });

  it('keeps command-history navigation separate from text submission', () => {
    expect(
      resolveChatInputKeyAction(
        {key: 'ArrowUp', shiftKey: false, isComposing: false, keyCode: 38},
        false,
      ),
    ).toBe('history_previous');
    expect(
      resolveChatInputKeyAction(
        {key: 'ArrowDown', shiftKey: false, isComposing: false, keyCode: 40},
        false,
      ),
    ).toBe('history_next');
  });
});
