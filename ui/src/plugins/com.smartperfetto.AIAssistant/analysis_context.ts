// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
} from './types';

const STORAGE_KEY = 'smartperfetto-analysis-context-v1';
const MAX_CODEBASE_LABEL_LENGTH = 48;
const SHORT_CODEBASE_ID_LENGTH = 16;

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
  return {
    codeAwareMode: normalizedMode(candidate.codeAwareMode),
    codebaseIds: normalizedIds(candidate.codebaseIds),
    knowledgeSourceIds: normalizedIds(candidate.knowledgeSourceIds),
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
    codeAwareMode: 'off',
    codebaseIds: [],
    knowledgeSourceIds: normalized.knowledgeSourceIds,
  };
}
