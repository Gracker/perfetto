// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Area Selection Analysis Tab — "AI Analyze"
 *
 * Registered via trace.selection.registerAreaSelectionTab(). When the user
 * selects a time or track range, this tab appears in the bottom details panel
 * alongside built-in Perfetto tabs (Slices, Thread States, etc.).
 *
 * Two-tier interaction:
 *   1. **Quick stats** — instant SQL queries for the selected range (slice
 *      count, avg/max duration, frame/jank counts if available). No AI needed.
 *   2. **"Deep Analyze with AI"** — sets pendingSelectionAnalysis in shared
 *      state, opens the AI dock, auto-triggers analysis scoped to the selection.
 */

import m from 'mithril';
import {AreaSelection, AreaSelectionTab, ContentWithLoadingFlag} from '../../public/selection';
import {Trace} from '../../public/trace';
import {Icon} from '../../widgets/icon';
import {NUM, NUM_NULL} from '../../trace_processor/query_result';
import {updateAISharedState, getAISharedState} from './ai_shared_state';
import {formatDurationAuto} from './renderers/formatters';
import {switchFloatingMode} from './ai_transient_state';

// ── Quick-stats data structures ─────────────────────────────────────────

interface QuickStats {
  sliceCount: number;
  avgDurNs: number;
  maxDurNs: number;
  /** null = `actual_frame_timeline_event` table is not present in the trace. */
  frameCount: number | null;
  jankCount: number | null;
  durationNs: bigint;
  trackCount: number;
}

// ── Styles ──────────────────────────────────────────────────────────────

const ANALYZE_BTN_BASE = `
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
`;

const STAT_VALUE_BASE = `
  font-size: 16px;
  font-weight: 600;
`;

const STYLES = {
  container: `
    padding: 8px 12px;
    font-family: 'Roboto', sans-serif;
    font-size: 13px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  `,
  header: `
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 500;
    color: var(--chat-primary, #3d5688);
    font-size: 13px;
  `,
  statsGrid: `
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 6px;
  `,
  statCard: `
    background: var(--chat-bg-secondary, #f8f9fa);
    border-radius: 6px;
    padding: 8px 10px;
    border: 1px solid var(--chat-border, #e8eaed);
  `,
  statLabel: `
    font-size: 11px;
    color: var(--chat-text-secondary, #5f6368);
    margin-bottom: 2px;
  `,
  statValue: `${STAT_VALUE_BASE} color: var(--chat-text, #202124);`,
  statValueWarning: `${STAT_VALUE_BASE} color: var(--chat-error, #ea4335);`,
  analyzeBtn: `
    ${ANALYZE_BTN_BASE}
    background: var(--chat-primary, #3d5688);
    color: white;
    cursor: pointer;
    transition: background 0.15s;
  `,
  analyzeBtnDisabled: `
    ${ANALYZE_BTN_BASE}
    background: var(--chat-bg-tertiary, #dadce0);
    color: var(--chat-text-secondary, #80868b);
    cursor: not-allowed;
  `,
  actions: `
    display: flex;
    gap: 8px;
    align-items: center;
    margin-top: 2px;
  `,
  hint: `
    font-size: 11px;
    color: var(--chat-text-secondary, #80868b);
    font-style: italic;
  `,
  errorText: `color: var(--chat-error, #ea4335); font-size: 12px;`,
} as const;

const ANALYZE_BTN_HOVER_BG = 'var(--chat-primary-hover, #2e4470)';
const ANALYZE_BTN_BG = 'var(--chat-primary, #3d5688)';

// ── Factory ─────────────────────────────────────────────────────────────

/**
 * Creates and returns an AreaSelectionTab that integrates with the AI
 * Assistant. Registered once during onTraceLoad.
 */
