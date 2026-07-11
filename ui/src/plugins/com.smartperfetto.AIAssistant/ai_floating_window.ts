// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * AI Floating Window — body-level portal that hosts the AIPanel as a
 * draggable, resizable popup window.
 *
 * Why a body-level mount instead of CSS positioning inside the tab:
 * Perfetto's tab system re-renders tab content on each redraw; the AI
 * Assistant tab (see index.ts) swaps in a placeholder when mode is
 * 'floating' so only one AIPanel instance exists at any time. If the
 * AIPanel lived inside the tab DOM, tab switches would unmount it
 * along with the floating window. By living at document.body level,
 * the popup persists across all tab switches.
 *
 * Why m.mount (not m.render):
 * AIPanel's SSE event handlers call m.redraw() to refresh their view,
 * but m.redraw() only refreshes trees registered via m.mount. An
 * earlier version of this file used m.render(hostDiv, ...) which does
 * NOT participate in auto-redraw, so the floating AIPanel would freeze
 * on its last view() output during an active analysis — state.messages
 * kept receiving SSE events but the DOM only refreshed on drag / resize
 * / mode-switch. Mounting a FloatingRoot component via m.mount pulls
 * the floating tree into Mithril's global redraw system so SSE events
 * inside AIPanel trigger a repaint here too.
 *
 * State preservation across mode switches:
 * The AIPanel auto-restores recent sessions (<30min) on mount via
 * sessionManager. So when we unmount the tab AIPanel and mount a new
 * floating AIPanel, the chat history is preserved automatically. We
 * still call flushSessionSave() before mode switches to make sure the
 * very latest state is on disk.
 */

import m from 'mithril';
import {isTimelineRouteActive} from '../../frontend/timeline_route';
import {Trace} from '../../public/trace';
import {Icon} from '../../widgets/icon';
import {AIPanel} from './ai_panel';
import {
  applyFloatingSnapLayout,
  clamp,
  clampFloatingGeometryToViewport,
  clampSidebarHeight,
  clampSidebarWidth,
  FLOATING_SNAP_LAYOUTS,
  FloatingState,
  FLOATING_MIN_HEIGHT,
  FLOATING_MIN_WIDTH,
  getEffectiveSidebarHeight,
  getEffectiveSidebarWidth,
  getFloatingState,
  resetFloatingGeometry,
  SNAP_MARGIN,
  subscribeFloatingState,
  updateFloatingState,
} from './ai_floating_state';
import {SidebarPanel} from './ai_sidebar_panel';
import {switchFloatingMode} from './ai_transient_state';
import {isAIAnalysisIdentityLocked} from './ai_shared_state';
import {TracePairWorkspace} from './trace_pair_workspace';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';

// ── Layout constants ────────────────────────────────────────────────────

const HOST_DIV_ID = 'smartperfetto-floating-window-host';
const UI_MAIN_SELECTOR = '.pf-ui-main';

const TITLEBAR_HEIGHT = 36;
const RESIZE_HANDLE_SIZE = 18;
/** Min horizontal reveal of the window when dragged off-screen. */
const DRAG_MIN_VISIBLE_X = 100;
/** Right-side margin the title bar must stay within to remain grabbable. */
const DRAG_TITLEBAR_REACH = 80;
/** Viewport-edge margin applied to max size. */
const VIEWPORT_MARGIN = 24;
// Perfetto popups (including the Timeline Sync statusbar popup) render in
// `.pf-popup-portal` at z-index 10. Keep the floating AI host one layer below
// so clicking Timeline Sync always places its popup above this window.
const FLOATING_WINDOW_Z_INDEX = 9;

const BTN_BG_IDLE = 'rgba(255,255,255,0.12)';
const BTN_BG_HOVER = 'rgba(255,255,255,0.22)';

/**
 * Resting-state drop shadow for the floating window. Reused by the
 * `locateFloatingWindow()` scale-pulse animation so its first and last
 * keyframes blend back into the window's normal shadow seamlessly.
 */
