// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {uiText as text} from './ui_language';
import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
  SourceMechanismStatus,
  SourceUseReceipt,
  SourceUseStatus,
} from './types';

const STORAGE_KEY = 'smartperfetto-analysis-context-v1';
const MAX_CODEBASE_LABEL_LENGTH = 48;
const SHORT_CODEBASE_ID_LENGTH = 16;
const MAX_AUTHORIZATION_EPOCH = 2_147_483_647;
const MAX_RECEIPT_CODEBASE_IDS = 24;
const MAX_RECEIPT_IDENTIFIER_LENGTH = 96;
const MAX_RECEIPT_INCOMPLETE_REASONS = 20;

export const EMPTY_ANALYSIS_CONTEXT: AnalysisContextSelection = {
  codeAwareMode: 'off',
  codebaseIds: [],
  knowledgeSourceIds: [],
};

export interface SelectedCodebaseLabelDescriptor {
  [key: string]: unknown;
  codebaseId?: unknown;
  displayName?: unknown;
}

export interface SelectedCodebaseLabel {
  codebaseId: string;
  label: string;
  known: boolean;
}

function normalizedIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)))
    .sort();
}

function normalizedMode(value: unknown): CodeAwareAnalysisMode {
  return value === 'metadata_only' || value === 'provider_send' ? value : 'off';
}

function normalizedAuthorizationEpoch(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 &&
      Number(value) <= MAX_AUTHORIZATION_EPOCH
    ? Number(value)
    : 0;
}

function compactLabel(value: string, maxLength: number): string {
  return value.length > maxLength
    ? `${value.slice(0, Math.max(1, maxLength - 1))}…`
    : value;
}

