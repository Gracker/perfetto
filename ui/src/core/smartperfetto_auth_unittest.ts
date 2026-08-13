// Copyright (C) 2024 SmartPerfetto

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  getSmartPerfettoAuthSession,
  getSmartPerfettoAuthSessionGeneration,
  handleSmartPerfettoAuthResponse,
  invalidateSmartPerfettoAuthSession,
  refreshSmartPerfettoAuthSession,
  smartPerfettoFetch,
  withSmartPerfettoAuth,
} from './smartperfetto_auth';

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((complete) => {
      resolve = complete;
    }),
    resolve,
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: 'user-a', email: 'user@example.com'},
    tenant: {id: 'tenant-a', name: 'Tenant A'},
    workspace: {
      id: 'workspace-a',
      name: 'Personal Workspace',
      kind: 'personal',
    },
    csrfToken: 'csrf-token-a',
  };
});

describe('SmartPerfetto browser authentication', () => {
  it('accepts only a complete ready OIDC session', () => {
    expect(getSmartPerfettoAuthSession()?.workspace?.id).toBe('workspace-a');

    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      ...window.__SMARTPERFETTO_AUTH_SESSION__!,
      workspace: null,
    };
    expect(getSmartPerfettoAuthSession()).toBeUndefined();
  });

  it('adds credentials and CSRF only to OIDC mutation requests', () => {
    const post = withSmartPerfettoAuth({
      method: 'POST',
      headers: {Authorization: 'Bearer operator-key'},
    });
    expect(post.credentials).toBe('include');
    expect(new Headers(post.headers).get('Authorization')).toBe(
      'Bearer operator-key',
    );
    expect(new Headers(post.headers).get('X-CSRF-Token')).toBe(
      'csrf-token-a',
    );

    const get = withSmartPerfettoAuth({method: 'GET'});
    expect(get.credentials).toBe('include');
    expect(new Headers(get.headers).has('X-CSRF-Token')).toBe(false);
  });

  it('routes fetch through the authenticated request contract', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response('{}', {status: 200}));
    vi.stubGlobal('fetch', fetchMock);

    await smartPerfettoFetch('http://backend/api/resource', {method: 'DELETE'});

    const init = fetchMock.mock.calls[0][1];
    expect(init?.credentials).toBe('include');
    expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe(
      'csrf-token-a',
    );
  });

  it('does not change credential handling when OIDC is disabled', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false};
    const original = {method: 'POST'} as const;
    const untouched = withSmartPerfettoAuth(original);
    expect(untouched).toBe(original);

    const explicit = withSmartPerfettoAuth({
      method: 'GET',
      credentials: 'same-origin',
    });
    expect(explicit.credentials).toBe('same-origin');
  });

  it('invalidates OIDC authority before scheduling a reload on 401', () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    window.addEventListener('smartperfetto-auth-session-changed', listener);
    const before = getSmartPerfettoAuthSessionGeneration();

    handleSmartPerfettoAuthResponse(new Response('', {status: 401}));

    expect(getSmartPerfettoAuthSession()).toBeUndefined();
    expect(getSmartPerfettoAuthSessionGeneration()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('smartperfetto-auth-session-changed', listener);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('does not invalidate a non-OIDC session on 401', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false};
    const before = getSmartPerfettoAuthSessionGeneration();

    handleSmartPerfettoAuthResponse(new Response('', {status: 401}));

    expect(getSmartPerfettoAuthSessionGeneration()).toBe(before);
  });

  it('rejects a stale session refresh after authority invalidation', async () => {
    const sessionResponse = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(sessionResponse.promise);
    vi.stubGlobal('fetch', fetchMock);

    const refresh = refreshSmartPerfettoAuthSession('http://backend');
    invalidateSmartPerfettoAuthSession(false);
    sessionResponse.resolve(
      new Response(JSON.stringify(window.__SMARTPERFETTO_AUTH_SESSION__), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );

    await expect(refresh).resolves.toBeUndefined();
    expect(getSmartPerfettoAuthSession()).toBeUndefined();
  });
});
