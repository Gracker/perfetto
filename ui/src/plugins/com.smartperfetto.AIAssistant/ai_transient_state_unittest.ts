// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Unit tests for ai_transient_state.ts
 *
 * Coverage:
 *   - Saver registration / unregistration with exact-ref check
 *   - captureTransientState calls the currently-registered saver
 *   - consumeTransientState is one-shot (clears pending)
 *   - resetTransientState clears without consuming
 *   - switchFloatingMode captures BEFORE updating mode
 *   - switchFloatingMode('floating') triggers viewport clamp
 *   - Snapshot hand-off pattern: old instance captures, new instance consumes
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';

import {
  TransientState,
  captureTransientState,
  consumeTransientState,
  registerTransientSaver,
  resetTransientState,
  switchFloatingMode,
  toggleSidebarCollapsedWithTransientState,
  unregisterTransientSaver,
} from './ai_transient_state';
import {
  getFloatingState,
  updateFloatingState,
  subscribeFloatingState,
} from './ai_floating_state';
import {createStreamingAnswerState, createStreamingFlowState} from './types';
import {setViewport} from './test_helpers';
import {resetAISharedState, updateAISharedState} from './ai_shared_state';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Build a minimal TransientState snapshot for tests. */
function makeSnapshot(overrides: Partial<TransientState> = {}): TransientState {
  return {
    inputDraft: '',
    collapsedTables: [],
    historyIndex: -1,
    activeAnalysis: null,
    ...overrides,
  };
}

beforeEach(() => {
  // Start each test from a clean slate: no pending snapshot, no active saver.
  resetTransientState();
  resetAISharedState();
  // Register a no-op unregister to drop any active saver via exact-ref trick:
  // we just clear by registering then unregistering our own throwaway.
  const dummy = () => makeSnapshot();
  registerTransientSaver(dummy);
  unregisterTransientSaver(dummy);
  // Reset floating state
  setViewport(1920, 1080);
  updateFloatingState({
    mode: 'tab',
    position: {x: 100, y: 100},
    size: {width: 640, height: 540},
  });
});

// ── Saver registration ─────────────────────────────────────────────────

describe('registerTransientSaver / unregisterTransientSaver', () => {
  it('captureTransientState calls the active saver and stores the result', () => {
    const saver = () => makeSnapshot({inputDraft: 'hello world'});
    registerTransientSaver(saver);
    captureTransientState();
    const snapshot = consumeTransientState();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.inputDraft).toBe('hello world');
  });

  it('captureTransientState is a no-op when no saver is registered', () => {
    // beforeEach already cleared — no saver active.
    captureTransientState();
    expect(consumeTransientState()).toBeNull();
  });

  it('unregisterTransientSaver only clears if the exact ref matches', () => {
    const saverA = () => makeSnapshot({inputDraft: 'A'});
    const saverB = () => makeSnapshot({inputDraft: 'B'});
    registerTransientSaver(saverA);
    // Registering B overwrites A
    registerTransientSaver(saverB);
    // Unregistering A should NOT clear B (exact-ref check)
    unregisterTransientSaver(saverA);
    captureTransientState();
    expect(consumeTransientState()?.inputDraft).toBe('B');
  });

  it('unregister with matching ref clears the saver', () => {
    const saver = () => makeSnapshot({inputDraft: 'C'});
    registerTransientSaver(saver);
    unregisterTransientSaver(saver);
    captureTransientState();
    expect(consumeTransientState()).toBeNull();
  });

  it('preserves a pending handoff when the next capture has no saver', () => {
    const saver = () => makeSnapshot({inputDraft: 'pending handoff'});
    registerTransientSaver(saver);
    captureTransientState();
    unregisterTransientSaver(saver);
    captureTransientState();

    expect(consumeTransientState()?.inputDraft).toBe('pending handoff');
  });

  it('swallows saver errors and stores null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerTransientSaver(() => {
      throw new Error('saver boom');
    });
    captureTransientState();
    expect(consumeTransientState()).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ── consumeTransientState is one-shot ───────────────────────────────────

describe('consumeTransientState()', () => {
  it('returns the pending snapshot and clears pending state', () => {
    registerTransientSaver(() => makeSnapshot({historyIndex: 5}));
    captureTransientState();
    expect(consumeTransientState()?.historyIndex).toBe(5);
    // Second consume returns null
    expect(consumeTransientState()).toBeNull();
  });

  it('returns null when no capture has happened', () => {
    expect(consumeTransientState()).toBeNull();
  });
});

// ── resetTransientState ─────────────────────────────────────────────────

describe('resetTransientState()', () => {
  it('clears pending snapshot without consuming it', () => {
    registerTransientSaver(() => makeSnapshot({inputDraft: 'will be cleared'}));
    captureTransientState();
    resetTransientState();
    expect(consumeTransientState()).toBeNull();
  });

  it('is safe to call when no snapshot is pending', () => {
    expect(() => resetTransientState()).not.toThrow();
  });
});

// ── switchFloatingMode ──────────────────────────────────────────────────