const WINDOW_BASE_SHADOW =
  '0 12px 40px rgba(0, 0, 0, 0.35), 0 0 0 1px rgba(0, 0, 0, 0.08)';

// ── Styles ──────────────────────────────────────────────────────────────

const STYLES = {
  window: `
    position: fixed;
    background: var(--pf-color-background, #ffffff);
    box-shadow: ${WINDOW_BASE_SHADOW};
    border-radius: 10px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    z-index: ${FLOATING_WINDOW_Z_INDEX};
    font-family: 'Roboto', sans-serif;
  `,
  // Title bar uses Perfetto's sidebar surface color (deep slate blue) so the
  // floating window reads as part of Perfetto chrome rather than a third-party
  // overlay. Fallback hex matches theme_provider.scss --pf-sidebar-surface.
  titlebar: `
    background: var(--pf-sidebar-surface, #262f3c);
    color: var(--pf-sidebar-on-surface, #c8c8c8);
    padding: 0 12px;
    height: ${TITLEBAR_HEIGHT}px;
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: grab;
    user-select: none;
    flex-shrink: 0;
  `,
  titleIcon: `
    font-size: 18px;
    line-height: 1;
  `,
  titleText: `
    font-size: 13px;
    font-weight: 500;
    flex: 1;
    letter-spacing: 0.2px;
  `,
  iconBtn: `
    background: ${BTN_BG_IDLE};
    color: var(--pf-sidebar-on-surface, #c8c8c8);
    border: none;
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    transition: background 0.15s;
  `,
  content: `
    flex: 1;
    overflow: hidden;
    position: relative;
    background: var(--pf-color-background, #ffffff);
  `,
  resizeHandle: `
    position: absolute;
    bottom: 0;
    right: 0;
    width: ${RESIZE_HANDLE_SIZE}px;
    height: ${RESIZE_HANDLE_SIZE}px;
    cursor: nwse-resize;
    background: linear-gradient(135deg, transparent 50%, var(--pf-color-text-muted, #75797c) 50%, var(--pf-color-text-muted, #75797c) 70%, transparent 70%);
    z-index: 1;
  `,
  // Backdrop is intentionally absent — popup is non-modal so the user
  // can keep interacting with the trace timeline behind it.
} as const;

// ── Drag / resize gesture state ─────────────────────────────────────────

interface DragGesture {
  type: 'drag' | 'resize';
  startMouseX: number;
  startMouseY: number;
  startPosX: number;
  startPosY: number;
  startWidth: number;
  startHeight: number;
}

let activeGesture: DragGesture | null = null;

/**
 * Module-level callback to dismiss the snap layout menu when a drag gesture
 * starts. startGesture() calls stopPropagation() which prevents the window's
 * onclick dismiss handler from firing, so without this the menu stays orphaned
 * during and after drag. The FloatingWindow component registers this.
 */
let dismissLayoutMenu: (() => void) | null = null;

/**
 * Clamp a candidate position so the window stays grabbable within the
 * current viewport. `width` is the window width (needed because we allow
 * the window to hang off the left edge as long as DRAG_MIN_VISIBLE_X
 * pixels remain visible on the right of the title bar).
 */
function clampPosition(
  x: number,
  y: number,
  width: number,
): {x: number; y: number} {
  return {
    x: clamp(
      x,
      -width + DRAG_MIN_VISIBLE_X,
      window.innerWidth - DRAG_TITLEBAR_REACH,
    ),
    y: clamp(y, 0, window.innerHeight - TITLEBAR_HEIGHT),
  };
}

/** Clamp a candidate size to the current viewport (minus margin). */
function clampSize(
  width: number,
  height: number,
): {width: number; height: number} {
  return {
    width: clamp(
      width,
      FLOATING_MIN_WIDTH,
      window.innerWidth - VIEWPORT_MARGIN,
    ),
    height: clamp(
      height,
      FLOATING_MIN_HEIGHT,
      window.innerHeight - VIEWPORT_MARGIN,
    ),
  };
}

