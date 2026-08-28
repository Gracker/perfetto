// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  analysisContextAfterBackendError,
  analysisContextRequiresFullMode,
  bumpAnalysisContextAuthorizationEpoch,
  normalizeAnalysisContext,
  parseSourceUseReceipt,
  selectedCodebaseLabels,
} from './analysis_context';
import type {AnalysisContextSelection} from './types';

const fullModeCases: Array<[string, AnalysisContextSelection]> = [
  ['source only', {codeAwareMode: 'metadata_only', codebaseIds: ['cb-a'], knowledgeSourceIds: []}],
  ['RAG only', {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: ['source-a']}],
  ['source and RAG', {
    codeAwareMode: 'provider_send',
    codebaseIds: ['cb-a'],
    knowledgeSourceIds: ['source-a'],
  }],
];

describe('analysisContextRequiresFullMode', () => {
  it.each(fullModeCases)('requires full mode for %s', (_label, selection) => {
    expect(analysisContextRequiresFullMode(selection)).toBe(true);
  });

  it('does not activate source retrieval when code-aware mode is off', () => {
    expect(analysisContextRequiresFullMode({
      codeAwareMode: 'off',
      codebaseIds: ['stale-ui-selection'],
      knowledgeSourceIds: [],
    })).toBe(false);
  });
});

describe('analysis context authorization epoch', () => {
  it('normalizes and advances a bounded explicit session boundary', () => {
    expect(normalizeAnalysisContext({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: -1,
    })).toEqual({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-a'],
      knowledgeSourceIds: [],
    });

    expect(bumpAnalysisContextAuthorizationEpoch({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: 8,
    })).toEqual({
      codeAwareMode: 'provider_send',
      codebaseIds: ['cb-a'],
      knowledgeSourceIds: [],
      authorizationEpoch: 9,
    });
  });
});

describe('source-use receipt privacy projection', () => {
  it('keeps only bounded decision fields and unique mechanism statuses', () => {
    const rawCanary = 'RAW_SOURCE_CANARY_/Users/private/root/Main.kt:42';
    const receipt = parseSourceUseReceipt({
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb-a', 'cb-b', 'cb-a'],
        queriedCodebaseIds: ['cb-b', 'cb-a'],
        usedCodebaseIds: ['cb-b'],
        status: 'search_incomplete',
        reasonCode: 'search_incomplete',
        coverageComplete: false,
        incompleteReasons: ['time_budget', 'time_budget', '../private'],
        attemptedTools: [rawCanary],
        references: [{
          id: 'source-ref-a',
          filePath: rawCanary,
          lineRange: {start: 1, end: 2},
          snippet: rawCanary,
          root: rawCanary,
          query: rawCanary,
        }],
      },
      sourceReferences: [{filePath: rawCanary, snippet: rawCanary}],
      sourceClaimBindings: [
        {
          claimId: 'claim-a',
          mechanismStatus: 'corroborated',
          sourceReferenceIds: ['source-ref-a'],
          reason: rawCanary,
        },
        {claimId: 'claim-b', mechanismStatus: 'corroborated'},
        {claimId: 'claim-c', mechanismStatus: 'compatible'},
        {claimId: 'claim-d', mechanismStatus: 'not-valid'},
      ],
      rootPath: rawCanary,
      snippet: rawCanary,
      query: rawCanary,
    });

    expect(receipt).toEqual({
      schemaVersion: 'source_use_receipt@1',
      codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['cb-a', 'cb-b'],
      queriedCodebaseIds: ['cb-b', 'cb-a'],
      usedCodebaseIds: ['cb-b'],
      status: 'search_incomplete',
      reasonCode: 'search_incomplete',
      coverageComplete: false,
      incompleteReasons: ['time_budget'],
      mechanismStatuses: ['corroborated', 'compatible'],
    });
    expect(JSON.stringify(receipt)).not.toContain(rawCanary);
    for (const forbidden of [
      'references',
      'sourceReferences',
      'filePath',
      'lineRange',
      'snippet',
      'rootPath',
      'query',
      'attemptedTools',
      'reason',
    ]) {
      expect(receipt).not.toHaveProperty(forbidden);
    }
  });

  it('fails closed on malformed required fields and bounds identifier lists', () => {
    expect(parseSourceUseReceipt({
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb-a'],
        queriedCodebaseIds: [],
        usedCodebaseIds: [],
        status: 'located',
      },
    })).toBeUndefined();
    expect(parseSourceUseReceipt({
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: 'cb-a',
        queriedCodebaseIds: [],
        usedCodebaseIds: [],
        status: 'located',
      },
    })).toBeUndefined();

    const bounded = parseSourceUseReceipt({
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'metadata_only',
        selectedCodebaseIds: Array.from({length: 100}, (_, index) => `cb-${index}`),
        queriedCodebaseIds: Array.from({length: 100}, (_, index) => `cb-${index}`),
        usedCodebaseIds: [],
        status: 'located',
      },
    });
    expect(bounded?.selectedCodebaseIds.length).toBeLessThanOrEqual(24);
    expect(bounded?.queriedCodebaseIds.length).toBeLessThanOrEqual(24);
  });
});

