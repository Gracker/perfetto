// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from 'vitest';

import {
  getUiLanguagePreference,
  normalizeUiLanguagePreference,
  resolveUiOutputLanguage,
  setUiLanguagePreference,
  uiOutputLanguage,
  uiText,
  uiTextForLanguage,
} from './ui_language';

describe('AI Assistant UI language', () => {
  afterEach(() => {
    setUiLanguagePreference('auto');
  });

  it('uses Chinese only for Chinese browser locales', () => {
    expect(uiTextForLanguage('zh-CN', '中文', 'English')).toBe('中文');
    expect(uiTextForLanguage('zh-TW', '中文', 'English')).toBe('中文');
    expect(uiTextForLanguage('en-US', '中文', 'English')).toBe('English');
    expect(uiTextForLanguage(undefined, '中文', 'English')).toBe('English');
  });

  it('exposes a canonical backend language value', () => {
    expect(['en', 'zh-CN']).toContain(uiOutputLanguage());
  });

  it('normalizes persisted preferences without leaking auto to the backend', () => {
    expect(normalizeUiLanguagePreference('zh-CN')).toBe('zh-CN');
    expect(normalizeUiLanguagePreference('en')).toBe('en');
    expect(normalizeUiLanguagePreference('auto')).toBe('auto');
    expect(normalizeUiLanguagePreference('invalid')).toBe('auto');
    expect(['en', 'zh-CN']).toContain(resolveUiOutputLanguage('auto'));
  });

  it('uses an explicit preference for both UI text and backend requests', () => {
    setUiLanguagePreference('zh-CN');
    expect(getUiLanguagePreference()).toBe('zh-CN');
    expect(uiText('中文', 'English')).toBe('中文');
    expect(uiOutputLanguage()).toBe('zh-CN');

    setUiLanguagePreference('en');
    expect(uiText('中文', 'English')).toBe('English');
    expect(uiOutputLanguage()).toBe('en');
  });
});
