// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';

import {CodebasePanel} from './codebase_panel';
import {ProviderPanel} from './provider_panel';
import {SettingsModal, type SettingsModalAttrs} from './settings_modal';
import {DEFAULT_SETTINGS} from './types';

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

function collectText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return collectText(node.children);
}

function findNode(node: any, predicate: (candidate: any) => boolean): any {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return findNode(node.children, predicate);
}

describe('SettingsModal codebase binding', () => {
  it('exposes dialog, close action, and connection labels to assistive technology', () => {
    const attrs: SettingsModalAttrs = {
      settings: {...DEFAULT_SETTINGS},
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
    const view = modal.view(vnode);

    expect(findNode(view, (node) => node.attrs?.role === 'dialog')?.attrs).toMatchObject({
      'aria-modal': 'true',
      'aria-labelledby': 'smartperfetto-settings-title',
    });
    expect(findNode(view, (node) => node.attrs?.['aria-label'] === 'Close settings')).toBeDefined();
    expect(findNode(view, (node) => node.attrs?.for === 'smartperfetto-workspace-id')).toBeDefined();
    expect(findNode(view, (node) => node.attrs?.id === 'smartperfetto-workspace-id')).toBeDefined();
  });

  it('keeps codebase mutations on the committed backend while connection edits are unsaved', () => {
    const attrs: SettingsModalAttrs = {
      settings: {
        ...DEFAULT_SETTINGS,
        backendUrl: 'http://committed-backend',
        backendApiKey: 'committed-key',
      },
      analysisContext: {
        codeAwareMode: 'off',
        codebaseIds: [],
        knowledgeSourceIds: [],
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
      onAnalysisContextChange: vi.fn(),
    };
    const modal = new SettingsModal() as any;
    const vnode = {attrs} as any;
    modal.oninit(vnode);
    modal.settings.backendUrl = 'http://draft-backend';
    modal.settings.backendApiKey = 'draft-key';
    modal.currentTab = 'codebases';

    const view = modal.view(vnode);
    const panel = findComponent(view, CodebasePanel);

    expect(panel.attrs).toMatchObject({
      backendUrl: 'http://committed-backend',
      apiKey: 'committed-key',
      readOnly: true,
    });
    expect(collectText(view)).toContain('Save connection settings');

    modal.currentTab = 'providers';
    const providerView = modal.view(vnode);
    expect(findComponent(providerView, ProviderPanel)).toBeUndefined();
    expect(collectText(providerView)).toContain('Save connection settings');
  });
});
