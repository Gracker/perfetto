// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {AnalysisRequestCoordinator} from './analysis_request_coordinator';

describe('AnalysisRequestCoordinator', () => {
  let coordinator: AnalysisRequestCoordinator;

  beforeEach(() => {
    coordinator = new AnalysisRequestCoordinator();
  });

  it('marks the active request for backend cancellation', () => {
    const request = coordinator.begin();

    expect(coordinator.requestCancel()).toBe(true);
    expect(coordinator.disposition(request)).toBe('cancelled');
  });

  it('makes an older request stale when a new request begins', () => {
    const oldRequest = coordinator.begin();
    const currentRequest = coordinator.begin();

    expect(coordinator.disposition(oldRequest)).toBe('stale');
    expect(coordinator.disposition(currentRequest)).toBe('active');
  });

  it('does not clear the current request when a stale request finishes', () => {
    const oldRequest = coordinator.begin();
    const currentRequest = coordinator.begin();

    coordinator.finish(oldRequest);

    expect(coordinator.disposition(currentRequest)).toBe('active');
  });

  it('reports no active cancellation after the current request finishes', () => {
    const request = coordinator.begin();
    coordinator.finish(request);

    expect(coordinator.requestCancel()).toBe(false);
    expect(coordinator.disposition(request)).toBe('stale');
  });
});