function onGestureMove(e: MouseEvent): void {
  if (!activeGesture) return;
  const dx = e.clientX - activeGesture.startMouseX;
  const dy = e.clientY - activeGesture.startMouseY;

  if (activeGesture.type === 'drag') {
    updateFloatingState({
      position: clampPosition(
        activeGesture.startPosX + dx,
        activeGesture.startPosY + dy,
        activeGesture.startWidth,
      ),
    });
  } else {
    updateFloatingState({
      size: clampSize(
        activeGesture.startWidth + dx,
        activeGesture.startHeight + dy,
      ),
    });
  }
}

function onVisibilityChange(): void {
  // If the tab becomes hidden mid-gesture (alt-tab, switch tab), treat it
  // as a gesture cancellation. Otherwise `activeGesture` sticks around
  // and the popup keeps tracking on the next mousedown anywhere.
  if (document.hidden && activeGesture !== null) {
    onGestureEnd();
  }
}

function onGestureEnd(): void {
  activeGesture = null;
  document.removeEventListener('mousemove', onGestureMove);
  document.removeEventListener('mouseup', onGestureEnd);
  // blur fires when the browser window loses focus (alt-tab, clicking
  // another app); visibilitychange fires on background tab. Both are
  // ways the user can release the mouse without us seeing mouseup.
  window.removeEventListener('blur', onGestureEnd);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.body.style.userSelect = '';
}

function startGesture(type: 'drag' | 'resize', e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  // Close the snap layout menu if open — drag on titlebar while menu is
  // open would leave it orphaned because stopPropagation prevents the
  // window's onclick dismiss handler from firing.
  if (dismissLayoutMenu) dismissLayoutMenu();
  // Defensive: if a previous gesture leaked (shouldn't happen but be safe),
  // tear it down before starting a new one.
  if (activeGesture !== null) {
    onGestureEnd();
  }
  const s = getFloatingState();
  activeGesture = {
    type,
    startMouseX: e.clientX,
    startMouseY: e.clientY,
    startPosX: s.position.x,
    startPosY: s.position.y,
    startWidth: s.size.width,
    startHeight: s.size.height,
  };
  document.addEventListener('mousemove', onGestureMove);
  document.addEventListener('mouseup', onGestureEnd);
  window.addEventListener('blur', onGestureEnd);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.body.style.userSelect = 'none';
}

// ── Layout dropdown styles ──────────────────────────────────────────────

/**
 * Shared base for both idle and hover variants of a menu item. The two
 * variants differ only in `background` + `color`, so we compose them
 * from this base rather than duplicating the full rule set.
 */
const LAYOUT_MENU_ITEM_BASE = `
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
`;

const LAYOUT_MENU_STYLES = {
  menu: `
    position: absolute;
    top: ${TITLEBAR_HEIGHT + 4}px;
    right: 8px;
    background: var(--pf-color-background, #ffffff);
    border-radius: 8px;
    box-shadow: 0 8px 24px var(--pf-color-box-shadow, rgba(0, 0, 0, 0.2)), 0 0 0 1px var(--pf-color-border, rgba(0, 0, 0, 0.08));
    padding: 6px;
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 4px;
    min-width: 260px;
    z-index: 1;
  `,
  menuItem: `
    ${LAYOUT_MENU_ITEM_BASE}
    background: transparent;
    color: var(--pf-color-text, #333333);
    transition: background 0.1s;
  `,
  menuItemHover: `
    ${LAYOUT_MENU_ITEM_BASE}
    background: var(--pf-color-background-secondary, #edf0f1);
    color: var(--pf-color-primary, #3d5688);
  `,
} as const;

// ── Floating window component ───────────────────────────────────────────

interface FloatingWindowAttrs {
  trace: Trace;
  tracePairWorkspaceController: TracePairWorkspaceController;
}

class FloatingWindow implements m.ClassComponent<FloatingWindowAttrs> {
  private showLayoutMenu = false;

  oncreate() {
    // Register module-level dismiss callback so startGesture() can close
    // the snap menu even though it calls stopPropagation().
    dismissLayoutMenu = () => {
      this.showLayoutMenu = false;
    };
  }

