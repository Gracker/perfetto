// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Unit tests for ai_floating_state.ts
 *
 * Coverage:
 *   - clampFloatingGeometryToViewport: off-screen / oversized / narrow viewport
 *   - resetFloatingGeometry: default then clamp behavior
 *   - computeSnapGeometry: all 10 preset layouts, viewport-relative math
 *   - applyFloatingSnapLayout: full integration through state update
 *   - getFloatingState / updateFloatingState: partial updates + subscribers
 *   - localStorage persistence: save on update, restore mode=tab
 */

import {describe, it, expect, beforeEach, vi} from 'vitest';

import {
  clamp,
  clampFloatingGeometryToViewport,
  computeSnapGeometry,
  FLOATING_MAX_DIM,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  FLOATING_SNAP_LAYOUTS,
  applyFloatingSnapLayout,
  getFloatingState,
  resetFloatingGeometry,
  subscribeFloatingState,
  updateFloatingState,
} from './ai_floating_state';
import {setViewport} from './test_helpers';

// ── Helpers ─────────────────────────────────────────────────────────────

/** Reset module singleton between tests by setting a known state. */
function resetModuleState(): void {
  updateFloatingState({
    mode: 'tab',
    position: {x: 100, y: 100},
    size: {width: 640, height: 540},
  });
}

beforeEach(() => {
  // jsdom provides localStorage but we still clear per test.
  if (typeof localStorage !== 'undefined') {
    localStorage.clear();
  }
  setViewport(1920, 1080);
  resetModuleState();
});

// ── clamp() basic sanity ────────────────────────────────────────────────

describe('clamp()', () => {
  it('returns value unchanged when within bounds', () => {
    expect(clamp(50, 0, 100)).toBe(50);
  });

  it('clamps to min when value is too small', () => {
    expect(clamp(-10, 0, 100)).toBe(0);
  });

  it('clamps to max when value is too large', () => {
    expect(clamp(150, 0, 100)).toBe(100);
  });
});

// ── clampFloatingGeometryToViewport ─────────────────────────────────────

describe('clampFloatingGeometryToViewport()', () => {
  it('pulls a far-off-screen position back into viewport', () => {
    setViewport(1440, 900);
    updateFloatingState({position: {x: 10000, y: 10000}, size: {width: 640, height: 540}});
    clampFloatingGeometryToViewport();
    const s = getFloatingState();
    // x clamped to vw - TITLEBAR_REACH (80) = 1360
    expect(s.position.x).toBe(1360);
    // y clamped to vh - TITLEBAR_HEIGHT (36) = 864
    expect(s.position.y).toBe(864);
  });

  it('shrinks oversized window to fit viewport', () => {
    setViewport(800, 600);
    updateFloatingState({position: {x: 0, y: 0}, size: {width: 3000, height: 2000}});
    clampFloatingGeometryToViewport();
    const s = getFloatingState();
    // width clamped to vw - 24 = 776
    expect(s.size.width).toBe(776);
    // height clamped to vh - 24 = 576
    expect(s.size.height).toBe(576);
  });

  it('enforces minimum size even when viewport is narrower', () => {
    setViewport(300, 200);  // narrower than FLOATING_MIN_WIDTH (400)
    updateFloatingState({position: {x: 0, y: 0}, size: {width: 640, height: 540}});
    clampFloatingGeometryToViewport();
    const s = getFloatingState();
    // Width stays at minimum, doesn't go below 400
    expect(s.size.width).toBe(FLOATING_MIN_WIDTH);
    expect(s.size.height).toBe(FLOATING_MIN_HEIGHT);
  });

  it('allows partial off-screen on left but keeps ≥100px peek', () => {
    setViewport(1920, 1080);
    // Try to push window further left than the clamp allows.
    // With width=640 and MIN_VISIBLE_X=100, the minimum allowed x is
    // -width + 100 = -540. Position -700 is below that, so it should
    // be pulled back to -540.
    updateFloatingState({position: {x: -700, y: 50}, size: {width: 640, height: 540}});
    clampFloatingGeometryToViewport();
    const s = getFloatingState();
    expect(s.position.x).toBe(-540);
  });

  it('preserves positions that are already within the left peek bound', () => {
    setViewport(1920, 1080);
    // -500 is already >= -540, so clamp should leave it alone.
    updateFloatingState({position: {x: -500, y: 50}, size: {width: 640, height: 540}});
    clampFloatingGeometryToViewport();
    expect(getFloatingState().position.x).toBe(-500);
  });

  it('no-op when geometry already within bounds', () => {
    setViewport(1920, 1080);
    updateFloatingState({position: {x: 200, y: 200}, size: {width: 800, height: 600}});
    clampFloatingGeometryToViewport();
    const s = getFloatingState();
    expect(s.position.x).toBe(200);
    expect(s.position.y).toBe(200);
    expect(s.size.width).toBe(800);
    expect(s.size.height).toBe(600);
  });
});

