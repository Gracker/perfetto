// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AnalysisResultPickerItem,
  AnalysisResultWindowState,
} from './types';

export interface AnalysisResultComparisonResolution {
  baselineId: string;
  candidateIds: string[];
  source: 'explicit_refs' | 'active_window';
}

export interface AnalysisResultComparisonNeedsSelection {
  baselineId?: string;
  candidateIds: string[];
  reason: 'no_baseline' | 'no_candidate' | 'ambiguous_candidates' | 'unknown_reference';
}

export type AnalysisResultComparisonRequestResolution =
  | {kind: 'not_comparison'}
  | {kind: 'resolved'; resolution: AnalysisResultComparisonResolution}
  | {kind: 'needs_selection'; selection: AnalysisResultComparisonNeedsSelection};

function compactSnapshotId(snapshotId: string): string {
  const withoutPrefix = snapshotId.replace(/^analysis-result[-_]?/i, '');
  const compact = withoutPrefix.replace(/[^a-zA-Z0-9]/g, '');
  return compact || snapshotId.replace(/[^a-zA-Z0-9]/g, '');
}

export function formatAnalysisResultRef(
  snapshotId: string | undefined,
  allSnapshotIds: readonly string[] = [],
): string {
  if (!snapshotId) return '';
  const compact = compactSnapshotId(snapshotId);
  const peerCompacts = allSnapshotIds
    .filter((id) => id !== snapshotId)
    .map((id) => compactSnapshotId(id).toLowerCase());
  for (let length = 8; length <= compact.length; length++) {
    const candidate = compact.slice(0, length);
    const lower = candidate.toLowerCase();
    if (!peerCompacts.some((peer) => peer.startsWith(lower))) {
      return `AR-${candidate}`;
    }
  }
  return `AR-${compact}`;
}

function normalizeRefToken(token: string): string {
  return token
    .trim()
    .replace(/^[`'"\s#]+|[`'"\s.,;:，。；：）)]+$/g, '')
    .replace(/^ar[\s_]+/i, 'AR-')
    .toLowerCase();
}

export function isAnalysisResultComparisonRequest(query: string): boolean {
  const text = query.trim();
  if (!text) return false;
  if (/\b(?:compare|vs|versus)\b/i.test(text)) {
    return /\b(?:analysis\s+result|snapshot|another|other|result)\b/i.test(text);
  }
  if (!/(对比|比较|相比|比一下)/.test(text)) return false;
  return /(另外|另一|另一个|另一份|其他|别的|刚刚|上一个|前一个|结果|snapshot|快照|AR[-_\s]?[a-zA-Z0-9]{4,16}|analysis-result-)/i.test(text);
}

export function extractAnalysisResultRefs(query: string): string[] {
  const refs = new Set<string>();
  const refRegex =
    /analysis-result-[a-zA-Z0-9_-]{8,80}|\bAR[-_\s]?[a-zA-Z0-9]{4,16}\b/gi;
  for (const match of query.matchAll(refRegex)) {
    refs.add(normalizeRefToken(match[0]));
  }
  return [...refs];
}

export function findAnalysisResultByRef(
  results: readonly AnalysisResultPickerItem[],
  ref: string,
): AnalysisResultPickerItem | null {
  const normalized = normalizeRefToken(ref);
  const shortMatch = normalized.match(/^ar-([a-z0-9]{4,})$/i);
  if (shortMatch) {
    const exactCompactMatches = results.filter(
      (item) => compactSnapshotId(item.id).toLowerCase() === shortMatch[1],
    );
    if (exactCompactMatches.length === 1) return exactCompactMatches[0]!;
  }
  const matches = results.filter((item) => {
    const itemId = item.id.toLowerCase();
    const compactId = compactSnapshotId(item.id).toLowerCase();
    return (
      itemId === normalized ||
      (shortMatch ? compactId.startsWith(shortMatch[1]) : false)
    );
  });
  return matches.length === 1 ? matches[0] : null;
}

function uniqueIds(ids: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function resolveAnalysisResultComparisonRequest(input: {
  query: string;
  results: readonly AnalysisResultPickerItem[];
  currentSnapshotId?: string;
  activeWindowStates?: readonly AnalysisResultWindowState[];
  currentWindowId?: string;
}): AnalysisResultComparisonRequestResolution {
  if (!isAnalysisResultComparisonRequest(input.query)) {
    return {kind: 'not_comparison'};
  }

  const resultIds = new Set(input.results.map((item) => item.id));
  const currentSnapshotId = input.currentSnapshotId &&
      resultIds.has(input.currentSnapshotId)
    ? input.currentSnapshotId
    : undefined;
  const explicitRefs = extractAnalysisResultRefs(input.query);
  const explicitResults = uniqueIds(
    explicitRefs.map((ref) => findAnalysisResultByRef(input.results, ref)?.id),
  );

  if (explicitRefs.length > 0 && explicitResults.length !== explicitRefs.length) {
    return {
      kind: 'needs_selection',
      selection: {
        ...(currentSnapshotId ? {baselineId: currentSnapshotId} : {}),
        candidateIds: explicitResults,
        reason: 'unknown_reference',
      },
    };
  }

  if (explicitResults.length >= 2) {
    const baselineId = explicitResults[0]!;
    const candidateIds = explicitResults.slice(1);
    return {
      kind: 'resolved',
      resolution: {baselineId, candidateIds, source: 'explicit_refs'},
    };
  }

  if (explicitResults.length === 1) {
    const explicitId = explicitResults[0]!;
    if (currentSnapshotId && explicitId !== currentSnapshotId) {
      return {
        kind: 'resolved',
        resolution: {
          baselineId: currentSnapshotId,
          candidateIds: [explicitId],
          source: 'explicit_refs',
        },
      };
    }
  }

  const baselineId = currentSnapshotId || explicitResults[0];
  if (!baselineId) {
    return {
      kind: 'needs_selection',
      selection: {candidateIds: [], reason: 'no_baseline'},
    };
  }

  const activeCandidateIds = uniqueIds(
    (input.activeWindowStates || [])
      .filter((state) => state.windowId !== input.currentWindowId)
      .map((state) => state.latestSnapshotId)
      .filter((id): id is string => !!id && id !== baselineId && resultIds.has(id)),
  );
  if (activeCandidateIds.length === 1) {
    return {
      kind: 'resolved',
      resolution: {
        baselineId,
        candidateIds: [activeCandidateIds[0]!],
        source: 'active_window',
      },
    };
  }
  if (activeCandidateIds.length > 1) {
    return {
      kind: 'needs_selection',
      selection: {
        baselineId,
        candidateIds: activeCandidateIds,
        reason: 'ambiguous_candidates',
      },
    };
  }

  const otherIds = input.results
    .map((item) => item.id)
    .filter((id) => id !== baselineId);
  return {
    kind: 'needs_selection',
    selection: {
      baselineId,
      candidateIds: otherIds,
      reason: otherIds.length === 0 ? 'no_candidate' : 'ambiguous_candidates',
    },
  };
}
