// Copyright (C) 2024 SmartPerfetto
//
// Shared frontend request context for SmartPerfetto backend calls.

const WINDOW_ID_KEY = 'smartperfetto-window-id';
const TENANT_ID_KEY = 'smartperfetto-tenant-id';
const USER_ID_KEY = 'smartperfetto-user-id';
const WORKSPACE_PREFERENCE_KEY_PREFIX =
  'smartperfetto-workspace-preference';

const DEFAULT_SMARTPERFETTO_TENANT_ID = 'default-dev-tenant';
const DEFAULT_SMARTPERFETTO_USER_ID = 'dev-user-123';
const DEFAULT_SMARTPERFETTO_WORKSPACE_ID = 'default-workspace';

export type SmartPerfettoStorageScope = 'user' | 'workspace' | 'window';

export interface SmartPerfettoRequestContext {
  tenantId: string;
  userId: string;
  workspaceId: string;
  windowId: string;
}

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

function sanitizeContextId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
  return normalized || fallback;
}

function getLocalStorageValue(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function setLocalStorageValue(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore storage failures in private browsing / quota edge cases.
  }
}

function getWorkspacePreferenceKey(tenantId: string, userId: string): string {
  return `${WORKSPACE_PREFERENCE_KEY_PREFIX}:${tenantId}:${userId}`;
}

export function getSmartPerfettoTenantId(): string {
  return sanitizeContextId(
    getLocalStorageValue(TENANT_ID_KEY),
    DEFAULT_SMARTPERFETTO_TENANT_ID,
  );
}

export function getSmartPerfettoUserId(): string {
  return sanitizeContextId(
    getLocalStorageValue(USER_ID_KEY),
    DEFAULT_SMARTPERFETTO_USER_ID,
  );
}

export function getSmartPerfettoWorkspaceId(
  tenantId = getSmartPerfettoTenantId(),
  userId = getSmartPerfettoUserId(),
): string {
  return sanitizeContextId(
    getLocalStorageValue(getWorkspacePreferenceKey(tenantId, userId)),
    DEFAULT_SMARTPERFETTO_WORKSPACE_ID,
  );
}

export function setSmartPerfettoWorkspaceId(
  workspaceId: string,
  tenantId = getSmartPerfettoTenantId(),
  userId = getSmartPerfettoUserId(),
): string {
  const sanitized = sanitizeContextId(
    workspaceId,
    DEFAULT_SMARTPERFETTO_WORKSPACE_ID,
  );
  setLocalStorageValue(getWorkspacePreferenceKey(tenantId, userId), sanitized);
  return sanitized;
}

export function getSmartPerfettoRequestContext(): SmartPerfettoRequestContext {
  const tenantId = getSmartPerfettoTenantId();
  const userId = getSmartPerfettoUserId();
  const workspaceId = getSmartPerfettoWorkspaceId(tenantId, userId);
  return {
    tenantId,
    userId,
    workspaceId,
    windowId: getSmartPerfettoWindowId(),
  };
}

function resolveContext(
  context?: Partial<SmartPerfettoRequestContext>,
): SmartPerfettoRequestContext {
  const current = getSmartPerfettoRequestContext();
  return {
    tenantId: sanitizeContextId(context?.tenantId, current.tenantId),
    userId: sanitizeContextId(context?.userId, current.userId),
    workspaceId: sanitizeContextId(context?.workspaceId, current.workspaceId),
    windowId: sanitizeContextId(context?.windowId, current.windowId),
  };
}

export function getSmartPerfettoStorageNamespace(
  scope: SmartPerfettoStorageScope,
  context?: Partial<SmartPerfettoRequestContext>,
): string {
  const resolved = resolveContext(context);
  const workspaceNamespace = [
    resolved.tenantId,
    resolved.userId,
    resolved.workspaceId,
  ].join(':');

  switch (scope) {
    case 'user':
      return [resolved.tenantId, resolved.userId].join(':');
    case 'window':
      return `${workspaceNamespace}:${resolved.windowId}`;
    case 'workspace':
    default:
      return workspaceNamespace;
  }
}

export function buildSmartPerfettoStorageKey(
  baseKey: string,
  scope: SmartPerfettoStorageScope = 'workspace',
  context?: Partial<SmartPerfettoRequestContext>,
): string {
  return `${baseKey}:${getSmartPerfettoStorageNamespace(scope, context)}`;
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
  const context = getSmartPerfettoRequestContext();
  const next = {...normalized};
  if (!hasHeader(next, 'x-tenant-id')) {
    next['X-Tenant-Id'] = context.tenantId;
  }
  if (!hasHeader(next, 'x-workspace-id')) {
    next['X-Workspace-Id'] = context.workspaceId;
  }
  if (!hasHeader(next, 'x-window-id')) {
    next['X-Window-Id'] = context.windowId;
  }
  return next;
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function ensureLeadingSlash(value: string): string {
  if (!value) return '';
  return String(value).startsWith('/') ? String(value) : `/${String(value)}`;
}

export function buildSmartPerfettoWorkspaceApiUrl(
  backendUrl: string,
  resource:
    | 'traces'
    | 'reports'
    | 'agent'
    | 'providers'
    | 'analysis-results'
    | 'windows'
    | 'comparisons'
    | 'trace-config',
  path = '',
): string {
  const {workspaceId} = getSmartPerfettoRequestContext();
  return `${trimTrailingSlash(backendUrl)}/api/workspaces/${encodeURIComponent(
    workspaceId,
  )}/${resource}${ensureLeadingSlash(path)}`;
}

export function buildSmartPerfettoTraceProcessorProxyTarget(
  backendUrl: string,
  leaseId: string,
  leaseStatus: {
    leaseMode?: 'shared' | 'isolated' | string;
    leaseModeReason?: string;
    leaseQueueLength?: number;
  } = {},
) {
  const context = getSmartPerfettoRequestContext();
  const encodedLeaseId = encodeURIComponent(leaseId);
  const query = new URLSearchParams({
    tenantId: context.tenantId,
    userId: context.userId,
    workspaceId: context.workspaceId,
    windowId: context.windowId,
  }).toString();
  const httpBase = `${trimTrailingSlash(backendUrl)}/api/tp/${encodedLeaseId}`;
  const parsedBackend = new URL(trimTrailingSlash(backendUrl));
  const websocketProtocol = parsedBackend.protocol === 'https:' ? 'wss:' : 'ws:';
  const pathPrefix = parsedBackend.pathname.replace(/\/+$/, '');
  const websocketBase = `${websocketProtocol}//${parsedBackend.host}${pathPrefix}`;
  const suffix = query ? `?${query}` : '';

  return {
    mode: 'backend-lease-proxy' as const,
    targetOwner: 'smartperfetto-backend' as const,
    leaseId,
    leaseMode: leaseStatus.leaseMode,
    leaseModeReason: leaseStatus.leaseModeReason,
    leaseQueueLength: leaseStatus.leaseQueueLength,
    statusUrl: `${httpBase}/status${suffix}`,
    websocketUrl: `${websocketBase}/api/tp/${encodedLeaseId}/websocket${suffix}`,
    heartbeatUrl: `${httpBase}/heartbeat${suffix}`,
    displayName: `backend ${leaseStatus.leaseMode ?? 'unknown'} lease ${leaseId.slice(0, 8)}`,
    headers: buildSmartPerfettoContextHeaders(),
    credentials: 'include' as const,
  };
}
