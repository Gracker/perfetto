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
  if (response.status === 401) scheduleAuthReload();
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
