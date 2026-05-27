// Copyright (C) 2024 SmartPerfetto
//
// Runtime SmartPerfetto backend URL resolution shared by the AI Assistant
// plugin and trace auto-upload code.

export const DEFAULT_SMARTPERFETTO_BACKEND_PORT = '3000';

export interface SmartPerfettoRuntimeConfig {
  backendUrl?: string;
  backendPort?: string | number;
  frontendPort?: string | number;
}

declare global {
  interface Window {
    __SMARTPERFETTO_CONFIG__?: SmartPerfettoRuntimeConfig;
  }
}

function readRuntimeConfig(): SmartPerfettoRuntimeConfig {
  try {
    return window.__SMARTPERFETTO_CONFIG__ || {};
  } catch {
    return {};
  }
}

function normalizePort(value: unknown): string | undefined {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    return undefined;
  }
  return String(parsed);
}

function normalizeBackendUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return trimmed;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

export function getSmartPerfettoBackendPort(): string {
  return normalizePort(readRuntimeConfig().backendPort)
    || DEFAULT_SMARTPERFETTO_BACKEND_PORT;
}

export function getDefaultSmartPerfettoBackendUrl(): string {
  const configuredUrl = normalizeBackendUrl(readRuntimeConfig().backendUrl);
  if (configuredUrl) return configuredUrl;

  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:${getSmartPerfettoBackendPort()}`;
}

export function isDefaultSmartPerfettoBackendUrl(value: unknown): boolean {
  const normalized = normalizeBackendUrl(value);
  if (!normalized) return false;

  const legacyDefaults = new Set([
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ]);
  if (legacyDefaults.has(normalized)) return true;

  return normalized === getDefaultSmartPerfettoBackendUrl();
}
