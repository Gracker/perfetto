// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0

/**
 * Manages comparison mode state persistence across trace switches.
 *
 * When the user clicks [切换] to view the reference trace, Perfetto
 * destroys and recreates the AIPanel plugin instance. This manager
 * uses sessionStorage to bridge state across that lifecycle boundary.
 *
 * Flow:
 *   1. User clicks [切换] → saveComparisonState() → AppImpl.openTraceFromBuffer()
 *   2. Perfetto destroys old plugin, creates new instance
 *   3. New instance's handleTraceChange() → restoreComparisonState()
 *   4. Comparison bar and mode are restored seamlessly
 */

import {
  getSmartPerfettoAuthSessionGeneration,
  isSmartPerfettoOidcMode,
} from '../../core/smartperfetto_auth';
import {buildSmartPerfettoStorageKey} from '../../core/smartperfetto_request_context';

const COMPARISON_STATE_KEY = 'smartperfetto_comparison_state_v2';
const LEGACY_COMPARISON_STATE_KEY = 'smartperfetto_comparison_state_v1';
const oidcComparisonState = new Map<string, PersistedComparisonState>();
let activeOidcComparisonKey: string | undefined;
let activeOidcComparisonGeneration = getSmartPerfettoAuthSessionGeneration();

function bindOidcComparisonIdentity(key: string): void {
  const generation = getSmartPerfettoAuthSessionGeneration();
  if (
    (activeOidcComparisonKey && activeOidcComparisonKey !== key) ||
    generation !== activeOidcComparisonGeneration
  ) {
    oidcComparisonState.clear();
  }
  activeOidcComparisonKey = key;
  activeOidcComparisonGeneration = generation;
}

export function getComparisonStateStorageKey(
  baseKey = COMPARISON_STATE_KEY,
): string {
  return isSmartPerfettoOidcMode()
    ? buildSmartPerfettoStorageKey(baseKey, 'workspace')
    : baseKey;
}

/** Persisted comparison state — survives plugin re-instantiation. */
export interface PersistedComparisonState {
  schemaVersion?: 2;
  sourceKind?: 'raw_trace_pair';
  /** Which trace is the "primary" (the one user originally opened) */
  primaryTraceId: string;
  primaryTraceName: string;
  primaryTraceFingerprint: string;
  /** Which trace is the "reference" (for comparison) */
  referenceTraceId: string;
  referenceTraceName: string;
  referenceTraceFingerprint?: string;
  /** Which one is currently displayed in Perfetto */
  activeView: 'primary' | 'reference';
  /** Backend trace IDs (for API calls) */
  primaryBackendTraceId: string;
  referenceBackendTraceId: string;
  /** Agent session ID for multi-turn continuity */
  agentSessionId?: string;
  /** Timestamp — for staleness detection */
  savedAt: number;
  /** Viewport snapshot for the trace being switched AWAY from */
  viewportSnapshot?: ViewportSnapshot;
}

/** Captured viewport state for restoration after switching back. */
export interface ViewportSnapshot {
  /** Absolute visible window (for same-trace precise restore) */
  startNs: number;
  endNs: number;
  /** Relative ratios (for cross-trace approximate mapping) */
  startRatio: number;
  endRatio: number;
}

/** Save comparison state to sessionStorage before trace switch. */
export function saveComparisonState(state: PersistedComparisonState): void {
  try {
    const normalized = {
      ...state,
      schemaVersion: 2 as const,
      sourceKind: 'raw_trace_pair' as const,
    } satisfies PersistedComparisonState;
    if (isSmartPerfettoOidcMode()) {
      const key = getComparisonStateStorageKey();
      bindOidcComparisonIdentity(key);
      oidcComparisonState.set(key, normalized);
      sessionStorage.removeItem(key);
      sessionStorage.removeItem(
        getComparisonStateStorageKey(LEGACY_COMPARISON_STATE_KEY),
      );
      return;
    }
    sessionStorage.setItem(
      getComparisonStateStorageKey(),
      JSON.stringify(normalized),
    );
    sessionStorage.removeItem(
      getComparisonStateStorageKey(LEGACY_COMPARISON_STATE_KEY),
    );
  } catch (e) {
    console.warn('[ComparisonState] Failed to save:', e);
  }
}

/**
 * Restore comparison state from sessionStorage after plugin re-instantiation.
 * @param currentTraceFingerprint — if provided, validates that the newly loaded
 *   trace belongs to this comparison pair. Prevents accidental restore when
 *   opening an unrelated trace within the TTL window.
 */
export function restoreComparisonState(currentTraceFingerprint?: string): PersistedComparisonState | null {
  try {
    const storageKey = getComparisonStateStorageKey();
    if (isSmartPerfettoOidcMode()) bindOidcComparisonIdentity(storageKey);
    const memoryState = isSmartPerfettoOidcMode()
      ? oidcComparisonState.get(storageKey)
      : undefined;
    const raw = memoryState
      ? JSON.stringify(memoryState)
      : sessionStorage.getItem(storageKey)
      || sessionStorage.getItem(
        getComparisonStateStorageKey(LEGACY_COMPARISON_STATE_KEY),
      );
    if (!raw) return null;
    const state: PersistedComparisonState = {
      ...JSON.parse(raw),
      schemaVersion: 2,
      sourceKind: 'raw_trace_pair',
    };
    // Stale check: 30 minutes TTL (users may spend time analyzing reference trace)
    if (Date.now() - state.savedAt > 30 * 60 * 1000) {
      clearComparisonState();
      return null;
    }
    // Fingerprint validation: only restore if the new trace matches primary or reference
    if (currentTraceFingerprint) {
      const matchesPrimary = state.primaryTraceFingerprint === currentTraceFingerprint;
      const matchesReference = state.referenceTraceFingerprint === currentTraceFingerprint;
      if (!matchesPrimary && !matchesReference) {
        // Unrelated trace opened — discard stale comparison state
        clearComparisonState();
        return null;
      }
    }
    saveComparisonState(state);
    return state;
  } catch {
    return null;
  }
}

/** Clear comparison state (on exit comparison mode or stale). */
export function clearComparisonState(): void {
  try {
    const storageKey = getComparisonStateStorageKey();
    oidcComparisonState.delete(storageKey);
    sessionStorage.removeItem(storageKey);
    sessionStorage.removeItem(
      getComparisonStateStorageKey(LEGACY_COMPARISON_STATE_KEY),
    );
  } catch { /* non-fatal */ }
}

/**
 * Capture current viewport as a snapshot for later restoration.
 * Uses Perfetto's Timeline API.
 */
export function captureViewport(trace: {
  timeline: {visibleWindow: {start: bigint; end: bigint}};
  traceInfo: {start: bigint; end: bigint};
}): ViewportSnapshot {
  const vw = trace.timeline.visibleWindow;
  const traceStart = Number(trace.traceInfo.start);
  const traceEnd = Number(trace.traceInfo.end);
  const traceDur = traceEnd - traceStart;
  const startNs = Number(vw.start);
  const endNs = Number(vw.end);

  return {
    startNs,
    endNs,
    startRatio: traceDur > 0 ? (startNs - traceStart) / traceDur : 0,
    endRatio: traceDur > 0 ? (endNs - traceStart) / traceDur : 1,
  };
}
