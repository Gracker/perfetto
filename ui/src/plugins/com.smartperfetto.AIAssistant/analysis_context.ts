// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
} from './types';

const STORAGE_KEY = 'smartperfetto-analysis-context-v1';

export const EMPTY_ANALYSIS_CONTEXT: AnalysisContextSelection = {
  codeAwareMode: 'off',
  codebaseIds: [],
  knowledgeSourceIds: [],
};

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
