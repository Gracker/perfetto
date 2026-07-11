// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import {Select} from '../../widgets/select';
import type {TracePairLayout, TracePairTraceSide} from './types';
import type {
  TracePairPaneSlot,
  TracePairWorkspaceController,
} from './trace_pair_workspace_state';
import {formatWorkspaceTraceCatalogMeta} from './workspace_trace_catalog';

function getPaneSlot(
  controller: TracePairWorkspaceController,
  traceSide: TracePairTraceSide,
): TracePairPaneSlot {
  const currentPane = controller.getState().currentPane;
  if (traceSide === 'current') return currentPane;
  return currentPane === 'first' ? 'second' : 'first';
}

function getPaneTitle(
  layout: TracePairLayout,
  pane: TracePairPaneSlot,
  traceSide: TracePairTraceSide,
): string {
  const location =
    layout === 'vertical'
      ? pane === 'first'
        ? '上'
        : '下'
      : pane === 'first'
        ? '左'
        : '右';
  return `${location}/${traceSide === 'current' ? '当前' : '参考'}`;
}

function buildFrameUrl(
  traceSourceUrl: string,
  traceFileName: string,
  traceSide: TracePairTraceSide,
): string {
  const params = new URLSearchParams({
    url: traceSourceUrl,
    traceFileName,
    hideSidebar: 'true',
    mode: 'embedded',
    smartperfettoDualTrace: 'true',
    smartperfettoPane: traceSide,
  });
  return `${window.location.origin}${window.location.pathname}#!/?${params.toString()}`;
}

function renderTraceSelector(
  controller: TracePairWorkspaceController,
  pane: TracePairPaneSlot,
  selectedTraceId: string,
): m.Children {
  const state = controller.getState();
  const history = state.catalog.filter(
    (trace) => trace.id !== state.currentTrace?.id,
  );
  const filenameCounts = new Map<string, number>();
  for (const trace of history) {
    filenameCounts.set(
      trace.filename,
      (filenameCounts.get(trace.filename) ?? 0) + 1,
    );
  }
  const selectorTitle = state.selectionLocked
    ? '分析运行中，Trace 选择已锁定'
    : state.catalogLoading
      ? '正在加载 Trace 列表'
      : '选择此窗口中显示的 Trace';
  return m(
    Select,
    {
      class: 'ai-trace-pair-selector',
      value: selectedTraceId,
      disabled: state.catalogLoading || state.selectionLocked,
      title: selectorTitle,
      onchange: (event: Event) => {
        const target = event.currentTarget;
        if (!(target instanceof HTMLSelectElement) || !target.value) return;
        controller.selectTrace({pane, traceId: target.value});
      },
    },
    [
      selectedTraceId
        ? null
        : m('option', {value: '', disabled: true}, '选择 Trace'),
      state.currentTrace
        ? m(
            'option',
            {value: state.currentTrace.id},
            `${state.currentTrace.filename} · 当前`,
          )
        : null,
      ...history.map((trace) => {
        const meta =
          filenameCounts.get(trace.filename) === 1
            ? ''
            : formatWorkspaceTraceCatalogMeta(trace);
        return m(
          'option',
          {value: trace.id},
          meta ? `${trace.filename} · ${meta}` : trace.filename,
        );
      }),
    ],
  );
}

export function renderTracePairPane(
  controller: TracePairWorkspaceController,
  traceSide: TracePairTraceSide,
): m.Children {
  const state = controller.getState();
  const pane = getPaneSlot(controller, traceSide);
  const trace =
    traceSide === 'current' ? state.currentTrace : state.referenceTrace;
  const minimized = state.minimizedTraceSides.has(traceSide);
  const maximized = state.maximizedTraceSide === traceSide;
  const paneClass = [
    `trace-side-${traceSide}`,
    `pane-slot-${pane}`,
    minimized ? 'is-minimized' : '',
    maximized ? 'is-maximized' : '',
    state.activeTraceSide === traceSide ? 'is-active' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const title = getPaneTitle(state.layout, pane, traceSide);
  const traceSourceUrl = trace
    ? controller.getTraceSourceUrl(trace.id)
    : null;
  const frameUrl = traceSourceUrl
    ? buildFrameUrl(traceSourceUrl, trace?.filename || 'trace.pftrace', traceSide)
    : null;
  const traceSourceError = trace
    ? controller.getTraceSourceError(trace.id)
    : null;
  const traceSourceLoading = trace
    ? controller.isTraceSourceLoading(trace.id)
    : false;

  return m(
    'section.ai-trace-pair-pane',
    {
      'class': paneClass,
      'data-pane-slot': pane,
      'data-trace-side': traceSide,
      'onmouseenter': () => controller.setActiveTraceSide(traceSide),
      'onfocusin': () => controller.setActiveTraceSide(traceSide),
    },
    [
      m('div.ai-trace-pair-pane-toolbar', [
        m('span.ai-trace-pair-pane-side', title),
        renderTraceSelector(controller, pane, trace?.id || ''),
        m('div.ai-trace-pair-pane-actions', [
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () =>
                frameUrl && window.open(frameUrl, '_blank', 'noopener'),
              title: '在新标签页打开此 Trace',
            },
            m('i.pf-icon', 'open_in_new'),
          ),
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () => controller.toggleMinimized(traceSide),
              title: minimized ? '还原窗口' : '最小化窗口',
            },
            m('i.pf-icon', minimized ? 'open_in_full' : 'minimize'),
          ),
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () => controller.toggleMaximized(traceSide),
              title: maximized ? '恢复分屏' : '最大化窗口',
            },
            m('i.pf-icon', maximized ? 'close_fullscreen' : 'open_in_full'),
          ),
        ]),
      ]),
      frameUrl
        ? m('iframe.ai-trace-pair-frame', {
            'src': frameUrl,
            'title': `${title} ${trace?.filename || 'Trace'}`,
            'loading': 'eager',
            'data-trace-side': traceSide,
          })
        : m('div.ai-trace-pair-empty', [
            m('i.pf-icon', traceSourceError ? 'error' : 'add_chart'),
            m(
              'span',
              traceSourceError
                ? traceSourceError
                : traceSourceLoading
                  ? '正在安全加载 Trace…'
                  : '在上方选择一个历史 Trace',
            ),
            traceSourceError && trace
              ? m(
                  'button.ai-trace-pair-icon-btn',
                  {
                    type: 'button',
                    onclick: () => controller.retryTraceSource(trace.id),
                    title: '重新加载 Trace',
                  },
                  '重试',
                )
              : null,
          ]),
      frameUrl
        ? m(
            'button.ai-trace-pair-minimized-rail',
            {
              type: 'button',
              onclick: () => controller.toggleMinimized(traceSide),
              title: '还原窗口',
            },
            [m('i.pf-icon', 'open_in_full'), m('span', trace?.filename)],
          )
        : null,
    ],
  );
}
