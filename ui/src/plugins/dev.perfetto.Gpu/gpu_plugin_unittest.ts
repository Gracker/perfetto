// Copyright (C) 2026 The Android Open Source Project
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

import {errResult, okResult} from '../../base/result';
import GpuPlugin from './index';

function scalarResult(cnt: number) {
  return {
    firstRow: () => ({cnt}),
  };
}

function emptyRowsResult() {
  return {
    iter: () => ({
      valid: () => false,
      next: () => {},
    }),
  };
}

describe('GpuPlugin', () => {
  it('does not require the newer gpu table when loading traces', async () => {
    const engine = {
      query: vi.fn(async (_sql: string) => emptyRowsResult()),
      tryQuery: vi.fn(async (sql: string) => {
        if (sql.includes('sqlite_master') || sql.includes('pragma_table_info')) {
          return okResult(scalarResult(0));
        }
        if (sql.includes('count(distinct gpu_id)')) {
          return okResult(scalarResult(1));
        }
        if (sql.includes('from gpu_counter_group')) {
          return errResult('no such column: name');
        }
        return okResult(emptyRowsResult());
      }),
    };
    const trace = {
      engine,
      tracks: {registerTrack: vi.fn()},
      plugins: {getPlugin: vi.fn()},
      defaultWorkspace: {},
    };

    await expect(new GpuPlugin().onTraceLoad(trace as any)).resolves.toBeUndefined();

    const querySql = engine.query.mock.calls.map(([sql]) => sql).join('\n');
    expect(querySql).not.toContain('left join gpu');
    expect(querySql).toContain('null as gpuName');
    expect(querySql).toContain('null as gpu_name');
  });
});
