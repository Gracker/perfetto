// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {MockedFunction} from 'vitest';

import {ProviderPanel} from './provider_panel';
import {ProviderQuickSwitcher} from './provider_switcher';
import {SettingsModal} from './settings_modal';
import {DEFAULT_SETTINGS} from './types';
import {
  createProviderCatalogEventSource,
  notifyProviderCatalogChanged,
  subscribeProviderCatalogChanged,
} from './provider_events';
import {resetAISharedState, updateAISharedState} from './ai_shared_state';

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

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((complete) => {
      resolve = complete;
    }),
    resolve: (response) => resolve(response),
  };
}

function providerPayload(
  name: string,
  options: {
    isActive?: boolean;
    agentRuntime?: 'claude-agent-sdk' | 'openai-agents-sdk';
  } = {},
) {
  return {
    success: true,
    providers: [
      {
        id: 'provider-1',
        name,
        category: 'official',
        type: 'deepseek',
        isActive: options.isActive ?? false,
        createdAt: '2026-07-03T00:00:00.000Z',
        updatedAt: '2026-07-03T00:00:00.000Z',
        models: {
          primary: 'deepseek-v4-pro',
          light: 'deepseek-v4-flash',
        },
        connection: {
          apiKey: '****1234',
          agentRuntime: options.agentRuntime ?? 'claude-agent-sdk',
          claudeBaseUrl: 'https://api.deepseek.com/anthropic',
        },
      },
    ],
  };
}

