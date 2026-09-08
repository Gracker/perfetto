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
  sourceUseReceiptPresentation,
} from './analysis_context';
import type {AnalysisContextSelection, SourceUseReceipt} from './types';
import {setUiLanguagePreference} from './ui_language';

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
      sourceTextAvailable: false,
      bindingVerificationStatus: 'not_checked',
      codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['cb-a', 'cb-b'],
      queriedCodebaseIds: ['cb-b', 'cb-a'],
      usedCodebaseIds: ['cb-b'],
      status: 'search_incomplete',
      reasonCode: 'search_incomplete',
      coverageComplete: false,
      incompleteReasons: ['time_budget'],
      mechanismStatuses: [],
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


describe('localized source-use receipt', () => {
  const receipt = (overrides: Partial<SourceUseReceipt> = {}): SourceUseReceipt => ({
    schemaVersion: 'source_use_receipt@1', codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['cb-a'], queriedCodebaseIds: ['cb-a'], usedCodebaseIds: ['cb-a'],
    status: 'located', mechanismStatuses: [], ...overrides,
  });
  it('does not infer source-text delivery from located references or use counts', () => {
    const presentation = sourceUseReceiptPresentation(receipt());
    expect(presentation?.summary).toContain('locations found');
    expect(presentation?.details.join(' ')).toContain('No source text delivery was confirmed');
  });
  it('separates actual text delivery, incomplete search, and corroborated mechanisms', () => {
    const presentation = sourceUseReceiptPresentation(receipt({
      status: 'search_incomplete', sourceTextAvailable: true, coverageComplete: false,
    }));
    expect(presentation?.summary).toContain('Snippets supplied; no verified mechanism binding');
    expect(presentation?.details.join(' ')).toContain('cannot prove source absence');
    expect(sourceUseReceiptPresentation(receipt({
      sourceTextAvailable: true, bindingVerificationStatus: 'passed', mechanismStatuses: ['corroborated'],
    }))?.summary).toContain('supports a mechanism claim');
  });
  it('renders Chinese statuses without raw enum values, ids, or diagnostic reasons', () => {
    setUiLanguagePreference('zh-CN');
    try {
      const presentation = sourceUseReceiptPresentation(receipt({
        status: 'search_incomplete', incompleteReasons: ['source_reference_budget'], coverageComplete: false,
      }));
      expect(presentation?.summary).toBe('搜索覆盖不完整');
      expect(JSON.stringify(presentation)).not.toMatch(/cb-a|search_incomplete|source_reference_budget/);
    } finally { setUiLanguagePreference('auto'); }
  });
  it.each(['metadata_only', 'provider_send'] as const)('derives body availability only from delivered references in %s', mode => {
    const parsed = parseSourceUseReceipt({
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1', codeAwareMode: mode,
        selectedCodebaseIds: ['cb-a'], queriedCodebaseIds: ['cb-a'], usedCodebaseIds: ['cb-a'],
        status: 'search_incomplete', references: [{id: 'source-ref-a', codebaseId: 'cb-a', lookupKind: 'body', snippet: 'PRIVATE'}],
      },
    });
    expect(parsed?.sourceTextAvailable).toBe(mode === 'provider_send');
    expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|lookupKind|references/);
  });
  it('does not derive text delivery from another source partition', () => {
    const parsed = parseSourceUseReceipt({
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb-a'], queriedCodebaseIds: ['cb-a'], usedCodebaseIds: ['cb-a'],
        status: 'located', references: [{codebaseId: 'other-source', lookupKind: 'body'}],
      },
    });
    expect(parsed?.sourceTextAvailable).toBe(false);
  });
});


