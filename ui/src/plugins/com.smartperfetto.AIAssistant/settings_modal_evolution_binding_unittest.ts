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

describe('AI Provider settings shortcut', () => {
  function attrs(overrides: Partial<SettingsModalAttrs> = {}): SettingsModalAttrs {
    return {
      settings: {...DEFAULT_SETTINGS},
      workspaceContext: {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', windowId: 'window-a'},
      onClose: vi.fn(), onSave: vi.fn(), onWorkspaceChange: vi.fn(),
      onCheckStatus: vi.fn(async () => ({connected: true})),
      onProviderSelectionChange: vi.fn(),
      initialStatus: {connected: true, configured: false},
      ...overrides,
    };
  }

  it('opens directly on Providers and keeps read-only initialization on Connection', () => {
    for (const readOnly of [false, true]) {
      const modal = new SettingsModal() as any;
      modal.oninit({attrs: attrs({initialTab: 'providers', readOnly})});
      expect(modal.currentTab).toBe(readOnly ? 'connection' : 'providers');
    }
  });

  it('switches from the unconfigured status card without bypassing unsaved connection or read-only locks', () => {
    for (const lock of ['none', 'readOnly', 'unsaved']) {
      const vnode = {attrs: attrs({readOnly: lock === 'readOnly'})} as any;
      const modal = new SettingsModal() as any;
      modal.oninit(vnode);
      if (lock === 'unsaved') modal.settings.backendUrl = 'http://unsaved-backend';
      const action = findStatusAction(modal.view(vnode));
      expect(action.attrs.disabled).toBe(lock !== 'none');
      action.attrs.onclick();
      expect(modal.currentTab).toBe(lock === 'none' ? 'providers' : 'connection');
    }
  });

  it('does not present Qoder local CLI auth as missing Provider setup', () => {
    const vnode = {attrs: attrs({
      initialStatus: {
        connected: true,
        configured: false,
        runtime: 'qoder-agent-sdk',
      },
    })} as any;
    const modal = new SettingsModal() as any;
    modal.oninit(vnode);
    const tree = modal.view(vnode);
    expect(findStatusAction(tree)).toBeUndefined();
    expect(JSON.stringify(tree)).toContain('local CLI login is verified during analysis');
  });
});

function findStatusAction(node: any): any {
  if (!node) return undefined;
  if (Array.isArray(node)) return node.map(findStatusAction).find(Boolean);
  if (node.attrs?.['data-testid'] === 'configure-provider-from-status') return node;
  return findStatusAction(node.children);
}

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
