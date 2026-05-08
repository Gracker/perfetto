// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * AI Transient State Bridge — carries per-instance UI state and active SSE
 * analysis across AIPanel unmount/remount during Pop Out / Dock Back.
 *
 * Why this exists:
 * When the user toggles between tab mode and floating mode, the old AIPanel
 * instance unmounts and a new one mounts. Most state lives in localStorage
 * sessions and auto-restores on the new instance. But a few things don't:
 *
 *   1. **Input field draft text** — what the user is currently typing
 *   2. **Collapsed table state** — which result tables are collapsed
 *   3. **Active SSE analysis** — an in-flight streaming analysis would be
 *      cancelled by onremove's cancelSSEConnection() and lost
 *
 * For SSE takeover we leverage the backend's existing Last-Event-ID replay:
 * cancelling the fetch + reconnecting with the saved cursor makes the backend
 * replay all events from that point forward. So we don't need to lift the
 * fetch stream itself — we just need to carry the last seen event ID across
 * the mount boundary.
 *
 * Save/restore flow:
 *
 *   popOutToFloatingWindow() / dockBack button
 *     └─> switchMode(newMode)
 *           ├─> captureTransientState()  // calls the registered saver
 *           │     └─> current AIPanel snapshots its transient fields
 *           └─> updateFloatingState({mode: newMode})
 *                 ├─> body portal renders new AIPanel (oncreate)
 *                 │     └─> consumeTransientState() restores the snapshot
 *                 └─> tab content re-renders (old AIPanel onremove)
 *                       └─> unregisterTransientSaver()
 *
 * The saver registration pattern lets external code (outside AIPanel) trigger
 * a state capture without needing a direct reference to the AIPanel instance.
 */

import {
  FloatingMode,
  clampFloatingGeometryToViewport,
  clampSidebarHeight,
  clampSidebarWidth,
  getFloatingState,
  updateFloatingState,
} from './ai_floating_state';
import {StreamingAnswerState, StreamingFlowState} from './types';

/**
 * Transient state snapshot captured during a mode switch.
 * All fields are optional — absent fields just aren't restored.
 */
export interface TransientState {
  /** Draft text in the input field. */
  inputDraft: string;
  /** IDs of currently collapsed result tables. */
  collapsedTables: string[];
  /** Command history index (current navigation position). */
  historyIndex: number;
  /**
   * An in-flight SSE analysis at the moment of mode switch. When set, the
   * new AIPanel instance reconnects via listenToAgentSSE() with the saved
   * lastEventId; the backend replays all events after that ID.
   */
  activeAnalysis: ActiveAnalysisSnapshot | null;
}

/**
 * In-flight analysis snapshot. Carries everything needed to make the
 * replayed event stream idempotent on the new AIPanel instance:
 *   - SSE cursor (agentSessionId + lastEventId) for backend replay
 *   - Dedup sets (displayedSkillProgress, completionHandled) so already-
 *     shown skill progress and conclusions don't reappear
 *   - Full streaming flow/answer state so in-progress bubbles continue
 *     updating instead of being recreated
 *
 * Per Codex review (HIGH 3): without these fields, replayed events would
 * trigger duplicate skill cards, duplicate conclusions, and a second
 * answer_stream bubble on every Pop Out / Dock Back during analysis.
 */
export interface ActiveAnalysisSnapshot {
  agentSessionId: string;
  /** null means "use 0 for full replay" — see Codex HIGH 2. */
  lastEventId: number | null;
  agentRunId: string | null;
  agentRequestId: string | null;
  agentRunSequence: number;
  loadingPhase: string;
  // ── Replay-sensitive handler state (Codex HIGH 3) ─────────────────
  /** IDs of skill progress events already displayed (dedup set). */
  displayedSkillProgress: string[];
  /** Whether the `conclusion` / `analysis_completed` was already handled. */
  completionHandled: boolean;
  /** Collected non-fatal errors for end-of-analysis summary. */
  collectedErrors: Array<{
    skillId: string;
    stepId?: string;
    error: string;
    timestamp: number;
  }>;
  /** Full streaming transcript state (phases/thoughts/tools/sub-agents). */
  streamingFlow: StreamingFlowState;
  /** Full incremental-answer stream state. */
  streamingAnswer: StreamingAnswerState;
}

// ── Module state ────────────────────────────────────────────────────────

/** One-shot payload: captured on mode switch, consumed on next mount. */
let pendingSnapshot: TransientState | null = null;

/** Callback registered by the currently-mounted AIPanel to produce a snapshot. */
let activeSaver: (() => TransientState) | null = null;

// ── Saver lifecycle ─────────────────────────────────────────────────────

/**
 * Called from AIPanel.oncreate. The saver closure captures `this` so it can
 * later produce a fresh snapshot on demand.
 */
export function registerTransientSaver(saver: () => TransientState): void {
  activeSaver = saver;
}

/**
 * Called from AIPanel.onremove. Clears the reference so a torn-down instance
 * can never be called after unmount.
 */
export function unregisterTransientSaver(saver: () => TransientState): void {
  // Only clear if this exact saver is still registered — prevents a late
  // unmount from clobbering the newly-registered saver of the next instance.
  if (activeSaver === saver) {
    activeSaver = null;
  }
}

// ── Snapshot capture / consume ──────────────────────────────────────────

/**
 * Capture a snapshot from the currently-mounted AIPanel. Called by
 * switchMode() before the mode change triggers a mount/unmount cycle.
 * No-op if no saver is registered (e.g. panel was never mounted).
 */
export function captureTransientState(): void {
  if (!activeSaver) {
    pendingSnapshot = null;
    return;
  }
  try {
    pendingSnapshot = activeSaver();
  } catch (e) {
    console.warn('[AITransientState] saver threw', e);
    pendingSnapshot = null;
  }
}

/**
 * One-shot read + clear. Called from AIPanel.oncreate on the new instance.
 * Returns null if no snapshot is pending.
 */
export function consumeTransientState(): TransientState | null {
  const snapshot = pendingSnapshot;
  pendingSnapshot = null;
  return snapshot;
}

/**
 * Clear any pending snapshot without consuming it. Called on trace unload
 * to prevent cross-trace leakage — the new trace's AIPanel should never
 * inherit the previous trace's input draft or SSE cursor.
 */
export function resetTransientState(): void {
  pendingSnapshot = null;
}

// ── Atomic mode switch helper ───────────────────────────────────────────

/**
 * Atomically capture transient state and switch floating window mode.
 * This is the public entry point for Pop Out / Dock Back buttons.
 *
 * Capture must happen *before* updateFloatingState() because the state
 * change synchronously triggers the floating window portal to render a
 * new AIPanel, which immediately calls consumeTransientState(). If we
 * captured after, the snapshot would be empty on the new instance's mount.
 */
export function switchFloatingMode(newMode: FloatingMode): void {
  captureTransientState();
  // Before entering floating mode, clamp the saved geometry against the
  // current viewport. Otherwise a position saved in a different viewport
  // (multi-monitor handoff, resized browser) could land the popup partially
  // or fully off-screen on first render (Codex round-2 HIGH).
  if (newMode === 'floating') {
    clampFloatingGeometryToViewport();
  }
  // Clamp sidebar width to viewport ratio on entry — a width saved on a
  // 4K monitor would overflow the sidebar on a smaller viewport otherwise.
  if (newMode === 'sidebar') {
    const layout = getFloatingState().sidebar.layout;
    if (layout === 'bottom') {
      clampSidebarHeight();
    } else {
      clampSidebarWidth();
    }
  }
  updateFloatingState({mode: newMode});
}
