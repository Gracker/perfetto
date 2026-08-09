// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  analysisContextAfterBackendError,
  analysisContextRequiresFullMode,
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
