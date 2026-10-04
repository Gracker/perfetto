// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  conversationTraceContextChanged,
  getConversation,
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

describe('startConversationTurn analysis context', () => {
  it('sends the shared analysis-context fields, depth included, and never ids hidden by off', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 202,
      json: async () => ({sessionId: 'c', runId: 'r', isNewSession: true, traceContextAttached: false}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    await startConversationTurn({backendUrl: 'http://backend'}, {query: 'q', analysisContext: {
      codeAwareMode: 'metadata_only', codebaseIds: ['cb-a'], knowledgeSourceIds: ['kb-a'], sourceDepth: 'mechanism'}});
    await startConversationTurn({backendUrl: 'http://backend'}, {query: 'q', analysisContext: {
      codeAwareMode: 'off', codebaseIds: ['cb-a'], knowledgeSourceIds: []}});
    const options = fetchMock.mock.calls.map(call => JSON.parse(String(call[1]?.body)).options);
    expect(options).toEqual([
      {codeAwareMode: 'metadata_only', codebaseIds: ['cb-a'], knowledgeSourceIds: ['kb-a'], sourceDepth: 'mechanism'},
      {codeAwareMode: 'off', sourceDepth: 'auto'},
    ]);
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

describe('streamConversationRun terminal event', () => {
  it('returns at run_completed, which carries no pending field, and reads nothing after it', async () => {
    const frames = [
      'event: run_completed\ndata: {"type":"run_completed","outcome":{"kind":"answered","message":"primary"}}\n\n',
      'event: run_failed\ndata: {"type":"run_failed","error":"late"}\n\n',
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
    const events: string[] = [];

    const outcome = await streamConversationRun(
      {backendUrl: 'http://backend'},
      {sessionId: 'conversation-1', runId: 'run-1', isNewSession: true, traceContextAttached: true},
      {
        onEvent: event => events.push(event.type),
        onOutcome: primary => events.push(`primary:${primary.message}`),
      },
    );

    expect(outcome).toEqual({kind: 'answered', message: 'primary'});
    expect(events).toEqual(['run_completed', 'primary:primary']);
  });
});

describe('streamConversationRun provisional answer', () => {
  it('hands the provisional answer over before the verdict and ignores it afterwards', async () => {
    const frames = [
      'event: provisional_answer\ndata: {"type":"provisional_answer","message":"answer body","verification":"pending"}\n\n',
      'event: run_completed\ndata: {"type":"run_completed","outcome":{"kind":"answered","message":"answer body"}}\n\n',
      'event: provisional_answer\ndata: {"type":"provisional_answer","message":"late replay","verification":"pending"}\n\n',
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
    await streamConversationRun(
      {backendUrl: 'http://backend'},
      {sessionId: 'conversation-1', runId: 'run-1', isNewSession: true, traceContextAttached: false},
      {
        onProvisionalAnswer: ({message}) => order.push(`provisional:${message}`),
        onOutcome: primary => order.push(`primary:${primary.message}`),
      },
    );
    expect(order).toEqual(['provisional:answer body', 'primary:answer body']);
  });
});

describe('getConversation', () => {
  it.each([401, 404, 409])('preserves HTTP %s without retrying or starting a new session', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Cannot restore', code: 'CONVERSATION_NOT_FOUND',
    }), {status}));
    vi.stubGlobal('fetch', fetch);
    await expect(getConversation({backendUrl: 'http://backend', apiKey: 'test-key'}, 'logical-id'))
      .rejects.toMatchObject({status});
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][1].headers).toMatchObject({'x-api-key': 'test-key'});
  });

  it('rejects a response for a different logical conversation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, sessionId: 'other', history: [], traceContext: {kind: 'none'},
    }), {status: 200})));
    await expect(getConversation({backendUrl: 'http://backend'}, 'requested'))
      .rejects.toThrow('Invalid conversation restoration response');
  });
});
