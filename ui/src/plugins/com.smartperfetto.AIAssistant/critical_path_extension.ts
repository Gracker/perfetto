// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Trace} from '../../public/trace';
import {getBackendUploadState} from '../../core/backend_upload_state';
import {
  backendUploadSourceKey,
  getBackendUploadIdentityKey,
} from '../../core/backend_uploader';
import {THREAD_STATE_TRACK_KIND} from '../../public/track_kinds';
import {buildSmartPerfettoContextHeaders} from '../../core/smartperfetto_request_context';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {SETTINGS_KEY} from './types';
import {getSettingsStorageKey} from './session_manager';
import {uiOutputLanguage, uiText} from './ui_language';

interface CriticalPathSegment {
  startOffsetMs?: number;
  durationMs?: number;
  processName?: string | null;
  threadName?: string | null;
  state?: string | null;
  modules?: string[];
  reasons?: string[];
  slices?: string[];
}

interface CriticalPathAnalysis {
  task?: {
    processName?: string | null;
    threadName?: string | null;
    state?: string | null;
    waker?: {
      processName?: string | null;
      threadName?: string | null;
      interruptContext?: boolean | null;
    };
  };
  totalMs?: number;
  blockingMs?: number;
  externalBlockingPercentage?: number;
  summary?: string;
  anomalies?: Array<{
    severity?: 'critical' | 'warning' | 'info';
    title?: string;
    detail?: string;
    evidence?: string[];
  }>;
  wakeupChain?: CriticalPathSegment[];
  moduleBreakdown?: Array<{
    module: string;
    durationMs?: number;
    percentage?: number;
    segmentCount?: number;
    examples?: string[];
  }>;
  recommendations?: string[];
  warnings?: string[];
}

interface CriticalPathAiSummary {
  generated?: boolean;
  model?: string;
  summary?: string;
  warnings?: string[];
  redactionApplied?: boolean;
}

interface CriticalPathState {
  open: boolean;
  loading: boolean;
  traceId: string;
  analysis: CriticalPathAnalysis | null;
  aiSummary: CriticalPathAiSummary | null;
  error: string;
}

interface SelectedTask {
  threadStateId: number;
  utid?: number;
  startTs: string;
  dur: string;
}

const INLINE_BTN_CLASS = 'sp-critical-path-inline-btn';
const DRAWER_CLASS = 'sp-critical-path-drawer';

function getBackendUrl(): string {
  try {
    const settings = JSON.parse(
      localStorage.getItem(getSettingsStorageKey()) ||
        localStorage.getItem(SETTINGS_KEY) ||
        '{}',
    ) as {backendUrl?: unknown};
    if (typeof settings.backendUrl === 'string' && settings.backendUrl.trim()) {
      return settings.backendUrl.replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return getDefaultSmartPerfettoBackendUrl().replace(/\/+$/, '');
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: buildSmartPerfettoContextHeaders(options?.headers),
  });
  const data = (await response.json().catch(() => ({}))) as T & {
    success?: boolean;
    error?: string;
    message?: string;
  };
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.message || `HTTP ${response.status}`);
  }
  return data;
}

async function resolveCurrentTraceId(sourceKey: string): Promise<string> {
  const backendUploadState = getBackendUploadState();
  const backendUrl = getBackendUrl();
  if (
    backendUploadState.state === 'ready' &&
    backendUploadState.traceId &&
    backendUploadState.sourceKey === sourceKey &&
    backendUploadState.backendIdentityKey ===
      getBackendUploadIdentityKey(backendUrl, sourceKey)
  ) {
    return backendUploadState.traceId;
  }
  throw new Error(
    uiText(
      '当前 Trace 尚未完成后端绑定，请等待 AI Assistant 显示当前 Trace 已连接后再试。',
      'The current trace is not bound to the backend yet. Wait until AI Assistant shows it as connected, then try again.',
    ),
  );
}

function numericString(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  const text = String(value).trim();
  return /^-?\d+$/.test(text) ? text : '';
}

