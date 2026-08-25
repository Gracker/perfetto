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
import {uiText} from './ui_language';

function getPaneSlot(
  traceSide: TracePairTraceSide,
): TracePairPaneSlot {
  return traceSide === 'current' ? 'first' : 'second';
}

function getPaneTitle(
  layout: TracePairLayout,
  pane: TracePairPaneSlot,
  traceSide: TracePairTraceSide,
): string {
  const location =
    layout === 'vertical'
      ? pane === 'first'
        ? uiText('上', 'Top')
        : uiText('下', 'Bottom')
      : pane === 'first'
        ? uiText('左', 'Left')
        : uiText('右', 'Right');
  return `${location}/${traceSide === 'current' ? uiText('基线', 'Baseline') : uiText('对比', 'Comparison')}`;
}

function buildFrameUrl(
  traceId: string,
  traceFileName: string,
  traceSide: TracePairTraceSide,
): string {
  const params = new URLSearchParams({
    smartperfettoTraceId: traceId,
    traceFileName,
    hideSidebar: 'true',
    mode: 'embedded',
    smartperfettoDualTrace: 'true',
    smartperfettoPane: traceSide,
  });
  return `${window.location.origin}${window.location.pathname}#!/viewer?${params.toString()}`;
}

function renderTraceSelector(
  controller: TracePairWorkspaceController,
  pane: TracePairPaneSlot,
  selectedTraceId: string,
): m.Children {
  const state = controller.getState();
  const candidates = [
    state.pageTrace,
    ...state.catalog,
    state.currentTrace,
    state.referenceTrace,
  ].filter((trace): trace is NonNullable<typeof trace> => trace !== null);
  const history = [...new Map(candidates.map((trace) => [trace.id, trace])).values()];
  const filenameCounts = new Map<string, number>();
  for (const trace of history) {
    filenameCounts.set(
      trace.filename,
      (filenameCounts.get(trace.filename) ?? 0) + 1,
    );
  }
  const selectorTitle = state.selectionLocked
    ? uiText('分析运行中，Trace 选择已锁定', 'Trace selection is locked while analysis is running')
    : state.catalogLoading
      ? uiText('正在加载 Trace 列表', 'Loading the trace list')
      : uiText('选择此窗口中显示的 Trace', 'Choose the trace shown in this pane');
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
        : m('option', {value: '', disabled: true}, uiText('选择 Trace', 'Select a trace')),
      ...history.map((trace) => {
        const meta =
          filenameCounts.get(trace.filename) === 1
            ? ''
            : formatWorkspaceTraceCatalogMeta(trace);
        return m(
          'option',
          {value: trace.id},
          trace.id === state.pageTrace?.id
            ? `${trace.filename} · ${uiText('当前页面', 'Current page')}`
            : meta
              ? `${trace.filename} · ${meta}`
              : trace.filename,
        );
      }),
    ],
  );
}

function renderTraceUploadControl(
  controller: TracePairWorkspaceController,
  pane: TracePairPaneSlot,
  replacing: boolean,
): m.Children {
  const state = controller.getState();
  const upload = state.paneUploads[pane];
  const disabled =
    state.selectionLocked ||
    upload.status === 'uploading' ||
    !controller.hasUploadHandler();
  const label = upload.status === 'uploading'
    ? uiText('上传中…', 'Uploading…')
    : replacing
      ? uiText('替换文件', 'Replace file')
      : uiText('上传 Trace', 'Upload trace');
  return m(
    `label.ai-trace-pair-upload${replacing ? '.is-compact' : ''}${disabled ? '.is-disabled' : ''}`,
    {
      title: state.selectionLocked
        ? uiText('分析运行中，上传已锁定', 'Uploads are locked while analysis is running')
        : label,
    },
    [
      m('i.pf-icon', upload.status === 'uploading' ? 'hourglass_top' : 'upload_file'),
      m('span', label),
      m('input', {
        type: 'file',
        accept: '.pftrace,.perfetto-trace,.trace,application/octet-stream',
        disabled,
        'data-trace-pair-upload': pane,
        onchange: (event: Event) => {
          const input = event.currentTarget;
          if (!(input instanceof HTMLInputElement)) return;
          const file = input.files?.[0];
          input.value = '';
          if (file) void controller.uploadTrace(pane, file);
        },
      }),
    ],
  );
}

export function renderTracePairPane(
  controller: TracePairWorkspaceController,
  traceSide: TracePairTraceSide,
): m.Children {
  const state = controller.getState();
  const pane = getPaneSlot(traceSide);
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
  const frameUrl = trace
    ? buildFrameUrl(trace.id, trace.filename || 'trace.pftrace', traceSide)
    : null;

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
          trace ? renderTraceUploadControl(controller, pane, true) : null,
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () =>
                frameUrl && window.open(frameUrl, '_blank', 'noopener'),
              title: uiText('在新标签页打开此 Trace', 'Open this trace in a new tab'),
            },
            m('i.pf-icon', 'open_in_new'),
          ),
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () => controller.toggleMinimized(traceSide),
              title: minimized
                ? uiText('还原窗口', 'Restore pane')
                : uiText('最小化窗口', 'Minimize pane'),
            },
            m('i.pf-icon', minimized ? 'open_in_full' : 'minimize'),
          ),
          m(
            'button.ai-trace-pair-icon-btn',
            {
              type: 'button',
              disabled: frameUrl === null,
              onclick: () => controller.toggleMaximized(traceSide),
              title: maximized
                ? uiText('恢复分屏', 'Restore split view')
                : uiText('最大化窗口', 'Maximize pane'),
            },
            m('i.pf-icon', maximized ? 'close_fullscreen' : 'open_in_full'),
          ),
        ]),
      ]),
      state.paneUploads[pane].error
        ? m('span.ai-trace-pair-upload-error', state.paneUploads[pane].error)
        : null,
      frameUrl
        ? m('iframe.ai-trace-pair-frame', {
            'src': frameUrl,
            'title': `${title} ${trace?.filename || 'Trace'}`,
            'loading': 'lazy',
            'data-trace-side': traceSide,
          })
        : m('div.ai-trace-pair-empty', [
            m('i.pf-icon', 'add_chart'),
            m(
              'span',
              traceSide === 'current'
                ? uiText('在上方选择一份基线 Trace', 'Select a baseline trace above')
                : uiText('在上方选择一份对比 Trace', 'Select a comparison trace above'),
            ),
            renderTraceUploadControl(controller, pane, false),
          ]),
      frameUrl
        ? m(
            'button.ai-trace-pair-minimized-rail',
            {
              type: 'button',
              onclick: () => controller.toggleMinimized(traceSide),
              title: uiText('还原窗口', 'Restore pane'),
            },
            [m('i.pf-icon', 'open_in_full'), m('span', trace?.filename)],
          )
        : null,
    ],
  );
}
