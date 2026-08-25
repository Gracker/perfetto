// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {
  loadPersistedTracePairWorkspace,
  persistTracePairWorkspace,
} from './trace_pair_workspace_persistence';

describe('trace pair workspace persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores an arbitrary pair and layout for the same backend workspace', () => {
    const controller = new TracePairWorkspaceController();
    controller.open({
      scope: {
        key: 'tenant/user/workspace',
        backendUrl: 'http://127.0.0.1:3000',
      },
    });
    controller.setCatalog([
      {id: 'baseline', filename: 'baseline.pftrace', size: 10},
      {id: 'comparison', filename: 'comparison.pftrace', size: 20},
    ]);
    controller.selectTrace({pane: 'first', traceId: 'baseline'});
    controller.selectTrace({pane: 'second', traceId: 'comparison'});
    controller.setLayout('vertical');
    controller.setSplitPercent(63);

    persistTracePairWorkspace(
      controller.getState(),
      'http://127.0.0.1:3000/',
    );

    expect(
      loadPersistedTracePairWorkspace('http://127.0.0.1:3000'),
    ).toMatchObject({
      open: true,
      baseline: {id: 'baseline', filename: 'baseline.pftrace'},
      comparison: {id: 'comparison', filename: 'comparison.pftrace'},
      layout: 'vertical',
      splitPercent: 63,
    });
    expect(
      loadPersistedTracePairWorkspace('http://127.0.0.1:4000'),
    ).toBeUndefined();
  });
});