function getSelectedTask(trace: Trace): SelectedTask {
  const selection = trace.selection.selection;
  if (selection.kind !== 'track_event') {
    throw new Error(
      uiText(
        '请先选中一个 thread_state task。',
        'Select a thread_state task first.',
      ),
    );
  }

  const startTs = numericString(selection.ts);
  const dur = numericString(selection.dur);
  if (!startTs || !dur || dur === '-1' || dur === '0') {
    throw new Error(
      uiText(
        '当前选中项没有有效持续时间，不能做 Critical path 分析。',
        'The selected item has no valid duration, so critical-path analysis cannot run.',
      ),
    );
  }

  const track = trace.tracks.getTrack(selection.trackUri);
  const utid =
    typeof track?.tags?.utid === 'number' ? track.tags.utid : undefined;
  return {
    threadStateId: selection.eventId,
    utid,
    startTs,
    dur,
  };
}

function hasThreadStateTaskSelection(trace: Trace): boolean {
  const selection = trace.selection.selection;
  if (selection.kind !== 'track_event') return false;

  const startTs = numericString(selection.ts);
  const dur = numericString(selection.dur);
  if (!startTs || !dur || dur === '-1' || dur === '0') return false;

  const track = trace.tracks.getTrack(selection.trackUri);
  return !!track?.tags?.kinds?.includes(THREAD_STATE_TRACK_KIND);
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );
}

function formatMs(value: unknown): string {
  const number = Number(value || 0);
  return `${number.toFixed(number >= 10 ? 1 : 2)} ms`;
}

function formatPercent(value: unknown): string {
  const number = Number(value || 0);
  return `${number.toFixed(number >= 10 ? 1 : 2)}%`;
}

function renderEvidence(items: unknown[] = []): string {
  const values = items.filter(Boolean).slice(0, 5);
  if (values.length === 0) return '';
  return `<div class="sp-critical-path-evidence">${values
    .map((item) => `<span>${escapeHtml(item)}</span>`)
    .join('')}</div>`;
}

function renderStatus(message: string, isError: boolean): string {
  return `<div class="sp-critical-path-status ${isError ? 'error' : ''}">${escapeHtml(message)}</div>`;
}

