// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const apiMocks = vi.hoisted(() => ({
  acceptPending: vi.fn(),
  listCodebases: vi.fn(),
  listKnowledge: vi.fn(),
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
    listCodebases: apiMocks.listCodebases,
    listExternalKnowledgeSources: apiMocks.listKnowledge,
    authorizeAvailableCodebaseExtensions: apiMocks.authorizeExtensions,
    authorizeCurrentCodebaseSelection: apiMocks.authorizeSelection,
    reindexCodebase: apiMocks.reindexCodebase,
    rejectPendingCodebaseGeneration: apiMocks.rejectPending,
  };
});

import {CodebaseApiError} from './codebase_api';
import type {CodebaseSummary, ExternalKnowledgeSourceSummary} from './codebase_api';
import {
  analysisContextAfterCodebaseDelete,
  analysisContextAfterCodebaseRegistration,
  codebaseIndexFailureMessage,
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
  apiMocks.listCodebases.mockReset().mockResolvedValue({featureEnabled: true, codebases: []});
  apiMocks.listKnowledge.mockReset().mockResolvedValue([]);
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
    expect(optionalIndexCopyForActiveRoot()).toContain('without an index');
    expect(optionalIndexCopyForActiveRoot()).toContain('current authorization scope');
    expect(optionalIndexCopyForActiveRoot()).toContain('optional');
  });

  it('removes only the deleted codebase from the analysis context', () => {
    expect(analysisContextAfterCodebaseDelete({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-b', 'codebase-a'],
      knowledgeSourceIds: ['wiki-a'],
      authorizationEpoch: 4,
    }, 'codebase-a')).toEqual({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-b'],
      knowledgeSourceIds: ['wiki-a'],
      authorizationEpoch: 5,
    });
  });

  it('emits an explicit authorization epoch when policy changes but selection does not', () => {
    const panel = new CodebasePanel() as any;
    const onSelectionChange = vi.fn();
    panel.selection = {
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: 9,
    };
    panel.onSelectionChange = onSelectionChange;

    panel.emitAuthorizationChange();

    expect(onSelectionChange).toHaveBeenCalledWith({
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: 10,
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

  it('emits the explicit parent authorization callback after the real mutation succeeds', async () => {
    vi.stubGlobal('window', {confirm: vi.fn(() => true)});
    const panel = new CodebasePanel() as any;
    const onAuthorizationChange = vi.fn();
    panel.backendUrl = 'http://backend';
    panel.scopeKey = 'scope';
    panel.selection = {
      codeAwareMode: 'provider_send',
      codebaseIds: ['codebase-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: 2,
    };
    panel.onAuthorizationChange = onAuthorizationChange;
    panel.load = vi.fn(async () => {});

    await panel.authorizeCurrentSelection(codebase({
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: false,
      pathFilters: ['src'],
    }));

    expect(apiMocks.authorizeSelection).toHaveBeenCalledOnce();
    expect(onAuthorizationChange).toHaveBeenCalledOnce();
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
      selectionPolicyRevision: 7,
      grantRevision: 5,
    }));
    const renderedText = collectText(rendered);

    expect(renderedText).toContain('.dart');
    expect(renderedText).toContain('.swift');
    expect(renderedText).toMatch(/current selection|当前选择/i);
    expect(renderedText).toMatch(/1\s*\/\s*2/);
    expect(renderedText).toMatch(/file_budget/);
    expect(renderedText).toMatch(/rebuild|重建/i);
    expect(renderedText).toMatch(/selection.*7|选择.*7/i);
    expect(renderedText).toMatch(/grant.*5|授权.*5/i);
    expect(findNode(rendered, node => node.attrs?.['aria-live'] === 'polite')).toBeDefined();
    const editButton = findNode(rendered, node =>
      node.tag === 'button' && /Edit scope|编辑范围/.test(collectText(node))
    );
    expect(editButton).toBeDefined();
    expect(Number.parseInt(String(editButton.attrs.style.minHeight), 10)).toBeGreaterThanOrEqual(40);
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


describe('add and use source selection', () => {
  const newSource = () => codebase({codebaseId: 'new-source', eligibleForSendToProvider: true});
  const previous = () => [codebase({eligibleForSendToProvider: true}), codebase({codebaseId: 'no-consent'})];
  it('enables only the newly authorized source when source mode was off', () => {
    expect(analysisContextAfterCodebaseRegistration({
      codeAwareMode: 'off', codebaseIds: ['codebase-a'], knowledgeSourceIds: ['wiki'],
    }, newSource(), previous())).toEqual({
      codeAwareMode: 'provider_send', codebaseIds: ['new-source'], knowledgeSourceIds: ['wiki'],
    });
  });
  it('retains valid authorized selection in provider-send mode', () => {
    expect(analysisContextAfterCodebaseRegistration({
      codeAwareMode: 'provider_send', codebaseIds: ['codebase-a', 'no-consent', 'deleted'], knowledgeSourceIds: [],
    }, newSource(), previous()).codebaseIds).toEqual(['codebase-a', 'new-source']);
  });
  it('preserves locate-only mode without demanding body consent', () => {
    expect(analysisContextAfterCodebaseRegistration({
      codeAwareMode: 'metadata_only', codebaseIds: ['no-consent'], knowledgeSourceIds: [],
    }, codebase({codebaseId: 'new-source', eligibleForSendToProvider: false}), previous())).toEqual({
      codeAwareMode: 'metadata_only', codebaseIds: ['new-source', 'no-consent'], knowledgeSourceIds: [],
    });
  });
  it('does not claim provider access when registration did not receive consent', () => {
    const selection = {codeAwareMode: 'off' as const, codebaseIds: [], knowledgeSourceIds: []};
    expect(analysisContextAfterCodebaseRegistration(selection, codebase(), previous())).toEqual(selection);
  });
  it('keeps successful registration and selection when list refresh fails', async () => {
    apiMocks.listCodebases.mockRejectedValue(new Error('refresh unavailable'));
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.viewMode = 'add-codebase';
    panel.onSelectionChange = vi.fn();
    panel.completeCodebaseRegistration(newSource(), true, 0, 0, panel.selection);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(panel.viewMode).toBe('list');
    expect(panel.codebases.map((source: CodebaseSummary) => source.codebaseId)).toEqual(['new-source']);
    expect(panel.selection.codebaseIds).toEqual(['new-source']);
    expect(panel.success).toContain('Added');
    expect(panel.error).toContain('refresh unavailable');
  });
  it('register-only preserves selection and mode exactly', () => {
    const panel = new CodebasePanel() as any;
    panel.selection = {codeAwareMode: 'off', codebaseIds: ['codebase-a'], knowledgeSourceIds: ['wiki']};
    panel.load = vi.fn();
    panel.onSelectionChange = vi.fn();
    panel.completeCodebaseRegistration(newSource(), false, 0, 0, panel.selection);
    expect(panel.onSelectionChange).not.toHaveBeenCalled();
    expect(panel.selection.codeAwareMode).toBe('off');
    expect(panel.selection.codebaseIds).toEqual(['codebase-a']);
  });
  it('does not apply a stale selection after context or permission changed mid-registration', () => {
    for (const change of ['mode', 'permission', 'authorization'] as const) {
      const panel = new CodebasePanel() as any;
      panel.load = vi.fn();
      panel.onSelectionChange = vi.fn();
      const original = panel.selection;
      if (change === 'mode') panel.selection = {...original, codeAwareMode: 'metadata_only'};
      if (change === 'permission') panel.readOnly = true;
      if (change === 'authorization') panel.registrationBoundaryRevision++;
      panel.completeCodebaseRegistration(newSource(), true, 0, 0, original);
      expect(panel.onSelectionChange).not.toHaveBeenCalled();
      expect(panel.codebases).toHaveLength(1);
      expect(panel.success).toContain('without selecting');
    }
  });
  it('ignores a registration from an earlier backend identity completely', () => {
    const panel = new CodebasePanel() as any;
    panel.identityEpoch = 2;
    panel.load = vi.fn();
    panel.completeCodebaseRegistration(newSource(), true, 1, 0, panel.selection);
    expect(panel.codebases).toEqual([]);
    expect(panel.load).not.toHaveBeenCalled();
  });
});

describe('truthful optional index failures', () => {
  it('distinguishes a capacity fallback from unavailable and unknown access', () => {
    const capacity = new CodebaseApiError('source_chunk_limit_exceeded:20000', 'CODEBASE_INDEX_CAPACITY_EXCEEDED', true);
    expect(codebaseIndexFailureMessage(capacity)).toContain('capacity');
    expect(codebaseIndexFailureMessage(capacity)).toContain('still available');
    expect(codebaseIndexFailureMessage(capacity)).not.toContain('20000');
    expect(codebaseIndexFailureMessage(new CodebaseApiError('root lost', 'CODEBASE_INDEX_FAILED', false), codebase())).toContain('unavailable');
    expect(codebaseIndexFailureMessage(new Error('timeout'))).toContain('could not be confirmed');
    expect(codebaseIndexFailureMessage(new Error('timeout'), codebase())).toContain('depend on current authorization');
  });
  it('refreshes root status after index failure and removes the unavailable selection', async () => {
    apiMocks.reindexCodebase.mockRejectedValue(new CodebaseApiError('root lost', 'CODEBASE_INDEX_FAILED', false));
    apiMocks.listCodebases.mockResolvedValue({featureEnabled: true, codebases: [codebase({rootAvailable: false})]});
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.codebases = [codebase()];
    panel.selection = {codeAwareMode: 'metadata_only', codebaseIds: ['codebase-a'], knowledgeSourceIds: []};
    await panel.reindex(codebase());
    expect(apiMocks.listCodebases).toHaveBeenCalledOnce();
    expect(panel.selection.codebaseIds).toEqual([]);
    expect(panel.error).toContain('unavailable');
    expect(panel.reindexingId).toBeNull();
  });
  it('does not infer availability from a stale root when refresh also fails', async () => {
    apiMocks.reindexCodebase.mockRejectedValue(new Error('index request failed'));
    apiMocks.listCodebases.mockRejectedValue(new Error('refresh failed'));
    const panel = new CodebasePanel() as any;
    panel.backendUrl = 'http://backend';
    panel.codebases = [codebase()];
    await panel.reindex(codebase());
    expect(panel.error).toContain('could not be confirmed');
    expect(panel.error).toContain('refresh failed');
    expect(panel.error).not.toContain('still available');
  });
});


it('fails closed after permission loss even when refreshing the list also fails', async () => {
  apiMocks.reindexCodebase.mockRejectedValue(new CodebaseApiError('forbidden', 'FORBIDDEN', undefined, 403));
  apiMocks.listCodebases.mockRejectedValue(new Error('refresh forbidden'));
  const panel = new CodebasePanel() as any;
  panel.backendUrl = 'http://backend';
  panel.codebases = [codebase()];
  panel.selection = {codeAwareMode: 'metadata_only', codebaseIds: ['codebase-a'], knowledgeSourceIds: []};
  await panel.reindex(codebase());
  expect(panel.selection.codebaseIds).toEqual([]);
  const checkbox = findNode(panel.renderCodebase(codebase()), node => node.tag === 'input');
  expect(checkbox.attrs.disabled).toBe(true);
  expect(panel.error).toContain('unavailable');
  apiMocks.listCodebases.mockResolvedValue({featureEnabled: true, codebases: [codebase()]});
  await panel.load();
  expect(panel.unavailableCodebaseIds.size).toBe(0);
});
