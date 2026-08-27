// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const apiMocks = vi.hoisted(() => ({
  acceptPending: vi.fn(),
  authorizeExtensions: vi.fn(),
  authorizeSelection: vi.fn(),
  reindexCodebase: vi.fn(),
  rejectPending: vi.fn(),
}));

vi.mock('./codebase_api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./codebase_api')>();
  return {
    ...actual,
    acceptPendingCodebaseGeneration: apiMocks.acceptPending,
    authorizeAvailableCodebaseExtensions: apiMocks.authorizeExtensions,
    authorizeCurrentCodebaseSelection: apiMocks.authorizeSelection,
    reindexCodebase: apiMocks.reindexCodebase,
    rejectPendingCodebaseGeneration: apiMocks.rejectPending,
  };
});

import type {CodebaseSummary, ExternalKnowledgeSourceSummary} from './codebase_api';
import {
  analysisContextAfterCodebaseDelete,
  analysisContextForFeatureAvailability,
  codebaseAvailableForOnDemandAccess,
  codebaseDeletionPending,
  codebaseCanAuthorizeAvailableExtensions,
  codebaseCanAuthorizeCurrentSelection,
  codebaseHasActiveIndex,
  CodebasePanel,
  externalKnowledgeSourceHasActiveIndex,
  optionalIndexCopyForActiveRoot,
} from './codebase_panel';

function codebase(overrides: Partial<CodebaseSummary> = {}): CodebaseSummary {
  return {
    codebaseId: 'codebase-a',
    kind: 'app_source',
    displayName: 'App',
    lifecycleState: 'active',
    rootAvailable: true,
    indexGeneration: 2,
    activeGeneration: 'codebase_2_active',
    contentFingerprint: 'fingerprint-a',
    chunkCount: 4,
    ...overrides,
  };
}

