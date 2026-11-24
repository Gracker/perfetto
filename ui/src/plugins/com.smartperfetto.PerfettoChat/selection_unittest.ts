// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {HighPrecisionTimeSpan} from '../../base/high_precision_time_span';
import type {time} from '../../base/time';
import type {Trace} from '../../public/trace';
import {captureSelection, locateReference} from './selection';
import {describe, expect, it, vi} from 'vitest';

const start = 9007199254740993n as time;
const end = 9007199254741993n as time;
const eventTs = 9007199254741103n as time;
const scrollTo = vi.fn();
function trace(selection: object): Trace {
  return {
    traceInfo: {start, end},
    selection: {selection},
    currentWorkspace: {getTrackByUri: () => ({name: 'RenderThread'})},
    timeline: {visibleWindow: HighPrecisionTimeSpan.fromTime(start, end)},
    scrollTo,
  } as unknown as Trace;
}

describe('PerfettoChatViewer selection', () => {
  it('captures absolute area, visible-window, and instant-event times without converting to a JS number', () => {
    expect(captureSelection(trace({kind: 'area', start, end, trackUris: ['render']}), 'trace-a', 'selection'))
      .toEqual({kind: 'area', traceId: 'trace-a', startNs: String(start), endNs: String(end),
        trackHints: [{kind: 'track', label: 'RenderThread'}]});
    expect(captureSelection(trace({kind: 'empty'}), 'trace-a', 'visible_window'))
      .toEqual({kind: 'visible_window', traceId: 'trace-a', startNs: String(start), endNs: String(end)});
    expect(captureSelection(trace({kind: 'track_event', ts: eventTs, dur: -1n, trackUri: 'render'}), 'trace-a', 'selection'))
      .toMatchObject({kind: 'event', startNs: String(eventTs), endNs: String(eventTs)});
  });

  it('uses the whole-file scope for an empty selection and ignores a reference to a previous Trace', () => {
    scrollTo.mockClear();
    const active = trace({kind: 'empty'});
    expect(captureSelection(active, 'trace-b', 'selection')).toEqual({kind: 'whole_trace', traceId: 'trace-b'});
    const reference = {traceId: 'trace-a', referenceId: 'ref', label: 'query/start', startNs: String(start), endNs: String(end)};
    locateReference(active, 'trace-b', reference);
    expect(scrollTo).not.toHaveBeenCalled();
    locateReference(active, 'trace-a', reference);
    expect(scrollTo).toHaveBeenCalledWith({time: {start, end, behavior: 'focus'}});
  });
});
