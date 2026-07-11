// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * AI Sidebar Panel — right-side docked panel for the AI Assistant.
 *
 * Renders inside the unified surface portal (ai_floating_window.ts) when
 * mode === 'sidebar'. Unlike the floating window, the sidebar does NOT
 * overlap the trace timeline — it uses a CSS variable (--pf-right-rail-width)
 * on the page container to push the main content left.
 *
 * Two visual states:
 *   - Expanded: titlebar + AIPanel + left-edge resize handle
 *   - Collapsed: 36px vertical strip with status icon + badge
 */

import m from 'mithril';
import {Trace} from '../../public/trace';
import {Icon} from '../../widgets/icon';
import {AIPanel} from './ai_panel';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {
  clamp,
  getFloatingState,
  SIDEBAR_MIN_HEIGHT,
  SIDEBAR_MIN_WIDTH,
  updateFloatingState,
} from './ai_floating_state';
import {getAISharedState} from './ai_shared_state';
import {toggleSidebarCollapsedWithTransientState} from './ai_transient_state';

// ── Constants ──────────────────────────────────────────────────────────

// ── Resize gesture ─────────────────────────────────────────────────────

let resizeActive = false;
let resizeAxis: 'x' | 'y' = 'x';
let resizeStartX = 0;
let resizeStartY = 0;
let resizeStartWidth = 0;
let resizeStartHeight = 0;
let rafId = 0;

/** Last mouse position during resize — committed synchronously on mouseup. */
let lastResizeClientX = 0;
let lastResizeClientY = 0;

function onResizeMove(e: MouseEvent): void {
  if (!resizeActive) return;
  lastResizeClientX = e.clientX;
  lastResizeClientY = e.clientY;
  // Cancel any pending rAF to avoid stacking updates (Codex #5).
  if (rafId) cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    if (resizeAxis === 'y') {
      // Dragging up (negative dy) → taller bottom dock.
      const dy = resizeStartY - e.clientY;
      const maxH = Math.floor(window.innerHeight * 0.6);
      const newHeight = clamp(resizeStartHeight + dy, SIDEBAR_MIN_HEIGHT, maxH);
      updateFloatingState({sidebar: {height: newHeight, collapsed: false}});
    } else {
      // Dragging left (negative dx) → wider sidebar.
      const dx = resizeStartX - e.clientX;
      const maxW = Math.floor(window.innerWidth * 0.5);
      const newWidth = clamp(resizeStartWidth + dx, SIDEBAR_MIN_WIDTH, maxW);
      updateFloatingState({sidebar: {width: newWidth, collapsed: false}});
    }
  });
}

function onResizeVisibilityChange(): void {
  // Alt-Tab / background tab while dragging — treat as gesture end,
  // matching the floating window's visibilitychange handling.
  if (document.hidden && resizeActive) onResizeEnd();
}

function onResizeEnd(): void {
  // Commit the final mouse position synchronously — the last rAF may not
  // have fired yet, so without this the sidebar snaps to the second-to-last
  // reported position.
  if (resizeActive) {
    if (resizeAxis === 'y') {
      const dy = resizeStartY - lastResizeClientY;
      const maxH = Math.floor(window.innerHeight * 0.6);
      const newHeight = clamp(resizeStartHeight + dy, SIDEBAR_MIN_HEIGHT, maxH);
      updateFloatingState({sidebar: {height: newHeight, collapsed: false}});
    } else {
      const dx = resizeStartX - lastResizeClientX;
      const maxW = Math.floor(window.innerWidth * 0.5);
      const newWidth = clamp(resizeStartWidth + dx, SIDEBAR_MIN_WIDTH, maxW);
      updateFloatingState({sidebar: {width: newWidth, collapsed: false}});
    }
  }
  resizeActive = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeEnd);
  window.removeEventListener('blur', onResizeEnd);
  document.removeEventListener('visibilitychange', onResizeVisibilityChange);
  document.body.style.userSelect = '';
  m.redraw();
}