  onremove() {
    if (dismissLayoutMenu) dismissLayoutMenu = null;
  }

  view({attrs}: m.Vnode<FloatingWindowAttrs>): m.Children {
    const s = getFloatingState();
    const identityLocked = isAIAnalysisIdentityLocked();
    return m(
      'div',
      {
        'data-ai-floating-window': 'true',
        'style': `${STYLES.window}
        left: ${s.position.x}px;
        top: ${s.position.y}px;
        width: ${s.size.width}px;
        height: ${s.size.height}px;
      `,
        // Click-away: close the layout menu when user clicks anywhere
        // inside the window that isn't the menu or its trigger.
        'onclick': (e: MouseEvent) => {
          if (!this.showLayoutMenu) return;
          const target = e.target as HTMLElement;
          if (
            target.closest('[data-layout-menu]') ||
            target.closest('[data-layout-trigger]')
          )
            return;
          this.showLayoutMenu = false;
        },
      },
      [
        // ── Title bar (drag handle) ──
        m(
          'div',
          {
            style: STYLES.titlebar,
            onmousedown: (e: MouseEvent) => {
              // Ignore mousedown on buttons inside the title bar
              if ((e.target as HTMLElement).closest('button')) return;
              startGesture('drag', e);
            },
          },
          [
            m('span', {style: STYLES.titleIcon}, '\u{1F916}'),
            m('span', {style: STYLES.titleText}, 'AI Assistant — 浮动窗口'),
            // Layout dropdown trigger — Windows Snap Assist style presets.
            m(
              'button',
              {
                'data-layout-trigger': 'true',
                'style': STYLES.iconBtn,
                'title': '预设布局（左半屏 / 右半屏 / 最大化等）',
                'onclick': () => {
                  this.showLayoutMenu = !this.showLayoutMenu;
                },
                'onmouseover': (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_HOVER;
                },
                'onmouseout': (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_IDLE;
                },
              },
              [m(Icon, {icon: 'dashboard', style: 'font-size: 14px'})],
            ),
            // Reset geometry — recovery hatch if user somehow lost the window.
            m(
              'button',
              {
                style: STYLES.iconBtn,
                title: '重置位置和大小（恢复默认）',
                onclick: () => resetFloatingGeometry(),
                onmouseover: (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_HOVER;
                },
                onmouseout: (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_IDLE;
                },
              },
              [m(Icon, {icon: 'restart_alt', style: 'font-size: 14px'})],
            ),
            m(
              'button',
              {
                style: STYLES.iconBtn,
                title: identityLocked
                  ? '分析运行中，完成或停止后可切换挂载位置'
                  : '收回到 AI Dock',
                onclick: identityLocked
                  ? undefined
                  : () => switchFloatingMode('sidebar'),
                disabled: identityLocked,
                onmouseover: (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_HOVER;
                },
                onmouseout: (e: MouseEvent) => {
                  (e.currentTarget as HTMLElement).style.background =
                    BTN_BG_IDLE;
                },
              },
              [
                m(Icon, {icon: 'close_fullscreen', style: 'font-size: 14px'}),
                m('span', 'Dock'),
              ],
            ),
          ],
        ),

        // ── Layout dropdown menu ──
        this.showLayoutMenu
          ? m(
              'div',
              {
                'data-layout-menu': 'true',
                'style': LAYOUT_MENU_STYLES.menu,
              },
              FLOATING_SNAP_LAYOUTS.map((opt) =>
                m(
                  'button',
                  {
                    key: opt.id,
                    style: LAYOUT_MENU_STYLES.menuItem,
                    title: opt.tooltip,
                    onclick: () => {
                      applyFloatingSnapLayout(opt.id);
                      this.showLayoutMenu = false;
                    },
                    onmouseover: (e: MouseEvent) => {
                      (e.currentTarget as HTMLElement).style.cssText =
                        LAYOUT_MENU_STYLES.menuItemHover;
                    },
                    onmouseout: (e: MouseEvent) => {
                      (e.currentTarget as HTMLElement).style.cssText =
                        LAYOUT_MENU_STYLES.menuItem;
                    },
                  },
                  [
                    m(Icon, {
                      icon: opt.icon,
                      style:
                        'font-size: 16px; color: var(--pf-color-text-muted, #75797c);',
                    }),
                    m('span', opt.label),
                  ],
                ),
              ),
            )
          : null,

        // ── Content: AIPanel ──
        m(
          'div',
          {style: STYLES.content},
          m(AIPanel, {
            engine: attrs.trace.engine,
            trace: attrs.trace,
            tracePairWorkspaceController: attrs.tracePairWorkspaceController,
          }),
        ),

        // ── Resize handle (bottom-right) ──
        m('div', {
          style: STYLES.resizeHandle,
          onmousedown: (e: MouseEvent) => startGesture('resize', e),
          title: '拖动调整大小',
        }),
      ],
    );
  }
}