export function createAIAreaSelectionTab(trace: Trace): AreaSelectionTab {
  // Closure state — survives across render cycles for the same trace.
  let lastSelKey = '';
  let stats: QuickStats | null = null;
  let loading = false;
  let queryError: string | null = null;

  /** Derive a cache key from selection boundaries + track identity. */
  function selectionKey(sel: AreaSelection): string {
    // Include full trackUris to avoid false cache hits when tracks differ
    // but time range and count happen to match (Codex review #1).
    return `${sel.start}_${sel.end}_${sel.trackUris.join(',')}`;
  }

  /** Fire-and-forget stats query (deduplicated by selectionKey). */
  function fetchStatsIfNeeded(sel: AreaSelection): void {
    const key = selectionKey(sel);
    if (key === lastSelKey) return;
    lastSelKey = key;
    loading = true;
    stats = null;
    queryError = null;

    fetchQuickStats(trace, sel).then((result) => {
      stats = result;
      loading = false;
      m.redraw();
    }).catch((e) => {
      queryError = String(e);
      loading = false;
      m.redraw();
    });
  }

  /** Trigger AI analysis scoped to this selection. */
  function analyzeWithAI(sel: AreaSelection): void {
    // Guard: don't queue a new analysis if one is already in flight.
    if (getAISharedState().status === 'analyzing') return;
    // Convert bigint→number for JSON serialization compatibility (Codex #6).
    updateAISharedState({
      pendingSelectionAnalysis: {
        startNs: Number(sel.start),
        endNs: Number(sel.end),
        trackUris: [...sel.trackUris],
      },
    });
    switchFloatingMode('sidebar');
  }

  return {
    id: 'smartperfetto-ai-analyze',
    name: 'AI Analyze',
    priority: 50,  // Appear early (higher = first)

    render(selection: AreaSelection): ContentWithLoadingFlag | undefined {
      fetchStatsIfNeeded(selection);

      const aiState = getAISharedState();
      const isAnalyzing = aiState.status === 'analyzing';
      const durationNs = selection.end - selection.start;
      const hintText = isAnalyzing
        ? aiState.currentPhase || '正在分析...'
        : '将选区发送到 AI Agent 进行深度性能分析';

      // Stats area: render the grid once data arrives, otherwise show
      // an error message or nothing while loading.
      let statsView: m.Children = null;
      if (stats) {
        statsView = renderStatsGrid(stats);
      } else if (queryError) {
        statsView = m('div', {style: STYLES.errorText}, `Stats error: ${queryError}`);
      }

      return {
        isLoading: loading,
        content: m('div', {style: STYLES.container}, [
          // ── Header ──
          m('div', {style: STYLES.header}, [
            m('span', {style: 'font-size: 16px'}, '\u{1F50D}'),
            m('span', `选区分析 · ${formatDurationAuto(Number(durationNs))} · ${selection.trackUris.length} tracks`),
          ]),

          // ── Quick Stats Grid ──
          statsView,

          // ── Actions ──
          m('div', {style: STYLES.actions}, [
            m('button', {
              style: isAnalyzing ? STYLES.analyzeBtnDisabled : STYLES.analyzeBtn,
              disabled: isAnalyzing,
              onclick: () => analyzeWithAI(selection),
              onmouseover: (e: MouseEvent) => {
                if (!isAnalyzing) (e.target as HTMLElement).style.background = ANALYZE_BTN_HOVER_BG;
              },
              onmouseout: (e: MouseEvent) => {
                if (!isAnalyzing) (e.target as HTMLElement).style.background = ANALYZE_BTN_BG;
              },
            }, [
              m(Icon, {icon: 'smart_toy', style: 'font-size: 16px'}),
              isAnalyzing ? 'AI 分析中...' : 'AI 深度分析',
            ]),
            m('span', {style: STYLES.hint}, hintText),
          ]),
        ]),
      };
    },
  };
}

// ── Stats rendering ─────────────────────────────────────────────────────

function renderStatsGrid(s: QuickStats): m.Children {
  const cards: Array<{label: string; value: string; warn?: boolean}> = [
    {label: 'Slices', value: s.sliceCount.toLocaleString()},
    {label: 'Avg Duration', value: formatDurationAuto(s.avgDurNs)},
    {label: 'Max Duration', value: formatDurationAuto(s.maxDurNs)},
  ];

  if (s.frameCount !== null) {
    cards.push({label: 'Frames', value: String(s.frameCount)});
  }
  if (s.jankCount !== null && s.frameCount !== null) {
    const rate = s.frameCount > 0
      ? ((s.jankCount / s.frameCount) * 100).toFixed(1) + '%'
      : '0%';
    cards.push({
      label: 'Jank Rate',
      value: `${s.jankCount} (${rate})`,
      warn: s.jankCount > 0,
    });
  }

  return m('div', {style: STYLES.statsGrid},
    cards.map((c) =>
      m('div', {style: STYLES.statCard}, [
        m('div', {style: STYLES.statLabel}, c.label),
        m('div', {style: c.warn ? STYLES.statValueWarning : STYLES.statValue}, c.value),
      ]),
    ),
  );
}

// ── SQL queries ─────────────────────────────────────────────────────────

async function fetchQuickStats(
  trace: Trace,
  sel: AreaSelection,
): Promise<QuickStats> {
  const engine = trace.engine;
  const {start, end} = sel;

  // Query 1: Slice statistics in the selected range
  const sliceResult = await engine.query(`
    WITH clipped AS (
      SELECT MIN(ts + dur, ${end}) - MAX(ts, ${start}) AS clipped_dur
      FROM slice
      WHERE ts < ${end} AND ts + dur > ${start} AND dur > 0
    )
    SELECT
      COUNT(*) AS cnt,
      CAST(IFNULL(AVG(clipped_dur), 0) AS INTEGER) AS avg_dur,
      CAST(IFNULL(MAX(clipped_dur), 0) AS INTEGER) AS max_dur
    FROM clipped
    WHERE clipped_dur > 0
  `);

  const sliceRow = sliceResult.iter({
    cnt: NUM,
    avg_dur: NUM,
    max_dur: NUM,
  });

  let sliceCount = 0;
  let avgDurNs = 0;
  let maxDurNs = 0;
  if (sliceRow.valid()) {
    sliceCount = sliceRow.cnt;
    avgDurNs = sliceRow.avg_dur;
    maxDurNs = sliceRow.max_dur;
  }

  // Query 2: Frame/jank statistics (graceful degradation if table absent)
  let frameCount: number | null = null;
  let jankCount: number | null = null;

  const frameResult = await engine.tryQuery(`
    SELECT
      COUNT(*) AS frame_cnt,
      SUM(CASE WHEN jank_type != 'None' AND jank_type IS NOT NULL THEN 1 ELSE 0 END) AS jank_cnt
    FROM actual_frame_timeline_event
    WHERE ts < ${end} AND ts + dur > ${start}
  `);

  if (frameResult.ok) {
    const frameRow = frameResult.value.iter({
      frame_cnt: NUM,
      jank_cnt: NUM_NULL,
    });
    if (frameRow.valid()) {
      frameCount = frameRow.frame_cnt;
      jankCount = frameRow.jank_cnt ?? 0;
    }
  }
  // If tryQuery failed (table doesn't exist), frameCount/jankCount stay null

  return {
    sliceCount,
    avgDurNs,
    maxDurNs,
    frameCount,
    jankCount,
    durationNs: end - start,
    trackCount: sel.trackUris.length,
  };
}