function renderMetric(label: string, value: string): string {
  return `
    <div class="sp-critical-path-metric">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderPlainText(value: unknown): string {
  return String(value || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join('');
}

function renderAnomalies(analysis: CriticalPathAnalysis): string {
  const items = analysis.anomalies ?? [];
  if (items.length === 0) {
    return `<div class="sp-critical-path-muted">${uiText(
      '未发现明显异常。',
      'No clear anomaly was found.',
    )}</div>`;
  }
  return items
    .map(
      (item) => `
      <div class="sp-critical-path-anomaly ${escapeHtml(item.severity || 'info')}">
        <b>${escapeHtml(item.title || uiText('异常', 'Anomaly'))}</b>
        <p>${escapeHtml(item.detail || '')}</p>
        ${renderEvidence(item.evidence)}
      </div>
    `,
    )
    .join('');
}

function renderChain(analysis: CriticalPathAnalysis): string {
  const items = analysis.wakeupChain ?? [];
  if (items.length === 0) {
    return `<div class="sp-critical-path-muted">${uiText(
      '没有取到外部 critical path 段。',
      'No external critical-path segments were found.',
    )}</div>`;
  }
  return items
    .slice(0, 24)
    .map(
      (item, index) => `
      <div class="sp-critical-path-chain-row">
        <div class="sp-critical-path-chain-index">${index + 1}</div>
        <div>
          <b>${escapeHtml(item.processName || '-')} / ${escapeHtml(item.threadName || '-')}</b>
          <p>${formatMs(item.durationMs)} · +${formatMs(item.startOffsetMs)} · ${escapeHtml(item.state || 'unknown')}</p>
          ${renderEvidence([...(item.modules ?? []), ...(item.reasons ?? []), ...(item.slices ?? [])])}
        </div>
      </div>
    `,
    )
    .join('');
}

function renderModules(analysis: CriticalPathAnalysis): string {
  const items = analysis.moduleBreakdown ?? [];
  if (items.length === 0) {
    return `<div class="sp-critical-path-muted">${uiText(
      '暂无模块归因。',
      'No module attribution is available.',
    )}</div>`;
  }
  return items
    .slice(0, 10)
    .map(
      (item) => `
      <div class="sp-critical-path-module-row">
        <span>
          <b>${escapeHtml(item.module)}</b>
          <small>${escapeHtml((item.examples ?? []).join('；') || `${item.segmentCount || 0} segments`)}</small>
        </span>
        <strong>${formatMs(item.durationMs)} · ${formatPercent(item.percentage)}</strong>
      </div>
    `,
    )
    .join('');
}

function renderList(items: string[] = []): string {
  if (items.length === 0) {
    return `<div class="sp-critical-path-muted">${uiText(
      '暂无建议。',
      'No recommendations are available.',
    )}</div>`;
  }
  return `<ul class="sp-critical-path-list">${items
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join('')}</ul>`;
}

function renderAiSummary(aiSummary: CriticalPathAiSummary | null): string {
  if (!aiSummary) return '';
  const badge = aiSummary.generated
    ? `LLM · ${aiSummary.model || 'model'}`
    : uiText('规则兜底', 'Rule fallback');
  return `
    <section class="sp-critical-path-card sp-critical-path-ai-card">
      <h3>${uiText('AI 诊断', 'AI diagnosis')} <span>${escapeHtml(badge)}</span></h3>
      <div class="sp-critical-path-summary">${renderPlainText(aiSummary.summary)}</div>
      ${aiSummary.redactionApplied ? renderStatus(uiText('已对发送给模型的数据做隐私脱敏。', 'Data sent to the model was privacy-redacted.'), false) : ''}
      ${aiSummary.warnings?.length ? renderStatus(aiSummary.warnings.join('；'), false) : ''}
    </section>
  `;
}

function renderAnalysis(
  analysis: CriticalPathAnalysis,
  aiSummary: CriticalPathAiSummary | null,
): string {
  const task = analysis.task ?? {};
  const waker = task.waker?.interruptContext
    ? 'Interrupt'
    : task.waker?.threadName
      ? `${task.waker.processName || '-'} / ${task.waker.threadName || '-'}`
      : '';
  return `
    <div class="sp-critical-path-metrics">
      ${renderMetric('Task', formatMs(analysis.totalMs))}
      ${renderMetric(uiText('外部链路', 'External path'), formatMs(analysis.blockingMs))}
      ${renderMetric(uiText('占比', 'Share'), formatPercent(analysis.externalBlockingPercentage))}
    </div>
    <section class="sp-critical-path-card">
      <h3>${uiText('规则事实', 'Rule facts')}</h3>
      <div class="sp-critical-path-summary">${renderPlainText(analysis.summary)}</div>
      <div class="sp-critical-path-facts">
        <span>${escapeHtml(task.processName || '-')} / ${escapeHtml(task.threadName || '-')}</span>
        <span>${escapeHtml(task.state || 'unknown')}</span>
        ${waker ? `<span>Waker: ${escapeHtml(waker)}</span>` : ''}
      </div>
    </section>
    ${renderAiSummary(aiSummary)}
    <section class="sp-critical-path-card"><h3>${uiText('异常判断', 'Anomaly assessment')}</h3>${renderAnomalies(analysis)}</section>
    <section class="sp-critical-path-card"><h3>${uiText('唤醒链', 'Wakeup chain')}</h3>${renderChain(analysis)}</section>
    <section class="sp-critical-path-card"><h3>${uiText('关联模块', 'Related modules')}</h3>${renderModules(analysis)}</section>
    <section class="sp-critical-path-card"><h3>${uiText('下一步', 'Next steps')}</h3>${renderList(analysis.recommendations)}</section>
    ${analysis.warnings?.length ? renderStatus(analysis.warnings.join('；'), false) : ''}
  `;
}

export function setupCriticalPathExtension(trace: Trace): {
  dispose: () => void;
} {
  const state: CriticalPathState = {
    open: false,
    loading: false,
    traceId: '',
    analysis: null,
    aiSummary: null,
    error: '',
  };

  let disposed = false;
  let drawer: HTMLElement | null = null;

  const ensureDrawer = (): HTMLElement => {
    if (!drawer) {
      drawer = document.createElement('aside');
      drawer.className = DRAWER_CLASS;
      document.body.appendChild(drawer);
    }
    return drawer;
  };

  const renderDrawer = (): void => {
    const target = ensureDrawer();
    target.classList.toggle('active', state.open);
    if (!state.open) return;
    target.innerHTML = `
      <div class="sp-critical-path-header">
        <div><span>Critical Path</span><h2>${uiText('Critical path 分析', 'Critical-path analysis')}</h2></div>
        <button class="sp-critical-path-close" type="button" aria-label="${uiText('关闭', 'Close')}">×</button>
      </div>
      ${state.loading ? renderStatus(uiText('正在分析所选 task 的 critical path，并生成 AI 诊断…', 'Analyzing the selected task critical path and generating an AI diagnosis…'), false) : ''}
      ${state.error ? renderStatus(state.error, true) : ''}
      ${state.analysis ? renderAnalysis(state.analysis, state.aiSummary) : ''}
    `;
    target
      .querySelector('.sp-critical-path-close')
      ?.addEventListener('click', () => {
        state.open = false;
        renderDrawer();
      });
  };

  const analyzeSelectedTask = async (): Promise<void> => {
    state.open = true;
    state.loading = true;
    state.error = '';
    state.aiSummary = null;
    renderDrawer();
    try {
      const backendUrl = getBackendUrl();
      const traceSource = (
        trace.traceInfo as unknown as {
          source?: Parameters<typeof backendUploadSourceKey>[0];
        }
      ).source;
      if (!traceSource) {
        throw new Error(
          uiText(
            '当前 Trace 缺少可验证的来源标识，无法安全选择后端 Trace。',
            'The current trace has no verifiable source identity, so the backend trace cannot be selected safely.',
          ),
        );
      }
      const traceId = await resolveCurrentTraceId(
        backendUploadSourceKey(traceSource),
      );
      state.traceId = traceId;
      const selectedTask = getSelectedTask(trace);
      const result = await fetchJson<{
        analysis: CriticalPathAnalysis;
        presentationAnalysis?: CriticalPathAnalysis;
        aiSummary?: CriticalPathAiSummary;
      }>(
        `${backendUrl}/api/critical-path/${encodeURIComponent(traceId)}/analyze`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept-Language': uiOutputLanguage(),
          },
          body: JSON.stringify({
            threadStateId: selectedTask.threadStateId,
            utid: selectedTask.utid,
            startTs: selectedTask.startTs,
            dur: selectedTask.dur,
            maxSegments: 180,
            includeAi: true,
            outputLanguage: uiOutputLanguage(),
          }),
        },
      );
      state.analysis = result.presentationAnalysis ?? result.analysis;
      state.aiSummary = result.aiSummary ?? null;
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      state.error = uiText(
        `Critical path 分析失败：${detail}`,
        `Critical-path analysis failed: ${detail}`,
      );
    } finally {
      state.loading = false;
      renderDrawer();
    }
  };

  const removeInlineButtons = (): void => {
    document
      .querySelectorAll<HTMLButtonElement>(`.${INLINE_BTN_CLASS}`)
      .forEach((button) => {
        button.remove();
      });
  };

  const ensureInlineButtons = (): void => {
    const selectionButton = document.querySelector<HTMLButtonElement>(
      '.ai-preset-questions .ai-selection-btn',
    );
    if (disposed || !selectionButton || !hasThreadStateTaskSelection(trace)) {
      removeInlineButtons();
      return;
    }

    const parent = selectionButton.parentElement;
    if (!parent || parent.querySelector(`.${INLINE_BTN_CLASS}`)) return;

    const analyzeButton = document.createElement('button');
    analyzeButton.type = 'button';
    analyzeButton.className = `ai-preset-btn ${INLINE_BTN_CLASS}`;
    analyzeButton.innerHTML = `<i class="pf-icon">account_tree</i><span>${uiText('Critical path 分析', 'Critical-path analysis')}</span>`;
    analyzeButton.title = uiText(
      '分析选中 thread_state task 的唤醒链、异常点和关联模块',
      'Analyze the selected thread_state task wakeup chain, anomalies, and related modules',
    );
    analyzeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void analyzeSelectedTask();
    });
    selectionButton.insertAdjacentElement('afterend', analyzeButton);
  };

  const observer = new MutationObserver(() => ensureInlineButtons());
  observer.observe(document.documentElement, {childList: true, subtree: true});
  ensureInlineButtons();

  return {
    dispose: () => {
      disposed = true;
      observer.disconnect();
      removeInlineButtons();
      drawer?.remove();
      drawer = null;
    },
  };
}
