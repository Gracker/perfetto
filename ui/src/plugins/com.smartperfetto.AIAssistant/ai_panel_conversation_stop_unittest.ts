// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/* eslint-disable @typescript-eslint/no-explicit-any -- tests drive private AIPanel state. */
import {afterEach, describe, expect, it, vi} from 'vitest';
import type * as ConversationClient from './conversation_client';
import type * as ConversationStore from './conversation_store';

vi.mock('./conversation_client', async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationClient>()),
  streamConversationRun: vi.fn(),
  cancelConversationRun: vi.fn(async () => undefined),
}));
vi.mock('./conversation_store', async (importOriginal) => ({
  ...(await importOriginal<typeof ConversationStore>()),
  appendConversationMessage: vi.fn(() => ({backendUrl: 'http://backend', messages: [], updatedAt: 0})),
}));

import {AIPanel} from './ai_panel';
import {resetAISharedState} from './ai_shared_state';
import {cancelConversationRun, streamConversationRun} from './conversation_client';
import {appendConversationMessage} from './conversation_store';
import {isStorableMessage} from './private_message_storage';
import {setUiLanguagePreference} from './ui_language';
import type {Message} from './types';

function panel() {
  const value = new AIPanel() as any;
  value.state.backendTraceId = 'trace-a';
  value.state.agentSessionId = 'session-a';
  value.state.agentRunId = 'run-a';
  value.state.isLoading = true;
  value.serverStatus = {connected: true, activeProvider: {id: 'provider-a'}};
  value.setLoadingState = vi.fn((loading: boolean) => {value.state.isLoading = loading;});
  value.saveCurrentSession = vi.fn(); value.flushSessionSave = vi.fn(); value.saveHistory = vi.fn();
  value.upsertSseStatusMessage = vi.fn();
  return value;
}

const conclusionEvent = {runId: 'run-a', data: {conclusion: 'Trace duration is 12.3 s.'}};
const completedEvent = {runId: 'run-a', data: {success: true, conclusion: 'Trace duration is 12.3 s.', findings: []}};
const answers = (value: any): Message[] =>
  value.state.messages.filter((message: Message) => message.flowTag === 'answer_stream');

function findCue(node: any): any {
  if (node === null || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map(findCue).find(Boolean);
  if (String(node.attrs?.className ?? '').includes('ai-answer-verification-cue')) return node;
  return findCue(node.children);
}

describe('AIPanel agent answer delivery', () => {
  afterEach(() => {vi.clearAllMocks(); resetAISharedState();});

  it('keeps the run active after a conclusion until analysis_completed', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', conclusionEvent);
    expect(value.state.isLoading).toBe(true);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBeUndefined();
    value.handleSSEEvent('analysis_completed', completedEvent);
    expect(answers(value)).toHaveLength(1);
    expect(value.state.isLoading).toBe(false);
  });

  it('replaces an agent answer draft in place and removes a revoked one', () => {
    const value = panel();
    const draftEvent = (token: string, attempt: number) => ({runId: 'run-a', data: {token, runId: 'run-a', attempt}});
    value.handleSSEEvent('answer_token', draftEvent('Pre-tool text', 0));
    expect(answers(value)).toMatchObject([{content: 'Pre-tool text', answerDraft: true}]);
    value.handleSSEEvent('answer_segment_reset', {runId: 'run-a', data: {runId: 'run-a', attempt: 1}});
    expect(answers(value)).toEqual([]);
    value.handleSSEEvent('answer_token', draftEvent('Trace duration', 1));
    const draftId = answers(value)[0].id;
    value.handleSSEEvent('conclusion', conclusionEvent);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0]).toMatchObject({id: draftId});
    expect(answers(value)[0].answerVerification).toBeUndefined();
    expect(answers(value)[0].answerDraft).toBeUndefined();
  });

  it('renders a stored old pending cue as unfinished', () => {
    setUiLanguagePreference('en');
    const value = panel();
    value.state.isLoading = false;
    value.state.messages.push({id: 'old-answer', role: 'assistant', content: 'Answer body.', timestamp: 1,
      answerVerification: 'pending'});
    const cue = findCue(value.view({attrs: {}}));
    expect(String(cue.attrs.className)).toContain('ai-answer-verification-unfinished');
    expect(JSON.stringify(cue.children)).toContain('Verification did not finish');
  });
});

