// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {raf} from '../../core/raf_scheduler';
import type {Trace} from '../../public/trace';
import {
  setupFloatingWindow,
  type FloatingWindowHandle,
} from './ai_floating_window';
import {getFloatingState, updateFloatingState} from './ai_floating_state';
import {toggleSidebarCollapsedWithTransientState} from './ai_transient_state';
import {setViewport} from './test_helpers';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';

const panelLifecycle = vi.hoisted(() => ({mounted: 0, removed: 0}));
vi.mock('./ai_panel', () => ({
  AIPanel: {
    oninit: () => {
      panelLifecycle.mounted++;
    },
    onremove: () => {
      panelLifecycle.removed++;
    },
    view: () => m('textarea', {'data-panel-probe': true}),
  },
}));

describe('AI surface portal', () => {
  let root: HTMLDivElement;
  let mainKey: number;
  let controller: TracePairWorkspaceController;
  let handle: FloatingWindowHandle | undefined;

  // Exercise Perfetto's patched m.mount/redraw, including application-first
  // redraw ordering. Mithril's original redraw.sync does not drive these mounts.
  function redraw(): Promise<void> {
    return new Promise((resolve) => raf.scheduleFullRedraw(resolve));
  }

  async function replaceMain(): Promise<void> {
    const previous = root.querySelector('.pf-ui-main');
    mainKey++;
    await redraw();
    expect(root.querySelector('.pf-ui-main')).not.toBe(previous);
    expect(previous?.isConnected).toBe(false);
  }

  beforeEach(() => {
    localStorage.clear();
    setViewport(1600, 900);
    window.location.hash = '#!/viewer';
    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    panelLifecycle.mounted = 0;
    panelLifecycle.removed = 0;
    mainKey = 0;
    controller = new TracePairWorkspaceController();
    updateFloatingState({
      mode: 'tab',
      sidebar: {layout: 'right', width: 400, collapsed: false},
    });
    root = document.createElement('div');
    document.body.appendChild(root);
    m.mount(root, {
      view: () => m('div', [m('main.pf-ui-main', {key: mainKey})]),
    });
    handle = setupFloatingWindow({} as Trace, controller);
  });

  afterEach(async () => {
    handle?.dispose();
    m.mount(root, null);
    root.remove();
    await redraw();
  });

  it.each(['sidebar', 'floating'] as const)(
    'preserves the mounted %s panel when the application replaces UiMain',
    async (mode) => {
      updateFloatingState({mode});
      await redraw();
      const host = document.getElementById('smartperfetto-floating-window-host');
      const panel = host?.querySelector<HTMLTextAreaElement>(
        '[data-panel-probe]',
      );
      expect(panel).toBeTruthy();
      panel!.value = 'unsent draft';

      await replaceMain();

      expect(host?.isConnected).toBe(true);
      expect(host?.parentElement).toBe(root.querySelector('.pf-ui-main'));
      expect(host?.querySelector('[data-panel-probe]')).toBe(panel);
      expect(panel?.value).toBe('unsent draft');
      expect(panelLifecycle).toEqual({mounted: 1, removed: 0});
      expect(
        document.documentElement.style.getPropertyValue('--pf-right-rail-width'),
      ).toBe(mode === 'sidebar' ? '400px' : '');
    },
  );

  it('can first open the sidebar after UiMain was replaced while in tab mode', async () => {
    await replaceMain();
    updateFloatingState({mode: 'sidebar'});
    await redraw();
    expect(
      root.querySelector('.ai-sidebar-expanded [data-panel-probe]'),
    ).not.toBeNull();
  });

  it('recovers on a hidden route before returning to the timeline', async () => {
    updateFloatingState({mode: 'sidebar'});
    await redraw();
    window.location.hash = '#!/settings';
    await replaceMain();
    const host = document.getElementById('smartperfetto-floating-window-host');
    expect(host?.parentElement).toBe(root.querySelector('.pf-ui-main'));
    expect(host?.querySelector('[data-panel-probe]')).toBeNull();
    window.location.hash = '#!/viewer';
    await redraw();
    expect(host?.querySelector('[data-panel-probe]')).not.toBeNull();
  });

  it('reconnects the dual-trace workspace without replacing its frame nodes or selection', async () => {
    controller.open({
      scope: {key: 'portal-test', backendUrl: 'http://127.0.0.1:3000'},
      currentTrace: {id: 'baseline', filename: 'baseline.pftrace'},
    });
    controller.setCatalog([{id: 'reference', filename: 'reference.pftrace'}]);
    controller.selectTrace({pane: 'second', traceId: 'reference'});
    await redraw();
    const frames = Array.from(root.querySelectorAll('iframe'));
    expect(frames).toHaveLength(2);
    const state = controller.getState();

    await replaceMain();

    const restoredFrames = Array.from(root.querySelectorAll('iframe'));
    expect(restoredFrames).toHaveLength(2);
    expect(restoredFrames[0]).toBe(frames[0]);
    expect(restoredFrames[1]).toBe(frames[1]);
    expect(controller.getState()).toBe(state);
  });

  it('does not reconnect a disposed portal on later redraws', async () => {
    updateFloatingState({mode: 'sidebar'});
    await redraw();
    const host = document.getElementById('smartperfetto-floating-window-host');
    handle!.dispose();
    handle = undefined;
    await replaceMain();

    expect(host?.isConnected).toBe(false);
    expect(
      document.getElementById('smartperfetto-floating-window-host'),
    ).toBeNull();
    expect(
      document.documentElement.style.getPropertyValue('--pf-right-rail-width'),
    ).toBe('');
    expect(panelLifecycle).toEqual({mounted: 1, removed: 1});
  });

  it('resizes and collapses the dock without remounting the composer', async () => {
    updateFloatingState({mode: 'sidebar'});
    await redraw();
    const panel = root.querySelector<HTMLTextAreaElement>('[data-panel-probe]')!;
    panel.value = 'draft stays here';
    const separator = root.querySelector<HTMLElement>('.ai-sidebar-resize-handle')!;
    separator.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowLeft', bubbles: true}));
    expect(getFloatingState().sidebar.width).toBe(416);
    separator.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true}));
    expect(getFloatingState().sidebar.width).toBe(1200);
    separator.dispatchEvent(new MouseEvent('dblclick', {bubbles: true}));
    expect(getFloatingState().sidebar.width).toBe(400);
    toggleSidebarCollapsedWithTransientState();
    await redraw();
    root.querySelector<HTMLButtonElement>('.ai-sidebar-collapsed')!.click();
    await redraw();
    expect(getFloatingState().sidebar.collapsed).toBe(false);
    expect(root.querySelector('[data-panel-probe]')).toBe(panel);
    expect(panel.value).toBe('draft stays here');
    expect(panelLifecycle).toEqual({mounted: 1, removed: 0});
  });

  it.each(['right', 'bottom'] as const)('commits the final %s pointer position and cleans up on blur', async (layout) => {
    updateFloatingState({mode: 'sidebar', sidebar: {layout, width: 400, height: 360}});
    await redraw();
    const separator = root.querySelector<HTMLElement>('.ai-sidebar-resize-handle')!;
    separator.setPointerCapture = vi.fn();
    separator.hasPointerCapture = vi.fn(() => true);
    separator.releasePointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number, pointerId = 7) => {
      const event = new MouseEvent(type, {clientX: x, clientY: y, bubbles: true, button: 0});
      Object.defineProperties(event, {pointerId: {value: pointerId}, isPrimary: {value: true}});
      return event;
    };
    separator.dispatchEvent(pointer('pointerdown', 900, 600));
    window.dispatchEvent(pointer('pointermove', 850, 550, 8));
    window.dispatchEvent(pointer('pointerup', 700, 500));
    expect(getFloatingState().sidebar.width).toBe(layout === 'right' ? 600 : 400);
    expect(getFloatingState().sidebar.height).toBe(layout === 'bottom' ? 460 : 360);
    separator.dispatchEvent(pointer('pointerdown', 700, 500));
    window.dispatchEvent(new Event('blur'));
    const state = getFloatingState();
    window.dispatchEvent(pointer('pointermove', 0, 0));
    expect(getFloatingState()).toBe(state);
    expect(document.body.style.userSelect).toBe('');
    expect(separator.releasePointerCapture).toHaveBeenCalledTimes(2);
  });


  it('resizes the floating left edge while keeping its right edge and draft fixed', async () => {
    updateFloatingState({mode: 'floating', position: {x: 500, y: 100}, size: {width: 640, height: 540}});
    await redraw();
    const panel = root.querySelector<HTMLTextAreaElement>('[data-panel-probe]')!;
    panel.value = 'floating draft';
    const edge = root.querySelector<HTMLElement>('.ai-floating-resize-edge--left')!;
    edge.setPointerCapture = vi.fn();
    edge.hasPointerCapture = vi.fn(() => true);
    edge.releasePointerCapture = vi.fn();
    const pointer = (type: string, clientX: number) => {
      const event = new MouseEvent(type, {clientX, clientY: 200, button: 0, bubbles: true});
      Object.defineProperties(event, {pointerId: {value: 1}, isPrimary: {value: true}});
      return event;
    };
    edge.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointerup', 300));
    expect(getFloatingState()).toMatchObject({position: {x: 300}, size: {width: 840}});
    expect(edge.releasePointerCapture).toHaveBeenCalledWith(1);
    await redraw();
    expect(root.querySelector('[data-panel-probe]')).toBe(panel);
    expect(panel.value).toBe('floating draft');
    edge.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    expect(getFloatingState()).toMatchObject({position: {x: 316}, size: {width: 824}});
  });

  it.each(['sidebar', 'floating'] as const)(
    'releases the %s pointer and restores body styles after cancellation or removal',
    async (mode) => {
      updateFloatingState({mode});
      await redraw();
      const selector = mode === 'sidebar'
        ? '.ai-sidebar-resize-handle'
        : '.ai-floating-resize-edge--right';
      const edge = root.querySelector<HTMLElement>(selector)!;
      edge.setPointerCapture = vi.fn();
      edge.hasPointerCapture = vi.fn(() => true);
      edge.releasePointerCapture = vi.fn();
      const pointer = (type: string, pointerId = 3) => {
        const event = new MouseEvent(type, {clientX: 800, clientY: 300, button: 0, bubbles: true});
        Object.defineProperties(event, {pointerId: {value: pointerId}, isPrimary: {value: true}});
        return event;
      };
      const userSelect = document.body.style.userSelect;
      const cursor = document.body.style.cursor;
      document.body.style.userSelect = 'text';
      document.body.style.cursor = 'crosshair';
      try {
        for (const reason of ['pointercancel', 'lostpointercapture']) {
          edge.dispatchEvent(pointer('pointerdown'));
          window.dispatchEvent(pointer('pointercancel', 99));
          edge.dispatchEvent(pointer('lostpointercapture', 99));
          expect(document.body.style.userSelect).toBe('none');
          if (reason === 'lostpointercapture') {
            edge.dispatchEvent(pointer(reason));
          } else {
            window.dispatchEvent(pointer(reason));
          }
          expect(document.body.style.userSelect).toBe('text');
          expect(document.body.style.cursor).toBe('crosshair');
          const settled = getFloatingState();
          window.dispatchEvent(pointer('pointermove'));
          expect(getFloatingState()).toBe(settled);
        }
        edge.dispatchEvent(pointer('pointerdown'));
        handle!.dispose();
        handle = undefined;
        expect(document.body.style.userSelect).toBe('text');
        expect(document.body.style.cursor).toBe('crosshair');
        expect(edge.releasePointerCapture).toHaveBeenCalledTimes(3);
      } finally {
        handle?.dispose();
        handle = undefined;
        document.body.style.userSelect = userSelect;
        document.body.style.cursor = cursor;
      }
    },
  );

});
