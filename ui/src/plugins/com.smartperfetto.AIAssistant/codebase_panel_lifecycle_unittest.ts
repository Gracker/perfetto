// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const api = vi.hoisted(() => ({
  listCodebases: vi.fn(), listKnowledgeBases: vi.fn(), consent: vi.fn(),
}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  listCodebases: api.listCodebases,
  listKnowledgeBases: api.listKnowledgeBases,
  setKnowledgeBaseConsent: api.consent,
}));

import type {KnowledgeBaseSummary} from './codebase_api';
import {CodebasePanel, type CodebasePanelAttrs} from './codebase_panel';

function handbook(overrides: Partial<KnowledgeBaseSummary> = {}): KnowledgeBaseSummary {
  return {
    sourceId: 'kb-a', kind: 'document_collection', displayName: 'Handbook', rightsAcknowledged: true,
    sendToProvider: true, indexGeneration: 1, documentCount: 3, hasActiveIndex: true, ...overrides,
  };
}

describe('CodebasePanel with its knowledge section, mounted', () => {
  let root: HTMLDivElement;

  beforeEach(() => {
    api.listCodebases.mockReset().mockResolvedValue({featureEnabled: true, codebases: []});
    api.listKnowledgeBases.mockReset().mockResolvedValue([handbook()]);
    api.consent.mockReset().mockResolvedValue(handbook({sendToProvider: false}));
    root = document.createElement('div');
    document.body.appendChild(root);
  });

  afterEach(() => {
    m.render(root, null);
    root.remove();
  });

  it('reports a consent change before its refresh, and keeps the section and its feedback through the refresh', async () => {
    const attrs: CodebasePanelAttrs = {
      backendUrl: 'http://lifecycle-backend', scopeKey: 'tenant\0workspace\0user',
      selection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: ['kb-a']},
      onSelectionChange: vi.fn(), onAuthorizationChange: vi.fn(),
    };
    // Every redraw a real mount would run is a render of the same tree.
    const rerender = () => m.render(root, m(CodebasePanel, attrs));
    rerender();
    await vi.waitFor(() => {
      rerender();
      expect(root.textContent).toContain('Handbook');
    });

    let resolveRefresh!: (value: KnowledgeBaseSummary[]) => void;
    api.listKnowledgeBases.mockImplementationOnce(() => new Promise(resolve => { resolveRefresh = resolve; }));
    const revoke = [...root.querySelectorAll('button')].find(button => /Revoke text|撤销正文授权/.test(button.textContent ?? ''));
    revoke!.click();
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());

    // The refresh is in flight: the parent redraws with its loading state.
    rerender();
    expect(attrs.onAuthorizationChange).toHaveBeenCalledOnce();
    expect(root.textContent).toContain('Handbook');

    resolveRefresh([handbook({sendToProvider: false})]);
    await vi.waitFor(() => {
      rerender();
      expect(root.textContent).toMatch(/Revoked text for Handbook|已撤销 Handbook 的正文发送授权/);
    });
    expect(attrs.onAuthorizationChange).toHaveBeenCalledOnce();
  });

  it('lists a retired Wiki record as delete-only, has no legacy Wiki section, and drops its stored selection', async () => {
    api.listKnowledgeBases.mockResolvedValue([
      handbook({sourceId: 'wiki', kind: 'android_internals_wiki', retired: true, displayName: 'Old Wiki'}),
      handbook(),
    ]);
    const attrs: CodebasePanelAttrs = {
      backendUrl: 'http://retired-backend', scopeKey: 'tenant\0workspace\0user',
      selection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: ['kb-a', 'wiki']},
      onSelectionChange: vi.fn(), onAuthorizationChange: vi.fn(),
    };
    const rerender = () => m.render(root, m(CodebasePanel, attrs));
    rerender();
    await vi.waitFor(() => {
      rerender();
      expect(root.textContent).toContain('Old Wiki');
    });

    expect(attrs.onSelectionChange).toHaveBeenCalledWith(expect.objectContaining({knowledgeSourceIds: ['kb-a']}));
    expect(root.textContent).not.toMatch(/Add knowledge source|新增知识源|Register external knowledge source/);
    const cards = [...root.querySelectorAll('div')].filter(div =>
      [...div.children].some(child => child.textContent === 'Old Wiki'));
    const wikiCard = cards[cards.length - 1];
    expect(wikiCard.textContent).toMatch(/Re-register the Wiki's src\/ folder|请将 Wiki 的 src\/ 目录重新注册/);
    const labels = [...wikiCard.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatch(/Delete|删除/);
  });
});
