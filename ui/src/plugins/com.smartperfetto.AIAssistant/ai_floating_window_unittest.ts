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
import {updateFloatingState} from './ai_floating_state';
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
});
