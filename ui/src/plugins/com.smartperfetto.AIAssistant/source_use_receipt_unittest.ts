// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  knowledgeUseReceiptPresentation,
  parseKnowledgeUseReceipt,
  parseSourceUseReceipt,
  sourceUseReceiptPresentation,
  sourceVerificationFailed,
} from './source_use_receipt';
import type {SourceUseReceipt} from './types';
import {setUiLanguagePreference} from './ui_language';

/** The contract-only call shape that historical (@1) receipts were parsed with. */
function parseLegacy(contract: unknown, verification?: unknown): SourceUseReceipt | undefined {
  return parseSourceUseReceipt({conclusionContract: contract, verification});
}

describe('source-use receipt privacy projection', () => {
  it('keeps only bounded decision fields and unique mechanism statuses', () => {
    const rawCanary = 'RAW_SOURCE_CANARY_/Users/private/root/Main.kt:42';
    const receipt = parseLegacy({
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
    expect(parseLegacy({
      sourceUseDecision: {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['cb-a'],
        queriedCodebaseIds: [],
        usedCodebaseIds: [],
        status: 'located',
      },
    })).toBeUndefined();
    expect(parseLegacy({
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

    const bounded = parseLegacy({
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
    const parsed = parseLegacy({
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
    const parsed = parseLegacy({
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
    expect(parseLegacy(contract)?.mechanismStatuses).toEqual([]);
    const parsed = parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'partial',
      bindings: [{...contract.sourceClaimBindings[0], mechanismStatus: 'compatible'}],
    });
    expect(parsed?.mechanismStatuses).toEqual(['compatible']);
    expect(parsed?.bindingVerificationStatus).toBe('partial');
    expect(sourceUseReceiptPresentation(parsed!)?.summary).not.toContain('supports a mechanism claim');
    const failed = parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'failed', bindings: [],
    });
    expect(sourceUseReceiptPresentation(failed!)?.details.join(' ')).toContain('failed verification');
  });

  it('admits a matching verified current-run source binding without retaining references', () => {
    const contract = sourceContract();
    const parsed = parseLegacy(contract, {
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
    const parsed = parseLegacy(contract, {
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
    const parsed = parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed',
      bindings: [{...contract.sourceClaimBindings[0], mechanismStatus: 'compatible'}],
    });
    expect(parsed?.sourceTextAvailable).toBe(false);
    expect(parsed?.mechanismStatuses).toEqual([]);
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toBe('Source lookup was not needed');
  });

  it('limits metadata-only references to locations and shows the stored strength without claiming text', () => {
    const contract = sourceContract();
    contract.sourceUseDecision.codeAwareMode = 'metadata_only';
    contract.sourceUseDecision.status = 'located';
    contract.sourceUseDecision.references[0].lookupKind = 'metadata';
    const parsed = parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    });
    expect(parsed?.sourceTextAvailable).toBe(false);
    expect(parsed?.mechanismStatuses).toEqual(['corroborated']);
    // Without source text the summary never says the source supports a mechanism.
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toBe('Source locations found');
    expect(sourceUseReceiptPresentation(parsed!)?.details.join(' ')).toContain('no source text is sent');
    // A body reference is not admitted in metadata_only, so the binding names nothing this run returned.
    contract.sourceUseDecision.references[0].lookupKind = 'body';
    expect(parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    })?.mechanismStatuses).toEqual([]);
  });

  it('shows a stored @1 corroboration whose binding cites a search hit as stored', () => {
    const contract: any = sourceContract();
    contract.sourceUseDecision.references = [
      {id: 'source-ref-hit', codebaseId: 'cb-a', lookupKind: 'search_hit'},
      {id: 'source-ref-body', codebaseId: 'cb-a', lookupKind: 'body'},
    ];
    contract.sourceUseDecision.referenceCounts = {located: 2, read: 2};
    contract.sourceClaimBindings = [{claimId: 'claim-a', mechanismStatus: 'corroborated',
      sourceReferenceIds: ['source-ref-hit'], traceEvidenceRefIds: ['trace-a']}];
    const parsed = parseLegacy(contract, {
      schemaVersion: 'source_claim_verifier@1', status: 'passed', bindings: contract.sourceClaimBindings,
    });
    expect(parsed?.mechanismStatuses).toEqual(['corroborated']);
    expect(sourceUseReceiptPresentation(parsed!)?.summary).toBe('Source supports a mechanism claim');
  });
});

// ---------------------------------------------------------------------------
// Read/located counts come from the backend (`referenceCounts`)
// ---------------------------------------------------------------------------

function decisionWith(
  references: unknown[],
  mode: 'metadata_only' | 'provider_send' = 'provider_send',
  referenceCounts?: unknown,
) {
  return {
    schemaVersion: 'source_use_decision@1', codeAwareMode: mode,
    selectedCodebaseIds: ['cb-a', 'cb-b'], queriedCodebaseIds: ['cb-a', 'cb-b'],
    usedCodebaseIds: ['cb-a', 'cb-b'], status: 'located', references,
    ...(referenceCounts === undefined ? {} : {referenceCounts}),
  };
}

describe('source receipt reference counts', () => {
  const hit = {id: 'hit', codebaseId: 'cb-a', lookupKind: 'search_hit', filePath: 'a/PRIVATE_PATH_CANARY.kt',
    lineRange: {start: 3, end: 4}, sourceGeneration: 'g'};

  it('shows the backend counts as given: a search hit it judged read makes source text available', () => {
    const receipt = parseSourceUseReceipt({sourceUseDecision: decisionWith([hit], 'provider_send', {located: 1, read: 1})});
    expect(receipt?.referenceCounts).toEqual({located: 1, read: 1});
    expect(receipt?.sourceTextAvailable).toBe(true);
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_PATH_CANARY|lineRange|sourceGeneration/);
    expect(sourceUseReceiptPresentation(receipt!)?.details.join(' ')).toContain('1 source locations returned; 1 read in full.');
  });

  it('never re-derives a read from paths or ranges', () => {
    const body = {id: 'b', codebaseId: 'cb-a', lookupKind: 'body', filePath: 'a/B.kt',
      lineRange: {start: 1, end: 10}, sourceGeneration: 'g'};
    // The backend said nothing was read: a body-shaped reference cannot override it.
    const receipt = parseSourceUseReceipt({sourceUseDecision: decisionWith([body], 'provider_send', {located: 1, read: 0})});
    expect(receipt?.referenceCounts).toEqual({located: 1, read: 0});
    expect(receipt?.sourceTextAvailable).toBe(false);
  });

  it.each([
    [{located: 1, read: 2}], [{located: -1, read: 0}], [{located: '1', read: 0}], [{located: 1.5, read: 1}], ['1/1'],
  ])('drops malformed counts %j and falls back to body references', counts => {
    const receipt = parseSourceUseReceipt({sourceUseDecision: decisionWith([hit], 'provider_send', counts)});
    expect(receipt).not.toHaveProperty('referenceCounts');
    expect(receipt?.sourceTextAvailable).toBe(false);
  });

  it('falls back to body references for payloads from before the backend counted', () => {
    const body = {id: 'b', codebaseId: 'cb-a', lookupKind: 'indexed'};
    expect(parseSourceUseReceipt({sourceUseDecision: decisionWith([body])})?.sourceTextAvailable).toBe(true);
    expect(parseSourceUseReceipt({sourceUseDecision: decisionWith([hit])})?.sourceTextAvailable).toBe(false);
  });

  it('never reports a read in metadata_only, whatever the counts say', () => {
    const receipt = parseSourceUseReceipt({sourceUseDecision: decisionWith([hit], 'metadata_only', {located: 1, read: 1})});
    expect(receipt?.referenceCounts).toEqual({located: 1, read: 0});
    expect(receipt?.sourceTextAvailable).toBe(false);
  });

  it('drops every copy of a duplicated reference id from binding admission', () => {
    const contract = {
      schemaVersion: 'conclusion_contract_v1',
      sourceUseDecision: decisionWith([
        {id: 'dup', codebaseId: 'cb-a', lookupKind: 'body'}, {id: 'dup', codebaseId: 'cb-a', lookupKind: 'body'},
      ]),
      claims: [{id: 'claim-a', text: 'Mechanism.', references: [{evidenceRefId: 'trace-a'}]}],
      sourceClaimBindings: [{claimId: 'claim-a', mechanismStatus: 'corroborated',
        sourceReferenceIds: ['dup'], traceEvidenceRefIds: ['trace-a']}],
    };
    expect(parseLegacy(contract, {schemaVersion: 'source_claim_verifier@1', status: 'passed',
      bindings: contract.sourceClaimBindings})?.mechanismStatuses).toEqual([]);
  });

  it('prefers the top-level decision over the contract copy', () => {
    const contract = {schemaVersion: 'conclusion_contract_v1', sourceUseDecision: {
      ...decisionWith([]), status: 'attempted'}};
    expect(parseSourceUseReceipt({conclusionContract: contract,
      sourceUseDecision: decisionWith([])})?.status).toBe('located');
    expect(parseSourceUseReceipt({conclusionContract: contract})?.status).toBe('attempted');
  });
});

// ---------------------------------------------------------------------------
// source_claim_verifier @1 / @2
// ---------------------------------------------------------------------------

describe('source claim verifier @2 receipts', () => {
  const pathCanary = 'app/src/PRIVATE_PATH_CANARY/Main.kt';
  const decision = {
    ...decisionWith([
      {id: 'ref-body', codebaseId: 'cb-a', lookupKind: 'body', filePath: pathCanary,
        lineRange: {start: 1, end: 20}, sourceGeneration: 'g'},
    ]),
    status: 'corroborated',
    depth: {requested: 'auto', effective: 'locate', origin: 'budget', fallbackReason: 'intent_unavailable',
      cap: 'metadata_only'},
  };
  const verification = (status: string, claims: unknown[], citations: unknown[], issues: unknown[] = []) => ({
    schemaVersion: 'source_claim_verifier@2', status,
    bindings: [{claimId: 'C1', sourceReferenceIds: ['ref-body'], traceEvidenceRefIds: ['trace-1']}],
    claims, citations, issues,
  });
  const claim = (claimId: string, status: string) =>
    ({claimId, status, sourceReferenceIds: ['ref-body'], traceEvidenceRefIds: []});
  const citation = (status: string) => ({citation: `${pathCanary}:L1-L2`, filePath: pathCanary,
    lineRange: {start: 1, end: 2}, status});

  it('counts claims per status and citations per status, keeping unmatched and ambiguous visible', () => {
    const receipt = parseSourceUseReceipt({sourceUseDecision: decision, verification: verification('partial',
      [claim('C1', 'trace_linked'), claim('C2', 'source_only'), claim('C3', 'location_only'),
        claim('C3', 'trace_linked'), claim('C4', 'not_a_status')],
      [citation('verified_body'), citation('located'), citation('unmatched'), citation('ambiguous'),
        citation('ambiguous')],
      [{code: 'source_citation_extraction_truncated', severity: 'warning', message: 'x'}])});
    expect(receipt).toMatchObject({
      claimVerifier: 'source_claim_verifier@2',
      bindingVerificationStatus: 'partial',
      mechanismStatuses: [],
      claimStatusCounts: {trace_linked: 1, source_only: 1, location_only: 1},
      citationStatusCounts: {verified_body: 1, located: 1, unmatched: 1, ambiguous: 2},
      citationsTruncated: true,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_PATH_CANARY|ref-body|trace-1|"C1"/);
    const presentation = sourceUseReceiptPresentation(receipt!)!;
    expect(presentation.summary).toBe('Source explanation linked to Trace evidence');
    const details = presentation.details.join(' | ');
    expect(details).toContain('Source explanation + Trace evidence 1');
    expect(details).toContain('Not returned in this run 1');
    expect(details).toContain('Several files match; not pinned 2');
    expect(details).toContain('the rest were not checked');
    expect(details).toContain('Source depth: Quick locate (from the analysis budget; capped by locate-only access)');
    // A Trace-linked source explanation is not a proof of mechanism or cause.
    expect(`${presentation.summary} ${details}`).not.toMatch(/supports a mechanism|proves|proven|root cause/i);
  });

  it('keeps trace_linked wording free of root-cause claims in Chinese', () => {
    setUiLanguagePreference('zh-CN');
    try {
      const presentation = sourceUseReceiptPresentation(parseSourceUseReceipt({sourceUseDecision: decision,
        verification: verification('passed', [claim('C1', 'trace_linked')], [citation('verified_body')])})!)!;
      expect(presentation.summary).toBe('源码解释已与 Trace 证据关联');
      expect(presentation.details.join(' ')).toContain('源码解释 + Trace 证据 1');
      expect(JSON.stringify(presentation)).not.toMatch(/根因|证明|trace_linked|cb-a/);
    } finally { setUiLanguagePreference('auto'); }
  });

  it('reads a failed @2 result (an invalid binding) as failed verification', () => {
    const failed = verification('failed', [claim('C1', 'invalid')], []);
    expect(sourceVerificationFailed(failed)).toBe(true);
    expect(sourceVerificationFailed({...failed, status: 'partial'})).toBe(false);
    expect(sourceVerificationFailed({schemaVersion: 'source_claim_verifier@1', status: 'failed'})).toBe(true);
    expect(sourceVerificationFailed({schemaVersion: 'source_claim_verifier@9', status: 'failed'})).toBe(false);
    const receipt = parseSourceUseReceipt({sourceUseDecision: decision, verification: failed})!;
    expect(sourceUseReceiptPresentation(receipt)?.summary)
      .toBe('Invalid source reference; dependent conclusions are unverified');
  });

  it('does not report source text as linked when no claim reached trace_linked', () => {
    const receipt = parseSourceUseReceipt({sourceUseDecision: decision,
      verification: verification('partial', [claim('C1', 'source_only')], [])})!;
    expect(sourceUseReceiptPresentation(receipt)?.summary)
      .toBe('Source read; no source conclusion is linked to Trace');
  });

  it('keeps a historical @1 receipt stored before @2 renderable as before', () => {
    const stored: SourceUseReceipt = {
      schemaVersion: 'source_use_receipt@1', codeAwareMode: 'provider_send',
      selectedCodebaseIds: ['cb-a'], queriedCodebaseIds: ['cb-a'], usedCodebaseIds: ['cb-a'],
      status: 'corroborated', sourceTextAvailable: true, bindingVerificationStatus: 'passed',
      mechanismStatuses: ['corroborated'],
    };
    expect(sourceUseReceiptPresentation(stored)?.summary).toBe('Source supports a mechanism claim');
    // A live @1 result is still parsed with its binding strengths.
    const contract = {
      schemaVersion: 'conclusion_contract_v1', sourceUseDecision: decisionWith([
        {id: 'ref-body', codebaseId: 'cb-a', lookupKind: 'body'}]),
      claims: [{id: 'claim-a', text: 'Mechanism.', references: [{evidenceRefId: 'trace-a'}]}],
      sourceClaimBindings: [{claimId: 'claim-a', mechanismStatus: 'corroborated',
        sourceReferenceIds: ['ref-body'], traceEvidenceRefIds: ['trace-a']}],
    };
    const parsed = parseLegacy(contract, {schemaVersion: 'source_claim_verifier@1', status: 'passed',
      bindings: contract.sourceClaimBindings});
    expect(parsed?.claimVerifier).toBe('source_claim_verifier@1');
    expect(parsed?.mechanismStatuses).toEqual(['corroborated']);
    expect(parsed?.claimStatusCounts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// knowledge_use@1
// ---------------------------------------------------------------------------

describe('knowledge use receipt', () => {
  const pathCanary = 'handbook/PRIVATE_KB_PATH.md';
  const citation = (status: string) =>
    ({citation: `kb-a:${pathCanary}#L1-L2`, relativePath: pathCanary, lineRange: {start: 1, end: 2}, status});

  it('treats an absent or malformed record as not recorded, never zero', () => {
    expect(parseKnowledgeUseReceipt(undefined)).toBeUndefined();
    expect(parseKnowledgeUseReceipt({schemaVersion: 'knowledge_use@2', sources: [], citations: []})).toBeUndefined();
    expect(parseKnowledgeUseReceipt({schemaVersion: 'knowledge_use@1', sources: []})).toBeUndefined();
  });

  it('shows a recorded zero as no content delivered', () => {
    const receipt = parseKnowledgeUseReceipt({schemaVersion: 'knowledge_use@1', sources: [], citations: []})!;
    expect(receipt).toEqual({schemaVersion: 'knowledge_use_receipt@1', sourceCount: 0,
      deliveredReferenceCount: 0, citationStatusCounts: {}});
    expect(knowledgeUseReceiptPresentation(receipt)?.summary)
      .toBe('No content was delivered from the selected knowledge bases');
  });

  it('counts delivered references per base and citation statuses without keeping paths', () => {
    const receipt = parseKnowledgeUseReceipt({
      schemaVersion: 'knowledge_use@1',
      sources: [
        {knowledgeBaseId: 'kb-a', kind: 'document_collection', generation: 'g1', deliveredReferenceCount: 3},
        {knowledgeBaseId: 'kb-b', kind: 'android_internals_wiki', generation: 'g2', deliveredReferenceCount: 2},
        {knowledgeBaseId: 'kb-a', kind: 'document_collection', generation: 'g1', deliveredReferenceCount: 9},
        {knowledgeBaseId: '/abs/kb', kind: 'document_collection', generation: 'g', deliveredReferenceCount: 1},
      ],
      citations: [citation('delivered'), citation('located'), citation('located'), citation('unmatched'),
        citation('ambiguous'), citation('bogus')],
      citationsTruncated: true,
    })!;
    expect(receipt).toEqual({
      schemaVersion: 'knowledge_use_receipt@1', sourceCount: 2, deliveredReferenceCount: 5,
      citationStatusCounts: {delivered: 1, located: 2, unmatched: 1, ambiguous: 1}, citationsTruncated: true,
    });
    expect(JSON.stringify(receipt)).not.toMatch(/PRIVATE_KB_PATH|kb-a|kb-b/);
    const presentation = knowledgeUseReceiptPresentation(receipt)!;
    expect(presentation.summary).toBe('5 reference(s) delivered from 2 knowledge base(s)');
    const details = presentation.details.join(' | ');
    expect(details).toContain('Text delivered in this run 1');
    expect(details).toContain('Located only; full text not delivered in this run 2');
    expect(details).toContain('Not returned in this run 1');
    expect(details).toContain('Several knowledge bases or versions match; not pinned 1');
    expect(details).toContain('background, not trace evidence');
  });

  it('distinguishes a located-only citation from delivered text', () => {
    const receipt = parseKnowledgeUseReceipt({schemaVersion: 'knowledge_use@1',
      sources: [{knowledgeBaseId: 'kb-a', kind: 'document_collection', generation: 'g', deliveredReferenceCount: 1}],
      citations: [citation('located')]})!;
    expect(receipt.citationStatusCounts).toEqual({located: 1});
    expect(knowledgeUseReceiptPresentation(receipt)?.details.join(' ')).not.toContain('Text delivered');
  });
});
