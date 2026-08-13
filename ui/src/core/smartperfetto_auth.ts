// Copyright (C) 2024 SmartPerfetto
//
// Browser-side OIDC session contract shared by SmartPerfetto backend clients.

export interface SmartPerfettoAuthSession {
  success: boolean;
  authenticated: boolean;
  authMode: 'local' | 'api_key' | 'oidc' | string;
  status:
    | 'unauthenticated'
    | 'ready'
    | 'needs_workspace_selection'
    | 'no_workspace_membership'
    | string;
  user?: {
    id: string;
    email: string;
    displayName?: string;
  };
  tenant?: {
    id: string;
    name: string;
  };
  workspace?: {
    id: string;
    name: string;
    kind: 'personal' | 'managed' | string;
  } | null;
  roles?: string[];
  scopes?: string[];
  expiresAt?: number;
  csrfToken?: string | null;
}

declare global {
  interface Window {
    __SMARTPERFETTO_AUTH_SESSION__?: SmartPerfettoAuthSession;
  }
}

let authReloadScheduled = false;
let authSessionGeneration = 0;

const AUTH_INVALIDATION_CHANNEL = 'smartperfetto-auth-invalidation';
let authInvalidationChannel: BroadcastChannel | undefined;

function dispatchSmartPerfettoAuthSessionChanged(): void {
  window.dispatchEvent(new Event('smartperfetto-auth-session-changed'));
}

export function getSmartPerfettoAuthSessionGeneration(): number {
  return authSessionGeneration;
}

/**
 * Invalidate the page's OIDC runtime without restoring identity from browser
 * storage. Logout and authentication failures use this same path.
 */
export function invalidateSmartPerfettoAuthSession(
  broadcast = true,
): void {
  authSessionGeneration++;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  dispatchSmartPerfettoAuthSessionChanged();
  if (broadcast) {
    try {
      authInvalidationChannel?.postMessage({type: 'invalidated'});
    } catch {
      // BroadcastChannel is only a best-effort cross-tab hint. The backend
      // remains authoritative for every subsequent scoped request.
    }
  }
}

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  try {
    authInvalidationChannel = new BroadcastChannel(AUTH_INVALIDATION_CHANNEL);
    authInvalidationChannel.addEventListener('message', (event: MessageEvent) => {
      if (event.data?.type === 'invalidated') {
        invalidateSmartPerfettoAuthSession(false);
      }
    });
  } catch {
    // Private-mode or embedded browsers can deny BroadcastChannel. Same-tab
    // teardown still runs through the DOM event above.
  }
}

export function isSmartPerfettoOidcMode(): boolean {
  try {
    return window.__SMARTPERFETTO_CONFIG__?.oidcEnabled === true;
  } catch {
    return false;
  }
}

export function getSmartPerfettoAuthSession():
  | SmartPerfettoAuthSession
  | undefined {
  try {
    const session = window.__SMARTPERFETTO_AUTH_SESSION__;
    if (!session || session.authenticated !== true || session.status !== 'ready') {
      return undefined;
    }
    if (!session.user?.id || !session.tenant?.id || !session.workspace?.id) {
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export async function refreshSmartPerfettoAuthSession(
  backendUrl: string,
): Promise<SmartPerfettoAuthSession | undefined> {
  if (!isSmartPerfettoOidcMode()) return undefined;
  const refreshGeneration = authSessionGeneration;
  const endpoint = `${backendUrl.replace(/\/+$/, '')}/api/auth/session`;
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      cache: 'no-cache',
      credentials: 'include',
    });
    if (refreshGeneration !== authSessionGeneration) return undefined;
    if (!response.ok) {
      throw new Error(`OIDC session request failed (${response.status})`);
    }
    const session = await response.json() as SmartPerfettoAuthSession;
    if (refreshGeneration !== authSessionGeneration) return undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = session;
    const hydrated = getSmartPerfettoAuthSession();
    if (!hydrated) {
      invalidateSmartPerfettoAuthSession();
      return undefined;
    }
    dispatchSmartPerfettoAuthSessionChanged();
    return hydrated;
  } catch {
    if (refreshGeneration === authSessionGeneration) {
      invalidateSmartPerfettoAuthSession();
    }
    return undefined;
  }
}

export function requireSmartPerfettoAuthSession(): SmartPerfettoAuthSession {
  const session = getSmartPerfettoAuthSession();
  if (!session) {
    throw new Error('SmartPerfetto OIDC session is not ready');
  }
  return session;
}

export function getSmartPerfettoCsrfToken(): string | undefined {
  const token = getSmartPerfettoAuthSession()?.csrfToken;
  return typeof token === 'string' && token ? token : undefined;
}

function isMutationMethod(method: string | undefined): boolean {
  const normalized = (method || 'GET').toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

function scheduleAuthReload(): void {
  if (!isSmartPerfettoOidcMode() || authReloadScheduled) return;
  authReloadScheduled = true;
  window.setTimeout(() => window.location.reload(), 0);
}

export async function smartPerfettoFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const authenticatedInit = withSmartPerfettoAuth(init);
  const response = await fetch(input, authenticatedInit);
  return handleSmartPerfettoAuthResponse(response);
}

export function handleSmartPerfettoAuthResponse(response: Response): Response {
  if (isSmartPerfettoOidcMode() && response.status === 401) {
    invalidateSmartPerfettoAuthSession();
    scheduleAuthReload();
  }
  return response;
}

export function withSmartPerfettoAuth(init: RequestInit = {}): RequestInit {
  const oidcMode = isSmartPerfettoOidcMode();
  if (!oidcMode) return init;

  const headers = new Headers(init.headers);
  if (isMutationMethod(init.method)) {
    const csrfToken = getSmartPerfettoCsrfToken();
    if (csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }
  return {
    ...init,
    headers,
    credentials: 'include',
  };
}
