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
} from './provider_types';

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
    const provider = {
      id: 'p1',
      name: 'Qoder Provider',
      type: 'custom' as const,
      connection: {agentRuntime: 'qoder-agent-sdk' as const},
    };
    expect(resolveProviderRuntime(provider)).toBe('qoder-agent-sdk');
  });

  it('falls back to claude-agent-sdk when only qoderAccessToken is set without agentRuntime', () => {
    const provider = {
      id: 'p1',
      name: 'Qoder Provider',
      type: 'custom' as const,
      connection: {qoderAccessToken: 'qpat_123'},
    };
    // resolveProviderRuntime only checks explicit agentRuntime field;
    // inference from qoderAccessToken is done via providerHasQoderSurface
    expect(resolveProviderRuntime(provider)).toBe('claude-agent-sdk');
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('does not resolve qoder for non-custom providers', () => {
    const provider = {
      id: 'p1',
      name: 'Anthropic',
      type: 'anthropic' as const,
      connection: {},
    };
    expect(resolveProviderRuntime(provider)).toBe('claude-agent-sdk');
  });
});

describe('providerHasQoderSurface', () => {
  it('detects Qoder surface via agentRuntime', () => {
    const provider = {
      id: 'p1',
      name: 'Test',
      type: 'custom' as const,
      connection: {agentRuntime: 'qoder-agent-sdk' as const},
    };
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('detects Qoder surface via qoderCliPath', () => {
    const provider = {
      id: 'p1',
      name: 'Test',
      type: 'custom' as const,
      connection: {qoderCliPath: '/usr/bin/qodercli'},
    };
    expect(providerHasQoderSurface(provider)).toBe(true);
  });

  it('returns false for non-custom providers', () => {
    const provider = {
      id: 'p1',
      name: 'Test',
      type: 'anthropic' as const,
      connection: {agentRuntime: 'qoder-agent-sdk' as const},
    };
    expect(providerHasQoderSurface(provider)).toBe(false);
  });
});

describe('providerSupportsRuntime', () => {
  it('supports qoder-agent-sdk for custom providers with Qoder surface', () => {
    const provider = {
      id: 'p1',
      name: 'Test',
      type: 'custom' as const,
      connection: {qoderAccessToken: 'qpat_123'},
    };
    expect(providerSupportsRuntime(provider, 'qoder-agent-sdk')).toBe(true);
  });
});
