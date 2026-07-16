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
