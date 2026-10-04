// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Terminal-run receipts for source and knowledge use. The parsers read the
 * owner's `analysis_completed` payload and keep only counts and statuses: no
 * reference, path, line range, citation or snippet survives into a message,
 * so chat, replay and browser storage never hold source locations.
 */

import {uiOutputLanguage, uiText as text} from './ui_language';
import {sourceDepthLabel} from './analysis_context';
import type {
  KnowledgeCitationStatus,
  SourceCitationStatus,
  SourceClaimStatus,
  SourceLookupKind,
} from './generated/data_contract.types';
import type {
  KnowledgeUseReceipt,
  SourceMechanismStatus,
  SourceUseReceipt,
  SourceUseReceiptDepth,
  SourceUseStatus,
} from './types';

const MAX_RECEIPT_CODEBASE_IDS = 24;
const MAX_RECEIPT_IDENTIFIER_LENGTH = 96;
const MAX_RECEIPT_INCOMPLETE_REASONS = 20;
const MAX_RECEIPT_REFERENCES = 100;
const MAX_RECEIPT_CLAIMS = 100;
const MAX_RECEIPT_CITATIONS = 200;
const MAX_RECEIPT_KNOWLEDGE_SOURCES = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const SOURCE_USE_STATUSES = new Set<SourceUseStatus>([
  'pending',
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'attempted',
  'located',
  'corroborated',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SOURCE_USE_REASON_CODES = new Set<NonNullable<SourceUseReceipt['reasonCode']>>([
  'not_needed',
  'disallowed',
  'no_queryable_anchor',
  'ambiguous_candidates',
  'not_found_complete',
  'search_incomplete',
  'unverified',
]);
const SOURCE_MECHANISM_STATUSES = new Set<SourceMechanismStatus>([
  'corroborated',
  'compatible',
  'ambiguous',
  'unverified',
]);
const LOOKUP_KINDS = new Set<SourceLookupKind>(['metadata', 'search_hit', 'body', 'indexed', 'graph']);
// Ordered as the HTML report lists them: strongest standing first.
const SOURCE_CLAIM_STATUSES: readonly SourceClaimStatus[] =
  ['trace_linked', 'source_only', 'location_only', 'unbound', 'invalid'];
const SOURCE_CITATION_STATUSES: readonly SourceCitationStatus[] =
  ['verified_body', 'located', 'unmatched', 'ambiguous'];
const KNOWLEDGE_CITATION_STATUSES: readonly KnowledgeCitationStatus[] =
  ['delivered', 'located', 'unmatched', 'ambiguous'];

function safeReceiptIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length > 0 &&
      normalized.length <= MAX_RECEIPT_IDENTIFIER_LENGTH &&
      /^[A-Za-z0-9][A-Za-z0-9_.:@+-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function boundedReceiptIdentifiers(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const identifier = safeReceiptIdentifier(candidate);
    if (!identifier) return undefined;
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    result.push(identifier);
    if (result.length >= MAX_RECEIPT_CODEBASE_IDS) break;
  }
  return result;
}

function safeIncompleteReasons(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    const reason = candidate.trim();
    if (
      !reason ||
      reason.length > 128 ||
      !/^[a-z][a-z0-9_.:-]*$/.test(reason) ||
      seen.has(reason)
    ) {
      continue;
    }
    seen.add(reason);
    result.push(reason);
    if (result.length >= MAX_RECEIPT_INCOMPLETE_REASONS) break;
  }
  return result.length > 0 ? result : undefined;
}

function safeCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

/** One admitted reference: identity and kind only, for @1 binding admission. */
interface ReceiptSourceReference {
  id: string;
  codebaseId: string;
  lookupKind: SourceLookupKind;
}

function isLocateOnlyLookupKind(kind: SourceLookupKind): boolean {
  return kind === 'metadata' || kind === 'graph' || kind === 'search_hit';
}

/**
 * The references a receipt may name: issued in a selected, queried and used
 * codebase, of a lookup kind the run's mode allows (metadata_only never
 * delivers a body). A duplicated id cannot say which reference it names, so
 * every copy is dropped.
 */
function receiptSourceReferences(
  value: unknown,
  mode: 'metadata_only' | 'provider_send',
  queried: readonly string[],
  used: readonly string[],
): Map<string, ReceiptSourceReference> {
  const references = new Map<string, ReceiptSourceReference>();
  const ambiguous = new Set<string>();
  for (const candidate of Array.isArray(value) ? value.slice(0, MAX_RECEIPT_REFERENCES) : []) {
    if (!isRecord(candidate)) continue;
    const id = safeReceiptIdentifier(candidate.id);
    const codebaseId = safeReceiptIdentifier(candidate.codebaseId);
    const kind = candidate.lookupKind as SourceLookupKind;
    if (!id || !codebaseId || !queried.includes(codebaseId) || !used.includes(codebaseId) ||
        !LOOKUP_KINDS.has(kind) ||
        (mode === 'metadata_only' && !isLocateOnlyLookupKind(kind))) continue;
    if (references.has(id) || ambiguous.has(id)) {
      references.delete(id);
      ambiguous.add(id);
      continue;
    }
    references.set(id, {id, codebaseId, lookupKind: kind});
  }
  return references;
}

/**
 * Read/located counts the backend derived with the rule its source verdicts
 * use (`referenceHasReadBody`); the receipt never re-derives them.
 */
function receiptReferenceCounts(value: unknown): {located: number; read: number} | undefined {
  if (!isRecord(value)) return undefined;
  const located = safeCount(value.located);
  const read = safeCount(value.read);
  return located !== undefined && read !== undefined && read <= located ? {located, read} : undefined;
}

// ---------------------------------------------------------------------------
// source_claim_verifier@1 (historical): binding admission against the contract
// ---------------------------------------------------------------------------

function receiptClaimIds(contract: Record<string, unknown>): Set<string> {
  if (contract.bindingEligibility === 'ineligible') return new Set();
  const ids = new Set<string>();
  const ambiguous = new Set<string>();
  const claims = Array.isArray(contract.claims) ? contract.claims.slice(0, MAX_RECEIPT_CLAIMS) : [];
  claims.forEach((claim, index) => {
    if (!isRecord(claim)) return;
    const id = claim.id === undefined && contract.bindingEligibility !== 'eligible'
      ? `Q${index + 1}` : safeReceiptIdentifier(claim.id);
    if (!id) return;
    if (ids.has(id) || ambiguous.has(id)) {
      ids.delete(id);
      ambiguous.add(id);
      return;
    }
    if (typeof claim.text !== 'string' || !claim.text.trim() ||
        !Array.isArray(claim.references) || claim.rawSemantics !== undefined ||
        claim.rawReferences !== undefined ||
        (Array.isArray(claim.semanticsParseIssues) && claim.semanticsParseIssues.length > 0)) {
      ambiguous.add(id);
      return;
    }
    ids.add(id);
  });
  return ids;
}

function receiptBindingIdentifiers(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_RECEIPT_CLAIMS) return undefined;
  const ids = value.map(safeReceiptIdentifier);
  if (ids.some(id => id === undefined)) return undefined;
  return [...new Set(ids as string[])].sort();
}

