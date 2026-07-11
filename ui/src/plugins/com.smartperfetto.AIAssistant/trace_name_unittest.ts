// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';
import {getCanonicalTraceName} from './trace_name';

describe('getCanonicalTraceName', () => {
  it('keeps file size out of the canonical Trace name', () => {
    expect(
      getCanonicalTraceName(
        {
          traceTitle: 'lacunh_heavy.pftrace (20 MB)',
          source: {
            type: 'FILE',
            file: new File([], 'lacunh_heavy.pftrace'),
          },
        },
        '当前 Trace',
      ),
    ).toBe('lacunh_heavy.pftrace');
  });

  it('uses the decoded filename for URL traces', () => {
    expect(
      getCanonicalTraceName(
        {
          traceTitle: 'launch%20light.pftrace',
          source: {
            type: 'URL',
            url: 'https://example.test/traces/launch%20light.pftrace',
          },
        },
        '当前 Trace',
      ),
    ).toBe('launch light.pftrace');
  });
});
