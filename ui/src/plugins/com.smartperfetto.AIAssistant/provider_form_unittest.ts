// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import type * as Auth from '../../core/smartperfetto_auth';
import {ProviderForm, type ProviderFormAttrs} from './provider_form';
import type {ProviderConfig, ProviderTemplate} from './provider_types';
import {setUiLanguagePreference} from './ui_language';

vi.mock('../../core/smartperfetto_auth', async (importOriginal) => ({
  ...(await importOriginal<typeof Auth>()),
  smartPerfettoFetch: vi.fn(),
}));

const templates: ProviderTemplate[] = [
  {
    type: 'glm',
    displayName: 'GLM',
    requiredFields: ['connection.apiKey'],
    defaultModels: {primary: 'glm-current', light: 'glm-flash'},
    availableModels: [
      {id: 'glm-current', name: 'GLM Current', tier: 'primary'},
    ],
    defaultConnection: {
      claudeBaseUrl: 'https://example.com/anthropic',
      agentRuntime: 'claude-agent-sdk',
    },
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.apiKey'],
    defaultModels: {primary: 'gpt-current', light: 'gpt-small'},
    availableModels: [],
    defaultConnection: {
      openaiBaseUrl: 'https://api.openai.com/v1',
      agentRuntime: 'openai-agents-sdk',
    },
  },
  {
    type: 'custom',
    displayName: 'Custom',
    requiredFields: [],
    defaultModels: {primary: '', light: ''},
    availableModels: [],
  },
];

function saved(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'saved',
    name: 'Personal provider',
    type: 'glm',
    category: 'official',
    isActive: false,
    createdAt: '',
    updatedAt: '',
    models: {
      primary: 'unlisted/new-model',
      light: 'legacy-light',
      subAgent: 'legacy-agent',
    },
    connection: {
      apiKey: 'shared***',
      claudeApiKey: 'claude***',
      claudeAuthToken: 'token***',
      openaiApiKey: 'openai***',
      claudeBaseUrl: 'https://custom.example/claude',
      openaiBaseUrl: 'https://custom.example/v1',
      agentRuntime: 'openai-agents-sdk',
      openaiProtocol: 'responses',
    },
    tuning: {maxTurns: 42, enableVerification: false},
    custom: {envOverrides: {EXAMPLE: 'value'}},
    ...overrides,
  };
}

