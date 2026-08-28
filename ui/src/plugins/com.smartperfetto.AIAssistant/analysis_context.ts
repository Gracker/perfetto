// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
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

/**
 * Project a terminal conclusion contract into the only source metadata that
 * chat/session storage may retain. Raw references and arbitrary prose are
 * deliberately never copied into the result.
 */
export function parseSourceUseReceipt(value: unknown): SourceUseReceipt | undefined {
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
  const reasonCode = typeof decision.reasonCode === 'string' &&
      SOURCE_USE_REASON_CODES.has(
        decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>,
      )
    ? decision.reasonCode as NonNullable<SourceUseReceipt['reasonCode']>
    : undefined;
  const mechanismStatuses: SourceMechanismStatus[] = [];
  const mechanismSeen = new Set<SourceMechanismStatus>();
  if (Array.isArray(value.sourceClaimBindings)) {
    for (const candidate of value.sourceClaimBindings.slice(0, 100)) {
      if (!isRecord(candidate) || typeof candidate.mechanismStatus !== 'string') {
        continue;
      }
      const mechanismStatus = candidate.mechanismStatus as SourceMechanismStatus;
      if (
        !SOURCE_MECHANISM_STATUSES.has(mechanismStatus) ||
        mechanismSeen.has(mechanismStatus)
      ) {
        continue;
      }
      mechanismSeen.add(mechanismStatus);
      mechanismStatuses.push(mechanismStatus);
    }
  }
  const incompleteReasons = safeIncompleteReasons(decision.incompleteReasons);
  return {
    schemaVersion: 'source_use_receipt@1',
    codeAwareMode,
    selectedCodebaseIds,
    queriedCodebaseIds,
    usedCodebaseIds,
    status,
    ...(reasonCode ? {reasonCode} : {}),
    ...(typeof decision.coverageComplete === 'boolean'
      ? {coverageComplete: decision.coverageComplete}
      : {}),
    ...(incompleteReasons ? {incompleteReasons} : {}),
    mechanismStatuses,
  };
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