// ── Setup / dispose ─────────────────────────────────────────────────────

export interface FloatingWindowHandle {
  dispose: () => void;
}

/**
 * Strong "locate" action — guarantees the user can find the floating
 * window even if it's drifted off-screen or they're looking at the
 * wrong corner of a multi-monitor setup.
 *
 * Three things happen in order:
 *   1. Clamp geometry to viewport. If the saved position was from a
 *      different viewport (multi-monitor handoff), this pulls it back.
 *   2. If the window would still be near an edge (<10% visible), center
 *      it in the viewport so the user can't miss it.
 *   3. Run a noticeable scale-pulse + glow animation on the window.
 *
 * Replaces the earlier flashFloatingWindow() which only did step 3 —
 * that was too subtle to cover "user can't see the window" cases.
 * No-op if the floating window isn't currently mounted.
 */
export function locateFloatingWindow(): void {
  // Step 1: force-clamp to current viewport.
  clampFloatingGeometryToViewport();

  // Step 2: if the window is still hugging an edge (common when the
  // saved position was clipped by a smaller viewport), center it.
  const s = getFloatingState();
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const visibleLeft = Math.max(0, s.position.x);
  const visibleRight = Math.min(vw, s.position.x + s.size.width);
  const visibleWidth = Math.max(0, visibleRight - visibleLeft);
  if (visibleWidth < s.size.width * 0.9) {
    updateFloatingState({
      position: {
        x: Math.max(SNAP_MARGIN, Math.floor((vw - s.size.width) / 2)),
        y: Math.max(SNAP_MARGIN, Math.floor((vh - s.size.height) / 2)),
      },
    });
  }

  // Step 3: strong animation — scale pulse + glow. Much more noticeable
  // than the earlier subtle box-shadow-only flash.
  const host = document.getElementById(HOST_DIV_ID);
  if (!host) return;
  const windowEl = host.querySelector<HTMLElement>('[data-ai-floating-window]');
  if (!windowEl) return;
  // Pulse uses Perfetto primary slate-blue (rgb 61,86,136 = #3d5688) so the
  // attention animation matches the rest of Perfetto chrome instead of
  // flashing in google-blue. Keyframes are inside Web Animations API strings
  // so CSS vars are not resolved here — the rgba literal is intentional.
  windowEl.animate?.(
    [
      {transform: 'scale(1)', boxShadow: WINDOW_BASE_SHADOW},
      {
        transform: 'scale(1.04)',
        boxShadow:
          '0 20px 60px rgba(61, 86, 136, 0.55), 0 0 0 4px rgba(61, 86, 136, 0.9)',
      },
      {
        transform: 'scale(1)',
        boxShadow:
          '0 12px 40px rgba(61, 86, 136, 0.35), 0 0 0 2px rgba(61, 86, 136, 0.5)',
      },
      {
        transform: 'scale(1.02)',
        boxShadow:
          '0 16px 50px rgba(61, 86, 136, 0.45), 0 0 0 3px rgba(61, 86, 136, 0.7)',
      },
      {transform: 'scale(1)', boxShadow: WINDOW_BASE_SHADOW},
    ],
    {duration: 1200, easing: 'ease-in-out'},
  );
}

