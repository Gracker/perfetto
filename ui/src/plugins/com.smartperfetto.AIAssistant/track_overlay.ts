// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Generic Track Overlay Engine — visualizes analysis results as
 * color-coded slices pinned to the top of the Perfetto timeline.
 *
 * Supports multiple overlay types via a declarative configuration registry.
 * Each overlay type defines its column mappings, pivot/color strategy,
 * and optional custom name generator.
 *
 * Currently registered overlays:
 * - **jank**: Jank frame analysis (from `get_app_jank_frames`)
 * - **scene_timeline**: Scene reconstruction timeline (from `clean_timeline`)
 * - **pipeline_slices**: Pipeline key slices for teaching (from `pipeline_key_slices_overlay`)
 *
 * Data flow:
 *   SSE DataEnvelope → STEP_TO_OVERLAY routing → createOverlayTrack()
 *   → SQL VALUES injection → addDebugSliceTrack() → pinned timeline tracks
 */

import {Trace} from '../../public/trace';
import {addDebugSliceTrack} from '../../components/tracks/debug_tracks';

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

/** Registered overlay type identifiers. */
type OverlayId =
  | 'jank'
  | 'scene_timeline'
  | 'pipeline_slices'
  | 'state_device'
  | 'state_input'
  | 'state_app'
  | 'state_system';

/** Declarative configuration for a track overlay type. */
interface OverlayConfig {
  /** Unique identifier for this overlay type */
  id: OverlayId;
  /** Display title for the debug track */
  trackTitle: string;
  /** Column mapping: which data columns map to ts/dur/name */
  columns: {
    ts: string;
    dur: string;
    name: string; // Used directly unless nameGenerator is provided
  };
  /** Column to pivot on — creates one track per distinct value */
  pivotOn?: string;
  /** Column to use for slice coloring */
  colorColumn?: string;
  /** Extra columns to show in the details panel when a slice is clicked */
  rawColumns: string[];
  /** Custom label generator. If omitted, the `name` column value is used. */
  nameGenerator?: (
    row: unknown[],
    idx: (name: string) => number,
  ) => string;
  /** Max rows to inject into SQL (safety limit). Default: 500 */
  maxRows?: number;
}

// ---------------------------------------------------------------------------
// Jank-specific name generator
// ---------------------------------------------------------------------------

function generateJankSliceName(responsibility: string, durMs: number): string {
  const rounded = Math.round(durMs);
  switch (responsibility) {
    case 'APP':
      return `APP ${rounded}ms`;
    case 'SF':
      return `SF ${rounded}ms`;
    case 'HIDDEN':
      return `隐形掉帧 ${rounded}ms`;
    case 'BUFFER_STUFFING':
      return '管线耗尽';
    default:
      return `${responsibility} ${rounded}ms`;
  }
}

// ---------------------------------------------------------------------------
// Overlay configuration registry
// ---------------------------------------------------------------------------

const OVERLAY_CONFIGS = new Map<OverlayId, OverlayConfig>([
  [
    'jank',
    {
      id: 'jank',
      trackTitle: 'AI Jank Analysis',
      columns: {ts: 'start_ts', dur: 'dur', name: '_generated'},
      pivotOn: 'layer_name',
      colorColumn: 'jank_responsibility',
      rawColumns: [
        'frame_id',
        'dur_ms',
        'jank_type',
        'jank_cause',
        'vsync_missed',
        'present_interval_ms',
        'process_name',
      ],
      nameGenerator: (row, idx) =>
        generateJankSliceName(
          String(row[idx('jank_responsibility')] ?? 'UNKNOWN'),
          idx('dur_ms') >= 0
            ? Number(row[idx('dur_ms')] || 0)
            : Number(row[idx('dur')] || 0) / 1e6,
        ),
    },
  ],
  [
    'scene_timeline',
    {
      id: 'scene_timeline',
      trackTitle: 'AI Scene Timeline',
      columns: {ts: 'ts', dur: 'dur', name: 'event'},
      colorColumn: 'event_type',
      rawColumns: [
        'event_id',
        'dur_ms',
        'event_type',
        'app_package',
        'rating',
      ],
      // event column already contains descriptive labels like
      // "冷启动 tiktok [1250ms]", "滑动 (23次移动, 580ms)"
    },
  ],
  [
    'pipeline_slices',
    {
      id: 'pipeline_slices',
      trackTitle: 'Pipeline Key Slices',
      columns: {ts: 'ts', dur: 'dur', name: 'slice_name'},
      pivotOn: 'thread_name',
      colorColumn: 'pipeline_stage',
      rawColumns: [
        'slice_name',
        'dur_ms',
        'thread_name',
        'process_name',
        'description',
      ],
    },
  ],
]);