beforeEach(() => {
  resetAISharedState();
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
  resetAISharedState();
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
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(fetchMock.mock.calls[0]?.[1]?.cache).toBe('no-store');
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

  it('closes the dropdown before switching runtimes and renders the refreshed runtime', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          providerPayload('DeepSeek Work', {
            isActive: true,
            agentRuntime: 'claude-agent-sdk',
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse({success: true}))
      .mockResolvedValueOnce(
        jsonResponse(
          providerPayload('DeepSeek Work', {
            isActive: true,
            agentRuntime: 'openai-agents-sdk',
          }),
        ),
      );

    m.mount(root, {
      view: () =>
        m(ProviderQuickSwitcher, {
          backendUrl: 'http://backend',
        }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    const toggle = root.querySelector('button');
    if (!toggle) throw new Error('Provider switcher button missing');
    toggle.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    m.redraw.sync();

    const openAiButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent === 'OpenAI',
    );
    if (!openAiButton) throw new Error('OpenAI runtime button missing');
    openAiButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    m.redraw.sync();

    expect(root.textContent).not.toContain('Not tested');

    await vi.waitFor(() => {
      m.redraw.sync();
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(root.textContent).toContain('OA');
    });
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/provider-1/runtime');
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/provider-1/activate')
    )).toBe(false);
  });

  it('resets active analysis identity as soon as the runtime mutation succeeds', async () => {
    const onActivate = vi.fn();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        providerPayload('DeepSeek Work', {
          isActive: true,
          agentRuntime: 'claude-agent-sdk',
        }),
      ))
      .mockResolvedValueOnce(jsonResponse({success: true}))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({error: 'reload failed'}),
      } as Response);

    m.mount(root, {
      view: () => m(ProviderQuickSwitcher, {
        backendUrl: 'http://backend',
        onActivate,
      }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    root.querySelector('button')?.dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    );
    m.redraw.sync();
    const openAiButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent === 'OpenAI',
    );
    if (!openAiButton) throw new Error('OpenAI runtime button missing');
    openAiButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(onActivate).toHaveBeenCalledTimes(1);
    });
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/provider-1/activate')
    )).toBe(false);
  });

  it('resets identity after quick activation before the provider reload completes', async () => {
    const onActivate = vi.fn();
    const reload = deferredResponse();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(providerPayload('DeepSeek Work')))
      .mockResolvedValueOnce(jsonResponse({success: true}))
      .mockReturnValueOnce(reload.promise);

    m.mount(root, {
      view: () => m(ProviderQuickSwitcher, {
        backendUrl: 'http://backend',
        onActivate,
      }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    root.querySelector('button')?.dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    );
    m.redraw.sync();
    const providerItem = Array.from(root.querySelectorAll('div')).find(
      (element) => element.textContent === 'DeepSeek Work',
    );
    if (!providerItem) throw new Error('Provider item missing');
    providerItem.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(onActivate).toHaveBeenCalledTimes(1);
    reload.resolve(jsonResponse(providerPayload('DeepSeek Work', {isActive: true})));
  });

  it('resets identity after quick deactivation before the provider reload completes', async () => {
    const onActivate = vi.fn();
    const reload = deferredResponse();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        providerPayload('DeepSeek Work', {isActive: true}),
      ))
      .mockResolvedValueOnce(jsonResponse({success: true}))
      .mockReturnValueOnce(reload.promise);

    m.mount(root, {
      view: () => m(ProviderQuickSwitcher, {
        backendUrl: 'http://backend',
        onActivate,
      }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    root.querySelector('button')?.dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    );
    m.redraw.sync();
    const systemDefault = Array.from(root.querySelectorAll('div')).find(
      (element) => element.textContent === 'System Default',
    );
    if (!systemDefault) throw new Error('System Default item missing');
    systemDefault.dispatchEvent(new MouseEvent('click', {bubbles: true}));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(onActivate).toHaveBeenCalledTimes(1);
    reload.resolve(jsonResponse(providerPayload('DeepSeek Work')));
  });

  it('finishes the identity reset when the analysis lock starts in flight', async () => {
    const onActivate = vi.fn();
    let resolveRuntimeMutation: ((response: Response) => void) | undefined;
    const runtimeMutation = new Promise<Response>((resolve) => {
      resolveRuntimeMutation = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        providerPayload('DeepSeek Work', {
          isActive: true,
          agentRuntime: 'claude-agent-sdk',
        }),
      ))
      .mockReturnValueOnce(runtimeMutation)
      .mockResolvedValueOnce(jsonResponse(
        providerPayload('DeepSeek Work', {
          isActive: true,
          agentRuntime: 'openai-agents-sdk',
        }),
      ));

    m.mount(root, {
      view: () => m(ProviderQuickSwitcher, {
        backendUrl: 'http://backend',
        onActivate,
      }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    root.querySelector('button')?.dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    );
    m.redraw.sync();
    const openAiButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent === 'OpenAI',
    );
    if (!openAiButton) throw new Error('OpenAI runtime button missing');
    openAiButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    updateAISharedState({status: 'analyzing'});
    resolveRuntimeMutation?.(jsonResponse({success: true}));

    await vi.waitFor(() => {
      expect(onActivate).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  it('does not activate an inactive provider when the lock starts in flight', async () => {
    const onActivate = vi.fn();
    let resolveRuntimeMutation: ((response: Response) => void) | undefined;
    const runtimeMutation = new Promise<Response>((resolve) => {
      resolveRuntimeMutation = resolve;
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(
        providerPayload('DeepSeek Work', {
          isActive: false,
          agentRuntime: 'claude-agent-sdk',
        }),
      ))
      .mockReturnValueOnce(runtimeMutation)
      .mockResolvedValueOnce(jsonResponse({success: true}));

    m.mount(root, {
      view: () => m(ProviderQuickSwitcher, {
        backendUrl: 'http://backend',
        onActivate,
      }),
    });
    await flushAsyncWork();
    m.redraw.sync();

    root.querySelector('button')?.dispatchEvent(
      new MouseEvent('click', {bubbles: true}),
    );
    m.redraw.sync();
    const openAiButton = Array.from(root.querySelectorAll('button')).find(
      (button) => button.textContent === 'OpenAI',
    );
    if (!openAiButton) throw new Error('OpenAI runtime button missing');
    openAiButton.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    updateAISharedState({status: 'analyzing'});
    resolveRuntimeMutation?.(jsonResponse({success: true}));
    await flushAsyncWork();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) =>
      String(url).includes('/provider-1/activate')
    )).toBe(false);
    expect(onActivate).not.toHaveBeenCalled();
  });

  it.each([
    ['activation', 'activateProvider'],
    ['deactivation', 'deactivateAll'],
    ['active deletion', 'deleteProvider'],
  ] as const)(
    'resets identity after ProviderPanel %s before catalog reload completes',
    async (_label, mutationName) => {
      const onProviderSelectionChange = vi.fn();
      const providersReload = deferredResponse();
      const templatesReload = deferredResponse();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({success: true}))
        .mockReturnValueOnce(providersReload.promise)
        .mockReturnValueOnce(templatesReload.promise);
      const panel = new ProviderPanel() as unknown as {
        backendUrl: string;
        providers: ReturnType<typeof providerPayload>['providers'];
        onProviderSelectionChange: () => void;
        activateProvider: (id: string) => Promise<void>;
        deactivateAll: () => Promise<void>;
        deleteProvider: (id: string) => Promise<void>;
      };
      panel.backendUrl = 'http://backend';
      panel.providers = providerPayload('DeepSeek Work', {isActive: true}).providers;
      panel.onProviderSelectionChange = onProviderSelectionChange;

      const mutation = mutationName === 'deactivateAll'
        ? panel.deactivateAll()
        : panel[mutationName]('provider-1');
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(onProviderSelectionChange).toHaveBeenCalledTimes(1);

      providersReload.resolve(jsonResponse(providerPayload('DeepSeek Work')));
      templatesReload.resolve(jsonResponse({success: true, templates: []}));
      await mutation;
    },
  );
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
