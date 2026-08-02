// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';

import {SelfEvolutionPanel} from './self_evolution_panel';
import {SettingsModal, type SettingsModalAttrs} from './settings_modal';
import {DEFAULT_SETTINGS} from './types';

describe('SettingsModal self-evolution binding', () => {
  it('uses the committed backend and disables mutations while edits are unsaved', () => {
    const attrs: SettingsModalAttrs = {
      settings: {
        ...DEFAULT_SETTINGS,
        backendUrl: 'http://committed-backend',
        backendApiKey: 'committed-key',
      },
      workspaceContext: {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'user-a',
        windowId: 'window-a',
      },
      onClose: vi.fn(),
      onSave: vi.fn(),
      onWorkspaceChange: vi.fn(),
      onCheckStatus: vi.fn(async () => ({connected: true})),
      onProviderSelectionChange: vi.fn(),
    };
    const modal = new SettingsModal() as any;
    const vnode = {attrs} as any;
    modal.oninit(vnode);
    modal.settings.backendUrl = 'http://draft-backend';
    modal.settings.backendApiKey = 'draft-key';
    modal.currentTab = 'evolution';

    const panel = findComponent(modal.view(vnode), SelfEvolutionPanel);
    expect(panel.attrs).toEqual({
      backendUrl: 'http://committed-backend',
      apiKey: 'committed-key',
      readOnly: true,
    });
  });
});

function findComponent(node: any, tag: unknown): any {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponent(child, tag);
      if (found) return found;
    }
    return undefined;
  }
  if (node.tag === tag) return node;
  return findComponent(node.children, tag);
}
