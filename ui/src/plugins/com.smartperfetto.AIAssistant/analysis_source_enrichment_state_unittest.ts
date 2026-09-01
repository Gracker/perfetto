// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';
import {hasRunningAnalysisSourceEnrichment} from './analysis_source_enrichment_state';
import type {Message} from './types';

describe('analysis source enrichment state', () => {
  it('keeps the cancel affordance active only while the detached supplement runs', () => {
    const message = (status: 'running' | 'completed' | 'failed' | 'cancelled'): Message => ({
      id: status,
      role: 'assistant',
      content: 'Primary conclusion.',
      timestamp: 1,
      analysisSourceEnrichment: status === 'completed'
        ? {
            status,
            message: 'Source supplement.',
            metrics: {searchCalls: 1, readCalls: 2, durationMs: 3},
          }
        : status === 'failed'
          ? {status, errorCode: 'analysis_source_enrichment_failed'}
          : {status},
    });

    expect(hasRunningAnalysisSourceEnrichment([message('running')])).toBe(true);
    expect(hasRunningAnalysisSourceEnrichment([message('completed')])).toBe(false);
    expect(hasRunningAnalysisSourceEnrichment([message('failed')])).toBe(false);
    expect(hasRunningAnalysisSourceEnrichment([message('cancelled')])).toBe(false);
  });
});
