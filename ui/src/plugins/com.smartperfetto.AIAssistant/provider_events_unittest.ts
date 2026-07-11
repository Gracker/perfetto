// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MockedFunction} from 'vitest';

import {ProviderQuickSwitcher} from './provider_switcher';
import {SettingsModal} from './settings_modal';
import {DEFAULT_SETTINGS} from './types';
import {
  createProviderCatalogEventSource,
  notifyProviderCatalogChanged,
  subscribeProviderCatalogChanged,
} from './provider_events';

let originalFetch: typeof fetch;
let fetchMock: MockedFunction<typeof fetch>;
let root: HTMLDivElement;

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function providerPayload(name: string) {
  return {
    success: true,
    providers: [
      {
        id: 'provider-1',
        name,
        category: 'official',
        type: 'deepseek',
        isActive: false,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        models: {
          primary: 'deepseek-v4-pro',
          light: 'deepseek-v4-flash',
        },
        connection: {
          apiKey: '****1234',
          agentRuntime: 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
        },
      },
    ],
  };
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchMock = vi.fn<typeof fetch>();
  globalThis.fetch = fetchMock;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({matches: false}),
  });
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  m.mount(root, null);
  root.remove();
  globalThis.fetch = originalFetch;
});

describe('Provider catalog change events', () => {
  it('notifies listeners until they unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeProviderCatalogChanged(listener);
    const source = createProviderCatalogEventSource('test');

    notifyProviderCatalogChanged({reason: 'created', source});
    unsubscribe();
    notifyProviderCatalogChanged({reason: 'updated', source});

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({reason: 'created', source});
  });

  it('refreshes the provider switcher when another surface changes providers', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({success: true, providers: []}))
      .mockResolvedValueOnce(jsonResponse(providerPayload('DeepSeek Work')));

    m.mount(root, {
      view: () =>
        m(ProviderQuickSwitcher, {
          backendUrl: 'http://backend',
        }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('System Default');

    notifyProviderCatalogChanged({
      reason: 'created',
      source: createProviderCatalogEventSource('provider-panel-test'),
    });
    await flushAsyncWork();
    m.redraw.sync();

    const toggle = root.querySelector('button');
    if (!toggle) throw new Error('Provider switcher button missing');
    toggle.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    m.redraw.sync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(root.textContent).toContain('DeepSeek Work');
  });
});

describe('Analysis identity lock', () => {
  it('keeps connection settings and Provider mutation controls read-only', () => {
    const onSave = vi.fn();
    const onWorkspaceChange = vi.fn();
    const onProviderSelectionChange = vi.fn();

    m.mount(root, {
      view: () =>
        m(SettingsModal, {
          settings: {...DEFAULT_SETTINGS},
          workspaceContext: {
            tenantId: 'tenant-a',
            userId: 'user-a',
            workspaceId: 'workspace-a',
            windowId: 'window-a',
          },
          readOnly: true,
          onClose: () => {},
          onSave,
          onWorkspaceChange,
          onCheckStatus: async () => ({connected: true}),
          onProviderSelectionChange,
        }),
    });
    m.redraw.sync();

    const providerTab = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Providers'),
    );
    const saveButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Save Settings'),
    );
    const inputs = Array.from(root.querySelectorAll('input'));

    expect(providerTab?.disabled).toBe(true);
    expect(saveButton?.disabled).toBe(true);
    expect(inputs.length).toBeGreaterThan(1);
    expect(inputs.every((input) => input.disabled)).toBe(true);

    saveButton?.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(onSave).not.toHaveBeenCalled();
    expect(onWorkspaceChange).not.toHaveBeenCalled();
    expect(onProviderSelectionChange).not.toHaveBeenCalled();
  });

  it('hard-blocks quick-switcher mouse and keyboard mutations', async () => {
    fetchMock.mockResolvedValue(jsonResponse(providerPayload('DeepSeek Work')));

    m.mount(root, {
      view: () =>
        m(ProviderQuickSwitcher, {
          backendUrl: 'http://backend',
          disabled: true,
        }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    const toggle = root.querySelector('button');
    if (!toggle) throw new Error('Provider switcher button missing');
    expect(toggle.disabled).toBe(true);

    toggle.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'POST'),
    ).toBe(false);
  });
});
