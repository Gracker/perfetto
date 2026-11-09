// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  connectionWithEffectiveSurface,
  providerApiSurface,
  providerNeedsPiEndpoint,
  ProviderRequestError,
  providerRequestFailure,
  providerStoreUnreadable,
  providerStoreUnreadableMessage,
  providerRuntimeLabel,
  providerRuntimeShortLabel,
  providerUsesPiCatalogRoute,
  resolveProviderRuntime,
  type ProviderConfig,
  withPiRuntimeRecord,
} from './provider_types';

function makeProvider(overrides: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p1',
    name: 'Test Provider',
    category: 'custom',
    type: 'custom',
    isActive: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    models: {primary: 'model-a', light: 'model-b'},
    connection: {},
    ...overrides,
  };
}

describe('provider runtime labels', () => {
  it('labels recorded provenance and defaults to Pi', () => {
    expect(providerRuntimeLabel('pi-agent-core')).toBe('Pi Agent Core');
    expect(providerRuntimeLabel('claude-agent-sdk')).toBe('Claude SDK');
    expect(providerRuntimeLabel('qoder-agent-sdk')).toBe('Qoder SDK');
    expect(providerRuntimeShortLabel('pi-agent-core')).toBe('PI');
    expect(providerRuntimeShortLabel('experimental-pi-agent-core')).toBe('PI');
    expect(providerRuntimeShortLabel('opencode')).toBe('OC');
    expect(providerRuntimeShortLabel('qoder-agent-sdk')).toBe('QD');
  });
});

describe('resolveProviderRuntime', () => {
  it('reports Pi for a record without a label and keeps a retired label', () => {
    expect(resolveProviderRuntime(makeProvider({type: 'anthropic'}))).toBe('pi-agent-core');
    expect(
      resolveProviderRuntime(makeProvider({connection: {agentRuntime: 'qoder-agent-sdk'}})),
    ).toBe('qoder-agent-sdk');
  });
});

describe('providerApiSurface', () => {
  const dualTemplate = {piCatalogRouteSurfaces: ['openai'], defaultApiSurface: 'claude'};

  it('uses the recorded surface only where a choice exists', () => {
    expect(providerApiSurface('glm', {apiSurface: 'claude', agentRuntime: 'pi-agent-core'}, dualTemplate)).toBe('claude');
    expect(providerApiSurface('custom', {apiSurface: 'openai'})).toBe('openai');
    expect(providerApiSurface('openai', {apiSurface: 'claude'}, {defaultApiSurface: 'openai'})).toBe('openai');
    expect(providerApiSurface('anthropic', {apiSurface: 'openai'})).toBe('claude');
  });

  it('follows the template catalog route for a Pi record and the template default otherwise', () => {
    expect(providerApiSurface('glm', {agentRuntime: 'pi-agent-core'}, dualTemplate)).toBe('openai');
    expect(providerApiSurface('glm', {}, dualTemplate)).toBe('claude');
    expect(providerApiSurface('qwen', {agentRuntime: 'pi-agent-core'}, {defaultApiSurface: 'claude'})).toBe('claude');
    expect(providerApiSurface('minimax', {agentRuntime: 'pi-agent-core'},
      {piCatalogRouteSurfaces: ['claude', 'openai'], defaultApiSurface: 'claude'})).toBe('claude');
    expect(providerUsesPiCatalogRoute({agentRuntime: 'pi-agent-core'}, dualTemplate)).toBe(true);
    expect(providerUsesPiCatalogRoute({agentRuntime: 'pi-agent-core', apiSurface: 'claude'}, dualTemplate)).toBe(false);
    expect(providerUsesPiCatalogRoute({}, dualTemplate)).toBe(false);
  });

  it('with neither template field behaves as a surface with no catalog route', () => {
    expect(providerUsesPiCatalogRoute({agentRuntime: 'pi-agent-core'}, {})).toBe(false);
    expect(providerUsesPiCatalogRoute({agentRuntime: 'pi-agent-core'})).toBe(false);
    expect(providerApiSurface('glm', {agentRuntime: 'pi-agent-core'}, {})).toBe('claude');
    expect(providerApiSurface('custom', {openaiBaseUrl: 'u'})).toBe('claude');
  });

  it('ignores template values outside the two surfaces', () => {
    expect(providerApiSurface('glm', {agentRuntime: 'pi-agent-core'},
      {piCatalogRouteSurfaces: ['grpc'], defaultApiSurface: 'grpc'})).toBe('claude');
  });
});

describe('providerNeedsPiEndpoint', () => {
  it('identifies state the migration could not convert', () => {
    expect(providerNeedsPiEndpoint({agentRuntime: 'pi-agent-core', apiKey: 'k'})).toBe(false);
    expect(providerNeedsPiEndpoint({})).toBe(false);
    expect(providerNeedsPiEndpoint({agentRuntime: 'qoder-agent-sdk'})).toBe(true);
    expect(providerNeedsPiEndpoint({agentRuntime: 'opencode'})).toBe(true);
    expect(providerNeedsPiEndpoint({qoderCliPath: '/x'} as ProviderConfig['connection'])).toBe(true);
  });

  it('writes Pi and removes the retired fields, keeping the rest', () => {
    const connection = withPiRuntimeRecord({
      agentRuntime: 'opencode',
      openCodeModelJson: '{}',
      apiKey: 'k',
    } as ProviderConfig['connection']);
    expect(connection).toEqual({agentRuntime: 'pi-agent-core', apiKey: 'k'});
  });
});

describe('providerStoreUnreadable', () => {
  it('recognizes the list state and the refused-write code', () => {
    expect(providerStoreUnreadable({store: {status: 'unreadable'}})).toBe(true);
    expect(
      providerStoreUnreadable({
        success: false,
        code: 'provider_store_unreadable',
      }),
    ).toBe(true);
    expect(providerStoreUnreadable({store: {status: 'ok'}})).toBe(false);
    expect(providerStoreUnreadable({success: false, error: 'x'})).toBe(false);
    expect(providerStoreUnreadable(undefined)).toBe(false);
  });
});

describe('providerRequestFailure', () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), {status: 409});

  it.each([
    [
      jsonResponse({code: 'provider_store_unreadable', error: 'raw'}),
      providerStoreUnreadableMessage(),
      true,
    ],
    [jsonResponse({error: 'Provider not found'}), 'Provider not found', false],
    [new Response('not json', {status: 500}), 'fallback', false],
  ])('reads the backend reason (%#)', async (res, message, storeUnreadable) => {
    const failure = await providerRequestFailure(res, 'fallback');
    expect(failure).toBeInstanceOf(ProviderRequestError);
    expect(failure.message).toBe(message);
    expect(failure.storeUnreadable).toBe(storeUnreadable);
  });
});

describe('connectionWithEffectiveSurface', () => {
  const record = (over: Partial<ProviderConfig>): ProviderConfig => ({
    id: 'p', name: 'p', category: 'custom', type: 'custom', isActive: false, createdAt: '', updatedAt: '',
    models: {primary: 'm', light: 'm'}, connection: {}, ...over,
  } as ProviderConfig);

  it('fills the surface only when none is recorded', () => {
    expect(connectionWithEffectiveSurface(record({effectiveApiSurface: 'openai'})).apiSurface).toBe('openai');
    expect(connectionWithEffectiveSurface(record({connection: {apiSurface: 'claude'}, effectiveApiSurface: 'openai'})).apiSurface)
      .toBe('claude');
    expect(connectionWithEffectiveSurface(record({})).apiSurface).toBeUndefined();
  });
});