describe('analysisContextAfterBackendError', () => {
  it('clears stale source selection but preserves external RAG', () => {
    expect(analysisContextAfterBackendError({
      codeAwareMode: 'provider_send',
      codebaseIds: ['source-a'],
      knowledgeSourceIds: ['wiki-a'],
    }, 'FEATURE_DISABLED')).toEqual({
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: ['wiki-a'],
    });
  });

  it('does not retry unrelated failures or RAG-only requests', () => {
    const ragOnly: AnalysisContextSelection = {
      codeAwareMode: 'off',
      codebaseIds: [],
      knowledgeSourceIds: ['wiki-a'],
    };
    expect(analysisContextAfterBackendError(ragOnly, 'FEATURE_DISABLED')).toBeUndefined();
    expect(analysisContextAfterBackendError({
      ...ragOnly,
      codeAwareMode: 'metadata_only',
      codebaseIds: ['source-a'],
    }, 'FORBIDDEN')).toBeUndefined();
  });
});

describe('selectedCodebaseLabels', () => {
  it('shows all selected registered display names', () => {
    expect(selectedCodebaseLabels(['cb-renderer', 'cb-systemui'], [
      {codebaseId: 'cb-renderer', displayName: 'Renderer'},
      {codebaseId: 'cb-systemui', displayName: 'SystemUI'},
    ])).toEqual([
      {codebaseId: 'cb-renderer', label: 'Renderer', known: true},
      {codebaseId: 'cb-systemui', label: 'SystemUI', known: true},
    ]);
  });

  it('disambiguates duplicate display names with short IDs', () => {
    expect(selectedCodebaseLabels(['app-alpha-source', 'app-beta-source'], [
      {codebaseId: 'app-alpha-source', displayName: 'App'},
      {codebaseId: 'app-beta-source', displayName: 'App'},
    ])).toEqual([
      {
        codebaseId: 'app-alpha-source',
        label: 'App (app-alpha-source)',
        known: true,
      },
      {
        codebaseId: 'app-beta-source',
        label: 'App (app-beta-source)',
        known: true,
      },
    ]);
  });

  it('uses safe short IDs for missing summaries', () => {
    expect(selectedCodebaseLabels(['missing-codebase-id-1234567890'], [])).toEqual([
      {
        codebaseId: 'missing-codebase-id-1234567890',
        label: 'missing-codebas…',
        known: false,
      },
    ]);
  });

  it('does not accept absolute-path display fields', () => {
    const labels = selectedCodebaseLabels(['cb-private'], [{
      codebaseId: 'cb-private',
      displayName: '/Users/chris/Code/private-app',
      rootPath: '/Users/chris/Code/private-app',
    }]);

    expect(labels).toEqual([
      {codebaseId: 'cb-private', label: 'cb-private', known: false},
    ]);
    expect(JSON.stringify(labels)).not.toContain('/Users/chris');
  });
});
