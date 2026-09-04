// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  RUN_CONFLICT_RETRY_INTERVAL_MS,
  RUN_CONFLICT_WAIT_MS,
  isTransientRunConflict,
} from './analysis_run_conflict';

describe('run conflict classification', () => {
  it('treats a still-cancelling session as worth waiting for', () => {
    expect(isTransientRunConflict(409, {code: 'CANCELLATION_IN_PROGRESS'})).toBe(true);
  });

  it('does not wait on an active run', () => {
    // The backend returns this for a session parked in `awaiting_user` too,
    // which needs the respond flow and never clears by waiting.
    expect(isTransientRunConflict(409, {code: 'RUN_ALREADY_ACTIVE'})).toBe(false);
  });

  it('leaves a code-aware context conflict to its own fallback', () => {
    // Retrying this one would loop against a backend that will keep refusing.
    expect(isTransientRunConflict(409, {code: 'CODEBASE_ANALYSIS_DISABLED'})).toBe(false);
  });

  it('does not wait on an unknown conflict code', () => {
    expect(isTransientRunConflict(409, {code: 'SOMETHING_NEW'})).toBe(false);
    expect(isTransientRunConflict(409, {})).toBe(false);
    expect(isTransientRunConflict(409, null)).toBe(false);
  });

  it('ignores every non-409 status', () => {
    for (const status of [200, 400, 404, 429, 500]) {
      expect(isTransientRunConflict(status, {code: 'CANCELLATION_IN_PROGRESS'})).toBe(false);
    }
  });

  it('bounds the wait well above the measured settle window', () => {
    // A mid-run stop settled in ~2.4s; the bound must clear that with margin
    // while still failing rather than hanging.
    expect(RUN_CONFLICT_WAIT_MS).toBeGreaterThan(2_400);
    expect(RUN_CONFLICT_WAIT_MS).toBeLessThanOrEqual(15_000);
    expect(RUN_CONFLICT_RETRY_INTERVAL_MS).toBeGreaterThan(0);
    expect(RUN_CONFLICT_RETRY_INTERVAL_MS).toBeLessThan(RUN_CONFLICT_WAIT_MS);
  });
});
