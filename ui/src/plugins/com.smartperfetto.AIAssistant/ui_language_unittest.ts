// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {uiOutputLanguage, uiTextForLanguage} from './ui_language';

describe('AI Assistant UI language', () => {
  it('uses Chinese only for Chinese browser locales', () => {
    expect(uiTextForLanguage('zh-CN', '中文', 'English')).toBe('中文');
    expect(uiTextForLanguage('zh-TW', '中文', 'English')).toBe('中文');
    expect(uiTextForLanguage('en-US', '中文', 'English')).toBe('English');
    expect(uiTextForLanguage(undefined, '中文', 'English')).toBe('English');
  });

  it('exposes a canonical backend language value', () => {
    expect(['en', 'zh-CN']).toContain(uiOutputLanguage());
  });
});
