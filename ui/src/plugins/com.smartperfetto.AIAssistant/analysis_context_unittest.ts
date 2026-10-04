// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  analysisAuthorizationKey,
  analysisContextAfterBackendError,
  analysisContextRequestFields,
  analysisContextRequiresFullMode,
  analysisContextScopeKey,
  bumpAnalysisContextAuthorizationEpoch,
  loadAnalysisContext,
  normalizeAnalysisContext,
  sameAnalysisAuthorization,
  sameAnalysisContext,
  saveAnalysisContext,
  selectedCodebaseLabels,
  submittedAnalysisContext,
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
      sourceDepth: 'auto',
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
      sourceDepth: 'auto',
      authorizationEpoch: 9,
    });
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
      sourceDepth: 'auto',
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
    const descriptor = {
      codebaseId: 'cb-private',
      displayName: '/Users/chris/Code/private-app',
      rootPath: '/Users/chris/Code/private-app',
    };
    const labels = selectedCodebaseLabels(['cb-private'], [descriptor]);

    expect(labels).toEqual([
      {codebaseId: 'cb-private', label: 'cb-private', known: false},
    ]);
    expect(JSON.stringify(labels)).not.toContain('/Users/chris');
  });
});

describe('analysis context source depth', () => {
  it('reads selections stored before depth existed, and unknown depths, as auto', () => {
    localStorage.clear();
    const context = {tenantId: 't', workspaceId: 'w', userId: 'u'} as any;
    localStorage.setItem('smartperfetto-analysis-context-v1', JSON.stringify({
      [analysisContextScopeKey('http://backend', context)]: {
        codeAwareMode: 'provider_send', codebaseIds: ['cb-a'], knowledgeSourceIds: [], authorizationEpoch: 2,
      },
    }));
    expect(loadAnalysisContext('http://backend', context)).toEqual({
      codeAwareMode: 'provider_send', codebaseIds: ['cb-a'], knowledgeSourceIds: [], sourceDepth: 'auto',
      authorizationEpoch: 2,
    });
    expect(normalizeAnalysisContext({sourceDepth: 'deepest'}).sourceDepth).toBe('auto');
    saveAnalysisContext('http://backend', context, {
      codeAwareMode: 'metadata_only', codebaseIds: ['cb-a'], knowledgeSourceIds: [], sourceDepth: 'mechanism'});
    expect(loadAnalysisContext('http://backend', context).sourceDepth).toBe('mechanism');
  });

  it('compares depth for saving but leaves it out of the authorization', () => {
    const base: AnalysisContextSelection = {codeAwareMode: 'provider_send', codebaseIds: ['cb-a'], knowledgeSourceIds: []};
    const deeper = {...base, sourceDepth: 'mechanism' as const};
    expect(sameAnalysisContext(base, deeper)).toBe(false);
    expect(sameAnalysisAuthorization(base, deeper)).toBe(true);
    expect(analysisAuthorizationKey(base)).toBe(analysisAuthorizationKey(deeper));
    expect(sameAnalysisAuthorization(base, {...base, codebaseIds: ['cb-b']})).toBe(false);
    expect(sameAnalysisAuthorization(base, {...base, knowledgeSourceIds: ['kb']})).toBe(false);
    expect(sameAnalysisAuthorization(base, {...base, authorizationEpoch: 1})).toBe(false);
  });

  it('builds the request fields once for both exits: ids hidden by off are not sent, depth always is', () => {
    expect(analysisContextRequestFields({codeAwareMode: 'off', codebaseIds: ['cb-a'], knowledgeSourceIds: ['kb']}))
      .toEqual({codeAwareMode: 'off', knowledgeSourceIds: ['kb'], sourceDepth: 'auto'});
    expect(analysisContextRequestFields({codeAwareMode: 'metadata_only', codebaseIds: ['cb-b', 'cb-a'],
      knowledgeSourceIds: [], sourceDepth: 'locate'}))
      .toEqual({codeAwareMode: 'metadata_only', codebaseIds: ['cb-a', 'cb-b'], sourceDepth: 'locate'});
  });

  it('records a submitted snapshot of names and counts, and nothing when nothing is used', () => {
    expect(submittedAnalysisContext({codeAwareMode: 'off', codebaseIds: ['cb-a'], knowledgeSourceIds: []}, []))
      .toBeUndefined();
    expect(submittedAnalysisContext({codeAwareMode: 'provider_send', codebaseIds: ['cb-a'],
      knowledgeSourceIds: ['kb-1', 'kb-2'], sourceDepth: 'mechanism'},
    [{codebaseId: 'cb-a', displayName: 'Launcher'}])).toEqual({
      codeAwareMode: 'provider_send', codebaseLabels: ['Launcher'], knowledgeSourceCount: 2, sourceDepth: 'mechanism',
    });
    expect(submittedAnalysisContext({codeAwareMode: 'off', codebaseIds: ['cb-a'], knowledgeSourceIds: ['kb']}, []))
      .toEqual({codeAwareMode: 'off', codebaseLabels: [], knowledgeSourceCount: 1, sourceDepth: 'auto'});
  });
});
