// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  formatWorkspaceTraceCatalogMeta,
  parseWorkspaceTraceCatalogResponse,
} from './workspace_trace_catalog';

describe('parseWorkspaceTraceCatalogResponse', () => {
  it('uses filename as the primary trace name', () => {
    const result = parseWorkspaceTraceCatalogResponse({
      traces: [
        {
          id: 'trace-1',
          filename: 'launch_light.pftrace',
          uploadedAt: '2026-07-10T01:30:00.000Z',
          size: 10_997_797,
          status: 'ready',
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      items: [
        {
          id: 'trace-1',
          filename: 'launch_light.pftrace',
          uploadedAt: '2026-07-10T01:30:00.000Z',
          size: 10_997_797,
        },
      ],
    });
  });

  it('keeps distinct uploads that share the same filename', () => {
    const result = parseWorkspaceTraceCatalogResponse({
      traces: [
        {id: 'trace-1', filename: 'scroll.pftrace', status: 'ready'},
        {id: 'trace-2', filename: 'scroll.pftrace', status: 'ready'},
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      items: [
        {id: 'trace-1', filename: 'scroll.pftrace'},
        {id: 'trace-2', filename: 'scroll.pftrace'},
      ],
    });
  });

  it('filters malformed rows without discarding valid traces', () => {
    const result = parseWorkspaceTraceCatalogResponse({
      traces: [
        {id: 'trace-1', filename: 'valid.pftrace', status: 'ready'},
        {id: '', filename: 'missing-id.pftrace', status: 'ready'},
        {id: 'trace-3', status: 'ready'},
        {
          id: 'trace-4',
          filename: 'still-processing.pftrace',
          status: 'processing',
        },
      ],
    });

    expect(result).toEqual({
      ok: true,
      items: [{id: 'trace-1', filename: 'valid.pftrace'}],
    });
  });

  it('reports an invalid response envelope', () => {
    expect(parseWorkspaceTraceCatalogResponse({items: []})).toEqual({
      ok: false,
      error: 'Trace 列表响应格式无效',
    });
  });
});

describe('formatWorkspaceTraceCatalogMeta', () => {
  it('shows time and size as secondary metadata', () => {
    const meta = formatWorkspaceTraceCatalogMeta({
      id: 'trace-1',
      filename: 'launch_light.pftrace',
      uploadedAt: '2026-07-10T01:30:00.000Z',
      size: 10_997_797,
    });

    expect(meta).toContain('10.5 MB');
    expect(meta).not.toContain('trace-1');
  });

  it('omits invalid dates instead of rendering Invalid Date', () => {
    expect(
      formatWorkspaceTraceCatalogMeta({
        id: 'trace-1',
        filename: 'launch_light.pftrace',
        uploadedAt: 'not-a-date',
        size: 10_997_797,
      }),
    ).toBe('10.5 MB');
  });
});
