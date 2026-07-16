// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';

import type {CodebaseSummary, ExternalKnowledgeSourceSummary} from './codebase_api';
import {
  analysisContextAfterCodebaseDelete,
  analysisContextForFeatureAvailability,
  codebaseDeletionPending,
  codebaseHasActiveIndex,
  CodebasePanel,
  externalKnowledgeSourceHasActiveIndex,
} from './codebase_panel';

function codebase(overrides: Partial<CodebaseSummary> = {}): CodebaseSummary {
  return {
    codebaseId: 'codebase-a',
    kind: 'app_source',
    displayName: 'App',
    lifecycleState: 'active',
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
    expect(codebaseHasActiveIndex(codebase({lifecycleState: 'deleting'}))).toBe(false);
    expect(codebaseDeletionPending(codebase({lifecycleState: 'deleting'}))).toBe(true);
    expect(codebaseDeletionPending(codebase())).toBe(false);
    expect(codebaseHasActiveIndex(codebase({chunkCount: 0}))).toBe(false);
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
});