describe('AIPanel conversation answers and stops', () => {
  afterEach(() => {vi.clearAllMocks(); resetAISharedState();});
  const config = {backendUrl: 'http://backend'};
  const receipt = {sessionId: 'conv-1', runId: 'run-1', isNewSession: false, traceContextAttached: false};
  const messageId = 'conversation-conv-1-run-1-assistant';
  const UNCONFIRMED = /停止未确认|Stop not confirmed/;
  const hangingStop = () => {
    let resolve!: (status: string | undefined) => void;
    let reject!: (error: unknown) => void;
    vi.mocked(cancelConversationRun).mockImplementationOnce(() => new Promise((res, rej) => {
      resolve = res; reject = rej;
    }));
    return {resolve: (status: string | undefined) => resolve(status), reject: (error: unknown) => reject(error)};
  };
  const showAnswer = (value: any) => {
    value.activeConversationRun = receipt;
    value.state.messages.push({id: messageId, role: 'assistant', content: 'Answer body.', timestamp: 1});
  };

  it('ignores a replayed provisional_answer event from an old stream', async () => {
    const value = panel();
    const controller = new AbortController();
    value.conversationAbortController = controller; value.activeConversationRun = receipt;
    vi.mocked(streamConversationRun).mockImplementation(async (_config, _receipt, options) => {
      options?.onEvent?.({type: 'provisional_answer', data: {message: 'Answer body.', verification: 'pending'}} as any);
      expect(value.state.messages.find((message: Message) => message.id === messageId)).toBeUndefined();
      options?.onOutcome?.({kind: 'answered', message: 'Answer body.'});
      return {kind: 'answered', message: 'Answer body.'};
    });
    await value.consumeConversationRun(config, receipt, controller, value.conversationRequestOrdinal, () => true);
    const matching = value.state.messages.filter((message: Message) => message.id === messageId);
    expect(matching).toHaveLength(1);
    expect(matching[0].answerVerification).toBeUndefined();
    expect(appendConversationMessage).toHaveBeenCalledOnce();
    expect(value.saveHistory).toHaveBeenCalled();
  });

  it('renders answer drafts in the run message, revoked by a reset and replaced by the outcome', async () => {
    const value = panel();
    const controller = new AbortController();
    value.conversationAbortController = controller; value.activeConversationRun = receipt;
    const ordinal = value.conversationRequestOrdinal;
    const shown = () => value.state.messages.find((message: Message) => message.id === messageId);
    const update = (runtimeUpdate: unknown) => ({type: 'runtime_update', data: {update: runtimeUpdate}});
    const draft = (token: string, attempt: number) =>
      update({type: 'answer_token', content: {token, runId: 'run-1', attempt}});
    vi.mocked(streamConversationRun).mockImplementation(async (_config, _receipt, options) => {
      options?.onEvent?.(update({type: 'progress', content: {message: 'Reading the trace'}}));
      expect(value.state.loadingPhase).toBe('Reading the trace');
      // A string payload is neither a phase label nor a draft.
      options?.onEvent?.(update({type: 'answer_token', content: 'untyped answer text'}));
      options?.onEvent?.(update({type: 'tool_call', content: {message: 'Tool narration'}}));
      expect(value.state.loadingPhase).toBe('Reading the trace');
      expect(shown()).toBeUndefined();
      options?.onEvent?.(draft('Pre-tool ', 0));
      expect(shown()).toMatchObject({content: 'Pre-tool ', answerDraft: true});
      options?.onEvent?.(update({type: 'answer_segment_reset', content: {runId: 'run-1', attempt: 1}}));
      expect(shown()).toBeUndefined();
      options?.onEvent?.(draft('LATE', 0));
      options?.onEvent?.(draft('Answer ', 1));
      options?.onEvent?.(draft('body.', 1));
      expect(shown()).toMatchObject({content: 'Answer body.', answerDraft: true});
      expect(value.saveHistory).not.toHaveBeenCalled();
      options?.onOutcome?.({kind: 'answered', message: 'Answer body.'});
      expect(shown().answerDraft).toBeUndefined();
      expect(shown().content).toBe('Answer body.');
      options?.onEvent?.(draft(' AFTER', 1));
      expect(shown().content).toBe('Answer body.');
      return {kind: 'answered', message: 'Answer body.'};
    });
    await value.consumeConversationRun(config, receipt, controller, ordinal, () => true);
    const matching = value.state.messages.filter((message: Message) => message.id === messageId);
    expect(matching).toHaveLength(1);
    expect(matching[0].answerDraft).toBeUndefined();
    expect(appendConversationMessage).toHaveBeenCalledOnce();
  });

  it('removes a draft left by a run that failed before any answer', async () => {
    const value = panel();
    const controller = new AbortController();
    value.conversationAbortController = controller; value.activeConversationRun = receipt;
    vi.mocked(streamConversationRun).mockImplementation(async (_config, _receipt, options) => {
      options?.onEvent?.({type: 'runtime_update', data: {update: {type: 'answer_token',
        content: {token: 'Half an answer', runId: 'run-1', attempt: 0}}}});
      throw new Error('Conversation failed');
    });
    await expect(value.consumeConversationRun(config, receipt, controller, value.conversationRequestOrdinal, () => true))
      .rejects.toThrow('Conversation failed');
    expect(value.state.messages.find((message: Message) => message.id === messageId)).toBeUndefined();
    expect(appendConversationMessage).not.toHaveBeenCalled();
  });

  it('a stop during the draft is a full cancel that replaces the draft with the cancelled notice', async () => {
    const value = panel();
    value.activeConversationRun = receipt;
    value.state.messages.push({id: messageId, role: 'assistant', content: 'Half an answer', timestamp: 1,
      answerDraft: true});
    vi.mocked(cancelConversationRun).mockResolvedValueOnce('cancelled');
    const ordinal = value.conversationRequestOrdinal;
    await value.cancelConversationAnalysis();
    expect(value.conversationRequestOrdinal).toBe(ordinal + 1);
    expect(cancelConversationRun).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'run-1', expect.any(AbortSignal));
    const shown = value.state.messages.find((message: Message) => message.id === messageId);
    expect(shown.content).toMatch(/分析已取消|Analysis cancelled/);
    expect(shown.answerDraft).toBeUndefined();
    expect(value.activeConversationRun).toBeUndefined();
  });

  it.each([
    ['the cancel request fails', () => vi.mocked(cancelConversationRun).mockRejectedValueOnce(new Error('network'))],
    ['the run settled another way', () => vi.mocked(cancelConversationRun).mockResolvedValueOnce('answered')],
  ])('a draft-phase stop keeps the stream attached when %s', async (_label, arrange) => {
    const value = panel();
    value.activeConversationRun = receipt;
    value.state.messages.push({id: messageId, role: 'assistant', content: 'Half an answer', timestamp: 1,
      answerDraft: true});
    arrange();
    const ordinal = value.conversationRequestOrdinal;
    await value.cancelConversationAnalysis();
    // Only a confirmed cancellation detaches; otherwise the stream still settles the run.
    expect(value.conversationRequestOrdinal).toBe(ordinal);
    expect(value.activeConversationRun).toBe(receipt);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
    const shown = value.state.messages.find((message: Message) => message.id === messageId);
    expect(shown.content).toBe('Half an answer');
  });

  it('keeps the stream attached when a stop outcome is unknown, since the backend may have applied it', async () => {
    const value = panel();
    showAnswer(value);
    vi.mocked(cancelConversationRun).mockRejectedValueOnce(new Error('network'));
    await value.cancelConversationAnalysis();
    expect(value.state.loadingPhase).toMatch(UNCONFIRMED);
    expect(value.activeConversationRun).toBe(receipt);
  });

  it('a stop answered with a settled outcome leaves the verdict to the stream', async () => {
    const value = panel();
    value.activeConversationRun = receipt;
    vi.mocked(cancelConversationRun).mockResolvedValueOnce('answered');
    await value.cancelConversationAnalysis();
    expect(value.state.loadingPhase).not.toMatch(UNCONFIRMED);
    expect(value.activeConversationRun).toBe(receipt);
    expect(value.state.isLoading).toBe(true);
  });

  it('sends one stop for a double press while the first is in flight', async () => {
    const value = panel();
    showAnswer(value);
    const response = hangingStop();
    const first = value.cancelConversationAnalysis();
    expect(value.conversationStopPending()).toBe(true);
    await value.cancelConversationAnalysis();
    expect(cancelConversationRun).toHaveBeenCalledOnce();
    response.resolve('answered');
    await first;
    expect(value.conversationStopPending()).toBe(false);
  });

  it('ignores a stop failure that arrives after the verdict', async () => {
    const value = panel();
    showAnswer(value);
    const response = hangingStop();
    const stop = value.cancelConversationAnalysis();
    // The verdict lands first and ends loading.
    Object.getPrototypeOf(value).setLoadingState.call(value, false);
    response.reject(new Error('network'));
    await stop;
    expect(value.state.loadingPhase).toBe('');
  });

  it('bounds a stop request that never answers and treats it as an unknown outcome', async () => {
    vi.useFakeTimers();
    try {
      const value = panel();
      showAnswer(value);
      let lateResolve!: (status: string) => void;
      vi.mocked(cancelConversationRun).mockImplementationOnce((_config, _sessionId, _runId, signal) =>
        new Promise((resolve, reject) => {
          lateResolve = resolve;
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }));
      const first = value.cancelConversationAnalysis();
      expect(value.conversationStopPending()).toBe(true);
      await vi.advanceTimersByTimeAsync(25_000);
      await first;
      expect(value.conversationStopPending()).toBe(false);
      expect(value.state.loadingPhase).toMatch(UNCONFIRMED);
      expect(cancelConversationRun).toHaveBeenCalledOnce();
      const second = hangingStop();
      const press = value.cancelConversationAnalysis();
      expect(cancelConversationRun).toHaveBeenCalledTimes(2);
      lateResolve('answered');
      await Promise.resolve();
      expect(value.conversationStopPending()).toBe(true);
      second.resolve('answered');
      await press;
      expect(cancelConversationRun).toHaveBeenCalledTimes(2);
    } finally {vi.useRealTimers();}
  });

  it('a late response of an older run never clears the stop in flight for the current run', async () => {
    const value = panel();
    value.activeConversationRun = receipt;
    const older = hangingStop();
    const olderStop = value.cancelConversationAnalysis();
    // A new message superseded the run (dropping its stop state) and its receipt arrived.
    const next = {...receipt, runId: 'run-2'};
    value.conversationStopInFlight = undefined;
    value.activeConversationRun = next;
    const current = hangingStop();
    const currentStop = value.cancelConversationAnalysis();
    older.resolve('answered');
    await olderStop;
    expect(value.conversationStopPending()).toBe(true);
    await value.cancelConversationAnalysis();
    expect(cancelConversationRun).toHaveBeenCalledTimes(2);
    current.resolve('answered');
    await currentStop;
    expect(value.conversationStopPending()).toBe(false);
  });

  it('a confirmed cancel before any draft shows the cancelled notice as the run message', async () => {
    const value = panel();
    value.activeConversationRun = receipt;
    vi.mocked(cancelConversationRun).mockResolvedValueOnce('cancelled');
    await value.cancelConversationAnalysis();
    const shown = value.state.messages.filter((message: Message) => message.id === messageId);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({role: 'assistant'});
    expect(shown[0].content).toMatch(/分析已取消|Analysis cancelled/);
    expect(shown[0].answerDraft).toBeUndefined();
    expect(isStorableMessage(shown[0])).toBe(true);
    expect(value.conversationMessageIds.has(messageId)).toBe(true);
    expect(value.state.isLoading).toBe(false);
  });
});