function containsAbsolutePath(value: string): boolean {
  return /(^|[\s(["'])((~\/)|\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

export function shortCodebaseId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return 'unknown';
  const parts = raw.split(/[\\/]/).filter(Boolean);
  const leaf = parts.length > 0 ? parts[parts.length - 1] : raw;
  return compactLabel(leaf, SHORT_CODEBASE_ID_LENGTH);
}

function safeCodebaseDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || containsAbsolutePath(normalized)) return undefined;
  return compactLabel(normalized, MAX_CODEBASE_LABEL_LENGTH);
}

export function selectedCodebaseLabels(
  selectedCodebaseIds: readonly string[],
  descriptors: readonly SelectedCodebaseLabelDescriptor[],
): SelectedCodebaseLabel[] {
  const descriptorById = new Map<string, SelectedCodebaseLabelDescriptor>();
  for (const descriptor of descriptors) {
    if (typeof descriptor.codebaseId !== 'string') continue;
    const codebaseId = descriptor.codebaseId.trim();
    if (!codebaseId) continue;
    descriptorById.set(codebaseId, descriptor);
  }

  const labels = normalizedIds([...selectedCodebaseIds]).map((codebaseId) => {
    const displayName = safeCodebaseDisplayName(
      descriptorById.get(codebaseId)?.displayName,
    );
    return {
      codebaseId,
      label: displayName || shortCodebaseId(codebaseId),
      known: Boolean(displayName),
    };
  });
  const labelCounts = labels.reduce((counts, item) => {
    counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return labels.map((item) => (labelCounts.get(item.label) ?? 0) > 1
    ? {...item, label: `${item.label} (${shortCodebaseId(item.codebaseId)})`}
    : item);
}

export function normalizeAnalysisContext(value: unknown): AnalysisContextSelection {
  const candidate = value && typeof value === 'object'
    ? value as Partial<AnalysisContextSelection>
    : {};
  const authorizationEpoch = normalizedAuthorizationEpoch(
    candidate.authorizationEpoch,
  );
  return {
    codeAwareMode: normalizedMode(candidate.codeAwareMode),
    codebaseIds: normalizedIds(candidate.codebaseIds),
    knowledgeSourceIds: normalizedIds(candidate.knowledgeSourceIds),
    ...(authorizationEpoch > 0 ? {authorizationEpoch} : {}),
  };
}

/** Advance the explicit local authorization boundary without changing source selection. */
export function bumpAnalysisContextAuthorizationEpoch(
  selection: AnalysisContextSelection,
): AnalysisContextSelection {
  const normalized = normalizeAnalysisContext(selection);
  const current = normalized.authorizationEpoch ?? 0;
  return {
    ...normalized,
    authorizationEpoch: current >= MAX_AUTHORIZATION_EPOCH ? 0 : current + 1,
  };
}

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
  if (value === undefined) return undefined;
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

interface ReceiptSourceReference {
  id: string;
  codebaseId: string;
  lookupKind: 'metadata' | 'body' | 'indexed' | 'graph';
}

function receiptSourceReferences(
  value: unknown,
  mode: 'metadata_only' | 'provider_send',
  queried: readonly string[],
  used: readonly string[],
): Map<string, ReceiptSourceReference> {
  const references = new Map<string, ReceiptSourceReference>();
  const ambiguous = new Set<string>();
  for (const candidate of Array.isArray(value) ? value.slice(0, 100) : []) {
    if (!isRecord(candidate)) continue;
    const id = safeReceiptIdentifier(candidate.id);
    const codebaseId = safeReceiptIdentifier(candidate.codebaseId);
    const kind = candidate.lookupKind;
    if (!id || !codebaseId || !queried.includes(codebaseId) || !used.includes(codebaseId) ||
        (kind !== 'metadata' && kind !== 'body' && kind !== 'indexed' && kind !== 'graph') ||
        (mode === 'metadata_only' && kind !== 'metadata' && kind !== 'graph')) continue;
    if (references.has(id) || ambiguous.has(id)) {
      // The execution ledger emits one canonical record per ID. Duplicates in a
      // restored payload cannot establish which reference a binding names.
      references.delete(id);
      ambiguous.add(id);
      continue;
    }
    references.set(id, {id, codebaseId, lookupKind: kind});
  }
  return references;
}

function receiptClaimIds(contract: Record<string, unknown>): Set<string> {
  if (contract.bindingEligibility === 'ineligible') return new Set();
  const ids = new Set<string>();
  const ambiguous = new Set<string>();
  const claims = Array.isArray(contract.claims) ? contract.claims.slice(0, 100) : [];
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
  if (!Array.isArray(value) || value.length > 100) return undefined;
  const ids = value.map(safeReceiptIdentifier);
  if (ids.some(id => id === undefined)) return undefined;
  return [...new Set(ids as string[])].sort();
}

function receiptBinding(
  value: unknown,
  claims: ReadonlySet<string>,
  references: ReadonlyMap<string, ReceiptSourceReference>,
): {identity: string; mechanism: SourceMechanismStatus} | undefined {
  if (!isRecord(value)) return undefined;
  const claimId = safeReceiptIdentifier(value.claimId);
  const sourceIds = receiptBindingIdentifiers(value.sourceReferenceIds);
  const traceIds = receiptBindingIdentifiers(value.traceEvidenceRefIds);
  const mechanism = value.mechanismStatus as SourceMechanismStatus;
  if (!claimId || !claims.has(claimId) || !sourceIds?.length || !traceIds ||
      !sourceIds.every(id => references.has(id)) || !SOURCE_MECHANISM_STATUSES.has(mechanism)) {
    return undefined;
  }
  const hasBody = sourceIds.some(id => {
    const kind = references.get(id)?.lookupKind;
    return kind === 'body' || kind === 'indexed';
  });
  return {
    identity: JSON.stringify([claimId, sourceIds, traceIds]),
    mechanism: mechanism === 'corroborated' && (!hasBody || traceIds.length === 0)
      ? 'compatible' : mechanism,
  };
}

/**
 * Project a terminal conclusion contract into the only source metadata that
 * chat/session storage may retain. Raw references and arbitrary prose are
 * deliberately never copied into the result.
 */
export function parseSourceUseReceipt(
  value: unknown,
  verification?: unknown,
): SourceUseReceipt | undefined {
  if (!isRecord(value) || value.schemaVersion !== 'conclusion_contract_v1') {
    return undefined;
  }
  const decision = value.sourceUseDecision;
  if (!isRecord(decision) || decision.schemaVersion !== 'source_use_decision@1') {
    return undefined;
  }
  const codeAwareMode = decision.codeAwareMode === 'metadata_only' ||
      decision.codeAwareMode === 'provider_send'
    ? decision.codeAwareMode
    : undefined;
  const status = typeof decision.status === 'string' &&
      SOURCE_USE_STATUSES.has(decision.status as SourceUseStatus)
    ? decision.status as SourceUseStatus
    : undefined;
  const selectedCodebaseIds = boundedReceiptIdentifiers(
    decision.selectedCodebaseIds,
  );
  const queriedCandidates = boundedReceiptIdentifiers(
    decision.queriedCodebaseIds,
  );
  const usedCandidates = boundedReceiptIdentifiers(decision.usedCodebaseIds);
  if (
    !codeAwareMode ||
    !status ||
    !selectedCodebaseIds ||
    !queriedCandidates ||
    !usedCandidates
  ) {
    return undefined;
  }
  const selected = new Set(selectedCodebaseIds);
  const queriedCodebaseIds = queriedCandidates.filter((id) => selected.has(id));
  const usedCodebaseIds = usedCandidates.filter((id) => selected.has(id));
  const references = receiptSourceReferences(
    decision.references, codeAwareMode, queriedCodebaseIds, usedCodebaseIds,
  );
  const claims = receiptClaimIds(value);
  const declaredBindings = new Set((Array.isArray(value.sourceClaimBindings)
    ? value.sourceClaimBindings.slice(0, 100) : [])
    .map(binding => receiptBinding(binding, claims, references)?.identity)
    .filter((identity): identity is string => identity !== undefined));
  const reasonCode = typeof decision.reasonCode === 'string' &&
      SOURCE_USE_REASON_CODES.has(
        decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>,
      )
    ? decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>
    : undefined;
  const mechanismStatuses: SourceMechanismStatus[] = [];
  const mechanismSeen = new Set<SourceMechanismStatus>();
  const verified = isRecord(verification) &&
    verification.schemaVersion === 'source_claim_verifier@1' ? verification : undefined;
  const bindingVerificationStatus = verified?.status === 'passed' ||
    verified?.status === 'partial' || verified?.status === 'failed'
    ? verified.status : 'not_checked';
  if (bindingVerificationStatus !== 'not_checked' && Array.isArray(verified?.bindings)) {
    for (const candidate of verified.bindings.slice(0, 100)) {
      const binding = receiptBinding(candidate, claims, references);
      if (!binding || !declaredBindings.has(binding.identity)) continue;
      const mechanismStatus = binding.mechanism;
      if (mechanismSeen.has(mechanismStatus)) continue;
      mechanismSeen.add(mechanismStatus);
      mechanismStatuses.push(mechanismStatus);
    }
  }
  const incompleteReasons = safeIncompleteReasons(decision.incompleteReasons);
  const sourceTextAvailable = codeAwareMode === 'provider_send' &&
    [...references.values()].some(reference =>
      reference.lookupKind === 'body' || reference.lookupKind === 'indexed');
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
  };
}

export interface SourceUseReceiptPresentation {
  summary: string;
  details: string[];
}

/** A bounded, localized receipt; neither raw identifiers nor source references are rendered. */
export function sourceUseReceiptPresentation(
  receipt: SourceUseReceipt,
): SourceUseReceiptPresentation | undefined {
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
  const statusLabels: Record<SourceUseStatus, string> = {
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
  const sourceTextAvailable = receipt.codeAwareMode === 'provider_send' &&
    receipt.sourceTextAvailable === true && locatedCount > 0;
  const mechanisms = new Set(Array.isArray(receipt.mechanismStatuses)
    ? receipt.mechanismStatuses.filter(status => SOURCE_MECHANISM_STATUSES.has(status))
    : []);
  const verificationStatus = receipt.bindingVerificationStatus;
  const hasVerification = verificationStatus === 'passed' ||
    verificationStatus === 'partial' || verificationStatus === 'failed';
  const hasBinding = hasVerification && sourceTextAvailable &&
    mechanisms.has('corroborated');
  const summary = hasBinding
    ? text('源码已支持机制结论', 'Source supports a mechanism claim')
    : sourceTextAvailable
      ? text('已提供源码片段，尚无已核验机制绑定', 'Snippets supplied; no verified mechanism binding')
      : statusLabels[receipt.status];
  const details = [
    receipt.codeAwareMode === 'metadata_only'
      ? text('仅定位文件、符号和行号，不发送源码正文。', 'Locate-only access; no source text is sent.' )
      : sourceTextAvailable
        ? text('本轮模型已收到授权范围内的源码片段。', 'The model received authorized source snippets in this run.')
        : text('本轮未确认向模型提供源码正文。', 'No source text delivery was confirmed for this run.'),
    text(`已选 ${selected.length} 个源码库；查询 ${queriedCount} 个；定位 ${locatedCount} 个。`,
      `${selected.length} codebases selected; ${queriedCount} queried; ${locatedCount} located.`),
  ];
  if (receipt.status !== 'corroborated' && sourceTextAvailable) details.push(statusLabels[receipt.status]);
  if (receipt.coverageComplete === false) {
    details.push(text('搜索覆盖不完整，不能据此断言源码不存在。', 'Incomplete search coverage cannot prove source absence.'));
  }
  if (!hasVerification) details.push(text('机制绑定尚未核验。', 'Mechanism bindings have not been verified.'));
  if (verificationStatus === 'failed') details.push(text('部分源码绑定核验失败，不能作为已核验结论。', 'Some source bindings failed verification and cannot support verified conclusions.'));
  if (verificationStatus === 'partial') details.push(text('源码绑定核验仍有未满足的条件。', 'Source binding verification has unresolved conditions.'));
  if (hasBinding) details.push(text('源码支持实现机制；实际耗时和事件仍以 trace 证据为准。', 'Source supports implementation mechanisms; trace evidence establishes timing and occurrence.'));
  if (hasVerification && mechanisms.has('compatible')) details.push(text('部分源码机制与 trace 相容，尚未达到佐证标准。', 'Some mechanisms are compatible with the trace but are not corroborated.'));
  if (hasVerification && mechanisms.has('ambiguous')) details.push(text('部分机制仍有多个候选。', 'Some mechanism candidates remain ambiguous.'));
  if (hasVerification && mechanisms.has('unverified')) details.push(text('部分机制绑定未通过核验。', 'Some mechanism bindings are unverified.'));
  return {summary, details};
}

export function analysisContextScopeKey(
  backendUrl: string,
  context: SmartPerfettoRequestContext,
): string {
  return [
    backendUrl.replace(/\/+$/, ''),
    context.tenantId,
    context.workspaceId,
    context.userId,
  ].join('\0');
}

function loadPartitions(): Record<string, AnalysisContextSelection> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object'
      ? parsed as Record<string, AnalysisContextSelection>
      : {};
  } catch {
    return {};
  }
}

export function loadAnalysisContext(
  backendUrl: string,
  context: SmartPerfettoRequestContext,
): AnalysisContextSelection {
  const stored = loadPartitions()[analysisContextScopeKey(backendUrl, context)];
  return stored ? normalizeAnalysisContext(stored) : {...EMPTY_ANALYSIS_CONTEXT};
}

export function saveAnalysisContext(
  backendUrl: string,
  context: SmartPerfettoRequestContext,
  selection: AnalysisContextSelection,
): void {
  const partitions = loadPartitions();
  partitions[analysisContextScopeKey(backendUrl, context)] = normalizeAnalysisContext(selection);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(partitions));
  } catch {
    // Storage can be disabled; the in-memory selection remains authoritative.
  }
}

