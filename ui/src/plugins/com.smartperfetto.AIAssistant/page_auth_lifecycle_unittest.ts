// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {invalidateSmartPerfettoAuthSession} from '../../core/smartperfetto_auth';
import {PageAuthGate} from './page_auth_lifecycle';

let root: HTMLDivElement;
let mounted = 0;
let removed = 0;

const Probe: m.Component = {
  oninit: () => { mounted++; },
  onremove: () => { removed++; },
  view: () => m('div', {'data-page-auth-probe': 'ready'}, 'ready'),
};

function installOidcSession(
  userId = 'user-a',
  workspaceId = 'workspace-a',
): void {
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: userId, email: `${userId}@example.test`},
    tenant: {id: 'tenant-a', name: 'Tenant A'},
    workspace: {id: workspaceId, name: workspaceId, kind: 'personal'},
  };
}

function mountGate(): void {
  m.mount(root, {
    view: () => m(PageAuthGate, {content: m(Probe)}),
  });
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.appendChild(root);
  mounted = 0;
  removed = 0;
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  m.mount(root, null);
  root.remove();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('PageAuthGate', () => {
  it('keeps local/API-key content available without an OIDC session', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false};

    mountGate();

    expect(root.querySelector('[data-page-auth-probe="ready"]')).not.toBeNull();
    expect(root.querySelector('[data-ai-auth-state]')).toBeNull();
  });

  it('does not mount identity-bound content before OIDC authority is ready', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};

    mountGate();

    expect(root.querySelector('[data-page-auth-probe="ready"]')).toBeNull();
    expect(root.querySelector('[data-ai-auth-state="unauthenticated"]')).not.toBeNull();
    expect(root.querySelector('[data-ai-auth-relogin]')).not.toBeNull();
  });

  it('unmounts ready content after the real auth invalidation event', () => {
    installOidcSession();
    mountGate();
    expect(mounted).toBe(1);

    invalidateSmartPerfettoAuthSession(false);
    m.redraw.sync();

    expect(root.querySelector('[data-page-auth-probe="ready"]')).toBeNull();
    expect(root.querySelector('[data-ai-auth-state="unauthenticated"]')).not.toBeNull();
    expect(removed).toBe(1);
  });

  it('remounts identity-bound content when the ready user/workspace changes', () => {
    installOidcSession('user-a', 'workspace-a');
    mountGate();
    expect(mounted).toBe(1);

    installOidcSession('user-b', 'workspace-b');
    window.dispatchEvent(new Event('smartperfetto-auth-session-changed'));
    m.redraw.sync();

    expect(root.querySelector('[data-page-auth-probe="ready"]')).not.toBeNull();
    expect(removed).toBe(1);
    expect(mounted).toBe(2);
  });
});