function createHostDiv(): HTMLDivElement {
  const div = document.createElement('div');
  div.id = HOST_DIV_ID;
  getHostParent().appendChild(div);
  return div;
}

/**
 * Perfetto's fullscreen modal is rendered inside `.pf-ui-main`, whose CSS uses
 * `isolation: isolate`. Mount the SmartPerfetto host under that stable root
 * instead of directly under `body`, so the floating window can remain visible
 * while still sorting below in-app popups and modals by z-index.
 */
function getHostParent(): HTMLElement {
  const uiMain = document.querySelector(UI_MAIN_SELECTOR);
  return uiMain instanceof HTMLElement ? uiMain : document.body;
}

function ensureHostParent(hostDiv: HTMLElement): void {
  const hostParent = getHostParent();
  if (hostDiv.parentElement !== hostParent) {
    hostParent.appendChild(hostDiv);
  }
}

// ── Dock CSS variables (sidebar/bottom margin push) ────────────────────
// The core layout rule `.pf-ui-main__page-container { margin-right:
// var(--pf-right-rail-width, 0px) }` responds to this variable. Setting it
// causes only the page area to shrink — topbar and statusbar stay full-width.

const RIGHT_RAIL_VAR = '--pf-right-rail-width';
const BOTTOM_RAIL_VAR = '--pf-bottom-rail-height';
const STATUSBAR_HEIGHT_VAR = '--pf-statusbar-height';

function getStatusbarHeight(): number {
  const statusbar = document.querySelector('.pf-statusbar');
  return statusbar instanceof HTMLElement
    ? Math.ceil(statusbar.getBoundingClientRect().height)
    : 0;
}

function syncDockSpace(
  tracePairWorkspaceController: TracePairWorkspaceController,
): void {
  const s = getFloatingState();
  const timelineActive = isTimelineRouteActive();
  const sidebarVisible = timelineActive && s.mode === 'sidebar';
  const workspaceVisible =
    timelineActive && tracePairWorkspaceController.getState().open;

  if (sidebarVisible || workspaceVisible) {
    document.documentElement.style.setProperty(
      STATUSBAR_HEIGHT_VAR,
      `${getStatusbarHeight()}px`,
    );
  } else {
    document.documentElement.style.removeProperty(STATUSBAR_HEIGHT_VAR);
  }

  if (sidebarVisible) {
    document.documentElement.style.setProperty(
      RIGHT_RAIL_VAR,
      `${getEffectiveSidebarWidth()}px`,
    );
    document.documentElement.style.setProperty(
      BOTTOM_RAIL_VAR,
      `${getEffectiveSidebarHeight()}px`,
    );
  } else {
    document.documentElement.style.removeProperty(RIGHT_RAIL_VAR);
    document.documentElement.style.removeProperty(BOTTOM_RAIL_VAR);
  }
}

function clearDockSpace(): void {
  document.documentElement.style.removeProperty(RIGHT_RAIL_VAR);
  document.documentElement.style.removeProperty(BOTTOM_RAIL_VAR);
  document.documentElement.style.removeProperty(STATUSBAR_HEIGHT_VAR);
}

