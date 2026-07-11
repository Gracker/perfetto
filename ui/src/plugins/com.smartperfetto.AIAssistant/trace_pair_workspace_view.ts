// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import {getFloatingState} from './ai_floating_state';
import {
  switchFloatingMode,
  toggleSidebarCollapsedWithTransientState,
} from './ai_transient_state';
import type {TracePairLayout} from './types';
import type {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {renderTracePairPane} from './trace_pair_workspace_pane_view';

interface LayoutButton {
  readonly layout: TracePairLayout;
  readonly icon: string;
  readonly label: string;
}

const LAYOUT_BUTTONS: ReadonlyArray<LayoutButton> = [
  {layout: 'horizontal', icon: 'view_column', label: '左右'},
  {layout: 'vertical', icon: 'view_stream', label: '上下'},
];

function renderLayoutButton(
  controller: TracePairWorkspaceController,
  button: LayoutButton,
): m.Children {
  return m(
    'button.ai-trace-pair-tool-btn',
    {
      type: 'button',
      class: controller.getState().layout === button.layout ? 'active' : '',
      onclick: () => controller.setLayout(button.layout),
      title: `${button.label}排列`,
    },
    [m('i.pf-icon', button.icon), button.label],
  );
}

function renderSplitter(
  startResize: (event: PointerEvent) => void,
): m.Children {
  return m(
    'div.ai-trace-pair-splitter',
    {
      role: 'separator',
      title: '拖动调整两侧窗口大小',
      onpointerdown: (event: PointerEvent) => startResize(event),
    },
    m('span.ai-trace-pair-splitter-handle'),
  );
}

function toggleWorkspaceAssistant(): void {
  const floatingState = getFloatingState();
  if (floatingState.mode !== 'sidebar') {
    switchFloatingMode('sidebar');
    return;
  }
  toggleSidebarCollapsedWithTransientState();
}

export function renderTracePairWorkspace(
  controller: TracePairWorkspaceController,
  resizing: boolean,
  startResize: (event: PointerEvent) => void,
): m.Children {
  const state = controller.getState();
  if (!state.open || !state.scope || !state.currentTrace) return null;
  const floatingState = getFloatingState();
  const assistantExpanded =
    floatingState.mode === 'sidebar' && !floatingState.sidebar.collapsed;
  const workspaceClass = [
    resizing ? 'is-resizing' : '',
    state.maximizedTraceSide ? 'is-maximized' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const bodyClass = [
    `layout-${state.layout}`,
    state.minimizedTraceSides.has(
      state.currentPane === 'first' ? 'current' : 'reference',
    )
      ? 'first-minimized'
      : '',
    state.minimizedTraceSides.has(
      state.currentPane === 'first' ? 'reference' : 'current',
    )
      ? 'second-minimized'
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return m('div.ai-trace-pair-workspace', {class: workspaceClass}, [
    m('div.ai-trace-pair-header', [
      m('div.ai-trace-pair-title', [
        m('i.pf-icon', 'view_column'),
        m('span', '双 Trace 工作区'),
      ]),
      m('div.ai-trace-pair-summary', [
        m('span', state.currentTrace.filename),
        m('span.ai-trace-pair-summary-separator', 'vs'),
        m('span', state.referenceTrace?.filename || '请选择历史 Trace'),
      ]),
      state.catalogLoading
        ? m('span.ai-trace-pair-catalog-status', '正在加载 Trace...')
        : null,
      state.catalogError
        ? m('span.ai-trace-pair-catalog-status.is-error', state.catalogError)
        : null,
      m('div.ai-trace-pair-toolbar', [
        m(
          'button.ai-trace-pair-tool-btn.ai-trace-pair-tool-btn--assistant',
          {
            'type': 'button',
            'class': assistantExpanded ? 'active' : '',
            'onclick': toggleWorkspaceAssistant,
            'title': assistantExpanded ? '收起 AI 助手' : '打开 AI 助手',
            'aria-label': assistantExpanded ? '收起 AI 助手' : '打开 AI 助手',
            'aria-pressed': assistantExpanded ? 'true' : 'false',
            'data-trace-pair-assistant': '',
          },
          [m('i.pf-icon', 'smart_toy'), 'AI 助手'],
        ),
        ...LAYOUT_BUTTONS.map((button) =>
          renderLayoutButton(controller, button),
        ),
        m(
          'button.ai-trace-pair-tool-btn',
          {
            type: 'button',
            onclick: () => controller.resetLayout(),
            title: '恢复 50/50 布局',
          },
          [m('i.pf-icon', 'fit_screen'), '重置'],
        ),
        m(
          'button.ai-trace-pair-tool-btn.ai-trace-pair-tool-btn--primary',
          {
            'type': 'button',
            'disabled': state.selectionLocked,
            'onclick': () => controller.close(),
            'title': state.selectionLocked
              ? '分析运行中，停止后可退出双窗'
              : '退出双 Trace 工作区',
            'data-trace-pair-exit': '',
          },
          [m('i.pf-icon', 'close'), '退出双窗'],
        ),
      ]),
    ]),
    m(
      'div.ai-trace-pair-body',
      {
        class: bodyClass,
        style: `--ai-trace-pair-split: ${state.splitPercent}%;`,
      },
      [
        renderTracePairPane(controller, 'current'),
        renderSplitter(startResize),
        renderTracePairPane(controller, 'reference'),
      ],
    ),
  ]);
}
