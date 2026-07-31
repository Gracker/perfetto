// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {fetchSmartPerfettoBackend} from '../../core/smartperfetto_backend_fetch';

export interface EnterpriseAuthWorkspace {
  workspaceId: string;
  name: string;
  role: string;
}

export interface EnterpriseAuthConfig {
  success: true;
  enterprise: boolean;
  oidc: {
    enabled: boolean;
    issuerUrl?: string;
    clientId?: string;
    scopes?: string[];
    loginPath: string;
    localLogoutOnly: boolean;
  };
}

export type EnterpriseAuthSession =
  | {
      success: true;
      authenticated: false;
    }
  | {
      success: true;
      authenticated: true;
      status:
        | 'ready'
        | 'needs_workspace_selection'
        | 'no_workspace_membership';
      tenantId: string;
      userId: string;
      workspaceId?: string;
      email?: string;
      displayName?: string;
      roles: string[];
      scopes: string[];
      workspaces: EnterpriseAuthWorkspace[];
      expiresAt: number;
    };

export interface EnterpriseAuthIdentity {
  tenantId: string;
  userId: string;
  workspaceId: string;
}

export interface OidcPopupResult {
  ok: boolean;
  status: string;
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function authApiUrl(backendUrl: string, path: string): string {
  return `${trimTrailingSlash(backendUrl)}/api/auth${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as
    | (T & {error?: string})
    | null;
  if (!response.ok || !body) {
    throw new Error(body?.error || `Authentication request failed (${response.status})`);
  }
  return body;
}

export async function fetchEnterpriseAuthConfig(
  backendUrl: string,
): Promise<EnterpriseAuthConfig> {
  const response = await fetchSmartPerfettoBackend(
    authApiUrl(backendUrl, '/config'),
  );
  return readJson<EnterpriseAuthConfig>(response);
}

export async function fetchEnterpriseAuthSession(
  backendUrl: string,
): Promise<EnterpriseAuthSession> {
  const response = await fetchSmartPerfettoBackend(
    authApiUrl(backendUrl, '/session'),
  );
  return readJson<EnterpriseAuthSession>(response);
}

export async function selectEnterpriseWorkspace(
  backendUrl: string,
  workspaceId: string,
): Promise<EnterpriseAuthSession> {
  const response = await fetchSmartPerfettoBackend(
    authApiUrl(backendUrl, '/onboarding/workspace'),
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({workspaceId}),
    },
  );
  await readJson(response);
  return fetchEnterpriseAuthSession(backendUrl);
}

export async function logoutEnterpriseSession(
  backendUrl: string,
): Promise<void> {
  const response = await fetchSmartPerfettoBackend(
    authApiUrl(backendUrl, '/logout'),
    {method: 'POST'},
  );
  await readJson(response);
}

export function buildOidcLoginUrl(
  backendUrl: string,
  returnTo: string,
): string {
  const url = new URL(authApiUrl(backendUrl, '/oidc/login'));
  url.searchParams.set('returnTo', returnTo);
  return url.toString();
}

export function signInWithOidc(
  backendUrl: string,
  returnTo: string = window.location.href,
  timeoutMs = 2 * 60 * 1000,
): Promise<OidcPopupResult> {
  const loginUrl = buildOidcLoginUrl(backendUrl, returnTo);
  const popup = window.open(
    loginUrl,
    'smartperfetto-oidc',
    'popup=yes,width=560,height=720,resizable=yes,scrollbars=yes',
  );
  if (!popup) {
    window.location.assign(loginUrl);
    return Promise.resolve({ok: false, status: 'redirecting'});
  }

  const expectedOrigin = new URL(backendUrl).origin;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result?: OidcPopupResult, error?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(closedTimer);
      window.clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result || {ok: false, status: 'cancelled'});
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as Partial<OidcPopupResult> & {type?: string};
      if (
        event.origin !== expectedOrigin
        || event.source !== popup
        || data?.type !== 'smartperfetto:oidc-callback'
        || typeof data.ok !== 'boolean'
        || typeof data.status !== 'string'
      ) {
        return;
      }
      finish({ok: data.ok, status: data.status});
    };
    window.addEventListener('message', onMessage);
    const closedTimer = window.setInterval(() => {
      if (popup.closed) finish({ok: false, status: 'cancelled'});
    }, 400);
    const timeout = window.setTimeout(() => {
      popup.close();
      finish(undefined, new Error('OIDC sign-in timed out'));
    }, timeoutMs);
  });
}

export function identityFromEnterpriseSession(
  session: EnterpriseAuthSession,
): EnterpriseAuthIdentity | null {
  if (
    !session.authenticated
    || session.status !== 'ready'
    || !session.workspaceId
  ) {
    return null;
  }
  return {
    tenantId: session.tenantId,
    userId: session.userId,
    workspaceId: session.workspaceId,
  };
}
