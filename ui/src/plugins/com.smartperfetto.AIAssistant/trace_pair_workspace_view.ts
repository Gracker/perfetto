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
import {uiOutputLanguage, uiText} from './ui_language';

interface LayoutButton {
  readonly layout: TracePairLayout;
  readonly icon: string;
  readonly zhLabel: string;
  readonly enLabel: string;
}

const LAYOUT_BUTTONS: ReadonlyArray<LayoutButton> = [
  {layout: 'horizontal', icon: 'view_column', zhLabel: '左右', enLabel: 'Side by side'},
  {layout: 'vertical', icon: 'view_stream', zhLabel: '上下', enLabel: 'Stacked'},
];

function renderLayoutButton(
  controller: TracePairWorkspaceController,
  button: LayoutButton,
): m.Children {
  const label = uiText(button.zhLabel, button.enLabel);
  return m(
    'button.ai-trace-pair-tool-btn',
    {
      type: 'button',
      class: controller.getState().layout === button.layout ? 'active' : '',
      onclick: () => controller.setLayout(button.layout),
      title: uiText(`${button.zhLabel}排列`, `${button.enLabel} layout`),
    },
    [m('i.pf-icon', button.icon), label],
  );
}

function renderSplitter(
  controller: TracePairWorkspaceController,
  startResize: (event: PointerEvent) => void,
): m.Children {
  const state = controller.getState();
  return m(
    'div.ai-trace-pair-splitter',
    {
      role: 'separator',
      tabindex: 0,
      'aria-orientation': state.layout === 'horizontal' ? 'vertical' : 'horizontal',
      'aria-valuemin': 20,
      'aria-valuemax': 80,
      'aria-valuenow': Math.round(state.splitPercent),
      title: uiText(
        '拖动或使用方向键调整两侧窗口大小',
        'Drag or use the arrow keys to resize the trace panes',
      ),
      onpointerdown: (event: PointerEvent) => startResize(event),
      onkeydown: (event: KeyboardEvent) => {
        const horizontal = state.layout === 'horizontal';
        let next: number | undefined;
        if (event.key === 'Home') next = 20;
        if (event.key === 'End') next = 80;
        if ((horizontal && event.key === 'ArrowLeft') || (!horizontal && event.key === 'ArrowUp')) {
          next = state.splitPercent - 2;
        }
        if ((horizontal && event.key === 'ArrowRight') || (!horizontal && event.key === 'ArrowDown')) {
          next = state.splitPercent + 2;
        }
        if (next === undefined) return;
        event.preventDefault();
        controller.setSplitPercent(next);
      },
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

  return m('div.ai-trace-pair-workspace', {
    class: workspaceClass,
    lang: uiOutputLanguage() === 'zh-CN' ? 'zh-CN' : 'en',
  }, [
    m('div.ai-trace-pair-header', [
      m('div.ai-trace-pair-title', [
        m('i.pf-icon', 'view_column'),
        m('span', uiText('双 Trace 工作区', 'Dual-Trace Workspace')),
      ]),
      m('div.ai-trace-pair-summary', [
        m('span', state.currentTrace.filename),
        m('span.ai-trace-pair-summary-separator', 'vs'),
        m('span', state.referenceTrace?.filename || uiText('请选择历史 Trace', 'Select a historical trace')),
      ]),
      state.catalogLoading
        ? m('span.ai-trace-pair-catalog-status', uiText('正在加载 Trace...', 'Loading traces...'))
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
            'title': assistantExpanded
              ? uiText('收起 AI 助手', 'Collapse AI assistant')
              : uiText('打开 AI 助手', 'Open AI assistant'),
            'aria-label': assistantExpanded
              ? uiText('收起 AI 助手', 'Collapse AI assistant')
              : uiText('打开 AI 助手', 'Open AI assistant'),
            'aria-pressed': assistantExpanded ? 'true' : 'false',
            'data-trace-pair-assistant': '',
          },
          [m('i.pf-icon', 'smart_toy'), uiText('AI 助手', 'AI Assistant')],
        ),
        ...LAYOUT_BUTTONS.map((button) =>
          renderLayoutButton(controller, button),
        ),
        m(
          'button.ai-trace-pair-tool-btn',
          {
            type: 'button',
            onclick: () => controller.resetLayout(),
            title: uiText('恢复 50/50 布局', 'Restore the 50/50 layout'),
          },
          [m('i.pf-icon', 'fit_screen'), uiText('重置', 'Reset')],
        ),
        m(
          'button.ai-trace-pair-tool-btn.ai-trace-pair-tool-btn--primary',
          {
            'type': 'button',
            'disabled': state.selectionLocked,
            'onclick': () => controller.close(),
            'title': state.selectionLocked
              ? uiText('分析运行中，停止后可退出双窗', 'Stop the analysis before exiting the dual-trace workspace')
              : uiText('退出双 Trace 工作区', 'Exit the dual-trace workspace'),
            'data-trace-pair-exit': '',
          },
          [m('i.pf-icon', 'close'), uiText('退出双窗', 'Exit')],
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
        renderSplitter(controller, startResize),
        renderTracePairPane(controller, 'reference'),
      ],
    ),
  ]);
}
