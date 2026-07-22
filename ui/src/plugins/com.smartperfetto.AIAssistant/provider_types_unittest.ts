// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  providerHasQoderSurface,
  providerRuntimeLabel,
  providerRuntimeShortLabel,
  providerSupportsRuntime,
  resolveProviderRuntime,
  type ProviderConfig,
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

describe('provider runtime short labels', () => {
  it('keeps OpenCode distinct from Claude', () => {
    expect(providerRuntimeShortLabel('opencode')).toBe('OC');
    expect(providerRuntimeShortLabel('experimental-opencode')).toBe('OC');
    expect(providerRuntimeShortLabel('claude-agent-sdk')).toBe('CL');
  });

  it('labels the Qoder runtime distinctly', () => {
    expect(providerRuntimeShortLabel('qoder-agent-sdk')).toBe('QD');
    expect(providerRuntimeLabel('qoder-agent-sdk')).toBe('Qoder SDK');
  });
});

describe('resolveProviderRuntime', () => {
  it('resolves qoder-agent-sdk when agentRuntime is set', () => {
    const provider = makeProvider({
      connection: {agentRuntime: 'qoder-agent-sdk'},
    });
    expect(resolveProviderRuntime(provider)).toBe('qoder-agent-sdk');
  });

  it('falls back to claude-agent-sdk when only qoderAccessToken is set without agentRuntime', () => {
    const provider = makeProvider({
      connection: {qoderAccessToken: 'qpat_123'},
    });
    // resolveProviderRuntime only checks explicit agentRuntime field;
    // inference from qoderAccessToken is done via providerHasQoderSurface
    expect(resolveProviderRuntime(provider)).toBe('claude-agent-sdk');
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('does not resolve qoder for non-custom providers', () => {
    const provider = makeProvider({
      type: 'anthropic',
      connection: {},
    });
    expect(resolveProviderRuntime(provider)).toBe('claude-agent-sdk');
  });
});

describe('providerHasQoderSurface', () => {
  it('detects Qoder surface via agentRuntime', () => {
    const provider = makeProvider({
      connection: {agentRuntime: 'qoder-agent-sdk'},
    });
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('detects Qoder surface via qoderCliPath', () => {
    const provider = makeProvider({
      connection: {qoderCliPath: '/usr/bin/qodercli'},
    });
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('returns false for non-custom providers', () => {
    const provider = makeProvider({
      type: 'anthropic',
      connection: {agentRuntime: 'qoder-agent-sdk'},
    });
    expect(providerHasQoderSurface(provider)).toBe(false);
  });
});

describe('providerSupportsRuntime', () => {
  it('supports qoder-agent-sdk for custom providers with Qoder surface', () => {
    const provider = makeProvider({
      connection: {qoderAccessToken: 'qpat_123'},
    });
    expect(providerSupportsRuntime(provider, 'qoder-agent-sdk')).toBe(true);
  });
});
