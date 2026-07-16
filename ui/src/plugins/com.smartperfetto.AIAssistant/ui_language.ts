// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export function uiTextForLanguage(
  language: string | undefined,
  zh: string,
  en: string,
): string {
  return language?.toLowerCase().startsWith('zh') ? zh : en;
}

export function uiText(zh: string, en: string): string {
  return uiTextForLanguage(
    typeof navigator === 'undefined' ? undefined : navigator.language,
    zh,
    en,
  );
}

/** Canonical backend language contract derived from the current browser UI. */
export function uiOutputLanguage(): 'zh-CN' | 'en' {
  return typeof navigator !== 'undefined' &&
    navigator.language.toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en';
}
