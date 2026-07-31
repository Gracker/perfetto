// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  buildOidcLoginUrl,
  fetchEnterpriseAuthSession,
  identityFromEnterpriseSession,
  selectEnterpriseWorkspace,
  signInWithOidc,
} from './enterprise_auth';
import {EnterpriseAuthCard} from './enterprise_auth_card';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('enterprise auth browser API', () => {
  it('uses credentialed requests and refreshes the HttpOnly session after selection', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({success: true}), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        authenticated: true,
        status: 'ready',
        tenantId: 'tenant-a',
        userId: 'user-a',
        workspaceId: 'workspace-a',
        roles: ['analyst'],
        scopes: ['trace:read'],
        workspaces: [],
        expiresAt: Date.now() + 60_000,
      }), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }));
    vi.stubGlobal('fetch', fetchMock);

    const session = await selectEnterpriseWorkspace(
      'https://backend.example/',
      'workspace-a',
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://backend.example/api/auth/onboarding/workspace',
      expect.objectContaining({
        method: 'POST',
        credentials: 'include',
        body: JSON.stringify({workspaceId: 'workspace-a'}),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://backend.example/api/auth/session',
      expect.objectContaining({credentials: 'include'}),
    );
    expect(identityFromEnterpriseSession(session)).toEqual({
      tenantId: 'tenant-a',
      userId: 'user-a',
      workspaceId: 'workspace-a',
    });
  });

  it('does not invent an identity before a workspace is ready', async () => {
    const response = new Response(JSON.stringify({
      success: true,
      authenticated: false,
    }), {
      status: 200,
      headers: {'Content-Type': 'application/json'},
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));

    expect(
      identityFromEnterpriseSession(
        await fetchEnterpriseAuthSession('http://127.0.0.1:3000'),
      ),
    ).toBeNull();
  });

  it('builds an allowlist-checkable login return target', () => {
    const url = new URL(buildOidcLoginUrl(
      'https://backend.example/',
      'https://frontend.example/viewer#trace',
    ));
    expect(url.origin).toBe('https://backend.example');
    expect(url.pathname).toBe('/api/auth/oidc/login');
    expect(url.searchParams.get('returnTo')).toBe(
      'https://frontend.example/viewer#trace',
    );
  });

  it('accepts only a validated popup callback', async () => {
    const popup = {
      closed: false,
      close: vi.fn(),
    } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);

    const signIn = signInWithOidc(
      'https://backend.example',
      'https://frontend.example/viewer',
      5_000,
    );
    const unrelated = new MessageEvent('message', {
      data: {type: 'unrelated'},
      origin: 'https://backend.example',
      source: popup,
    });
    window.dispatchEvent(unrelated);

    const callback = new MessageEvent('message', {
      data: {
        type: 'smartperfetto:oidc-callback',
        perfettoIgnore: true,
        ok: true,
        status: 'ready',
      },
      origin: 'https://backend.example',
      source: popup,
    });
    window.dispatchEvent(callback);

    await expect(signIn).resolves.toEqual({ok: true, status: 'ready'});
  });

  it('clears a stale enterprise identity when the browser session is no longer ready', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        enterprise: true,
        oidc: {
          enabled: true,
          loginPath: '/api/auth/oidc/login',
          localLogoutOnly: true,
        },
      }), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        authenticated: false,
      }), {
        status: 200,
        headers: {'Content-Type': 'application/json'},
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onIdentityChange = vi.fn();
    const root = document.createElement('div');
    document.body.appendChild(root);
    try {
      m.mount(root, {
        view: () => m(EnterpriseAuthCard, {
        backendUrl: 'https://backend.example',
        onIdentityChange,
        }),
      });

      await vi.waitFor(() => {
        expect(onIdentityChange).toHaveBeenCalledWith(null);
      });
    } finally {
      m.mount(root, null);
      root.remove();
    }
  });
});