describe('ProviderForm', () => {
  let root: HTMLElement;
  let attrs: ProviderFormAttrs;
  beforeEach(() => {
    setUiLanguagePreference('en');
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({matches: false})),
    );
    vi.mocked(smartPerfettoFetch)
      .mockReset()
      .mockResolvedValue({ok: true} as Response);
    root = document.createElement('div');
    document.body.appendChild(root);
    attrs = {
      backendUrl: 'http://localhost:3000',
      templates,
      onSaved: vi.fn(),
      onCancel: vi.fn(),
    };
  });
  afterEach(() => {
    m.mount(root, null);
    root.remove();
    vi.unstubAllGlobals();
    setUiLanguagePreference('auto');
  });
  function mount(overrides: Partial<ProviderFormAttrs> = {}) {
    attrs = {...attrs, ...overrides};
    m.mount(root, {view: () => m(ProviderForm, attrs)});
  }
  function input(id: string, value: string) {
    const el = root.querySelector<HTMLInputElement>(`#${id}`)!;
    el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    m.redraw.sync();
  }
  function choose(type: string) {
    const el = root.querySelector<HTMLSelectElement>('#provider-type')!;
    el.value = type;
    el.dispatchEvent(new Event('change', {bubbles: true}));
    m.redraw.sync();
  }
  async function save() {
    const button = Array.from(root.querySelectorAll('button')).find((el) =>
      /Create Provider|Save Changes/.test(el.textContent || ''),
    )!;
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    return JSON.parse(
      String(vi.mocked(smartPerfettoFetch).mock.calls[0][1]?.body),
    );
  }
  it.each([
    'anthropic',
    'openai',
    'glm',
    'ollama',
    'vertex',
    'bedrock',
    'custom',
  ] as const)(
    'renders %s connection surface and exposes required settings',
    (type) => {
      const template: ProviderTemplate = {
        ...templates[0],
        type,
        displayName: type,
        requiredFields:
          type === 'vertex'
            ? ['connection.gcpProjectId', 'connection.gcpRegion']
            : [],
      };
      mount({templates: [template]});
      expect(root.querySelector('#provider-model-primary')).not.toBeNull();
      expect(root.querySelector<HTMLDetailsElement>('details')!.open).toBe(
        false,
      );
      if (type === 'vertex') {
        expect(
          root.querySelector('#provider-gcpProjectId')!.closest('details'),
        ).toBeNull();
      }
      if (type === 'bedrock') expect(root.textContent).toContain('AWS Region');
    },
  );
  it('prefills templates with a compact selector and collapsed advanced settings', async () => {
    mount();
    expect(root.querySelectorAll('#provider-type option')).toHaveLength(3);
    expect(root.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(root.querySelector<HTMLInputElement>('#provider-name')!.value).toBe(
      'GLM',
    );
    expect(
      root.querySelector<HTMLInputElement>('#provider-model-primary')!.value,
    ).toBe('glm-current');
    input('provider-apiKey', 'new-secret');
    const body = await save();
    expect(body.name).toBe('GLM');
    expect(body.connection.claudeBaseUrl).toBe('https://example.com/anthropic');
    expect(body.models.light).toBe('glm-flash');
    expect(attrs.onSaved).toHaveBeenCalledOnce();
  });
  it('offers datalist choices while saving exact unlisted model IDs for all roles', async () => {
    mount();
    expect(
      root
        .querySelector('#provider-model-primary-options option')!
        .getAttribute('value'),
    ).toBe('glm-current');
    for (const role of ['primary', 'light', 'subAgent']) {
      input(`provider-model-${role}`, ` new/${role}-2027 `);
    }
    const body = await save();
    expect(body.models).toEqual({
      primary: 'new/primary-2027',
      light: 'new/light-2027',
      subAgent: 'new/subAgent-2027',
    });
  });
  it('uses provider-scoped live choices without changing the saved model value', () => {
    const provider = saved();
    mount({
      editingProvider: provider,
      availableModels: [
        {id: 'glm-account-model', name: 'GLM Account Model', tier: 'primary'},
      ],
    });

    expect(
      root
        .querySelector('#provider-model-primary-options option')!
        .getAttribute('value'),
    ).toBe('glm-account-model');
    expect(
      root.querySelector<HTMLInputElement>('#provider-model-primary')!.value,
    ).toBe(provider.models.primary);
  });
  it('updates generated names on type changes but keeps user names', () => {
    mount();
    choose('openai');
    expect(root.querySelector<HTMLInputElement>('#provider-name')!.value).toBe(
      'OpenAI',
    );
    input('provider-name', 'My endpoint');
    choose('glm');
    expect(root.querySelector<HTMLInputElement>('#provider-name')!.value).toBe(
      'My endpoint',
    );
  });
  it('preserves unknown saved models, connection overrides, masked keys and tuning on edit', async () => {
    const provider = saved();
    mount({editingProvider: provider});
    expect(root.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
    expect(
      root.querySelector<HTMLInputElement>('#provider-model-primary')!.value,
    ).toBe(provider.models.primary);
    expect(
      root.querySelector<HTMLInputElement>('#provider-openaiApiKey')!.value,
    ).toBe('openai***');
    expect(
      root.querySelector<HTMLSelectElement>('#provider-type')!.disabled,
    ).toBe(true);
    input('provider-model-primary', 'another-new-model');
    const body = await save();
    expect(body.connection).toEqual(provider.connection);
    expect(body.tuning).toEqual(provider.tuning);
    expect(body.custom).toEqual(provider.custom);
    expect(body.models.light).toBe('legacy-light');
    expect(vi.mocked(smartPerfettoFetch).mock.calls[0][1]?.method).toBe(
      'PATCH',
    );
  });
  it('edits effective runtime credentials without changing shared or other-runtime keys', async () => {
    const provider = saved();
    mount({editingProvider: provider});
    input('provider-openaiApiKey', 'replacement');
    const body = await save();
    expect(body.connection).toEqual({
      ...provider.connection,
      openaiApiKey: 'replacement',
    });
  });
  it('clones name, models and custom metadata without replacing them with defaults', async () => {
    const provider = saved();
    mount({cloneSource: provider});
    const body = await save();
    expect(body.name).toBe('Personal provider (Copy)');
    expect(body.models).toEqual(provider.models);
    expect(body.custom).toEqual(provider.custom);
    expect(vi.mocked(smartPerfettoFetch).mock.calls[0][1]?.method).toBe('POST');
  });
  it('uses primary as light fallback for custom models and rejects an empty primary', async () => {
    mount();
    choose('custom');
    const button = Array.from(root.querySelectorAll('button')).find(
      (el) => el.textContent === 'Create Provider',
    )!;
    button.click();
    m.redraw.sync();
    expect(smartPerfettoFetch).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Enter a primary model ID');
    input('provider-model-primary', ' custom/new-model ');
    const body = await save();
    expect(body.models).toEqual({
      primary: 'custom/new-model',
      light: 'custom/new-model',
    });
  });
  it('shows custom Pi and Qoder required settings outside advanced details', () => {
    mount();
    choose('custom');
    const runtimeButton = (name: string) =>
      Array.from(root.querySelectorAll('button')).find(
        (el) => el.textContent === name,
      )!;
    runtimeButton('Pi Agent Core').click();
    m.redraw.sync();
    expect(
      root.querySelector('#provider-piAgentCoreModelJson')!.closest('details'),
    ).toBeNull();
    runtimeButton('Qoder SDK').click();
    m.redraw.sync();
    expect(
      root.querySelector('#provider-qoderAccessToken')!.closest('details'),
    ).toBeNull();
  });
});
