// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Trace} from '../../public/trace';
import type {time} from '../../base/time';

export type Focus = 'selection' | 'whole_trace' | 'visible_window';

export interface ChatSelection {
  traceId: string;
  kind: 'whole_trace' | 'area' | 'event' | 'visible_window';
  startNs?: string;
  endNs?: string;
  trackHints?: {kind: 'track'; label: string}[];
}

export function captureSelection(trace: Trace, traceId: string, focus: Focus): ChatSelection {
  const whole: ChatSelection = {kind: 'whole_trace', traceId};
  const {start: traceStart, end: traceEnd} = trace.traceInfo;
  function range(kind: ChatSelection['kind'], start: bigint, end: bigint, labels: string[] = []): ChatSelection {
    start = start < traceStart ? traceStart : start;
    end = end > traceEnd ? traceEnd : end;
    if (end < start || (end === start && kind !== 'event')) return whole;
    return {traceId, kind, startNs: start.toString(), endNs: end.toString(),
      ...(labels.length ? {trackHints: labels.map(label => ({kind: 'track', label: label.slice(0, 160)}))} : {})};
  }
  if (focus === 'whole_trace') return whole;
  if (focus === 'visible_window') {
    const {start, end} = trace.timeline.visibleWindow.toTimeSpan();
    return range('visible_window', start, end);
  }
  const selection = trace.selection.selection;
  if (selection.kind === 'area') {
    return range('area', selection.start, selection.end, selection.trackUris.slice(0, 4).flatMap(uri => {
      const node = trace.currentWorkspace.getTrackByUri(uri);
      return node ? [node.name] : [];
    }));
  }
  if (selection.kind === 'track_event') {
    const track = trace.currentWorkspace.getTrackByUri(selection.trackUri);
    return range('event', selection.ts, selection.ts + (selection.dur && selection.dur > 0n ? selection.dur : 0n),
      track ? [track.name] : []);
  }
  return whole;
}

export interface TraceReference {
  traceId: string;
  referenceId: string;
  label: string;
  startNs: string;
  endNs: string;
}

export function locateReference(trace: Trace, traceId: string, reference: TraceReference): void {
  if (reference.traceId !== traceId || !/^-?\d{1,19}$/.test(reference.startNs) ||
      !/^-?\d{1,19}$/.test(reference.endNs)) return;
  const start = BigInt(reference.startNs) as time;
  const end = BigInt(reference.endNs) as time;
  if (start < trace.traceInfo.start || end > trace.traceInfo.end || end <= start) return;
  trace.scrollTo({time: {start, end, behavior: 'focus'}});
}
