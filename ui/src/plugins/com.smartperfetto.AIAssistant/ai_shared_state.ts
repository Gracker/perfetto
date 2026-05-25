// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Module-level shared state for AI Assistant cross-component communication.
 *
 * Enables the Status Bar widget, Area Selection Tab, and Timeline Notes to
 * read AI analysis state without a direct reference to the AIPanel instance.
 * AIPanel writes; other components read.
 *
 * Each update triggers m.redraw() so that Status Bar, Area Selection Tab,
 * and other readers see fresh state regardless of whether the caller also
 * triggered a redraw (self-contained update semantics).
 *
 * Why a module singleton instead of Perfetto's mountStore():
 * - State is ephemeral (no cross-trace persistence needed)
 * - Needs access from both index.ts (registration) and ai_panel.ts (updates)
 * - mountStore() is per-plugin scoped and serialization-oriented
 */

import m from 'mithril';

/**
 * An AI-detected finding that can be annotated on the timeline.
 */
export interface AIFinding {
  id: string;
  type: 'jank' | 'anr' | 'slow_function' | 'binder_slow' | 'warning' | 'insight';
  label: string;
  timestampNs: bigint;
  durationNs?: bigint;
  severity: 'critical' | 'warning' | 'info';
}

/**
 * Shared state readable by Status Bar, Area Selection Tab, etc.
 */
export interface AISharedState {
  /** Current analysis lifecycle phase. */
  status: 'idle' | 'ready' | 'analyzing' | 'completed' | 'partial' | 'quota_exceeded' | 'error';
  /** Number of issues found in the latest analysis. */
  issueCount: number;
  /** Human-readable phase label (e.g. "Executing scrolling_analysis"). */
  currentPhase: string;
  /** Epoch ms of the last completed analysis. */
  lastAnalysisTime: number | null;
  /** Extracted findings from the latest analysis (for notes + status popup). */
  findings: AIFinding[];
  /**
   * Set by the Area/Range Selection Tab's "Analyze" button.
   * AIPanel checks this on each render and auto-triggers analysis if non-null.
   * Uses number (not bigint) because the downstream SelectionContext and
   * JSON.stringify both require plain numbers.
   */
  pendingSelectionAnalysis: {
    startNs: number;
    endNs: number;
    trackUris: string[];
  } | null;
}

function createDefaultState(): AISharedState {
  return {
    status: 'idle',
    issueCount: 0,
    currentPhase: '',
    lastAnalysisTime: null,
    findings: [],
    pendingSelectionAnalysis: null,
  };
}

// ── Module singleton ────────────────────────────────────────────────────
let sharedState: AISharedState = createDefaultState();

/** Read the current shared state (treat as immutable snapshot). */
export function getAISharedState(): Readonly<AISharedState> {
  return sharedState;
}

/** Merge partial updates into the shared state. */
export function updateAISharedState(update: Partial<AISharedState>): void {
  sharedState = {...sharedState, ...update};
  // Schedule a Mithril redraw so Status Bar, Area Selection Tab, and other
  // readers reflect the update without relying on callers to m.redraw().
  m.redraw();
}

/** Reset to default (e.g. on trace unload or clear-chat). */
export function resetAISharedState(): void {
  sharedState = createDefaultState();
}
