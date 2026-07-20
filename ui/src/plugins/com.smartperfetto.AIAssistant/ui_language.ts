// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type UiLanguagePreference = 'auto' | 'zh-CN' | 'en';
export type UiOutputLanguage = Exclude<UiLanguagePreference, 'auto'>;

let currentPreference: UiLanguagePreference = 'auto';

function browserOutputLanguage(): UiOutputLanguage {
  return typeof navigator !== 'undefined' &&
    navigator.language.toLowerCase().startsWith('zh')
    ? 'zh-CN'
    : 'en';
}

export function normalizeUiLanguagePreference(
  value: unknown,
): UiLanguagePreference {
  return value === 'zh-CN' || value === 'en' ? value : 'auto';
}

export function setUiLanguagePreference(value: unknown): void {
  currentPreference = normalizeUiLanguagePreference(value);
}

export function getUiLanguagePreference(): UiLanguagePreference {
  return currentPreference;
}

export function resolveUiOutputLanguage(
  preference: UiLanguagePreference = currentPreference,
): UiOutputLanguage {
  return preference === 'auto' ? browserOutputLanguage() : preference;
}

export function uiTextForLanguage(
  language: string | undefined,
  zh: string,
  en: string,
): string {
  return language?.toLowerCase().startsWith('zh') ? zh : en;
}

export function uiText(zh: string, en: string): string {
  return resolveUiOutputLanguage() === 'zh-CN' ? zh : en;
}

/** Canonical backend language contract derived from the saved UI preference. */
export function uiOutputLanguage(): UiOutputLanguage {
  return resolveUiOutputLanguage();
}
