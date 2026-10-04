// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {codebaseUsableInMode, type CodebaseSummary} from './codebase_api';
import {uiText} from './ui_language';
import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
  RequestedSourceDepth,
  SubmittedAnalysisContext,
} from './types';

const STORAGE_KEY = 'smartperfetto-analysis-context-v1';
const MAX_CODEBASE_LABEL_LENGTH = 48;
const SHORT_CODEBASE_ID_LENGTH = 16;
const MAX_AUTHORIZATION_EPOCH = 2_147_483_647;

export const EMPTY_ANALYSIS_CONTEXT: AnalysisContextSelection = {
  codeAwareMode: 'off',
  codebaseIds: [],
  knowledgeSourceIds: [],
  sourceDepth: 'auto',
};

export interface SelectedCodebaseLabelDescriptor {
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

function normalizedSourceDepth(value: unknown): RequestedSourceDepth {
  return value === 'locate' || value === 'mechanism' ? value : 'auto';
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
  // Selections stored before source depth existed read as `auto`.
  return {
    codeAwareMode: normalizedMode(candidate.codeAwareMode),
    codebaseIds: normalizedIds(candidate.codebaseIds),
    knowledgeSourceIds: normalizedIds(candidate.knowledgeSourceIds),
    sourceDepth: normalizedSourceDepth(candidate.sourceDepth),
    ...(authorizationEpoch > 0 ? {authorizationEpoch} : {}),
  };
}

/**
 * The authorization part of a selection: what the backend fingerprints
 * (mode, codebases, knowledge) plus the local epoch. Source depth is a
 * per-run budget and is left out, so changing it keeps the session.
 */
export function analysisAuthorizationKey(selection: AnalysisContextSelection): string {
  const {sourceDepth: _sourceDepth, ...authorization} = normalizeAnalysisContext(selection);
  return JSON.stringify(authorization);
}

export function sameAnalysisAuthorization(
  left: AnalysisContextSelection,
  right: AnalysisContextSelection,
): boolean {
  return analysisAuthorizationKey(left) === analysisAuthorizationKey(right);
}

/**
 * The analysis-context fields of a request, one builder for both exits (the
 * Agent analyze request and the conversation start). Ids hidden by `off` are
 * not sent; source depth is always sent so a conversation never keeps an
 * earlier turn's depth.
 */
export function analysisContextRequestFields(selection: AnalysisContextSelection): {
  codeAwareMode: CodeAwareAnalysisMode;
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  sourceDepth: RequestedSourceDepth;
} {
  const normalized = normalizeAnalysisContext(selection);
  return {
    codeAwareMode: normalized.codeAwareMode,
    ...(normalized.codeAwareMode !== 'off' && normalized.codebaseIds.length > 0
      ? {codebaseIds: normalized.codebaseIds}
      : {}),
    ...(normalized.knowledgeSourceIds.length > 0
      ? {knowledgeSourceIds: normalized.knowledgeSourceIds}
      : {}),
    sourceDepth: normalized.sourceDepth ?? 'auto',
  };
}

/** The snapshot a user turn records: labels and counts as submitted. */
export function submittedAnalysisContext(
  selection: AnalysisContextSelection,
  descriptors: readonly SelectedCodebaseLabelDescriptor[],
): SubmittedAnalysisContext | undefined {
  const fields = analysisContextRequestFields(selection);
  const codebaseIds = fields.codebaseIds ?? [];
  const knowledgeSourceCount = fields.knowledgeSourceIds?.length ?? 0;
  if (codebaseIds.length === 0 && knowledgeSourceCount === 0) return undefined;
  return {
    codeAwareMode: codebaseIds.length > 0 ? fields.codeAwareMode : 'off',
    codebaseLabels: selectedCodebaseLabels(codebaseIds, descriptors).map(item => item.label),
    knowledgeSourceCount,
    sourceDepth: fields.sourceDepth,
  };
}

/** The one name of each source depth, for the chooser, the chip and the receipt. */
export function sourceDepthLabel(depth: RequestedSourceDepth): string {
  return depth === 'locate'
    ? uiText('快速定位', 'Quick locate')
    : depth === 'mechanism'
      ? uiText('完整分析', 'Full analysis')
      : uiText('智能', 'Auto');
}

/** Switch the source mode; sending text keeps only codebases whose text is allowed. */
export function analysisContextWithSourceMode(
  selection: AnalysisContextSelection,
  mode: CodeAwareAnalysisMode,
  codebases: readonly CodebaseSummary[],
): AnalysisContextSelection {
  const normalized = normalizeAnalysisContext(selection);
  return normalizeAnalysisContext({
    ...normalized,
    codeAwareMode: mode,
    codebaseIds: mode === 'provider_send'
      ? normalized.codebaseIds.filter(id => {
          const codebase = codebases.find(candidate => candidate.codebaseId === id);
          return codebase !== undefined && codebaseUsableInMode(codebase, mode);
        })
      : normalized.codebaseIds,
  });
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
