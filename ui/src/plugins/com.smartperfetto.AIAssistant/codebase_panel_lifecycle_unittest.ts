// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const api = vi.hoisted(() => ({
  listCodebases: vi.fn(), listKnowledgeBases: vi.fn(), listWiki: vi.fn(), consent: vi.fn(),
}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  listCodebases: api.listCodebases,
  listKnowledgeBases: api.listKnowledgeBases,
  listExternalKnowledgeSources: api.listWiki,
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
    api.listWiki.mockReset().mockResolvedValue([]);
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
});