describe('source receipt binding admission', () => {
  function sourceContract() {
    return {
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1', codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb-a'], queriedCodebaseIds: ['cb-a'], usedCodebaseIds: ['cb-a'],
        status: 'corroborated', references: [
          {id: 'source-ref-a', codebaseId: 'cb-a', lookupKind: 'body'},
        ],
      },
      claims: [{id: 'claim-a', text: 'A source mechanism is compatible with this event.', references: [{evidenceRefId: 'trace-a'}]}],
      sourceClaimBindings: [{claimId: 'claim-a', mechanismStatus: 'corroborated',
        sourceReferenceIds: ['source-ref-a'], traceEvidenceRefIds: ['trace-a']}],
    };
  }

  it('uses verified binding strength instead of the model declaration', () => {
    const contract = sourceContract();
    expect(parseSourceUseReceipt(contract)?.mechanismStatuses).toEqual([]);
    const parsed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'partial',
      bindings: [{...contract.sourceClaimBindings[0], mechanismStatus: 'compatible'}],
    });
    expect(parsed?.mechanismStatuses).toEqual(['compatible']);
    expect(parsed?.bindingVerificationStatus).toBe('partial');
    expect(sourceUseReceiptPresentation(parsed!)?.summary).not.toContain('supports a mechanism claim');
    const failed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'failed', bindings: [],
    });
    expect(sourceUseReceiptPresentation(failed!)?.details.join(' ')).toContain('failed verification');
  });

  it('admits a matching verified current-run source binding without retaining references', () => {
    const contract = sourceContract();
    const parsed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    });
    expect(parsed?.mechanismStatuses).toEqual(['corroborated']);
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toContain('supports a mechanism claim');
    expect(JSON.stringify(parsed)).not.toMatch(/source-ref-a|claim-a|trace-a|lookupKind/);
  });

  it.each([
    'empty-binding', 'missing-reference', 'outside-selection', 'unqueried-source', 'unused-source',
    'missing-claim', 'duplicate-claim', 'invalid-claim', 'ineligible-contract',
    'changed-declaration', 'missing-declaration', 'duplicate-reference', 'malformed-reference-id',
  ])('rejects %s even when a stale verifier says compatible', scenario => {
    const contract: any = sourceContract();
    const binding = {...contract.sourceClaimBindings[0], mechanismStatus: 'compatible'};
    switch (scenario) {
      case 'empty-binding': binding.sourceReferenceIds = []; break;
      case 'missing-reference': contract.sourceUseDecision.references = []; break;
      case 'outside-selection': contract.sourceUseDecision.references[0].codebaseId = 'other-source'; break;
      case 'unqueried-source': contract.sourceUseDecision.queriedCodebaseIds = []; break;
      case 'unused-source': contract.sourceUseDecision.usedCodebaseIds = []; break;
      case 'missing-claim': contract.claims = []; break;
      case 'duplicate-claim': contract.claims.push({...contract.claims[0]}); break;
      case 'invalid-claim': contract.claims[0].rawSemantics = {invalid: true}; break;
      case 'ineligible-contract': contract.bindingEligibility = 'ineligible'; break;
      case 'changed-declaration': contract.sourceClaimBindings[0].traceEvidenceRefIds = ['other-trace']; break;
      case 'missing-declaration': contract.sourceClaimBindings = []; break;
      case 'duplicate-reference': contract.sourceUseDecision.references.push({...contract.sourceUseDecision.references[0]}); break;
      case 'malformed-reference-id': contract.sourceUseDecision.references[0].id = '/Users/private/ref'; break;
    }
    const parsed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: [binding],
    });
    expect(parsed?.mechanismStatuses).toEqual([]);
    expect(sourceUseReceiptPresentation(parsed!)?.details.join(' ')).not.toContain('Some mechanisms are compatible');
  });

  it('does not show source compatibility for not-needed source and an empty binding', () => {
    const contract: any = sourceContract();
    contract.sourceUseDecision.status = 'not_needed';
    contract.sourceUseDecision.references = [];
    contract.sourceUseDecision.queriedCodebaseIds = [];
    contract.sourceUseDecision.usedCodebaseIds = [];
    contract.sourceClaimBindings[0].sourceReferenceIds = [];
    const parsed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed',
      bindings: [{...contract.sourceClaimBindings[0], mechanismStatus: 'compatible'}],
    });
    expect(parsed?.sourceTextAvailable).toBe(false);
    expect(parsed?.mechanismStatuses).toEqual([]);
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toBe('Source lookup was not needed');
  });

  it('limits metadata-only references to locations and downgrades source corroboration', () => {
    const contract = sourceContract();
    contract.sourceUseDecision.codeAwareMode = 'metadata_only';
    contract.sourceUseDecision.status = 'located';
    contract.sourceUseDecision.references[0].lookupKind = 'metadata';
    const parsed = parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    });
    expect(parsed?.sourceTextAvailable).toBe(false);
    expect(parsed?.mechanismStatuses).toEqual(['compatible']);
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toBe('Source locations found');
    expect(sourceUseReceiptPresentation(parsed!)?.details.join(' ')).toContain('no source text is sent');
    contract.sourceUseDecision.references[0].lookupKind = 'body';
    expect(parseSourceUseReceipt(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    })?.mechanismStatuses).toEqual([]);
  });
});
