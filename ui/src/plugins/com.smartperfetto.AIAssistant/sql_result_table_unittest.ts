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

import {describe, it, expect, jest} from '@jest/globals';

import {SqlResultTable, UserInteraction} from './sql_result_table';

describe('SqlResultTable unit handling', () => {
  it('formats duration values in milliseconds only', () => {
    const table = new SqlResultTable() as any;

    expect(table.formatDuration(16666667n)).toBe('16.67ms');
    expect(table.formatDuration(1500n)).toBe('0.0015ms');
    expect(table.formatDuration(1500000000n)).toBe('1500.0ms');
  });

  it('converts mixed units to nanoseconds consistently', () => {
    const table = new SqlResultTable() as any;

    expect(table.parseTimeValueToNs('1.5', 'ms')).toBe(1500000n);
    expect(table.parseTimeValueToNs('1500', 'us')).toBe(1500000n);
    expect(table.parseTimeValueToNs(2, 's')).toBe(2000000000n);
    expect(table.parseTimeValueToNs(10n, 'ms')).toBe(10000000n);
  });

  it('binds duration range only to start-like timestamp columns', () => {
    const table = new SqlResultTable() as any;

    const detected = table.detectTimestampColumns(['start_ts', 'end_ts', 'duration_ms']);
    const start = detected.find((v: any) => v.columnName === 'start_ts');
    const end = detected.find((v: any) => v.columnName === 'end_ts');

    expect(start).toBeDefined();
    expect(start.durationColumnName).toBe('duration_ms');
    expect(start.durationUnit).toBe('ms');

    expect(end).toBeDefined();
    expect(end.durationColumnName).toBeUndefined();
  });

  it('emits ns timeRange for timestamp range click', () => {
    const table = new SqlResultTable() as any;
    const trace = {scrollTo: jest.fn()} as any;
    const onInteraction = jest.fn();

    table.timestampColumns = [{
      columnIndex: 0,
      columnName: 'start_ts',
      unit: 'ns',
      durationColumnIndex: 1,
      durationColumnName: 'dur_ms',
      durationUnit: 'ms',
    }];

    const vnode: any = table.renderCellPerfetto(
      '123',
      0,
      'col-timestamp',
      trace,
      ['123', 1.5],
      ['start_ts', 'dur_ms'],
      onInteraction,
      {
        name: 'start_ts',
        type: 'timestamp',
        clickAction: 'navigate_range',
        durationColumn: 'dur_ms',
        unit: 'ns',
      }
    );

    vnode.attrs.onclick({stopPropagation: jest.fn()} as any);

    expect(trace.scrollTo).toHaveBeenCalledTimes(1);
    expect(onInteraction).toHaveBeenCalledTimes(1);
    const interaction = onInteraction.mock.calls[0][0] as UserInteraction;
    expect(interaction.target.timeRange).toEqual({
      start: '123',
      end: '1500123',
    });
  });

  it('emits ns point range for timestamp click without duration', () => {
    const table = new SqlResultTable() as any;
    const trace = {scrollTo: jest.fn()} as any;
    const onInteraction = jest.fn();

    table.timestampColumns = [{
      columnIndex: 0,
      columnName: 'ts_ms',
      unit: 'ms',
    }];

    const vnode: any = table.renderCellPerfetto(
      1.5,
      0,
      'col-timestamp',
      trace,
      [1.5],
      ['ts_ms'],
      onInteraction,
      {
        name: 'ts_ms',
        type: 'timestamp',
        clickAction: 'navigate_timeline',
        unit: 'ms',
      }
    );

    vnode.attrs.onclick({stopPropagation: jest.fn()} as any);

    expect(trace.scrollTo).toHaveBeenCalledTimes(1);
    expect(onInteraction).toHaveBeenCalledTimes(1);
    const interaction = onInteraction.mock.calls[0][0] as UserInteraction;
    expect(interaction.target.timeRange).toEqual({
      start: '1500000',
      end: '1500000',
    });
  });
});