function receiptBinding(
  value: unknown,
  claims: ReadonlySet<string>,
  references: ReadonlyMap<string, ReceiptSourceReference>,
): {identity: string; mechanism?: SourceMechanismStatus} | undefined {
  if (!isRecord(value)) return undefined;
  const claimId = safeReceiptIdentifier(value.claimId);
  const sourceIds = receiptBindingIdentifiers(value.sourceReferenceIds);
  const traceIds = receiptBindingIdentifiers(value.traceEvidenceRefIds);
  const mechanism = value.mechanismStatus as SourceMechanismStatus;
  if (!claimId || !claims.has(claimId) || !sourceIds?.length || !traceIds ||
      !sourceIds.every(id => references.has(id))) {
    return undefined;
  }
  const identity = JSON.stringify([claimId, sourceIds, traceIds]);
  // Historical (@1) results show the strength their verifier stored; the
  // receipt checks only that the binding names this run's claims and
  // references, and never re-judges it. @2 declarations carry no status.
  return SOURCE_MECHANISM_STATUSES.has(mechanism) ? {identity, mechanism} : {identity};
}

function legacyMechanismStatuses(
  contract: Record<string, unknown> | undefined,
  verified: Record<string, unknown>,
  references: ReadonlyMap<string, ReceiptSourceReference>,
): SourceMechanismStatus[] {
  if (!contract || !Array.isArray(verified.bindings)) return [];
  const claims = receiptClaimIds(contract);
  const declaredBindings = new Set((Array.isArray(contract.sourceClaimBindings)
    ? contract.sourceClaimBindings.slice(0, MAX_RECEIPT_CLAIMS) : [])
    .map(binding => receiptBinding(binding, claims, references)?.identity)
    .filter((identity): identity is string => identity !== undefined));
  const statuses: SourceMechanismStatus[] = [];
  for (const candidate of verified.bindings.slice(0, MAX_RECEIPT_CLAIMS)) {
    const binding = receiptBinding(candidate, claims, references);
    if (!binding?.mechanism || !declaredBindings.has(binding.identity)) continue;
    if (!statuses.includes(binding.mechanism)) statuses.push(binding.mechanism);
  }
  return statuses;
}