export function sameAnalysisContext(
  left: AnalysisContextSelection,
  right: AnalysisContextSelection,
): boolean {
  return JSON.stringify(normalizeAnalysisContext(left)) ===
    JSON.stringify(normalizeAnalysisContext(right));
}

/** Source/RAG retrieval requires the full evidence and verification pipeline. */
export function analysisContextRequiresFullMode(
  selection: AnalysisContextSelection,
): boolean {
  const normalized = normalizeAnalysisContext(selection);
  return normalized.knowledgeSourceIds.length > 0 ||
    (normalized.codeAwareMode !== 'off' && normalized.codebaseIds.length > 0);
}

/**
 * A backend may disable registered source analysis while external RAG remains
 * available. Clear only the unsupported source selection so callers can retry
 * once without silently discarding an independently authorized knowledge base.
 */
export function analysisContextAfterBackendError(
  selection: AnalysisContextSelection,
  errorCode: unknown,
): AnalysisContextSelection | undefined {
  const normalized = normalizeAnalysisContext(selection);
  if (
    errorCode !== 'FEATURE_DISABLED' ||
    normalized.codeAwareMode === 'off' ||
    normalized.codebaseIds.length === 0
  ) {
    return undefined;
  }
  return {
    ...normalized,
    codeAwareMode: 'off',
    codebaseIds: [],
  };
}
