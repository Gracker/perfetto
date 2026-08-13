// Copyright (C) 2024 SmartPerfetto

import {beforeEach, describe, expect, it} from 'vitest';

import {
  buildSmartPerfettoStorageKey,
  buildSmartPerfettoContextHeaders,
  buildSmartPerfettoTraceProcessorProxyTarget,
  buildSmartPerfettoWorkspaceApiUrl,
  getSmartPerfettoRequestContext,
  getSmartPerfettoStorageNamespace,
  getSmartPerfettoWindowId,
  setSmartPerfettoWorkspaceId,
  tryGetSmartPerfettoRequestContext,
} from './smartperfetto_request_context';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('SmartPerfetto frontend request context', () => {
  it('creates and reuses a stable per-window id', () => {
    const first = getSmartPerfettoWindowId();
    const second = getSmartPerfettoWindowId();

    expect(first).toMatch(/^win-/);
    expect(second).toBe(first);
    expect(sessionStorage.getItem('smartperfetto-window-id')).toBe(first);
  });

  it('injects X-Window-Id into backend request headers', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');

    expect(
      buildSmartPerfettoContextHeaders({'Content-Type': 'application/json'}),
    ).toEqual({
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'default-dev-tenant',
      'X-Workspace-Id': 'default-workspace',
      'X-Window-Id': 'window-a',
    });
  });

  it('does not replace explicit context headers', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');

    expect(
      buildSmartPerfettoContextHeaders({
        'x-tenant-id': 'tenant-b',
        'x-workspace-id': 'workspace-b',
        'x-window-id': 'window-b',
      }),
    ).toEqual({
      'x-tenant-id': 'tenant-b',
      'x-workspace-id': 'workspace-b',
      'x-window-id': 'window-b',
    });
  });

  it('uses the OIDC session identity and replaces caller-supplied scope headers', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-oidc', email: 'user@example.com'},
      tenant: {id: 'tenant-oidc', name: 'Tenant'},
      workspace: {
        id: 'workspace-oidc',
        name: 'Personal Workspace',
        kind: 'personal',
      },
      csrfToken: 'csrf-oidc',
    };
    sessionStorage.setItem('smartperfetto-window-id', 'window-oidc');

    expect(setSmartPerfettoWorkspaceId('workspace-spoofed')).toBe(
      'workspace-oidc',
    );
    expect(getSmartPerfettoRequestContext()).toEqual({
      tenantId: 'tenant-oidc',
      userId: 'user-oidc',
      workspaceId: 'workspace-oidc',
      windowId: 'window-oidc',
    });
    expect(
      buildSmartPerfettoContextHeaders({
        'x-tenant-id': 'tenant-spoofed',
        'X-Workspace-Id': 'workspace-spoofed',
      }),
    ).toMatchObject({
      'X-Tenant-Id': 'tenant-oidc',
      'X-Workspace-Id': 'workspace-oidc',
      'X-Window-Id': 'window-oidc',
    });
  });

  it('persists the workspace preference under the tenant and user namespace', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');

    setSmartPerfettoWorkspaceId('workspace-a');

    expect(getSmartPerfettoRequestContext()).toEqual({
      tenantId: 'default-dev-tenant',
      userId: 'dev-user-123',
      workspaceId: 'workspace-a',
      windowId: 'window-a',
    });
    expect(
      localStorage.getItem(
        'smartperfetto-workspace-preference:default-dev-tenant:dev-user-123',
      ),
    ).toBe('workspace-a');
    expect(buildSmartPerfettoContextHeaders()).toMatchObject({
      'X-Workspace-Id': 'workspace-a',
    });
  });

  it('builds user, workspace, and window scoped storage namespaces', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');
    setSmartPerfettoWorkspaceId('workspace-a');

    expect(getSmartPerfettoStorageNamespace('user')).toBe(
      'default-dev-tenant:dev-user-123',
    );
    expect(getSmartPerfettoStorageNamespace('workspace')).toBe(
      'default-dev-tenant:dev-user-123:workspace-a',
    );
    expect(getSmartPerfettoStorageNamespace('window')).toBe(
      'default-dev-tenant:dev-user-123:workspace-a:window-a',
    );
    expect(buildSmartPerfettoStorageKey('settings')).toBe(
      'settings:default-dev-tenant:dev-user-123:workspace-a',
    );
  });

  it('builds workspace resource API URLs from the selected workspace', () => {
    setSmartPerfettoWorkspaceId('workspace-a');

    expect(
      buildSmartPerfettoWorkspaceApiUrl('http://backend/', 'agent', '/resume'),
    ).toBe('http://backend/api/workspaces/workspace-a/agent/resume');
    expect(buildSmartPerfettoWorkspaceApiUrl('http://backend', 'traces')).toBe(
      'http://backend/api/workspaces/workspace-a/traces',
    );
  });

  it('builds trace processor lease proxy status, websocket, and heartbeat URLs', () => {
    sessionStorage.setItem('smartperfetto-window-id', 'window-a');
    setSmartPerfettoWorkspaceId('workspace-a');

    const target = buildSmartPerfettoTraceProcessorProxyTarget(
      'https://backend.example/base/',
      'lease-a',
      {leaseMode: 'shared'},
    );

    expect(target.statusUrl).toContain(
      'https://backend.example/base/api/tp/lease-a/status?',
    );
    expect(target.websocketUrl).toContain(
      'wss://backend.example/base/api/tp/lease-a/websocket?',
    );
    expect(target.heartbeatUrl).toContain(
      'https://backend.example/base/api/tp/lease-a/heartbeat?',
    );
    expect(target.headers).toMatchObject({'X-Window-Id': 'window-a'});
    expect(target.credentials).toBe('include');
  });

  it('adds the OIDC CSRF token to trace processor status and heartbeat requests', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-oidc', email: 'user@example.com'},
      tenant: {id: 'tenant-oidc', name: 'Tenant'},
      workspace: {
        id: 'workspace-oidc',
        name: 'Personal Workspace',
        kind: 'personal',
      },
      csrfToken: 'csrf-oidc',
    };

    const target = buildSmartPerfettoTraceProcessorProxyTarget(
      'https://backend.example',
      'lease-oidc',
    );

    expect(target.credentials).toBe('include');
    expect(target.headers).toMatchObject({
      'X-Tenant-Id': 'tenant-oidc',
      'X-Workspace-Id': 'workspace-oidc',
      'X-CSRF-Token': 'csrf-oidc',
    });
  });

  it('fails closed for optional context reads after OIDC authority expires', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};

    expect(tryGetSmartPerfettoRequestContext()).toBeUndefined();
  });

  it('returns the complete context for an authenticated OIDC page', () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-optional', email: 'user@example.com'},
      tenant: {id: 'tenant-optional', name: 'Tenant'},
      workspace: {id: 'workspace-optional', name: 'Workspace', kind: 'personal'},
    };

    expect(tryGetSmartPerfettoRequestContext()).toEqual(expect.objectContaining({
      tenantId: 'tenant-optional',
      userId: 'user-optional',
      workspaceId: 'workspace-optional',
    }));
  });
});