function startResize(e: MouseEvent): void {
  e.preventDefault();
  e.stopPropagation();
  if (resizeActive) onResizeEnd();
  const s = getFloatingState();
  resizeAxis = s.sidebar.layout === 'bottom' ? 'y' : 'x';
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  lastResizeClientX = e.clientX;
  lastResizeClientY = e.clientY;
  resizeStartWidth = s.sidebar.width;
  resizeStartHeight = s.sidebar.height;
  resizeActive = true;
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeEnd);
  window.addEventListener('blur', onResizeEnd);
  document.addEventListener('visibilitychange', onResizeVisibilityChange);
  document.body.style.userSelect = 'none';
}

// ── Sidebar Component ──────────────────────────────────────────────────

export interface SidebarPanelAttrs {
  trace: Trace;
  tracePairWorkspaceController: TracePairWorkspaceController;
}

export class SidebarPanel implements m.ClassComponent<SidebarPanelAttrs> {
  view({attrs}: m.Vnode<SidebarPanelAttrs>): m.Children {
    const s = getFloatingState();
    const workspaceOpen = attrs.tracePairWorkspaceController.getState().open;
    return m.fragment({}, [
      this.renderCollapsed(!s.sidebar.collapsed, workspaceOpen),
      this.renderExpanded(
        attrs.trace,
        attrs.tracePairWorkspaceController,
        s.sidebar.width,
        s.sidebar.height,
        s.sidebar.layout,
        s.sidebar.collapsed,
      ),
    ]);
  }

  onremove(): void {
    // Defensive: if a resize gesture is in-flight when we unmount, clean up.
    if (resizeActive) onResizeEnd();
  }

  // ── Collapsed strip ────────────────────────────────────────────────

  private renderCollapsed(hidden: boolean, workspaceOpen: boolean): m.Children {
    const shared = getAISharedState();
    const isAnalyzing = shared.status === 'analyzing';
    const issueCount = shared.issueCount;

    return m(
      'button.ai-sidebar-collapsed',
      {
        'type': 'button',
        'class': workspaceOpen ? 'ai-sidebar-collapsed--workspace' : undefined,
        'style': hidden ? 'display: none;' : undefined,
        'onclick': () => toggleSidebarCollapsedWithTransientState(),
        'title': workspaceOpen
          ? '展开 AI 侧边栏（双 Trace 工作区保持打开）'
          : '展开 AI 侧边栏',
        'aria-label': '展开 AI 侧边栏',
        'aria-hidden': hidden ? 'true' : undefined,
        'data-workspace-open': workspaceOpen ? 'true' : 'false',
      },
      [
        m(Icon, {
          icon: 'smart_toy',
          style: `font-size: 18px; ${isAnalyzing ? 'animation: ai-sidebar-pulse 1.5s ease-in-out infinite;' : ''}`,
        }),
        m('span.ai-sidebar-collapsed-label', 'AI'),
        issueCount > 0 ? m('.ai-sidebar-badge', String(issueCount)) : null,
      ],
    );
  }

  // ── Expanded panel ─────────────────────────────────────────────────

  private renderExpanded(
    trace: Trace,
    tracePairWorkspaceController: TracePairWorkspaceController,
    width: number,
    height: number,
    layout: 'right' | 'bottom',
    hidden: boolean,
  ): m.Children {
    return m(
      `.ai-sidebar-expanded.ai-sidebar-expanded--${layout}`,
      {
        'style': hidden
          ? 'display: none;'
          : layout === 'bottom'
            ? `height: ${height}px;`
            : `width: ${width}px;`,
        'aria-hidden': hidden ? 'true' : undefined,
      },
      [
        m(`.ai-sidebar-resize-handle.ai-sidebar-resize-handle--${layout}`, {
          onmousedown: startResize,
          title: layout === 'bottom' ? '拖动调整高度' : '拖动调整宽度',
        }),

        // Content: AIPanel
        m(
          '.ai-sidebar-content',
          m(AIPanel, {
            key: 'analysis-request-owner',
            engine: trace.engine,
            trace,
            tracePairWorkspaceController,
          }),
        ),
      ],
    );
  }
}
