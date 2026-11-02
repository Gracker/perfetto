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
import type {Trace} from '../../public/trace';
import {Icon} from '../../widgets/icon';
import {AIPanel} from './ai_panel';
import {PageAuthGate} from './page_auth_lifecycle';
import type {AnalysisBackendConnection} from './analysis_backend_connection';
import {uiText} from './ui_language';
import type {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {
  clamp,
  getFloatingState,
  getSidebarSizeBounds,
  SIDEBAR_DEFAULT_HEIGHT,
  SIDEBAR_DEFAULT_WIDTH,
  updateFloatingState,
} from './ai_floating_state';
import {getAISharedState} from './ai_shared_state';
import {toggleSidebarCollapsedWithTransientState} from './ai_transient_state';

// ── Sidebar Component ──────────────────────────────────────────────────

export interface SidebarPanelAttrs {
  trace: Trace;
  tracePairWorkspaceController: TracePairWorkspaceController;
  analysisBackendConnection?: AnalysisBackendConnection;
}

export class SidebarPanel implements m.ClassComponent<SidebarPanelAttrs> {
  private endResize?: () => void;
  private resizing = false;

  private setSize(layout: 'right' | 'bottom', value: number): void {
    const {min, max} = getSidebarSizeBounds(layout);
    const size = clamp(value, min, max);
    updateFloatingState({
      sidebar: layout === 'right' ? {width: size} : {height: size},
    });
  }

  private resetSize(layout: 'right' | 'bottom'): void {
    this.setSize(
      layout,
      layout === 'right' ? SIDEBAR_DEFAULT_WIDTH : SIDEBAR_DEFAULT_HEIGHT,
    );
  }

  private startResize(event: PointerEvent, layout: 'right' | 'bottom'): void {
    if (!event.isPrimary || event.button !== 0) return;
    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;
    event.preventDefault();
    this.endResize?.();
    const {pointerId, clientX, clientY} = event;
    const sidebar = getFloatingState().sidebar;
    const startSize = layout === 'right' ? sidebar.width : sidebar.height;
    let lastPosition = layout === 'right' ? clientX : clientY;
    let frame = 0;
    const oldUserSelect = document.body.style.userSelect;
    const oldCursor = document.body.style.cursor;
    const commit = () => {
      frame = 0;
      this.setSize(
        layout,
        startSize + (layout === 'right' ? clientX : clientY) - lastPosition,
      );
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      lastPosition = layout === 'right' ? e.clientX : e.clientY;
      if (!frame) frame = requestAnimationFrame(commit);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      commit();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', visibility);
      handle.removeEventListener('lostpointercapture', cancel);
      this.endResize = undefined;
      this.resizing = false;
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
      document.body.style.userSelect = oldUserSelect;
      document.body.style.cursor = oldCursor;
      m.redraw();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      lastPosition = layout === 'right' ? e.clientX : e.clientY;
      stop();
    };
    const cancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) stop();
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    handle.setPointerCapture(pointerId);
    this.resizing = true;
    this.endResize = stop;
    document.body.style.userSelect = 'none';
    document.body.style.cursor =
      layout === 'right' ? 'col-resize' : 'row-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', visibility);
    handle.addEventListener('lostpointercapture', cancel);
  }

  private resizeWithKeyboard(
    event: KeyboardEvent,
    layout: 'right' | 'bottom',
  ): void {
    const {min, max} = getSidebarSizeBounds(layout);
    const sidebar = getFloatingState().sidebar;
    const size = layout === 'right' ? sidebar.width : sidebar.height;
    const step = event.shiftKey ? 64 : 16;
    let next: number | undefined;
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (
      (layout === 'right' && event.key === 'ArrowLeft') ||
      (layout === 'bottom' && event.key === 'ArrowUp')
    )
      next = size + step;
    if (
      (layout === 'right' && event.key === 'ArrowRight') ||
      (layout === 'bottom' && event.key === 'ArrowDown')
    )
      next = size - step;
    if (event.key === 'Enter')
      next =
        layout === 'right' ? SIDEBAR_DEFAULT_WIDTH : SIDEBAR_DEFAULT_HEIGHT;
    if (next === undefined) return;
    event.preventDefault();
    this.setSize(layout, next);
  }

  onbeforeupdate(): void {
    if (getFloatingState().sidebar.collapsed) this.endResize?.();
  }

  view({attrs}: m.Vnode<SidebarPanelAttrs>): m.Children {
    const s = getFloatingState();
    const workspaceOpen = attrs.tracePairWorkspaceController.getState().open;
    return m.fragment({}, [
      this.renderCollapsed(!s.sidebar.collapsed, workspaceOpen),
      this.renderExpanded(
        attrs.trace,
        attrs.tracePairWorkspaceController,
        attrs.analysisBackendConnection,
        s.sidebar.width,
        s.sidebar.height,
        s.sidebar.layout,
        s.sidebar.collapsed,
      ),
    ]);
  }

  onremove(): void {
    // Defensive: if a resize gesture is in-flight when we unmount, clean up.
    this.endResize?.();
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
        'class': `ai-sidebar-collapsed--${getFloatingState().sidebar.layout}${workspaceOpen ? ' ai-sidebar-collapsed--workspace' : ''}`,
        'style': hidden ? 'display: none;' : undefined,
        'onclick': () => toggleSidebarCollapsedWithTransientState(),
        'title': workspaceOpen
          ? uiText(
              '展开 AI 侧边栏（双 Trace 工作区保持打开）',
              'Expand the AI sidebar (keep the dual-trace workspace open)',
            )
          : uiText('展开 AI 侧边栏', 'Expand the AI sidebar'),
        'aria-label': uiText('展开 AI 侧边栏', 'Expand the AI sidebar'),
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
    analysisBackendConnection: AnalysisBackendConnection | undefined,
    width: number,
    height: number,
    layout: 'right' | 'bottom',
    hidden: boolean,
  ): m.Children {
    return m(
      `.ai-sidebar-expanded.ai-sidebar-expanded--${layout}`,
      {
        'class': this.resizing ? 'is-resizing' : undefined,
        'style': hidden
          ? 'display: none;'
          : layout === 'bottom'
            ? `height: ${height}px;`
            : `width: ${width}px;`,
        'aria-hidden': hidden ? 'true' : undefined,
      },
      [
        m(`.ai-sidebar-resize-handle.ai-sidebar-resize-handle--${layout}`, {
          'role': 'separator',
          'tabindex': 0,
          'aria-label':
            layout === 'right'
              ? uiText('调整 AI 侧栏宽度', 'Resize AI sidebar width')
              : uiText('调整 AI 面板高度', 'Resize AI panel height'),
          'aria-orientation': layout === 'right' ? 'vertical' : 'horizontal',
          'aria-valuemin': getSidebarSizeBounds(layout).min,
          'aria-valuemax': getSidebarSizeBounds(layout).max,
          'aria-valuenow': Math.round(layout === 'right' ? width : height),
          'onpointerdown': (e: PointerEvent) => this.startResize(e, layout),
          'onkeydown': (e: KeyboardEvent) => this.resizeWithKeyboard(e, layout),
          'ondblclick': () => this.resetSize(layout),
          'title': uiText(
            '拖动调整大小；双击复位；方向键微调',
            'Drag to resize; double-click to reset; arrow keys to fine-tune',
          ),
        }),

        // Content: AIPanel
        m(
          '.ai-sidebar-content',
          m(PageAuthGate, {
            content: m(AIPanel, {
              key: 'analysis-request-owner',
              engine: trace.engine,
              trace,
              tracePairWorkspaceController,
              analysisBackendConnection,
            }),
          }),
        ),
      ],
    );
  }
}
