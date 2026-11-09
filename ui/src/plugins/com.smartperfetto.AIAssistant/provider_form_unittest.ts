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
      agentRuntime: 'pi-agent-core',
    },
    piCatalogRouteSurfaces: ['openai'],
    defaultApiSurface: 'claude',
  },
  {
    type: 'openai',
    displayName: 'OpenAI',
    requiredFields: ['connection.apiKey'],
    defaultModels: {primary: 'gpt-current', light: 'gpt-small'},
    availableModels: [],
    defaultConnection: {
      openaiBaseUrl: 'https://api.openai.com/v1',
      agentRuntime: 'pi-agent-core',
    },
    defaultApiSurface: 'openai',
  },
  {
    type: 'custom',
    displayName: 'Custom',
    requiredFields: [],
    defaultModels: {primary: '', light: ''},
    availableModels: [],
    defaultApiSurface: 'claude',
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
      agentRuntime: 'pi-agent-core',
      apiSurface: 'openai',
      openaiProtocol: 'responses',
    },
    tuning: {maxTurns: 42, enableSubAgents: false},
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
  function button(name: string) {
    return Array.from(root.querySelectorAll('button')).find(
      (el) => el.textContent === name,
    )!;
  }
  function clickSurface(name: string) {
    button(name).click();
    m.redraw.sync();
  }
  it('shows endpoint, key and optional model JSON outside advanced settings for a custom provider', () => {
    mount();
    choose('custom');
    for (const field of ['claudeBaseUrl', 'claudeApiKey', 'piAgentCoreModelJson']) {
      expect(root.querySelector(`#provider-${field}`)!.closest('details')).toBeNull();
    }
    expect(root.querySelector('#provider-openaiBaseUrl')).toBeNull();
    expect(root.querySelector('#provider-qoderAccessToken')).toBeNull();
    expect(button('Claude')).toBeUndefined();
  });
  it('switches a custom provider surface, saves it and keeps the protocol select on OpenAI only', async () => {
    mount();
    choose('custom');
    expect(root.querySelector('details')!.textContent).not.toContain('OpenAI Protocol');
    clickSurface('OpenAI-compatible');
    expect(root.querySelector('#provider-claudeBaseUrl')).toBeNull();
    expect(root.querySelector('details')!.textContent).toContain('OpenAI Protocol');
    input('provider-openaiBaseUrl', 'https://gateway.example/v1');
    input('provider-openaiApiKey', 'sk-new');
    input('provider-model-primary', 'gateway/model');
    const body = await save();
    expect(body.connection).toMatchObject({
      apiSurface: 'openai',
      openaiBaseUrl: 'https://gateway.example/v1',
      openaiApiKey: 'sk-new',
      openaiProtocol: 'chat_completions',
    });
    expect(root.querySelector('button[disabled]')).toBeNull();
  });
  it('shows a custom shared key and base URL under their surface field without resending them', async () => {
    const provider = saved({
      type: 'custom',
      connection: {
        apiKey: '****1234',
        baseUrl: 'https://gateway.example',
        agentRuntime: 'pi-agent-core',
        apiSurface: 'claude',
      },
    });
    mount({editingProvider: provider});
    expect(root.querySelector<HTMLInputElement>('#provider-claudeBaseUrl')!.value).toBe('https://gateway.example');
    expect(root.querySelector<HTMLInputElement>('#provider-claudeApiKey')!.value).toBe('****1234');
    input('provider-model-primary', 'gateway/other');
    const body = await save();
    expect(body.connection.claudeBaseUrl).toBeUndefined();
    expect(body.connection.claudeApiKey).toBeUndefined();
  });
  it('offers a surface choice on a dual-surface type only when both endpoints exist', () => {
    const dual = saved({
      connection: {
        apiKey: 'shared***',
        agentRuntime: 'pi-agent-core',
        claudeBaseUrl: 'https://custom.example/claude',
        openaiBaseUrl: 'https://custom.example/v1',
      },
    });
    mount({editingProvider: dual});
    expect(button('OpenAI-compatible')).toBeDefined();
    m.mount(root, null);
    mount({editingProvider: saved({connection: {apiKey: 'shared***', agentRuntime: 'pi-agent-core', claudeBaseUrl: 'https://custom.example/claude'}})});
    expect(button('OpenAI-compatible')).toBeUndefined();
    expect(root.querySelector('#provider-apiKey')).not.toBeNull();
  });
  it('uses the shared key for a Pi catalog route and the surface key once a surface is recorded', async () => {
    const provider = saved({
      connection: {
        apiKey: 'shared***',
        agentRuntime: 'pi-agent-core',
        claudeApiKey: 'stale***',
        claudeBaseUrl: 'https://custom.example/claude',
        openaiBaseUrl: 'https://custom.example/v1',
      },
    });
    mount({editingProvider: provider});
    // Primary credential field outside the advanced section.
    expect(root.querySelector('#provider-apiKey')!.closest('details')).toBeNull();
    expect(root.querySelector('#provider-claudeApiKey')).toBeNull();
    expect(root.querySelector('#provider-claudeBaseUrl')).toBeNull();
    clickSurface('Anthropic-compatible');
    expect(root.querySelector('#provider-claudeApiKey')!.closest('details')).toBeNull();
    expect(root.querySelector('#provider-claudeBaseUrl')!.closest('details')).not.toBeNull();
    const body = await save();
    expect(body.connection.apiSurface).toBe('claude');
  });
  it('leaves a record without agentRuntime without one and without a surface', async () => {
    const provider = saved({
      connection: {apiKey: 'shared***', claudeBaseUrl: 'https://custom.example/claude'},
    });
    mount({editingProvider: provider});
    const body = await save();
    expect(body.connection).not.toHaveProperty('agentRuntime');
    expect(body.connection).not.toHaveProperty('apiSurface');
  });
  it('clears the other stored keys once the new host has its own key', async () => {
    mount({editingProvider: saved({
      type: 'custom',
      connection: {apiKey: '****1234', claudeBaseUrl: 'https://gateway.example', agentRuntime: 'pi-agent-core'},
    })});
    clickSurface('OpenAI-compatible');
    input('provider-openaiBaseUrl', 'https://other.example/v1');
    input('provider-openaiApiKey', 'sk-new');
    const body = await save();
    expect(body.connection).toMatchObject({apiSurface: 'openai', openaiApiKey: 'sk-new', apiKey: ''});
  });

  it('does not ask for a key when a record with no recorded surface is opened', () => {
    mount({editingProvider: saved({
      type: 'custom',
      connection: {apiKey: '****1234', openaiBaseUrl: 'https://llm.example/v1'},
      effectiveApiSurface: 'openai',
    })});
    expect(root.querySelector('[data-testid=surface-credential-reentry]')).toBeNull();
    expect(root.querySelector('#provider-openaiBaseUrl')).not.toBeNull();
  });

  it('asks to re-enter the key before a saved provider switches endpoint', () => {
    const hint = () => root.querySelector('[data-testid=surface-credential-reentry]');
    mount({editingProvider: saved({
      type: 'custom',
      connection: {claudeApiKey: '****1234', claudeBaseUrl: 'https://gateway.example', agentRuntime: 'pi-agent-core', apiSurface: 'claude'},
    })});
    expect(hint()).toBeNull();
    clickSurface('OpenAI-compatible');
    expect(hint()).not.toBeNull();
    input('provider-openaiApiKey', 'sk-new');
    expect(hint()).toBeNull();
  });
  it.each([
    ['another origin', 'https://other.example/v1', true],
    ['the same origin', 'https://shared.example/v1', false],
  ])('on a dual-surface type asks for the key only when the switch reaches %s', (_label, openaiBaseUrl, shown) => {
    mount({editingProvider: saved({connection: {
      apiKey: '****1234', agentRuntime: 'pi-agent-core', apiSurface: 'claude',
      claudeBaseUrl: 'https://shared.example/anthropic', openaiBaseUrl,
    }})});
    clickSurface('OpenAI-compatible');
    expect(root.querySelector('[data-testid=surface-credential-reentry]') !== null).toBe(shown);
  });
  it('does not ask for a key the provider never had, or when the endpoint stays', () => {
    const hint = () => root.querySelector('[data-testid=surface-credential-reentry]');
    mount({editingProvider: saved({
      type: 'custom',
      connection: {claudeBaseUrl: 'http://localhost:9000', agentRuntime: 'pi-agent-core', apiSurface: 'claude'},
    })});
    clickSurface('OpenAI-compatible');
    expect(hint()).toBeNull();
    m.mount(root, null);
    mount({editingProvider: saved()});
    expect(hint()).toBeNull();
  });
  describe('a retired record the backend could not convert', () => {
    const unconvertible = () => saved({
      type: 'custom',
      connection: {
        agentRuntime: 'qoder-agent-sdk',
        qoderAccessToken: '****oken',
        qoderCliPath: '/usr/bin/qodercli',
        openCodeModelJson: '****json',
      } as ProviderConfig['connection'],
    });
    it('shows endpoint fields and a hint instead of the Qoder fields', () => {
      mount({editingProvider: unconvertible()});
      expect(root.textContent).toContain('saving moves it to Pi Agent Core');
      expect(root.querySelector('#provider-claudeBaseUrl')).not.toBeNull();
      expect(root.querySelector('#provider-qoderAccessToken')).toBeNull();
      expect(root.querySelector('#provider-qoderCliPath')).toBeNull();
    });
    it('saves the provider onto Pi with its new endpoint and no retired fields', async () => {
      mount({editingProvider: unconvertible()});
      clickSurface('OpenAI-compatible');
      input('provider-openaiBaseUrl', 'https://gateway.example/v1');
      input('provider-openaiApiKey', 'sk-new');
      const body = await save();
      expect(body.connection).toMatchObject({
        agentRuntime: 'pi-agent-core',
        apiSurface: 'openai',
        openaiBaseUrl: 'https://gateway.example/v1',
        openaiApiKey: 'sk-new',
      });
      for (const field of ['qoderAccessToken', 'qoderCliPath', 'openCodeModelJson']) {
        expect(body.connection).not.toHaveProperty(field);
      }
    });
    it('refuses to save without an endpoint or a model JSON', () => {
      mount({editingProvider: unconvertible()});
      button('Save Changes').click();
      m.redraw.sync();
      expect(smartPerfettoFetch).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Enter a Base URL for the selected endpoint');
    });
    it('validates only the selected surface endpoint and treats whitespace as empty', () => {
      mount({editingProvider: unconvertible()});
      const saveAttempt = () => {
        button('Save Changes').click();
        m.redraw.sync();
      };
      input('provider-claudeBaseUrl', '   ');
      saveAttempt();
      expect(smartPerfettoFetch).not.toHaveBeenCalled();
      input('provider-claudeBaseUrl', 'https://gateway.example');
      clickSurface('OpenAI-compatible');
      saveAttempt();
      expect(smartPerfettoFetch).not.toHaveBeenCalled();
      expect(root.textContent).toContain('Enter a Base URL for the selected endpoint');
    });
  });
});