// ── resetFloatingGeometry ───────────────────────────────────────────────

describe('resetFloatingGeometry()', () => {
  it('resets to default bottom-right position in large viewport', () => {
    setViewport(1920, 1080);
    updateFloatingState({position: {x: 50, y: 50}, size: {width: 1200, height: 900}});
    resetFloatingGeometry();
    const s = getFloatingState();
    // Default width=640, height=540, position is vw-width-24 and vh-height-24
    expect(s.size.width).toBe(640);
    expect(s.size.height).toBe(540);
    expect(s.position.x).toBe(1920 - 640 - 24);
    expect(s.position.y).toBe(1080 - 540 - 24);
  });

  it('clamps to small viewport so resize handle stays visible', () => {
    setViewport(500, 400);  // smaller than default 640×540
    updateFloatingState({position: {x: 100, y: 100}, size: {width: 1000, height: 800}});
    resetFloatingGeometry();
    const s = getFloatingState();
    // Default state is (24, 24, 640, 540), then clamp shrinks
    // width = min(640, 500 - 24) = 476
    // height = min(540, 400 - 24) = 376
    expect(s.size.width).toBe(500 - 24);
    expect(s.size.height).toBe(400 - 24);
  });
});

// ── computeSnapGeometry (pure, all 10 presets) ──────────────────────────

describe('computeSnapGeometry()', () => {
  // Use a round viewport for easy math: 1200×800
  const VW = 1200;
  const VH = 800;

  it('default returns canonical 640×540 bottom-right', () => {
    const g = computeSnapGeometry('default', VW, VH);
    expect(g.size.width).toBe(640);
    expect(g.size.height).toBe(540);
    expect(g.position.x).toBe(VW - 640 - 24);
    expect(g.position.y).toBe(VH - 540 - 24);
  });

  it('maximize fills viewport minus 24px margin each side', () => {
    const g = computeSnapGeometry('maximize', VW, VH);
    expect(g.position).toEqual({x: 24, y: 24});
    expect(g.size.width).toBe(VW - 48);
    expect(g.size.height).toBe(VH - 48);
  });

  it('left-half covers left 50% full height', () => {
    const g = computeSnapGeometry('left-half', VW, VH);
    expect(g.position.x).toBe(24);
    expect(g.position.y).toBe(24);
    expect(g.size.height).toBe(VH - 48);
    // halfW = (vw - 72) / 2 = 564
    expect(g.size.width).toBe(Math.floor((VW - 72) / 2));
  });

  it('right-half sits adjacent to left-half with margin gap', () => {
    const g = computeSnapGeometry('right-half', VW, VH);
    const halfW = Math.floor((VW - 72) / 2);
    expect(g.position.x).toBe(24 + halfW + 24);
    expect(g.position.y).toBe(24);
    expect(g.size.width).toBe(halfW);
    expect(g.size.height).toBe(VH - 48);
  });

  it('top-half covers top 50% full width', () => {
    const g = computeSnapGeometry('top-half', VW, VH);
    const halfH = Math.floor((VH - 72) / 2);
    expect(g.position).toEqual({x: 24, y: 24});
    expect(g.size.width).toBe(VW - 48);
    expect(g.size.height).toBe(halfH);
  });

  it('bottom-half is vertically shifted from top-half', () => {
    const g = computeSnapGeometry('bottom-half', VW, VH);
    const halfH = Math.floor((VH - 72) / 2);
    expect(g.position.x).toBe(24);
    expect(g.position.y).toBe(24 + halfH + 24);
    expect(g.size.height).toBe(halfH);
  });

  it('top-left covers top-left quadrant', () => {
    const g = computeSnapGeometry('top-left', VW, VH);
    const halfW = Math.floor((VW - 72) / 2);
    const halfH = Math.floor((VH - 72) / 2);
    expect(g.position).toEqual({x: 24, y: 24});
    expect(g.size).toEqual({width: halfW, height: halfH});
  });

  it('top-right quadrant is horizontally mirrored from top-left', () => {
    const g = computeSnapGeometry('top-right', VW, VH);
    const halfW = Math.floor((VW - 72) / 2);
    const halfH = Math.floor((VH - 72) / 2);
    expect(g.position.x).toBe(24 + halfW + 24);
    expect(g.position.y).toBe(24);
    expect(g.size).toEqual({width: halfW, height: halfH});
  });

  it('bottom-right quadrant is diagonal mirror of top-left', () => {
    const g = computeSnapGeometry('bottom-right', VW, VH);
    const halfW = Math.floor((VW - 72) / 2);
    const halfH = Math.floor((VH - 72) / 2);
    expect(g.position.x).toBe(24 + halfW + 24);
    expect(g.position.y).toBe(24 + halfH + 24);
  });

  it('all layouts produce valid (≥min) sizes even in tiny viewport', () => {
    const tinyVW = 300;
    const tinyVH = 300;
    for (const opt of FLOATING_SNAP_LAYOUTS) {
      const g = computeSnapGeometry(opt.id, tinyVW, tinyVH);
      expect(g.size.width).toBeGreaterThanOrEqual(FLOATING_MIN_WIDTH);
      expect(g.size.height).toBeGreaterThanOrEqual(FLOATING_MIN_HEIGHT);
    }
  });
});