describe('switchFloatingMode()', () => {
  it('captures BEFORE updating mode so new instance sees the snapshot', () => {
    // Track the order: saver must fire before any state-change notification.
    // switchFloatingMode('floating') fires multiple state updates:
    //   1. saver captures
    //   2. clampFloatingGeometryToViewport may call updateFloatingState
    //   3. updateFloatingState({mode: 'floating'}) flips the mode
    // We only care that 'saver' is the first entry.
    const order: string[] = [];
    registerTransientSaver(() => {
      order.push('saver');
      return makeSnapshot({inputDraft: 'captured'});
    });
    const unsub = subscribeFloatingState(() => {
      order.push('state-change');
    });
    switchFloatingMode('floating');
    expect(order[0]).toBe('saver');
    // There must be at least one state change after the saver fires.
    expect(order.slice(1).every((e) => e === 'state-change')).toBe(true);
    // And the snapshot is ready to be consumed
    expect(consumeTransientState()?.inputDraft).toBe('captured');
    unsub();
  });

  it('updates mode to the target value', () => {
    switchFloatingMode('floating');
    expect(getFloatingState().mode).toBe('floating');
    switchFloatingMode('tab');
    expect(getFloatingState().mode).toBe('tab');
  });

  it('entering floating mode clamps geometry to viewport', () => {
    setViewport(800, 600);
    // Saved position is far off-screen, simulating a multi-monitor handoff
    updateFloatingState({
      position: {x: 10000, y: 10000},
      size: {width: 3000, height: 2000},
    });
    switchFloatingMode('floating');
    const s = getFloatingState();
    // After clamp: width=776, height=576, position constrained
    expect(s.size.width).toBe(776);
    expect(s.size.height).toBe(576);
    // x pulled back to vw - 80 (TITLEBAR_REACH) = 720
    expect(s.position.x).toBe(720);
  });

  it('leaving floating mode does NOT trigger clamp', () => {
    setViewport(1920, 1080);
    // Position intentionally off-screen
    updateFloatingState({
      mode: 'floating',
      position: {x: 5000, y: 5000},
      size: {width: 400, height: 320},
    });
    switchFloatingMode('tab');
    // x/y remain un-clamped because tab mode doesn't need clamping
    const s = getFloatingState();
    expect(s.position.x).toBe(5000);
    expect(s.position.y).toBe(5000);
  });

  it('carries an ActiveAnalysisSnapshot end-to-end', () => {
    const streamingFlow = createStreamingFlowState();
    const streamingAnswer = createStreamingAnswerState();
    registerTransientSaver(() => ({
      inputDraft: 'in-progress query',
      collapsedTables: ['msg-1', 'msg-5'],
      historyIndex: 3,
      activeAnalysis: {
        agentSessionId: 'sess-123',
        lastEventId: 42,
        agentRunId: 'run-1',
        agentRequestId: 'req-1',
        agentRunSequence: 2,
        loadingPhase: 'Analyzing scrolling performance',
        displayedSkillProgress: ['skill-a:step1', 'skill-b:step2'],
        completionHandled: false,
        collectedErrors: [],
        streamingFlow,
        streamingAnswer,
      },
    }));
    switchFloatingMode('floating');
    const s = consumeTransientState();
    expect(s).not.toBeNull();
    expect(s?.activeAnalysis?.agentSessionId).toBe('sess-123');
    expect(s?.activeAnalysis?.lastEventId).toBe(42);
    expect(s?.activeAnalysis?.displayedSkillProgress).toEqual([
      'skill-a:step1',
      'skill-b:step2',
    ]);
    expect(s?.collapsedTables).toEqual(['msg-1', 'msg-5']);
  });
});

describe('toggleSidebarCollapsedWithTransientState()', () => {
  it('keeps collapse and expand visual without snapshot handoff', () => {
    updateFloatingState({
      mode: 'sidebar',
      sidebar: {collapsed: false},
    });
    const saver = vi.fn(() => makeSnapshot({inputDraft: 'still running'}));
    registerTransientSaver(saver);

    toggleSidebarCollapsedWithTransientState();
    toggleSidebarCollapsedWithTransientState();

    expect(getFloatingState().sidebar.collapsed).toBe(false);
    expect(saver).not.toHaveBeenCalled();
    expect(consumeTransientState()).toBeNull();
    unregisterTransientSaver(saver);
  });

  it('defers mount-changing transitions while analysis owns the panel', () => {
    updateFloatingState({
      mode: 'sidebar',
      sidebar: {collapsed: false},
    });
    updateAISharedState({status: 'analyzing'});
    const saver = vi.fn(() => makeSnapshot());
    registerTransientSaver(saver);

    switchFloatingMode('tab');
    expect(getFloatingState().mode).toBe('sidebar');
    expect(getFloatingState().sidebar.collapsed).toBe(true);

    switchFloatingMode('floating');
    expect(getFloatingState().mode).toBe('sidebar');
    expect(saver).not.toHaveBeenCalled();
    unregisterTransientSaver(saver);
  });

  it('keeps a running floating owner mounted when Dock is requested', () => {
    updateFloatingState({mode: 'floating'});
    updateAISharedState({status: 'analyzing'});

    switchFloatingMode('sidebar');

    expect(getFloatingState().mode).toBe('floating');
  });
});

// ── Full handoff pattern (integration) ──────────────────────────────────

describe('full handoff pattern', () => {
  it('old saver is captured, new saver registered, old unregister is no-op', () => {
    // Old AIPanel registers its saver
    const oldSaverRef = () => makeSnapshot({inputDraft: 'from old instance'});
    registerTransientSaver(oldSaverRef);

    // User clicks Pop Out → switchFloatingMode calls captureTransientState
    switchFloatingMode('floating');

    // Simulate new AIPanel oncreate: registers its own saver, consumes snapshot
    const newSaverRef = () => makeSnapshot({inputDraft: 'from new instance'});
    registerTransientSaver(newSaverRef);
    const snapshot = consumeTransientState();
    expect(snapshot?.inputDraft).toBe('from old instance');

    // Simulate old AIPanel onremove (late unregister) — must not clear new saver
    unregisterTransientSaver(oldSaverRef);

    // New saver still works
    captureTransientState();
    expect(consumeTransientState()?.inputDraft).toBe('from new instance');
  });
});
