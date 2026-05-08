// Copyright (C) 2024 SmartPerfetto
//
// Shared frontend request context for SmartPerfetto backend calls.

const WINDOW_ID_KEY = 'smartperfetto-window-id';

function createWindowId(): string {
  return `win-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function getSmartPerfettoWindowId(): string {
  try {
    const existing = sessionStorage.getItem(WINDOW_ID_KEY);
    if (existing) return existing;
    const next = createWindowId();
    sessionStorage.setItem(WINDOW_ID_KEY, next);
    return next;
  } catch {
    return createWindowId();
  }
}

function normalizeHeaders(headers?: HeadersInit): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return {...headers};
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lowerName = name.toLowerCase();
  return Object.keys(headers).some(key => key.toLowerCase() === lowerName);
}

export function buildSmartPerfettoContextHeaders(
  headers?: HeadersInit,
): Record<string, string> {
  const normalized = normalizeHeaders(headers);
  if (hasHeader(normalized, 'x-window-id')) {
    return normalized;
  }
  return {
    ...normalized,
    'X-Window-Id': getSmartPerfettoWindowId(),
  };
}