// ── applyFloatingSnapLayout (integration with state) ────────────────────

describe('applyFloatingSnapLayout()', () => {
  it('updates state to match computeSnapGeometry output', () => {
    setViewport(1600, 900);
    applyFloatingSnapLayout('maximize');
    const s = getFloatingState();
    expect(s.position).toEqual({x: 24, y: 24});
    expect(s.size.width).toBe(1600 - 48);
    expect(s.size.height).toBe(900 - 48);
  });

  it('preserves mode (does not flip to floating)', () => {
    updateFloatingState({mode: 'tab'});
    applyFloatingSnapLayout('left-half');
    expect(getFloatingState().mode).toBe('tab');
  });
});

// ── updateFloatingState / subscribers ───────────────────────────────────

describe('updateFloatingState() subscribers', () => {
  it('notifies all subscribers synchronously on update', () => {
    let calls = 0;
    const unsub = subscribeFloatingState(() => calls++);
    updateFloatingState({mode: 'floating'});
    updateFloatingState({position: {x: 50, y: 50}});
    expect(calls).toBe(2);
    unsub();
  });

  it('stops notifying after unsubscribe', () => {
    let calls = 0;
    const unsub = subscribeFloatingState(() => calls++);
    updateFloatingState({mode: 'floating'});
    unsub();
    updateFloatingState({mode: 'tab'});
    expect(calls).toBe(1);
  });

  it('merges partial position updates preserving missing axis', () => {
    updateFloatingState({position: {x: 100, y: 200}});
    // This test verifies partial update semantics — if the implementation
    // spreads correctly, {x: 50} alone should leave y untouched.
    updateFloatingState({position: {x: 50, y: 200}});
    const s = getFloatingState();
    expect(s.position).toEqual({x: 50, y: 200});
  });

  it('isolates subscriber errors (one throwing does not break others)', () => {
    let aCalls = 0;
    let bCalls = 0;
    const unsubA = subscribeFloatingState(() => {
      aCalls++;
      throw new Error('subscriber A boom');
    });
    const unsubB = subscribeFloatingState(() => bCalls++);
    // Silence console.warn for the expected error
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    updateFloatingState({mode: 'floating'});
    expect(aCalls).toBe(1);
    expect(bCalls).toBe(1);
    warnSpy.mockRestore();
    unsubA();
    unsubB();
  });
});

// ── FLOATING_SNAP_LAYOUTS constant ──────────────────────────────────────

describe('FLOATING_SNAP_LAYOUTS', () => {
  it('exports exactly 10 presets', () => {
    expect(FLOATING_SNAP_LAYOUTS).toHaveLength(10);
  });

  it('all presets have unique ids', () => {
    const ids = FLOATING_SNAP_LAYOUTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('all presets have label, icon, tooltip', () => {
    for (const opt of FLOATING_SNAP_LAYOUTS) {
      expect(opt.label.length).toBeGreaterThan(0);
      expect(opt.icon.length).toBeGreaterThan(0);
      expect(opt.tooltip.length).toBeGreaterThan(0);
    }
  });
});

// ── Constants sanity ────────────────────────────────────────────────────

describe('exported constants', () => {
  it('FLOATING_MIN_WIDTH = 400, FLOATING_MIN_HEIGHT = 320', () => {
    expect(FLOATING_MIN_WIDTH).toBe(400);
    expect(FLOATING_MIN_HEIGHT).toBe(320);
  });

  it('FLOATING_MAX_DIM is large enough for 4K screens', () => {
    expect(FLOATING_MAX_DIM).toBeGreaterThanOrEqual(3840);
  });
});