// ---------------------------------------------------------------------------
// State lane overlay factory — shared config for continuous state timeline
// ---------------------------------------------------------------------------

function makeStateLaneOverlay(
  id: OverlayId,
  title: string,
  extraRawCols: string[] = [],
): [OverlayId, OverlayConfig] {
  return [
    id,
    {
      id,
      trackTitle: title,
      columns: {ts: 'start_ts', dur: 'dur_ns', name: 'state_label'},
      colorColumn: 'state',
      rawColumns: [
        'state',
        'dur_ms',
        'state_label',
        'source_status',
        ...extraRawCols,
      ],
      maxRows: 1000,
    },
  ];
}

// Register state lane overlays
OVERLAY_CONFIGS.set(...makeStateLaneOverlay('state_device', 'Device State'));
OVERLAY_CONFIGS.set(
  ...makeStateLaneOverlay('state_input', 'User Input', ['app_package']),
);
OVERLAY_CONFIGS.set(...makeStateLaneOverlay('state_app', 'App State'));
OVERLAY_CONFIGS.set(
  ...makeStateLaneOverlay('state_system', 'System State', ['confidence']),
);

// ---------------------------------------------------------------------------
// stepId → overlayId routing table
// ---------------------------------------------------------------------------

/**
 * Maps SSE DataEnvelope stepId values to overlay config IDs.
 * Used by sse_event_handlers.ts to route incoming data to the right overlay.
 */
export const STEP_TO_OVERLAY = new Map<string, OverlayId>([
  ['get_app_jank_frames', 'jank'],
  ['batch_frame_root_cause', 'jank'],
  ['clean_timeline', 'scene_timeline'],
  ['pipeline_key_slices_overlay', 'pipeline_slices'],
  // State timeline lanes (continuous state coverage)
  ['device_state_lane', 'state_device'],
  ['input_state_lane', 'state_input'],
  ['app_state_lane', 'state_app'],
  ['system_state_lane', 'state_system'],
]);

// ---------------------------------------------------------------------------
// Per-overlay state: TrackNode IDs for cleanup
// ---------------------------------------------------------------------------

const activeTrackNodes = new Map<OverlayId, string[]>();

// ---------------------------------------------------------------------------
// SQL utilities
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROWS = 500;

// Pre-compiled regexes for sqlValue() — avoids per-call compilation
const RE_INTEGER = /^-?\d+$/;
const RE_FLOAT = /^-?\d+\.\d+$/;

/**
 * Convert a JS value to a SQL literal for use in a VALUES clause.
 *
 * - null/undefined/empty → NULL
 * - numbers → unquoted (integers stay integer, floats get 6dp)
 * - bigints → unquoted
 * - numeric-looking strings (BigInt timestamps) → unquoted
 * - other strings → single-quoted with internal quotes escaped
 */
function sqlValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'NULL';

  if (typeof value === 'number') {
    if (isNaN(value)) return 'NULL';
    return Number.isInteger(value) ? String(value) : value.toFixed(6);
  }
  if (typeof value === 'bigint') return String(value);

  const str = String(value);
  if (RE_INTEGER.test(str) || RE_FLOAT.test(str)) return str;

  return `'${str.replace(/'/g, "''")}'`;
}

// ---------------------------------------------------------------------------
// Core overlay functions
// ---------------------------------------------------------------------------

/**
 * Create an overlay track on the Perfetto timeline.
 *
 * Looks up the overlay configuration by `overlayId`, builds a SQL CTE
 * with VALUES from the provided data, and creates debug slice tracks.
 *
 * @param trace      The current Perfetto Trace instance
 * @param overlayId  Key into OVERLAY_CONFIGS (e.g., 'jank', 'scene_timeline')
 * @param columns    Column names from the DataEnvelope
 * @param rows       Row data (2D array) from the DataEnvelope
 */
