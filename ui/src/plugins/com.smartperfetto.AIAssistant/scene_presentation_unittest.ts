// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {getSceneDisplayName} from './scene_constants';
import {SceneNavigationBar} from './scene_navigation_bar';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scene presentation language', () => {
  it('uses English scene names without duplicating projected duration labels', () => {
    vi.stubGlobal('navigator', {language: 'en-US'});

    expect(getSceneDisplayName('scroll', 'Scroll (1000ms)')).toBe('Scroll');
    expect(getSceneDisplayName('vendor_scene', 'Vendor scene')).toBe('Vendor scene');
  });

  it('renders the scene navigation surface in English', () => {
    vi.stubGlobal('navigator', {language: 'en-US'});
    const component = new SceneNavigationBar();
    const rendered = component.view({
      attrs: {
        scenes: [],
        trace: {scrollTo: vi.fn()},
      },
    } as any);
    const output = JSON.stringify(rendered);

    expect(output).toContain('Scene navigation');
    expect(output).toContain('No scenes detected');
    expect(output).not.toContain('场景导航');
  });
});

describe('canonical scene presentation', () => {
  it('uses stable segment identity and never derives a green grade from contact duration', () => {
    const component = new SceneNavigationBar();
    const rendered = component.view({attrs: {trace: {scrollTo: vi.fn()}, scenes: [{
      id: 'stable-segment', type: 'scene_observation', startTs: '9007199254740993', endTs: '9007199254740994',
      durationMs: 0.000001, confidence: 0, label: 'Observed touch movement',
      metadata: {canonical: true, deviceState: 'Unknown', appResponse: 'Unknown', semanticStatus: 'unverified'},
    }]}} as any);
    const output = JSON.stringify(rendered);
    expect(output).toContain('stable-segment'); expect(output).toContain('Observed touch movement');
    expect(output).not.toContain('🟢'); expect(output).not.toContain('0%');
  });
});
