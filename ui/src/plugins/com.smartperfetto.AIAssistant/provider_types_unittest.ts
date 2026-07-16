// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {providerRuntimeShortLabel} from './provider_types';

describe('provider runtime short labels', () => {
  it('keeps OpenCode distinct from Claude', () => {
    expect(providerRuntimeShortLabel('opencode')).toBe('OC');
    expect(providerRuntimeShortLabel('experimental-opencode')).toBe('OC');
    expect(providerRuntimeShortLabel('claude-agent-sdk')).toBe('CL');
  });
});