export async function createOverlayTrack(
  trace: Trace,
  overlayId: string,
  columns: string[],
  rows: unknown[][],
): Promise<void> {
  const config = OVERLAY_CONFIGS.get(overlayId as OverlayId);
  if (!config) {
    console.warn(`[TrackOverlay] Unknown overlay: ${overlayId}`);
    return;
  }

  // Clean up previous overlay of the same type (idempotent)
  cleanupOverlayTracks(trace, overlayId);

  if (!rows.length || !columns.length) return;

  // Column index lookup helper
  const idx = (name: string) => columns.indexOf(name);

  const tsIdx = idx(config.columns.ts);
  const durIdx = idx(config.columns.dur);

  // Require ts and dur columns
  if (tsIdx < 0 || durIdx < 0) {
    console.warn(`[TrackOverlay:${overlayId}] Missing ts/dur columns:`, {
      [config.columns.ts]: tsIdx,
      [config.columns.dur]: durIdx,
    });
    return;
  }

  // If no nameGenerator, require the name column
  const nameIdx = config.nameGenerator ? -1 : idx(config.columns.name);
  if (!config.nameGenerator && nameIdx < 0) {
    console.warn(
      `[TrackOverlay:${overlayId}] Missing name column: ${config.columns.name}`,
    );
    return;
  }

  // Safety: cap rows
  const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
  const limitedRows = rows.slice(0, maxRows);

  // Filter rawColumns to those present in the data
  const rawCols = config.rawColumns.filter((c) => idx(c) >= 0);

  // Pre-cache column indices to avoid repeated indexOf calls in the row loop
  const colorIdx = config.colorColumn ? idx(config.colorColumn) : -1;
  const pivotIdx = config.pivotOn ? idx(config.pivotOn) : -1;
  const rawColIndices = rawCols.map((c) => idx(c));

  // Build CTE column list
  const cteColumns = [
    config.columns.ts, // ts
    config.columns.dur, // dur
    'name', // generated or from data
    ...(colorIdx >= 0 ? [config.colorColumn!] : []),
    ...(pivotIdx >= 0 ? [config.pivotOn!] : []),
    ...rawCols,
  ];

  // Build VALUES tuples
  const valueTuples = limitedRows.map((row) => {
    // Name: use generator or column value
    const name = config.nameGenerator
      ? config.nameGenerator(row, idx)
      : String(row[nameIdx] ?? '');

    const vals = [
      sqlValue(row[tsIdx]),
      sqlValue(row[durIdx]),
      sqlValue(name),
      ...(colorIdx >= 0 ? [sqlValue(row[colorIdx])] : []),
      ...(pivotIdx >= 0 ? [sqlValue(row[pivotIdx])] : []),
      ...rawColIndices.map((i) => sqlValue(row[i])),
    ];

    return `(${vals.join(', ')})`;
  });

  const sqlSource = `
    WITH source(${cteColumns.join(', ')}) AS (
      VALUES
        ${valueTuples.join(',\n        ')}
    )
    SELECT * FROM source
  `;

  // Snapshot pinned track node IDs before creation
  const pinnedNode = trace.currentWorkspace.pinnedTracksNode;
  const beforeIds = new Set(pinnedNode.children.map((n) => n.id));

  await addDebugSliceTrack({
    trace,
    data: {sqlSource},
    title: config.trackTitle,
    columns: {ts: config.columns.ts, dur: config.columns.dur, name: 'name'},
    ...(pivotIdx >= 0 ? {pivotOn: config.pivotOn} : {}),
    ...(colorIdx >= 0 ? {colorColumn: config.colorColumn} : {}),
    rawColumns: rawCols,
  });

  // Record newly created node IDs for future cleanup
  const newNodeIds = pinnedNode.children
    .filter((n) => !beforeIds.has(n.id))
    .map((n) => n.id);
  activeTrackNodes.set(config.id, newNodeIds);

  console.log(
    `[TrackOverlay:${overlayId}] Created ${newNodeIds.length} track(s) ` +
      `with ${limitedRows.length} row(s)`,
  );
}

/**
 * Remove overlay tracks from the timeline.
 *
 * @param trace      The current Perfetto Trace instance
 * @param overlayId  If provided, remove only tracks of this overlay type.
 *                   If omitted, remove ALL AI overlay tracks.
 */
export function cleanupOverlayTracks(trace: Trace, overlayId?: string): void {
  const idsToClean: OverlayId[] = overlayId
    ? (OVERLAY_CONFIGS.has(overlayId as OverlayId) ? [overlayId as OverlayId] : [])
    : Array.from(activeTrackNodes.keys());

  const pinnedNode = trace.currentWorkspace.pinnedTracksNode;
  let removed = 0;

  for (const id of idsToClean) {
    const nodeIds = activeTrackNodes.get(id);
    if (!nodeIds || nodeIds.length === 0) continue;

    for (const nodeId of nodeIds) {
      const node = pinnedNode.children.find((n) => n.id === nodeId);
      if (node) {
        node.remove();
        removed++;
      }
    }
    activeTrackNodes.delete(id);
  }

  if (removed > 0) {
    console.log(
      `[TrackOverlay] Cleaned up ${removed} track(s)` +
        (overlayId ? ` for ${overlayId}` : ' (all)'),
    );
  }
}