function source(
  overrides: Partial<ExternalKnowledgeSourceSummary> = {},
): ExternalKnowledgeSourceSummary {
  return {
    sourceId: 'wiki',
    kind: 'android_internals_wiki',
    displayName: 'Android Internals',
    revision: 'rev-1',
    contentFingerprint: 'fingerprint-1',
    dirty: false,
    license: 'CC-BY-SA',
    rightsAcknowledged: true,
    sendToProvider: true,
    activeGeneration: 'generation-1',
    indexGeneration: 1,
    indexedChunkCount: 10,
    ...overrides,
  };
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

beforeEach(() => {
  apiMocks.acceptPending.mockReset().mockResolvedValue(codebase());
  apiMocks.authorizeExtensions.mockReset().mockResolvedValue(codebase());
  apiMocks.authorizeSelection.mockReset().mockResolvedValue(codebase());
  apiMocks.rejectPending.mockReset().mockResolvedValue(codebase());
  apiMocks.reindexCodebase.mockReset().mockResolvedValue({
    chunksAdded: 1,
    activationDisposition: 'active',
  });
});

describe('external knowledge active-index contract', () => {
  it('requires consent, active generation, fingerprint, and indexed chunks', () => {
    expect(externalKnowledgeSourceHasActiveIndex(source())).toBe(true);
    expect(externalKnowledgeSourceHasActiveIndex(source({contentFingerprint: ''}))).toBe(false);
    expect(externalKnowledgeSourceHasActiveIndex(source({indexedChunkCount: 0}))).toBe(false);
    expect(externalKnowledgeSourceHasActiveIndex(source({activeGeneration: undefined}))).toBe(false);
    expect(externalKnowledgeSourceHasActiveIndex(source({sendToProvider: false}))).toBe(false);
  });

  it('removes a stale persisted selection before a run can reach the backend', () => {
    const panel = new CodebasePanel() as any;
    const onSelectionChange = vi.fn();
    panel.knowledgeSources = [source({indexedChunkCount: 0})];
    panel.selection = {
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: ['wiki'],
    };
    panel.onSelectionChange = onSelectionChange;

    panel.reconcileSelection({codebasesLoaded: false, knowledgeLoaded: true});

    expect(onSelectionChange).toHaveBeenCalledWith({
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: [],
    });
  });

  it('does not clear source selection when only the codebase request failed', () => {
    const panel = new CodebasePanel() as any;
    const onSelectionChange = vi.fn();
    panel.knowledgeSources = [source()];
    panel.selection = {
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: ['stale-wiki'],
    };
    panel.onSelectionChange = onSelectionChange;

    panel.reconcileSelection({codebasesLoaded: false, knowledgeLoaded: true});

    expect(onSelectionChange).toHaveBeenCalledWith({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: [],
    });
  });

  it('does not clear RAG selection when only the knowledge request failed', () => {
    const panel = new CodebasePanel() as any;
    const onSelectionChange = vi.fn();
    panel.featureEnabled = true;
    panel.codebases = [codebase({eligibleForSendToProvider: true})];
    panel.selection = {
      codeAwareMode: 'provider_send',
      codebaseIds: ['stale-codebase'],
      knowledgeSourceIds: ['wiki'],
    };
    panel.onSelectionChange = onSelectionChange;

    panel.reconcileSelection({codebasesLoaded: true, knowledgeLoaded: false});

    expect(onSelectionChange).toHaveBeenCalledWith({
      codeAwareMode: 'provider_send',
      codebaseIds: [],
      knowledgeSourceIds: ['wiki'],
    });
  });
});

describe('codebase lifecycle contract', () => {
  it('clears source selections when the backend disables code-aware analysis', () => {
    expect(analysisContextForFeatureAvailability({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: ['wiki-a'],
    }, false)).toEqual({
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: ['wiki-a'],
    });
  });

  it('never selects a registration that has entered deletion', () => {
    expect(codebaseHasActiveIndex(codebase())).toBe(true);
    expect(codebaseAvailableForOnDemandAccess(codebase())).toBe(true);
    expect(codebaseAvailableForOnDemandAccess(codebase({chunkCount: 0}))).toBe(true);
    expect(codebaseAvailableForOnDemandAccess(codebase({rootAvailable: false}))).toBe(false);
    expect(codebaseAvailableForOnDemandAccess(codebase({lifecycleState: 'deleting'}))).toBe(false);
    expect(codebaseDeletionPending(codebase({lifecycleState: 'deleting'}))).toBe(true);
    expect(codebaseDeletionPending(codebase())).toBe(false);
    expect(codebaseHasActiveIndex(codebase({chunkCount: 0}))).toBe(false);
  });

  it('offers new-language authorization only after provider-send consent exists', () => {
    expect(codebaseCanAuthorizeAvailableExtensions(codebase({
      eligibleForSendToProvider: false,
      availableNotConsentedExtensions: ['.dart'],
    }))).toBe(false);
    expect(codebaseCanAuthorizeAvailableExtensions(codebase({
      eligibleForSendToProvider: true,
      availableNotConsentedExtensions: ['.dart'],
    }))).toBe(true);
  });

  it('offers current-selection authorization only for an active consented mismatch', () => {
    expect(codebaseCanAuthorizeCurrentSelection(codebase({
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: false,
    }))).toBe(true);
    expect(codebaseCanAuthorizeCurrentSelection(codebase({
      eligibleForSendToProvider: false,
      providerGrantScopeCurrent: false,
    }))).toBe(false);
    expect(codebaseCanAuthorizeCurrentSelection(codebase({
      lifecycleState: 'deleting',
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: false,
    }))).toBe(false);
  });

  it('keeps an unindexed but available source selected for on-demand access', () => {
    const panel = new CodebasePanel() as any;
    const onSelectionChange = vi.fn();
    panel.featureEnabled = true;
    panel.codebases = [codebase({
      activeGeneration: undefined,
      contentFingerprint: undefined,
      chunkCount: 0,
    })];
    panel.selection = {
      codeAwareMode: 'metadata_only',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: [],
    };
    panel.onSelectionChange = onSelectionChange;

    panel.reconcileSelection({codebasesLoaded: true, knowledgeLoaded: false});

    expect(onSelectionChange).not.toHaveBeenCalled();
    expect(panel.selection.codebaseIds).toEqual(['codebase-a']);
    expect(optionalIndexCopyForActiveRoot()).toContain('needs no rebuild');
    expect(optionalIndexCopyForActiveRoot()).toContain('GitNexus index');
    expect(optionalIndexCopyForActiveRoot()).toContain('optional');
  });

  it('removes only the deleted codebase from the analysis context', () => {
    expect(analysisContextAfterCodebaseDelete({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-b', 'codebase-a'],
      knowledgeSourceIds: ['wiki-a'],
    }, 'codebase-a')).toEqual({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-b'],
      knowledgeSourceIds: ['wiki-a'],
    });
  });

  it('clears pending and authorization busy state before reloading', async () => {
    vi.stubGlobal('window', {confirm: vi.fn(() => true)});
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.apiKey = 'key';
    panel.scopeKey = 'scope';
    panel.loadEpoch = 1;
    panel.load = vi.fn(async () => {
      panel.loadEpoch++;
    });
    const pending = codebase({
      selectionPolicyRevision: 1,
      grantRevision: 1,
      pendingGeneration: {
        candidateGenerationId: 'candidate',
        chunkCount: 1,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 1,
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 2,
          filesSelected: 1,
          bytesSelected: 10,
          chunksIndexed: 1,
          truncated: true,
          complete: false,
        },
      },
    });

    await panel.resolvePendingGeneration(pending, true);
    expect(panel.pendingAction).toBeNull();
    expect(panel.reindexingId).toBeNull();

    await panel.authorizeAvailableExtensions(codebase({
      eligibleForSendToProvider: true,
      availableNotConsentedExtensions: ['.dart'],
    }));
    expect(panel.extensionAuthorizationId).toBeNull();
    expect(panel.updatingConsentId).toBeNull();
    vi.unstubAllGlobals();
  });

  it('requires informed confirmation before authorizing named extensions', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', {confirm});
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.loadEpoch = 1;

    await panel.authorizeAvailableExtensions(codebase({
      eligibleForSendToProvider: true,
      availableNotConsentedExtensions: ['.dart', '.swift'],
    }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/\.dart.*\.swift|\.swift.*\.dart/s));
    expect(apiMocks.authorizeExtensions).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('requires informed confirmation before authorizing the current path scope', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', {confirm});
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.loadEpoch = 1;

    await panel.authorizeCurrentSelection(codebase({
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: false,
      pathFilters: ['app', 'lib'],
      excludeGlobs: ['**/generated/**'],
    }));

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/app.*lib.*generated/s));
    expect(apiMocks.authorizeSelection).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('renders degraded coverage, maintenance guidance, extension names, and live feedback', () => {
    const panel = new CodebasePanel() as any;
    panel.selection = {codeAwareMode: 'metadata_only', codebaseIds: [], knowledgeSourceIds: []};
    panel.success = 'Updated';
    const rendered = panel.renderCodebase(codebase({
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: false,
      availableNotConsentedExtensions: ['.dart', '.swift'],
      activeIndexCoverage: {
        selectionPolicyRevision: 2,
        enumerationBackend: 'node-walk',
        backendFidelity: 'degraded',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      maintenanceWarning: 'inactive_chunk_cleanup_failed',
      reindexRequired: 'selection_scope_narrowed',
    }));
    const renderedText = collectText(rendered);

    expect(renderedText).toContain('.dart');
    expect(renderedText).toContain('.swift');
    expect(renderedText).toMatch(/current selection|当前选择/i);
    expect(renderedText).toMatch(/1\s*\/\s*2/);
    expect(renderedText).toMatch(/file_budget/);
    expect(renderedText).toMatch(/rebuild|重建/i);
    expect(findNode(rendered, node => node.attrs?.['aria-live'] === 'polite')).toBeDefined();
  });

  it('does not expose pending candidate actions after deletion starts', () => {
    const panel = new CodebasePanel() as any;
    panel.selection = {codeAwareMode: 'metadata_only', codebaseIds: [], knowledgeSourceIds: []};
    const rendered = panel.renderCodebase(codebase({
      lifecycleState: 'deleting',
      eligibleForSendToProvider: true,
      availableNotConsentedExtensions: ['.dart'],
      pendingGeneration: {
        candidateGenerationId: 'stale-candidate',
        chunkCount: 1,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 1,
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 2,
          filesSelected: 1,
          bytesSelected: 10,
          chunksIndexed: 1,
          truncated: true,
          complete: false,
        },
      },
    }));
    const renderedText = collectText(rendered);

    expect(renderedText).not.toMatch(/Accept limited index|接受受限索引/);
    expect(renderedText).not.toMatch(/Reject candidate|丢弃候选/);
    expect(renderedText).not.toMatch(/Authorize languages|授权新语言/);
  });

  it('describes a staged candidate instead of claiming reindex activation', async () => {
    apiMocks.reindexCodebase.mockResolvedValueOnce({
      chunksAdded: 3,
      activationDisposition: 'pending',
      coverage: {
        selectionPolicyRevision: 1,
        enumerationBackend: 'ripgrep',
        backendFidelity: 'exact',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 10,
        filesSelected: 3,
        bytesSelected: 100,
        chunksIndexed: 3,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
    });
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.loadEpoch = 1;
    panel.load = vi.fn(async () => {
      panel.loadEpoch++;
    });

    await panel.reindex(codebase());

    expect(panel.success).toMatch(/candidate|候选/i);
    expect(panel.success).toMatch(/complete index|完整索引/i);
  });

  it('confirms the exact downgrade before accepting a limited candidate', async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal('window', {confirm});
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.loadEpoch = 1;
    const pending = codebase({
      pendingGeneration: {
        candidateGenerationId: 'candidate',
        chunkCount: 3,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 1,
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 10,
          filesSelected: 3,
          bytesSelected: 100,
          chunksIndexed: 3,
          truncated: true,
          complete: false,
          truncationReason: 'file_budget',
        },
      },
    });

    await panel.resolvePendingGeneration(pending, true);

    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/3.*10.*file_budget.*replace|3.*10.*file_budget.*替换/is));
    expect(apiMocks.acceptPending).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('disables conflicting operations while a codebase mutation is in progress', () => {
    const panel = new CodebasePanel() as any;
    panel.selection = {codeAwareMode: 'metadata_only', codebaseIds: [], knowledgeSourceIds: []};
    panel.pendingAction = {codebaseId: 'codebase-a', action: 'accept'};
    const rendered = panel.renderCodebase(codebase({
      eligibleForSendToProvider: true,
      pendingGeneration: {
        candidateGenerationId: 'candidate',
        chunkCount: 1,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 1,
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 2,
          filesSelected: 1,
          bytesSelected: 10,
          chunksIndexed: 1,
          truncated: true,
          complete: false,
        },
      },
    }));

    for (const label of ['Update optional index', 'Revoke content access', 'Delete codebase']) {
      expect(findNode(rendered, node =>
        node.tag === 'button' && collectText(node).includes(label))?.attrs.disabled).toBe(true);
    }
  });

  it('announces final success and error outcomes', () => {
    const panel = new CodebasePanel() as any;
    panel.featureEnabled = true;
    panel.loading = false;
    panel.codebases = [];
    panel.knowledgeSources = [];
    panel.selection = {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []};
    panel.success = 'Saved';
    panel.error = 'Failed';

    const rendered = panel.view({attrs: {}} as any);
    expect(collectText(findNode(rendered, node => node.attrs?.role === 'status'))).toContain('Saved');
    expect(collectText(findNode(rendered, node => node.attrs?.role === 'alert'))).toContain('Failed');
  });

  it('clears busy state when an unrelated list load finishes during a mutation', async () => {
    vi.stubGlobal('window', {confirm: vi.fn(() => true)});
    let resolveAccept!: (value: CodebaseSummary) => void;
    apiMocks.acceptPending.mockImplementationOnce(() => new Promise(resolve => {
      resolveAccept = resolve;
    }));
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.scopeKey = 'scope';
    panel.loadEpoch = 1;
    const pending = codebase({
      pendingGeneration: {
        candidateGenerationId: 'candidate',
        chunkCount: 1,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 1,
          enumerationBackend: 'ripgrep',
          backendFidelity: 'exact',
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 2,
          filesSelected: 1,
          bytesSelected: 10,
          chunksIndexed: 1,
          truncated: true,
          complete: false,
          truncationReason: 'file_budget',
        },
      },
    });

    const action = panel.resolvePendingGeneration(pending, true);
    await Promise.resolve();
    panel.loadEpoch++;
    resolveAccept(pending);
    await action;

    expect(panel.pendingAction).toBeNull();
    vi.unstubAllGlobals();
  });
});