export function setupFloatingWindow(
  trace: Trace,
  tracePairWorkspaceController: TracePairWorkspaceController,
): FloatingWindowHandle {
  // Reuse an existing host if a previous trace left one behind (defensive),
  // otherwise create a fresh div. Keep it under `.pf-ui-main` so Perfetto
  // popups/modals and the SmartPerfetto host share one stacking context.
  const hostDiv: HTMLElement =
    document.getElementById(HOST_DIV_ID) ?? createHostDiv();
  ensureHostParent(hostDiv);
  // Always start from a clean slate — m.mount(el, null) is the official
  // unmount path and also detaches any prior auto-redraw subscription.
  m.mount(hostDiv, null);

  const FloatingRoot: m.Component = {
    view: () => {
      if (!isTimelineRouteActive()) return null;
      const mode = getFloatingState().mode;
      const assistantSurface =
        mode === 'floating'
          ? m(FloatingWindow, {trace, tracePairWorkspaceController})
          : mode === 'sidebar'
            ? m(SidebarPanel, {trace, tracePairWorkspaceController})
            : null;
      return m.fragment({}, [
        m(TracePairWorkspace, {controller: tracePairWorkspaceController}),
        assistantSurface,
      ]);
    },
  };
  m.mount(hostDiv, FloatingRoot);

  // Subscribe floating state changes → schedule a redraw AND sync the
  // right-rail CSS variable so the page container makes room for the
  // sidebar. Mithril 2.x already batches multiple m.redraw() calls within
  // a frame via requestAnimationFrame, so mousemove-driven
  // updateFloatingState bursts from drag/resize gestures collapse to one
  // redraw per frame.
  const unsubscribeState = subscribeFloatingState(() => {
    syncDockSpace(tracePairWorkspaceController);
    m.redraw();
  });
  const unsubscribeTracePair = tracePairWorkspaceController.subscribe(() => {
    syncDockSpace(tracePairWorkspaceController);
    m.redraw();
  });
  // Run once on setup so the CSS variable is correct for the initial mode.
  syncDockSpace(tracePairWorkspaceController);

  // Re-render when the viewport resizes — clamp current geometry in case
  // the window is now partially or fully off-screen, or sidebar is too wide.
  const onResize = (): void => {
    syncDockSpace(tracePairWorkspaceController);
    const s: FloatingState = getFloatingState();
    if (s.mode === 'floating') {
      const size = clampSize(s.size.width, s.size.height);
      updateFloatingState({
        position: clampPosition(s.position.x, s.position.y, size.width),
        size,
      });
    } else if (s.mode === 'sidebar') {
      if (s.sidebar.layout === 'bottom') {
        clampSidebarHeight();
      } else {
        clampSidebarWidth();
      }
    }
  };
  window.addEventListener('resize', onResize);
  const onRouteChange = (): void => {
    syncDockSpace(tracePairWorkspaceController);
    m.redraw();
  };
  window.addEventListener('hashchange', onRouteChange);

  // Deliberately no Esc shortcut. We explored binding Esc on document,
  // but Perfetto has many widgets that listen for Escape on document
  // without stopPropagation (popup, menu, nodegraph, …) — any approach
  // short of a true modal window ends up with double-dismiss edge cases.
  // Scoping to hostDiv.contains(target) fixes the outer-widget conflict
  // but then the AIPanel auto-focuses its textarea on mount, and the
  // textarea exemption (needed so Esc-while-typing cancels typing,
  // not the window) makes Esc a no-op until the user clicks something
  // else inside the window. See Codex review rounds 3-5.
  //
  // The title-bar "收回" button and the tab-placeholder dock button are
  // always visible and always work, so a keyboard shortcut is a net
  // negative here.

  // No explicit initial render needed — m.mount() triggered FloatingRoot.view()
  // above, which reads the current floating mode.

  return {
    dispose: () => {
      unsubscribeState();
      unsubscribeTracePair();
      window.removeEventListener('resize', onResize);
      window.removeEventListener('hashchange', onRouteChange);
      // Tear down any in-flight drag/resize gesture — if the trace unloads
      // mid-drag, the document-level mousemove/mouseup listeners would
      // otherwise leak into the next trace session (Codex MEDIUM 2).
      if (activeGesture !== null) {
        onGestureEnd();
      }
      // Release the right-rail CSS variable so the page container returns
      // to full width. Must happen before mode reset to avoid a flash.
      clearDockSpace();
      // Force mode back to tab so any pending render won't recreate UI
      updateFloatingState({mode: 'tab'});
      // m.mount(el, null) is Mithril's official unmount path — tears down
      // the FloatingRoot subscription registered above.
      m.mount(hostDiv, null);
      if (hostDiv.parentNode) {
        hostDiv.parentNode.removeChild(hostDiv);
      }
    },
  };
}
