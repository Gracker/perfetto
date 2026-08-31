// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  conversationTraceContextChanged,
  parseConversationSseFrames,
  startConversationTurn,
  streamConversationRun,
} from './conversation_client';
import type {SelectionContext} from './types';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('conversationTraceContextChanged', () => {
  it('treats none↔attached and Trace A↔B as new safety boundaries', () => {
    expect(conversationTraceContextChanged(undefined, 'trace-a')).toBe(true);
    expect(conversationTraceContextChanged('trace-a', undefined)).toBe(true);
    expect(conversationTraceContextChanged('trace-a', 'trace-b')).toBe(true);
    expect(conversationTraceContextChanged('trace-a', ' trace-a ')).toBe(false);
    expect(conversationTraceContextChanged(undefined, undefined)).toBe(false);
  });
});

describe('startConversationTurn', () => {
  it('serializes the current Perfetto selection into conversation options', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 202,
      json: async () => ({
        sessionId: 'conversation-1',
        runId: 'run-1',
        isNewSession: true,
        traceContextAttached: true,
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    const selectionContext: SelectionContext = {
      kind: 'track_event',
      source: 'track_event_selection',
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
    };

    await startConversationTurn({backendUrl: 'http://backend'}, {
      query: '分析当前选择',
      traceId: 'trace-1',
      analysisContext: {
        codeAwareMode: 'off',
        codebaseIds: [],
        knowledgeSourceIds: [],
      },
      selectionContext,
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.options.selectionContext).toEqual({
      kind: 'track_event',
      source: 'track_event_selection',
      trackUri: '/process_1/thread_2',
      eventId: 42,
      ts: 1000,
      dur: 250,
    });
  });
});

describe('parseConversationSseFrames', () => {
  it('parses complete events and preserves an incomplete tail', () => {
    expect(parseConversationSseFrames(
      'event: connected\ndata: {"runId":"run-1"}\n\n' +
      'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"ok"}}\n',
    )).toEqual({
      events: [{type: 'connected', data: {runId: 'run-1'}}],
      remainder: 'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"ok"}}\n',
    });
  });

  it('supports CRLF and multi-line data', () => {
    expect(parseConversationSseFrames(
      'event: note\r\ndata: first\r\ndata: second\r\n\r\n',
    ).events).toEqual([{type: 'note', data: 'first\nsecond'}]);
  });
});

describe('streamConversationRun source enrichment', () => {
  it('delivers the primary outcome immediately and continues to the source terminal event', async () => {
    const frames = [
      'event: run_completed\ndata: {"type":"run_completed","enrichmentPending":true,"outcome":{"kind":"answered","message":"primary"}}\n\n',
      'event: source_enrichment_started\ndata: {"type":"source_enrichment_started"}\n\n',
      'event: source_enrichment_completed\ndata: {"type":"source_enrichment_completed","message":"supplement","evidence":[],"metrics":{"searchCalls":1,"readCalls":2,"durationMs":40}}\n\n',
    ];
    const encoder = new TextEncoder();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          for (const frame of frames) controller.enqueue(encoder.encode(frame));
          controller.close();
        },
      }),
    } as Response)));
    const order: string[] = [];

    const outcome = await streamConversationRun(
      {backendUrl: 'http://backend'},
      {sessionId: 'conversation-1', runId: 'run-1', isNewSession: true, traceContextAttached: true},
      {
        onPrimaryOutcome: primary => order.push(`primary:${primary.message}`),
        onSourceEnrichment: enrichment => order.push(`source:${enrichment.status}`),
      },
    );

    expect(outcome).toEqual({kind: 'answered', message: 'primary'});
    expect(order).toEqual([
      'primary:primary',
      'source:running',
      'source:completed',
    ]);
  });
});
