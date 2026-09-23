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
import {
  isSmartPerfettoOidcMode,
  smartPerfettoFetch,
} from '../../core/smartperfetto_auth';
import {
  buildSmartPerfettoContextHeaders,
  buildSmartPerfettoWorkspaceApiUrl,
} from '../../core/smartperfetto_request_context';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {SETTINGS_KEY} from './types';
import {getSettingsStorageKey} from './session_manager';
import {uiOutputLanguage, uiText} from './ui_language';
import type {AnalysisBackendConnection} from './analysis_backend_connection';
import {emitComposerDraft} from './assistant_command_bus';
import {copyTextToClipboard} from './clipboard';
import {getFloatingState, updateFloatingState} from './ai_floating_state';
import type {
  CriticalPathAiSummary,
  CriticalPathAnalysis,
  CriticalPathAnalyzeResponse,
  CriticalPathSegment,
  CriticalPathUnavailableReason,
  HypothesisStrength,
  SemanticSourceName,
  SemanticSourceStatus,
  SliceKind,
  WakerKind,
} from './generated';

interface CriticalPathState {
  open: boolean;
  loading: boolean;
  traceId: string;
  analysis: CriticalPathAnalysis | null;
  aiSummary: CriticalPathAiSummary | null;
  error: string;
  /** Feedback after copying a verification query or handing off. */
  notice: string;
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
  const defaultBackendUrl = getDefaultSmartPerfettoBackendUrl().replace(
    /\/+$/,
    '',
  );
  if (isSmartPerfettoOidcMode()) return defaultBackendUrl;
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
  return defaultBackendUrl;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await smartPerfettoFetch(url, {
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

async function resolveCurrentTraceId(
  sourceKey: string,
  analysisBackendConnection?: AnalysisBackendConnection,
): Promise<string> {
  if (isSmartPerfettoOidcMode()) {
    const snapshot = analysisBackendConnection?.getSnapshot();
    if (snapshot?.state === 'ready' && snapshot.traceId) {
      return snapshot.traceId;
    }
    throw new Error(
      uiText(
        '当前 Trace 尚未完成页面级 AI 后端绑定，请等待连接状态变为就绪。',
        'The current trace is not ready on the page-scoped AI backend yet.',
      ),
    );
  }
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
  const items = analysis.anomalies;
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

/** The critical-path route under the caller's workspace (reachable in enterprise mode). */
export function buildCriticalPathAnalyzeUrl(backendUrl: string, traceId: string): string {
  return buildSmartPerfettoWorkspaceApiUrl(
    backendUrl,
    'critical-path',
    `/${encodeURIComponent(traceId)}/analyze`,
  );
}

type TextPair = readonly [zh: string, en: string];
const pick = ([zh, en]: TextPair): string => uiText(zh, en);

const UNAVAILABLE_TEXT: Record<CriticalPathUnavailableReason, TextPair> = {
  task_state_running: [
    '选中的 thread_state 正在运行，没有等待可以分析。',
    'The selected thread_state is Running, so there is no wait to analyze.',
  ],
  no_waiting_time: [
    '所选窗口内没有睡眠、不可中断或可运行时间。',
    'The selected window holds no sleeping, uninterruptible or runnable time.',
  ],
  no_critical_path_stack: [
    'Perfetto 没有返回关键路径；trace 可能缺少 sched_waking。',
    'Perfetto returned no critical path; the trace may lack sched_waking.',
  ],
};

const SOURCE_STATUS_TEXT: Record<SemanticSourceStatus, TextPair> = {
  present: ['有数据', 'present'],
  empty: ['无匹配', 'no match'],
  stdlib_missing: ['缺 stdlib', 'stdlib missing'],
  sql_error: ['查询失败', 'query failed'],
  skipped: ['未查询', 'skipped'],
};

const SOURCE_NAME_TEXT: Record<SemanticSourceName, TextPair> = {
  binder: ['Binder', 'Binder'],
  monitor: ['Monitor 锁', 'Monitor locks'],
  io: ['IO', 'I/O'],
  gc: ['GC', 'GC'],
  cpu: ['CPU 竞争', 'CPU contention'],
  wakeSource: ['唤醒来源', 'Wake source'],
};

const WAKER_KIND_TEXT: Record<WakerKind, TextPair> = {
  irq: ['中断上下文', 'IRQ context'],
  swapper: ['idle/swapper', 'idle/swapper'],
  thread: ['线程', 'thread'],
  unknown: ['未知', 'unknown'],
};

const SLICE_KIND_TEXT: Record<SliceKind, TextPair> = {
  sleeping: ['睡眠', 'sleeping'],
  uninterruptible: ['不可中断', 'uninterruptible'],
  runnable: ['可运行', 'runnable'],
  running: ['运行', 'running'],
  unknown: ['未知', 'unknown'],
};

const STRENGTH_TEXT: Record<HypothesisStrength, TextPair> = {
  strong: ['强', 'strong'],
  weak: ['弱', 'weak'],
  speculative: ['推测', 'speculative'],
};

/** The top-level chain with its recursion children, each tagged with its level. */
function flattenChain(
  segments: readonly CriticalPathSegment[],
  depth = 0,
  out: Array<{segment: CriticalPathSegment; depth: number}> = [],
): Array<{segment: CriticalPathSegment; depth: number}> {
  for (const segment of segments) {
    out.push({segment, depth});
    if (segment.children?.length) flattenChain(segment.children, depth + 1, out);
  }
  return out;
}

function renderChain(analysis: CriticalPathAnalysis): string {
  const items = flattenChain(analysis.wakeupChain);
  if (items.length === 0) {
    return `<div class="sp-critical-path-muted">${uiText(
      '没有取到外部 critical path 段。',
      'No external critical-path segments were found.',
    )}</div>`;
  }
  const total = analysis.chainSegmentCount ?? analysis.wakeupChain.length;
  const shown = analysis.wakeupChain.length;
  const note =
    total > shown
      ? `<div class="sp-critical-path-muted">${uiText(
          `整条链 ${total} 段，这里显示前 ${shown} 段；时长与占比按整条链计算。`,
          `The chain has ${total} segments; the first ${shown} are shown. Durations and shares cover the whole chain.`,
        )}</div>`
      : '';
  return (
    note +
    items
      .slice(0, 40)
      .map(
        ({segment, depth}, index) => `
      <div class="sp-critical-path-chain-row${depth > 0 ? ` depth-${Math.min(depth, 2)}` : ''}">
        <div class="sp-critical-path-chain-index">${depth > 0 ? '↳' : index + 1}</div>
        <div>
          <b>${escapeHtml(segment.processName || '-')} / ${escapeHtml(segment.threadName || '-')}</b>
          <p>${formatMs(segment.durationMs)} · +${formatMs(segment.startOffsetMs)} · ${escapeHtml(segment.state || 'unknown')}${
            segment.blockedFunction ? ` · ${escapeHtml(segment.blockedFunction)}` : ''
          }</p>
          ${renderEvidence([...segment.modules, ...segment.reasons, ...segment.slices])}
        </div>
      </div>
    `,
      )
      .join('')
  );
}

function renderModules(analysis: CriticalPathAnalysis): string {
  const items = analysis.moduleBreakdown;
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
          <small>${escapeHtml(item.examples.join('；') || `${item.segmentCount} segments`)}</small>
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
      ${aiSummary.warnings.length ? renderStatus(aiSummary.warnings.join('；'), false) : ''}
    </section>
  `;
}

/** L2: who woke the task, read from its wakeup row. */
function renderWaker(analysis: CriticalPathAnalysis): string {
  const waker = analysis.directWaker;
  if (!waker) return '';
  const kind = escapeHtml(pick(WAKER_KIND_TEXT[waker.kind]));
  const who =
    waker.threadName || waker.processName
      ? `${escapeHtml(waker.processName || '-')} / ${escapeHtml(waker.threadName || '-')}`
      : kind;
  return `
    <div class="sp-critical-path-waker">
      <b>${uiText('直接唤醒者', 'Direct waker')}</b>
      <span>${who} · ${kind}${waker.state ? ` · ${escapeHtml(waker.state)}` : ''}</span>
      ${renderEvidence(waker.hints)}
    </div>
  `;
}

/** The target thread's own states inside the window, longest first. */
function renderSlices(analysis: CriticalPathAnalysis): string {
  const slices = [...(analysis.slices ?? [])].sort((a, b) => b.durationMs - a.durationMs);
  if (slices.length === 0) return '';
  return `
    <section class="sp-critical-path-card">
      <h3>${uiText('窗口内的线程状态', 'Thread states in the window')}</h3>
      ${slices
        .slice(0, 6)
        .map(
          (slice) => `
        <div class="sp-critical-path-module-row">
          <span>
            <b>${escapeHtml(slice.state || '-')} · ${escapeHtml(pick(SLICE_KIND_TEXT[slice.kind]))}</b>
            <small>${escapeHtml(
              [
                slice.threadStateId !== null ? `thread_state ${slice.threadStateId}` : '',
                slice.blockedFunction ?? '',
                slice.cpu !== null ? `CPU ${slice.cpu}` : '',
              ]
                .filter(Boolean)
                .join(' · '),
            )}</small>
          </span>
          <strong>${formatMs(slice.durationMs)}</strong>
        </div>
      `,
        )
        .join('')}
    </section>
  `;
}

/** L3: which semantic sources answered, so an empty section is not read as "nothing happened". */
function renderSources(analysis: CriticalPathAnalysis): string {
  const sources = analysis.semanticSources ?? {};
  const names = (Object.keys(SOURCE_NAME_TEXT) as SemanticSourceName[]).filter((name) => sources[name]);
  if (names.length === 0) return '';
  return `
    <div class="sp-critical-path-sources">
      ${names
        .map((name) => {
          const status = sources[name]!;
          return `<span class="${escapeHtml(status)}">${escapeHtml(pick(SOURCE_NAME_TEXT[name]))}: ${escapeHtml(pick(SOURCE_STATUS_TEXT[status]))}</span>`;
        })
        .join('')}
    </div>
  `;
}

/** L5: best case, frames and falsifiable hypotheses with their verification SQL. */
function renderQuantification(analysis: CriticalPathAnalysis): string {
  const quantification = analysis.quantification;
  if (!quantification) return '';
  const counterfactual = quantification.counterfactual;
  const frames = quantification.frameImpacts;
  const hypotheses = quantification.hypotheses;
  if (!counterfactual && frames.length === 0 && hypotheses.length === 0) return '';
  const counterfactualBlock = counterfactual
    ? `
      <div class="sp-critical-path-metrics compact">
        ${renderMetric(uiText('最好情况', 'Best case'), formatMs(counterfactual.bestCaseDurationMs))}
        ${renderMetric(uiText('至多节省', 'Saving at most'), formatMs(counterfactual.maxSavingMs))}
      </div>
      <div class="sp-critical-path-muted">${escapeHtml(counterfactual.note)}</div>
    `
    : '';
  const framesBlock = frames.length
    ? `<h4>${uiText('受影响的帧', 'Affected frames')}</h4>${frames
        .slice(0, 6)
        .map(
          (frame) => `
        <div class="sp-critical-path-module-row">
          <span>
            <b>${uiText('帧', 'Frame')} ${escapeHtml(frame.frameId ?? '-')}</b>
            <small>${escapeHtml([frame.jankType, frame.presentType, frame.layerName].filter(Boolean).join(' · '))}</small>
          </span>
          <strong>${formatMs(frame.overlapMs)} / ${formatMs(frame.expectedDeadlineDurMs)}</strong>
        </div>
      `,
        )
        .join('')}`
    : '';
  const hypothesesBlock = hypotheses.length
    ? `<h4>${uiText('可验证的假设', 'Verifiable hypotheses')}</h4>${hypotheses
        .map(
          (hypothesis, index) => `
        <div class="sp-critical-path-hypothesis">
          <b>${escapeHtml(hypothesis.statement)} <span>${escapeHtml(pick(STRENGTH_TEXT[hypothesis.strength]))}</span></b>
          ${renderEvidence(hypothesis.notes)}
          <pre>${escapeHtml(hypothesis.verificationSql)}</pre>
          <button type="button" class="sp-critical-path-copy" data-hypothesis-index="${index}">${uiText('复制验证 SQL', 'Copy verification SQL')}</button>
        </div>
      `,
        )
        .join('')}`
    : '';
  return `
    <section class="sp-critical-path-card">
      <h3>${uiText('量化', 'Quantification')}</h3>
      ${counterfactualBlock}${framesBlock}${hypothesesBlock}
    </section>
  `;
}

/** Everything the drawer shows for one result; exported for tests. */
export function renderCriticalPathDrawerBody(
  analysis: CriticalPathAnalysis,
  aiSummary: CriticalPathAiSummary | null,
): string {
  const task = analysis.task;
  const longest = analysis.longestSegment;
  const unavailable =
    !analysis.available && analysis.unavailableReason
      ? renderStatus(pick(UNAVAILABLE_TEXT[analysis.unavailableReason]), false)
      : '';
  return `
    ${unavailable}
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
        ${task.threadStateId !== undefined ? `<span>thread_state ${escapeHtml(task.threadStateId)}</span>` : ''}
        ${longest ? `<span>${uiText('最长外部段', 'Longest external segment')}: ${escapeHtml(longest.threadName || '-')} ${formatMs(longest.durationMs)}</span>` : ''}
      </div>
      ${renderWaker(analysis)}
      ${renderSources(analysis)}
    </section>
    ${renderAiSummary(aiSummary)}
    <section class="sp-critical-path-card"><h3>${uiText('异常判断', 'Anomaly assessment')}</h3>${renderAnomalies(analysis)}</section>
    ${renderSlices(analysis)}
    <section class="sp-critical-path-card"><h3>${uiText('唤醒链', 'Wakeup chain')}</h3>${renderChain(analysis)}</section>
    <section class="sp-critical-path-card"><h3>${uiText('关联模块', 'Related modules')}</h3>${renderModules(analysis)}</section>
    ${renderQuantification(analysis)}
    <section class="sp-critical-path-card"><h3>${uiText('下一步', 'Next steps')}</h3>${renderList(analysis.recommendations)}</section>
    ${analysis.warnings.length ? renderStatus(analysis.warnings.join('；'), false) : ''}
    <div class="sp-critical-path-actions">
      <button type="button" class="sp-critical-path-handoff">${uiText('在对话中继续追问', 'Continue in the conversation')}</button>
    </div>
  `;
}

function fixed(value: number | undefined | null): string {
  return Number.isFinite(value) ? Number(value).toFixed(2) : '-';
}

/**
 * The question the drawer hands to the conversation. Only ids and numbers go
 * in: trace-derived names and texts stay out of a message the user sends as
 * their own, and the agent re-reads the evidence itself from the ids.
 */
export function buildCriticalPathHandoffQuestion(analysis: CriticalPathAnalysis): string {
  const task = analysis.task;
  const selector =
    task.threadStateId !== undefined
      ? `thread_state_id=${task.threadStateId}`
      : `utid=${task.utid}, start_ts=${task.startTs}, end_ts=${task.startTs + task.dur}`;
  const longestMs = analysis.longestSegment?.durationMs;
  const segments = analysis.chainSegmentCount ?? analysis.wakeupChain.length;
  return uiText(
    `继续分析这个等待（${selector}，utid ${task.utid}）：窗口 ${fixed(analysis.totalMs)} ms，` +
      `外部阻塞 ${fixed(analysis.blockingMs)} ms（${fixed(analysis.externalBlockingPercentage)}%），` +
      `等待链 ${segments} 段${longestMs !== undefined ? `，最长外部段 ${fixed(longestMs)} ms` : ''}。` +
      `请重新取证：它在等什么、被谁唤醒，最值得先查哪一段。`,
    `Continue analyzing this wait (${selector}, utid ${task.utid}): window ${fixed(analysis.totalMs)} ms, ` +
      `external blocking ${fixed(analysis.blockingMs)} ms (${fixed(analysis.externalBlockingPercentage)}%), ` +
      `${segments} chain segments${longestMs !== undefined ? `, longest external segment ${fixed(longestMs)} ms` : ''}. ` +
      `Re-acquire the evidence: what it waited on, who woke it, and which segment to examine first.`,
  );
}

/** Put the question in the conversation composer and bring the assistant into view; never send it. */
function handOffToConversation(analysis: CriticalPathAnalysis, traceId: string): void {
  emitComposerDraft({text: buildCriticalPathHandoffQuestion(analysis), traceId});
  const floating = getFloatingState();
  if (floating.mode === 'sidebar' && floating.sidebar.collapsed) {
    updateFloatingState({sidebar: {collapsed: false}});
  }
}


export function setupCriticalPathExtension(
  trace: Trace,
  analysisBackendConnection?: AnalysisBackendConnection,
): {
  dispose: () => void;
} {
  const state: CriticalPathState = {
    open: false,
    loading: false,
    traceId: '',
    analysis: null,
    aiSummary: null,
    error: '',
    notice: '',
  };

  let disposed = false;
  let lifecycleGeneration = 0;
  let analysisAbortController: AbortController | undefined;
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
    if (disposed) return;
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
      ${state.notice ? renderStatus(state.notice, false) : ''}
      ${state.analysis ? renderCriticalPathDrawerBody(state.analysis, state.aiSummary) : ''}
    `;
    target
      .querySelector('.sp-critical-path-close')
      ?.addEventListener('click', () => {
        state.open = false;
        renderDrawer();
      });
    target
      .querySelectorAll<HTMLButtonElement>('.sp-critical-path-copy')
      .forEach((button) => {
        button.addEventListener('click', () => {
          const index = Number(button.dataset.hypothesisIndex);
          const sql = state.analysis?.quantification?.hypotheses[index]?.verificationSql;
          if (!sql) return;
          void copyTextToClipboard(sql).then((copied) => {
            if (disposed) return;
            state.notice = copied
              ? uiText('已复制验证 SQL。', 'Verification SQL copied.')
              : uiText('无法访问剪贴板，请手动复制。', 'The clipboard is unavailable; copy the SQL manually.');
            renderDrawer();
          });
        });
      });
    target
      .querySelector('.sp-critical-path-handoff')
      ?.addEventListener('click', () => {
        if (!state.analysis || !state.traceId) return;
        handOffToConversation(state.analysis, state.traceId);
        state.open = false;
        renderDrawer();
      });
  };

  const analyzeSelectedTask = async (): Promise<void> => {
    const generation = ++lifecycleGeneration;
    analysisAbortController?.abort();
    analysisAbortController = new AbortController();
    state.open = true;
    state.loading = true;
    state.error = '';
    state.notice = '';
    state.analysis = null;
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
        analysisBackendConnection,
      );
      state.traceId = traceId;
      const selectedTask = getSelectedTask(trace);
      // No limits of its own: the engine's `CRITICAL_PATH_DEFAULTS.ui` apply.
      const result = await fetchJson<CriticalPathAnalyzeResponse>(
        buildCriticalPathAnalyzeUrl(backendUrl, traceId),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept-Language': uiOutputLanguage(),
          },
          signal: analysisAbortController.signal,
          body: JSON.stringify({
            threadStateId: selectedTask.threadStateId,
            utid: selectedTask.utid,
            startTs: selectedTask.startTs,
            dur: selectedTask.dur,
            includeAi: true,
            outputLanguage: uiOutputLanguage(),
          }),
        },
      );
      if (disposed || generation !== lifecycleGeneration) return;
      state.analysis = result.presentationAnalysis;
      state.aiSummary = result.aiSummary ?? null;
    } catch (error: unknown) {
      if (disposed || generation !== lifecycleGeneration) return;
      const detail = error instanceof Error ? error.message : String(error);
      state.error = uiText(
        `Critical path 分析失败：${detail}`,
        `Critical-path analysis failed: ${detail}`,
      );
    } finally {
      if (disposed || generation !== lifecycleGeneration) return;
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
      lifecycleGeneration++;
      analysisAbortController?.abort();
      analysisAbortController = undefined;
      observer.disconnect();
      removeInlineButtons();
      drawer?.remove();
      drawer = null;
    },
  };
}
