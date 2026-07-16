// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  analysisContextAfterBackendError,
  analysisContextRequiresFullMode,
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