// ---------------------------------------------------------------------------
// source_claim_verifier@2: product-computed claim and citation standing
// ---------------------------------------------------------------------------

function countByStatus<T extends string>(
  value: unknown,
  statuses: readonly T[],
  limit: number,
  identity: (item: Record<string, unknown>) => string | undefined,
): Partial<Record<T, number>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const counts: Partial<Record<T, number>> = {};
  const seen = new Set<string>();
  for (const item of value.slice(0, limit)) {
    if (!isRecord(item) || !statuses.includes(item.status as T)) continue;
    const key = identity(item);
    if (key !== undefined) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const status = item.status as T;
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function receiptDepth(value: unknown): SourceUseReceiptDepth | undefined {
  if (!isRecord(value)) return undefined;
  const {requested, effective, origin, cap} = value;
  if ((requested !== 'auto' && requested !== 'locate' && requested !== 'mechanism') ||
      (effective !== 'locate' && effective !== 'mechanism') ||
      (origin !== 'requested' && origin !== 'intent' && origin !== 'budget')) {
    return undefined;
  }
  return {requested, effective, origin, ...(cap === 'metadata_only' ? {cap} : {})};
}

function sourceUseDecisionOf(
  decision: unknown,
  contract: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  for (const candidate of [decision, contract?.sourceUseDecision]) {
    if (isRecord(candidate) && candidate.schemaVersion === 'source_use_decision@1') return candidate;
  }
  return undefined;
}

export interface SourceUseReceiptInput {
  /** `analysis_completed.data.conclusionContract`; needed for @1 bindings. */
  conclusionContract?: unknown;
  /** `analysis_completed.data.sourceClaimVerificationResult` (@1 or @2). */
  verification?: unknown;
  /** `analysis_completed.data.sourceUseDecision`; falls back to the contract's copy. */
  sourceUseDecision?: unknown;
}

/**
 * Project a terminal run's source decision and claim verification into the
 * only source metadata chat and session storage may retain.
 */
export function parseSourceUseReceipt(input: SourceUseReceiptInput): SourceUseReceipt | undefined {
  const contract = isRecord(input.conclusionContract) &&
      input.conclusionContract.schemaVersion === 'conclusion_contract_v1'
    ? input.conclusionContract : undefined;
  const decision = sourceUseDecisionOf(input.sourceUseDecision, contract);
  if (!decision) return undefined;
  const codeAwareMode = decision.codeAwareMode === 'metadata_only' ||
      decision.codeAwareMode === 'provider_send'
    ? decision.codeAwareMode
    : undefined;
  const status = typeof decision.status === 'string' &&
      SOURCE_USE_STATUSES.has(decision.status as SourceUseStatus)
    ? decision.status as SourceUseStatus
    : undefined;
  const selectedCodebaseIds = boundedReceiptIdentifiers(decision.selectedCodebaseIds);
  const queriedCandidates = boundedReceiptIdentifiers(decision.queriedCodebaseIds);
  const usedCandidates = boundedReceiptIdentifiers(decision.usedCodebaseIds);
  if (!codeAwareMode || !status || !selectedCodebaseIds || !queriedCandidates || !usedCandidates) {
    return undefined;
  }
  const selected = new Set(selectedCodebaseIds);
  const queriedCodebaseIds = queriedCandidates.filter((id) => selected.has(id));
  const usedCodebaseIds = usedCandidates.filter((id) => selected.has(id));
  const references = receiptSourceReferences(
    decision.references, codeAwareMode, queriedCodebaseIds, usedCodebaseIds,
  );
  const referenceCounts = receiptReferenceCounts(decision.referenceCounts);
  // Payloads from before the backend counted reads fall back to body references.
  const sourceTextAvailable = codeAwareMode === 'provider_send' && (referenceCounts
    ? referenceCounts.read > 0
    : [...references.values()].some(reference =>
        reference.lookupKind === 'body' || reference.lookupKind === 'indexed'));
  const reasonCode = typeof decision.reasonCode === 'string' &&
      SOURCE_USE_REASON_CODES.has(decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>)
    ? decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>
    : undefined;
  const verified = isRecord(input.verification) &&
      (input.verification.schemaVersion === 'source_claim_verifier@1' ||
        input.verification.schemaVersion === 'source_claim_verifier@2')
    ? input.verification : undefined;
  const bindingVerificationStatus = verified?.status === 'passed' ||
      verified?.status === 'partial' || verified?.status === 'failed'
    ? verified.status : 'not_checked';
  const isV2 = verified?.schemaVersion === 'source_claim_verifier@2';
  const mechanismStatuses = verified && !isV2 && bindingVerificationStatus !== 'not_checked'
    ? legacyMechanismStatuses(contract, verified, references)
    : [];
  const claimStatusCounts = isV2
    ? countByStatus(verified.claims, SOURCE_CLAIM_STATUSES, MAX_RECEIPT_CLAIMS,
      claim => safeReceiptIdentifier(claim.claimId))
    : undefined;
  const citationStatusCounts = isV2
    ? countByStatus(verified.citations, SOURCE_CITATION_STATUSES, MAX_RECEIPT_CITATIONS, () => undefined)
    : undefined;
  const citationsTruncated = isV2 && Array.isArray(verified.issues) && verified.issues.some(issue =>
    isRecord(issue) && issue.code === 'source_citation_extraction_truncated');
  const incompleteReasons = safeIncompleteReasons(decision.incompleteReasons);
  const depth = receiptDepth(decision.depth);
  return {
    schemaVersion: 'source_use_receipt@1',
    codeAwareMode,
    selectedCodebaseIds,
    queriedCodebaseIds,
    usedCodebaseIds,
    sourceTextAvailable,
    bindingVerificationStatus,
    status,
    ...(reasonCode ? {reasonCode} : {}),
    ...(typeof decision.coverageComplete === 'boolean'
      ? {coverageComplete: decision.coverageComplete}
      : {}),
    ...(incompleteReasons ? {incompleteReasons} : {}),
    mechanismStatuses,
    ...(verified ? {claimVerifier: verified.schemaVersion as NonNullable<SourceUseReceipt['claimVerifier']>} : {}),
    ...(referenceCounts
      ? {referenceCounts: codeAwareMode === 'provider_send' ? referenceCounts : {...referenceCounts, read: 0}}
      : {}),
    ...(claimStatusCounts ? {claimStatusCounts} : {}),
    ...(citationStatusCounts ? {citationStatusCounts} : {}),
    ...(citationsTruncated ? {citationsTruncated: true} : {}),
    ...(depth ? {depth} : {}),
  };
}

/** A stored source verification that failed: @1 or @2 `failed`. */
export function sourceVerificationFailed(verification: unknown): boolean {
  return isRecord(verification) &&
    (verification.schemaVersion === 'source_claim_verifier@1' ||
      verification.schemaVersion === 'source_claim_verifier@2') &&
    verification.status === 'failed';
}

// ---------------------------------------------------------------------------
// knowledge_use@1
// ---------------------------------------------------------------------------

/**
 * Counts from `knowledge_use@1`. An absent or malformed record returns
 * undefined ("not recorded"); a record with no delivered source is zero use.
 */
export function parseKnowledgeUseReceipt(value: unknown): KnowledgeUseReceipt | undefined {
  if (!isRecord(value) || value.schemaVersion !== 'knowledge_use@1' ||
      !Array.isArray(value.sources) || !Array.isArray(value.citations)) {
    return undefined;
  }
  const bases = new Set<string>();
  let deliveredReferenceCount = 0;
  for (const source of value.sources.slice(0, MAX_RECEIPT_KNOWLEDGE_SOURCES)) {
    if (!isRecord(source)) continue;
    const id = safeReceiptIdentifier(source.knowledgeBaseId);
    const count = safeCount(source.deliveredReferenceCount);
    if (!id || count === undefined || bases.has(id)) continue;
    bases.add(id);
    deliveredReferenceCount += count;
  }
  const citationStatusCounts = countByStatus(value.citations, KNOWLEDGE_CITATION_STATUSES,
    MAX_RECEIPT_CITATIONS, () => undefined) ?? {};
  return {
    schemaVersion: 'knowledge_use_receipt@1',
    sourceCount: bases.size,
    deliveredReferenceCount,
    citationStatusCounts,
    ...(value.citationsTruncated === true ? {citationsTruncated: true} : {}),
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface ReceiptPresentation {
  summary: string;
  details: string[];
}

function countedLabels<T extends string>(
  counts: Partial<Record<T, number>> | undefined,
  order: readonly T[],
  labels: Record<T, string>,
): string[] {
  if (!counts) return [];
  return order
    .map(status => [status, safeCount(counts[status]) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${labels[status]} ${count}`);
}

function sourceClaimLabels(): Record<SourceClaimStatus, string> {
  // Same wording as the HTML report's source section; no label says a
  // mechanism or cause is proven.
  return {
    trace_linked: text('源码解释 + Trace 证据', 'Source explanation + Trace evidence'),
    source_only: text('源码解释（未与 Trace 关联）', 'Source explanation (not linked to Trace)'),
    location_only: text('未读取实现', 'Implementation not read'),
    unbound: text('源码解释（未绑定引用，未核验）', 'Source explanation (no bound reference, unverified)'),
    invalid: text('引用无效', 'Invalid reference'),
  };
}

function sourceCitationLabels(): Record<SourceCitationStatus, string> {
  return {
    verified_body: text('本轮读过该段实现', 'Read in this run'),
    located: text('本轮仅定位到', 'Located only in this run'),
    unmatched: text('本轮未检索到该位置', 'Not returned in this run'),
    ambiguous: text('多个文件都匹配，未能确定', 'Several files match; not pinned'),
  };
}

function knowledgeCitationLabels(): Record<KnowledgeCitationStatus, string> {
  return {
    delivered: text('本轮交付过该段正文', 'Text delivered in this run'),
    located: text('本轮仅定位到，未交付完整正文', 'Located only; full text not delivered in this run'),
    unmatched: text('本轮未检索到该位置', 'Not returned in this run'),
    ambiguous: text('多个知识库或版本都匹配，未能确定', 'Several knowledge bases or versions match; not pinned'),
  };
}

function depthLine(depth: SourceUseReceiptDepth): string {
  const effective = sourceDepthLabel(depth.effective);
  const origin = depth.origin === 'requested'
    ? text('按你的选择', 'as you chose')
    : depth.origin === 'intent'
      ? text('按问题判断', 'judged from the question')
      : text('按分析预算', 'from the analysis budget');
  const cap = depth.cap === 'metadata_only'
    ? text('；仅定位授权封顶', '; capped by locate-only access') : '';
  return text(`源码深度：${effective}（${origin}${cap}）`, `Source depth: ${effective} (${origin}${cap})`);
}

function statusLabels(): Record<SourceUseStatus, string> {
  return {
    pending: text('本轮未查询源码', 'No source lookup in this run'),
    not_needed: text('本轮未需要源码补充', 'Source lookup was not needed'),
    disallowed: text('当前授权不允许源码访问', 'Source access is not authorized'),
    no_queryable_anchor: text('缺少可定位的源码线索', 'No usable source anchor'),
    attempted: text('已尝试查询，尚未定位', 'Lookup attempted; no source located'),
    located: text('已定位源码', 'Source locations found'),
    corroborated: text('已取得源码证据', 'Source evidence collected'),
    ambiguous_candidates: text('找到多个候选，尚未消歧', 'Multiple candidates remain unresolved'),
    not_found_complete: text('当前搜索范围内未找到匹配', 'No match in the completed search scope'),
    search_incomplete: text('搜索覆盖不完整', 'Search coverage is incomplete'),
    unverified: text('源码证据尚未核验', 'Source evidence is unverified'),
  };
}

/** A bounded, localized receipt; neither raw identifiers nor source locations are rendered. */
export function sourceUseReceiptPresentation(
  receipt: SourceUseReceipt,
): ReceiptPresentation | undefined {
  if (receipt.schemaVersion !== 'source_use_receipt@1' ||
      !SOURCE_USE_STATUSES.has(receipt.status) ||
      (receipt.codeAwareMode !== 'metadata_only' && receipt.codeAwareMode !== 'provider_send')) {
    return undefined;
  }
  const selected = boundedReceiptIdentifiers(receipt.selectedCodebaseIds);
  const queried = boundedReceiptIdentifiers(receipt.queriedCodebaseIds);
  const used = boundedReceiptIdentifiers(receipt.usedCodebaseIds);
  if (!selected || !queried || !used) return undefined;
  const queriedCount = queried.filter(id => selected.includes(id)).length;
  const locatedCount = used.filter(id => selected.includes(id)).length;
  const labels = statusLabels();
  const sourceTextAvailable = receipt.codeAwareMode === 'provider_send' &&
    receipt.sourceTextAvailable === true && locatedCount > 0;
  const verificationStatus = receipt.bindingVerificationStatus;
  const hasVerification = verificationStatus === 'passed' ||
    verificationStatus === 'partial' || verificationStatus === 'failed';
  const details = [
    receipt.codeAwareMode === 'metadata_only'
      ? text('仅定位文件、符号和行号，不发送源码正文。', 'Locate-only access; no source text is sent.')
      : sourceTextAvailable
        ? text('本轮模型已收到授权范围内的源码片段。', 'The model received authorized source snippets in this run.')
        : text('本轮未确认向模型提供源码正文。', 'No source text delivery was confirmed for this run.'),
    text(`已选 ${selected.length} 个源码库；查询 ${queriedCount} 个；定位 ${locatedCount} 个。`,
      `${selected.length} codebases selected; ${queriedCount} queried; ${locatedCount} located.`),
  ];
  const referenceCounts = receipt.referenceCounts;
  const located = safeCount(referenceCounts?.located);
  const read = safeCount(referenceCounts?.read);
  if (located !== undefined && read !== undefined && located > 0) {
    details.push(receipt.codeAwareMode === 'provider_send'
      ? text(`返回 ${located} 个源码位置，其中 ${read} 个读过实现。`,
        `${located} source locations returned; ${read} read in full.`)
      : text(`返回 ${located} 个源码位置。`, `${located} source locations returned.`));
  }
  if (receipt.depth) details.push(depthLine(receipt.depth));
  if (receipt.coverageComplete === false) {
    details.push(text('搜索覆盖不完整，不能据此断言源码不存在。', 'Incomplete search coverage cannot prove source absence.'));
  }

  if (receipt.claimVerifier === 'source_claim_verifier@2') {
    const claimCounts = receipt.claimStatusCounts ?? {};
    const linked = safeCount(claimCounts.trace_linked) ?? 0;
    const invalid = safeCount(claimCounts.invalid) ?? 0;
    const summary = verificationStatus === 'failed' || invalid > 0
      ? text('源码引用无效，相关结论未核验', 'Invalid source reference; dependent conclusions are unverified')
      : linked > 0
        ? text('源码解释已与 Trace 证据关联', 'Source explanation linked to Trace evidence')
        : sourceTextAvailable
          ? text('已读取源码片段，尚无与 Trace 关联的源码结论', 'Source read; no source conclusion is linked to Trace')
          : labels[receipt.status];
    if (receipt.status !== 'corroborated' && sourceTextAvailable) details.push(labels[receipt.status]);
    const claimLabels = countedLabels(claimCounts, SOURCE_CLAIM_STATUSES, sourceClaimLabels());
    if (claimLabels.length > 0) {
      details.push(text(`依赖源码的结论：${claimLabels.join(' · ')}`,
        `Source-dependent conclusions: ${claimLabels.join(' · ')}`));
    }
    const citationLabels = countedLabels(receipt.citationStatusCounts, SOURCE_CITATION_STATUSES,
      sourceCitationLabels());
    if (citationLabels.length > 0) {
      details.push(text(`答案中的源码引用：${citationLabels.join(' · ')}`,
        `Source locations cited in the answer: ${citationLabels.join(' · ')}`));
    }
    if (receipt.citationsTruncated) {
      details.push(text('源码引用过多，其余未核对。', 'Too many source citations; the rest were not checked.'));
    }
    if (!hasVerification) {
      details.push(text('依赖源码的结论尚未核验。', 'Source-dependent conclusions have not been checked.'));
    } else if (claimLabels.length > 0) {
      details.push(text('源码只解释候选机制；是否发生与耗时以 Trace、Skill 和 SQL 证据为准。',
        'Source explains candidate mechanisms; Trace, Skill, and SQL evidence establish occurrence and timing.'));
    }
    return {summary, details};
  }

  // source_claim_verifier@1 (historical results) and receipts without a verifier.
  const mechanisms = new Set(Array.isArray(receipt.mechanismStatuses)
    ? receipt.mechanismStatuses.filter(status => SOURCE_MECHANISM_STATUSES.has(status))
    : []);
  const hasBinding = hasVerification && sourceTextAvailable && mechanisms.has('corroborated');
  const summary = hasBinding
    ? text('源码已支持机制结论', 'Source supports a mechanism claim')
    : sourceTextAvailable
      ? text('已提供源码片段，尚无已核验机制绑定', 'Snippets supplied; no verified mechanism binding')
      : labels[receipt.status];
  if (receipt.status !== 'corroborated' && sourceTextAvailable) details.push(labels[receipt.status]);
  if (!hasVerification) details.push(text('机制绑定尚未核验。', 'Mechanism bindings have not been verified.'));
  if (verificationStatus === 'failed') details.push(text('部分源码绑定核验失败，不能作为已核验结论。', 'Some source bindings failed verification and cannot support verified conclusions.'));
  if (verificationStatus === 'partial') details.push(text('源码绑定核验仍有未满足的条件。', 'Source binding verification has unresolved conditions.'));
  if (hasBinding) details.push(text('源码支持实现机制；实际耗时和事件仍以 trace 证据为准。', 'Source supports implementation mechanisms; trace evidence establishes timing and occurrence.'));
  if (hasVerification && mechanisms.has('compatible')) details.push(text('部分源码机制与 trace 相容，尚未达到佐证标准。', 'Some mechanisms are compatible with the trace but are not corroborated.'));
  if (hasVerification && mechanisms.has('ambiguous')) details.push(text('部分机制仍有多个候选。', 'Some mechanism candidates remain ambiguous.'));
  if (hasVerification && mechanisms.has('unverified')) details.push(text('部分机制绑定未通过核验。', 'Some mechanism bindings are unverified.'));
  return {summary, details};
}

/** Knowledge use as counts; undefined for a malformed receipt. */
export function knowledgeUseReceiptPresentation(
  receipt: KnowledgeUseReceipt,
): ReceiptPresentation | undefined {
  if (receipt.schemaVersion !== 'knowledge_use_receipt@1') return undefined;
  const sources = safeCount(receipt.sourceCount);
  const delivered = safeCount(receipt.deliveredReferenceCount);
  if (sources === undefined || delivered === undefined) return undefined;
  const summary = sources > 0
    ? text(`交付 ${delivered} 条引用（${sources} 个知识库）`,
      `${delivered} reference(s) delivered from ${sources} knowledge base(s)`)
    : text('本轮没有从已选知识库交付内容', 'No content was delivered from the selected knowledge bases');
  const details = [text('内部资料只提供背景，不是 Trace 证据。', 'Internal knowledge is background, not trace evidence.')];
  const citationLabels = countedLabels(receipt.citationStatusCounts, KNOWLEDGE_CITATION_STATUSES,
    knowledgeCitationLabels());
  if (citationLabels.length > 0) {
    details.push(text(`答案中的知识库引用：${citationLabels.join(' · ')}`,
      `Knowledge locations cited in the answer: ${citationLabels.join(' · ')}`));
  }
  if (receipt.citationsTruncated) {
    details.push(text('引用过多，其余未核对。', 'Too many citations; the rest were not checked.'));
  }
  return {summary, details};
}

const presentations = new WeakMap<object, {language: string; presentation: ReceiptPresentation | undefined}>();

/** A receipt's presentation, built once per receipt object and UI language (render runs on every redraw). */
export function memoizedReceiptPresentation<T extends object>(
  receipt: T,
  build: (receipt: T) => ReceiptPresentation | undefined,
): ReceiptPresentation | undefined {
  const language = uiOutputLanguage();
  const cached = presentations.get(receipt);
  if (cached?.language === language) return cached.presentation;
  const presentation = build(receipt);
  presentations.set(receipt, {language, presentation});
  return presentation;
}
