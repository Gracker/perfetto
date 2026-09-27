// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

vi.mock('./conversation_client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversation_client')>()),
  streamConversationRun: vi.fn(),
  cancelConversationRun: vi.fn(async () => undefined),
}));
vi.mock('./conversation_store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./conversation_store')>()),
  appendConversationMessage: vi.fn(() => ({backendUrl: 'http://backend', messages: [], updatedAt: 0})),
}));

import {AIPanel} from './ai_panel';
import {resetAISharedState} from './ai_shared_state';
import {cancelConversationRun, deferred, streamConversationRun} from './conversation_client';
import {appendConversationMessage} from './conversation_store';
import {projectMessageForStorage} from './private_message_storage';
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

const provisionalEvent = {runId: 'run-a', data: {conclusion: 'Trace duration is 12.3 s.', provisional: true,
  verification: 'pending'}};
const completedEvent = {runId: 'run-a', data: {success: true, conclusion: 'Trace duration is 12.3 s.', findings: []}};
const answers = (value: any): Message[] =>
  value.state.messages.filter((message: Message) => message.flowTag === 'answer_stream');

describe('AIPanel deliver first, verify after', () => {
  afterEach(() => {vi.clearAllMocks(); resetAISharedState();});

  it('shows the provisional answer while the run stays active, then replaces the verdict', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    expect(value.state.isLoading).toBe(true);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBe('pending');
    expect(value.hasProvisionalAgentAnswer()).toBe(true);
    value.handleSSEEvent('analysis_completed', completedEvent);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBeUndefined();
    expect(value.state.isLoading).toBe(false);
  });

  it('stop-and-redirect after a provisional answer stops only the review and waits for analysis_completed', async () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    value.state.sseConnectionState = 'connected';
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({success: true, sessionId: 'session-a',
      runId: 'run-a', status: 'review_stop_requested', runStatus: 'running', outcome: 'review_stop_requested'})));
    value.cancelSSEConnection = vi.fn(); value.focusChatInput = vi.fn(); value.listenToAgentSSE = vi.fn(async () => {});
    await value.stopAndRedirectAnalysis();
    expect(JSON.parse(value.fetchBackend.mock.calls[0][1].body)).toEqual({runId: 'run-a'});
    expect(value.cancelSSEConnection).not.toHaveBeenCalled();
    expect(value.listenToAgentSSE).not.toHaveBeenCalled();
    expect(value.focusChatInput).not.toHaveBeenCalled();
    expect(value.state.isLoading).toBe(true);
    expect(value.redirectAfterCancellation).toBe(true);
    value.handleSSEEvent('analysis_completed', completedEvent);
    expect(value.focusChatInput).toHaveBeenCalledOnce();
    expect(value.redirectAfterCancellation).toBe(false);
    expect(answers(value)[0].answerVerification).toBeUndefined();
  });

  it('reattaches the stream when the review stop wins a race with a full stop', async () => {
    const value = panel();
    value.state.sseConnectionState = 'disconnected';
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({success: true, runId: 'run-a',
      status: 'review_stop_requested'})));
    value.listenToAgentSSE = vi.fn(async () => {});
    await value.cancelAgentSessionAndUpdate('session-a', 'run-a');
    expect(value.listenToAgentSSE).toHaveBeenCalledWith('session-a', true);
    expect(value.state.isLoading).toBe(true);
  });

  it('clears an unfinished cue when the verdict is replayed after loading stopped (reconnect)', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    Object.getPrototypeOf(value).setLoadingState.call(value, false);
    expect(answers(value)[0].answerVerification).toBe('unfinished');
    value.handleSSEEvent('analysis_completed', completedEvent);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBeUndefined();
  });

  it('keeps a remounted in-flight provisional answer pending and its Stop review-only', async () => {
    const source = panel();
    source.handleSSEEvent('conclusion', provisionalEvent);
    const stored = projectMessageForStorage(answers(source)[0]);
    expect(stored.answerVerification).toBe('unfinished');
    const value = panel();
    value.state.messages = [stored];
    value.listenToAgentSSE = vi.fn(async () => {});
    value.restoreTransientState({inputDraft: '', collapsedTables: [], historyIndex: -1, activeAnalysis: {
      agentSessionId: 'session-a', lastEventId: 7, agentRunId: 'run-a', agentRequestId: null, agentRunSequence: 1,
      loadingPhase: '', displayedSkillProgress: [], completionHandled: true, collectedErrors: [],
      streamingFlow: source.state.streamingFlow, streamingAnswer: {...source.state.streamingAnswer}}});
    expect(answers(value)[0].answerVerification).toBe('pending');
    expect(value.hasProvisionalAgentAnswer()).toBe(true);
    value.state.sseConnectionState = 'connected';
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({success: true, runId: 'run-a',
      status: 'review_stop_requested'})));
    value.cancelSSEConnection = vi.fn();
    await value.cancelAnalysis();
    expect(value.cancelSSEConnection).not.toHaveBeenCalled();
    value.handleSSEEvent('analysis_completed', completedEvent);
    expect(answers(value)[0].answerVerification).toBeUndefined();
  });

  it('ignores a review stop confirmation that arrives after the verdict', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    value.handleSSEEvent('analysis_completed', completedEvent);
    value.listenToAgentSSE = vi.fn(async () => {});
    value.state.sseConnectionState = 'disconnected';
    value.applyConfirmedCancellation('review_stop_requested');
    expect(value.listenToAgentSSE).not.toHaveBeenCalled();
    expect(value.state.loadingPhase).not.toContain('核验');
    expect(value.reviewStopRequestedRunId).toBeUndefined();
  });

  it('makes a second stop after an accepted review stop a force stop', async () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    value.state.sseConnectionState = 'connected';
    value.fetchBackend = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({success: true, runId: 'run-a', status: 'review_stop_requested'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({success: true, runId: 'run-a', status: 'cancelled'})));
    value.cancelSSEConnection = vi.fn(); value.retireBackendAgentSession = vi.fn();
    await value.cancelAnalysis();
    expect(value.cancelSSEConnection).not.toHaveBeenCalled();
    expect(value.reviewStopRequestedRunId).toBe('run-a');
    await value.cancelAnalysis();
    expect(value.cancelSSEConnection).toHaveBeenCalled();
    expect(value.fetchBackend).toHaveBeenCalledTimes(2);
    expect(value.state.isLoading).toBe(false);
    expect(answers(value)[0].answerVerification).toBe('unfinished');
  });

  it.each(['committed', 'review_not_finished'])('reattaches after a force stop that found the run %s', async outcome => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    value.state.sseConnectionState = 'connected';
    value.fetchBackend = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({success: true, runId: 'run-a', status: 'review_stop_requested'})))
      .mockResolvedValueOnce(new Response(JSON.stringify({success: true, runId: 'run-a', status: 'completed',
        outcome})));
    value.cancelSSEConnection = vi.fn(() => {value.state.sseConnectionState = 'disconnected';});
    value.listenToAgentSSE = vi.fn(async () => {});
    value.retireBackendAgentSession = vi.fn();
    await value.cancelAnalysis();
    const before = value.state.messages.length;
    await value.cancelAnalysis();
    // No "already finished" notice and no retirement: the stream replays the terminal event.
    expect(value.state.messages).toHaveLength(before);
    expect(value.retireBackendAgentSession).not.toHaveBeenCalled();
    expect(value.listenToAgentSSE).toHaveBeenCalledWith('session-a', true);
    expect(value.state.isLoading).toBe(true);
    const unfinished = outcome === 'review_not_finished';
    value.handleSSEEvent('analysis_completed', {runId: 'run-a', data: {success: true, partial: unfinished,
      conclusion: 'Trace duration is 12.3 s.', findings: [],
      ...(unfinished ? {terminationReason: 'review_not_finished'} : {})}});
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBe(unfinished ? 'unfinished' : undefined);
    expect(value.state.isLoading).toBe(false);
  });

  it('keeps the run active after a final (no-review) conclusion until analysis_completed', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', {runId: 'run-a', data: {conclusion: 'Trace duration is 12.3 s.'}});
    expect(value.state.isLoading).toBe(true);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0].answerVerification).toBeUndefined();
    expect(value.hasProvisionalAgentAnswer()).toBe(false);
    value.handleSSEEvent('analysis_completed', completedEvent);
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
    value.handleSSEEvent('conclusion', provisionalEvent);
    expect(answers(value)).toHaveLength(1);
    expect(answers(value)[0]).toMatchObject({id: draftId, answerVerification: 'pending'});
    expect(answers(value)[0].answerDraft).toBeUndefined();
  });

  it('never leaves a pending cue once loading stops without a verdict, and never stores one as pending', () => {
    const value = panel();
    value.handleSSEEvent('conclusion', provisionalEvent);
    Object.getPrototypeOf(value).setLoadingState.call(value, false);
    expect(answers(value)[0].answerVerification).toBe('unfinished');
    expect(projectMessageForStorage({content: 'x', answerVerification: 'pending'}).answerVerification)
      .toBe('unfinished');
  });
});

describe('AIPanel conversation deliver first, verify after', () => {
  afterEach(() => {vi.clearAllMocks(); resetAISharedState();});
  const config = {backendUrl: 'http://backend'};
  const receipt = {sessionId: 'conv-1', runId: 'run-1', isNewSession: false, traceContextAttached: false};
  const messageId = 'conversation-conv-1-run-1-assistant';

  it('renders the provisional answer under the run id and writes the store only with the verdict', async () => {
    const value = panel();
    const controller = new AbortController();
    value.conversationAbortController = controller; value.activeConversationRun = receipt;
    const ordinal = value.conversationRequestOrdinal;
    vi.mocked(streamConversationRun).mockImplementation(async (_config, _receipt, options) => {
      options?.onProvisionalAnswer?.({message: 'Answer body.'});
      const shown = value.state.messages.find((message: Message) => message.id === messageId);
      expect(shown).toMatchObject({content: 'Answer body.', answerVerification: 'pending'});
      expect(value.provisionalConversationRun()).toBe(receipt);
      expect(appendConversationMessage).not.toHaveBeenCalled();
      // The first provisional insert is screen-only.
      expect(value.saveHistory).not.toHaveBeenCalled();
      expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
      options?.onPrimaryOutcome?.({kind: 'answered', message: 'Answer body.'});
      return {kind: 'answered', message: 'Answer body.'};
    });
    const settlement = deferred();
    value.conversationRunSettlement = settlement;
    let verdictSettled = false;
    void settlement.promise.then(() => {verdictSettled = true;});
    await value.consumeConversationRun(config, receipt, controller, ordinal, () => true);
    // The verdict itself resolves the settlement; the request's cleanup is not needed.
    expect(verdictSettled).toBe(true);
    const matching = value.state.messages.filter((message: Message) => message.id === messageId);
    expect(matching).toHaveLength(1);
    expect(matching[0].answerVerification).toBeUndefined();
    expect(appendConversationMessage).toHaveBeenCalledOnce();
    expect(vi.mocked(appendConversationMessage).mock.calls[0][1]).toMatchObject({id: messageId, content: 'Answer body.'});
    // The replaced provisional message is persisted in the local session too.
    expect(value.saveHistory).toHaveBeenCalled();
    expect(value.provisionalConversationRun()).toBeUndefined();
  });

  it('keeps a provisional answer that ended without a verdict, marked unverified', async () => {
    const value = panel();
    const controller = new AbortController();
    value.conversationAbortController = controller; value.activeConversationRun = receipt;
    vi.mocked(streamConversationRun).mockImplementation(async (_config, _receipt, options) => {
      options?.onProvisionalAnswer?.({message: 'Answer body.'});
      throw new Error('Conversation failed');
    });
    await expect(value.consumeConversationRun(config, receipt, controller, value.conversationRequestOrdinal, () => true))
      .rejects.toThrow('Conversation failed');
    expect(value.state.messages.find((message: Message) => message.id === messageId)?.answerVerification)
      .toBe('unfinished');
    expect(vi.mocked(appendConversationMessage).mock.calls[0][1]).toMatchObject({id: messageId,
      content: 'Answer body.', turn: {partial: true, completionStatus: 'incomplete'}});
  });

  it('renders answer drafts in the run message, revoked by a reset and replaced by the provisional answer', async () => {
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
      // A string payload (OpenCode/Qoder answer text) is neither a phase label nor a draft.
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
      options?.onProvisionalAnswer?.({message: 'Answer body.'});
      expect(shown()).toMatchObject({content: 'Answer body.', answerVerification: 'pending'});
      expect(shown().answerDraft).toBeUndefined();
      options?.onEvent?.(draft(' AFTER', 1));
      expect(shown().content).toBe('Answer body.');
      options?.onPrimaryOutcome?.({kind: 'answered', message: 'Answer body.'});
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
    expect(cancelConversationRun).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'run-1');
    const shown = value.state.messages.find((message: Message) => message.id === messageId);
    expect(shown.content).toMatch(/分析已取消|Analysis cancelled/);
    expect(shown.answerDraft).toBeUndefined();
    expect(value.activeConversationRun).toBeUndefined();
  });

  it('a stop that looked draft-only stays review-only when the backend already delivered the answer', async () => {
    const value = panel();
    value.activeConversationRun = receipt;
    value.state.messages.push({id: messageId, role: 'assistant', content: 'Half an answer', timestamp: 1,
      answerDraft: true});
    vi.mocked(cancelConversationRun).mockResolvedValueOnce('review_stop_requested');
    const ordinal = value.conversationRequestOrdinal;
    await value.cancelConversationAnalysis();
    // The provisional answer was in flight: the stream stays attached to deliver it.
    expect(value.conversationRequestOrdinal).toBe(ordinal);
    expect(value.activeConversationRun).toBe(receipt);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
    const shown = value.state.messages.find((message: Message) => message.id === messageId);
    expect(shown.content).not.toMatch(/分析已取消|Analysis cancelled/);
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

  const showPending = (value: any) => {
    value.activeConversationRun = receipt;
    value.state.messages.push({id: messageId, role: 'assistant', content: 'Answer body.', timestamp: 1,
      answerVerification: 'pending'});
  };

  it('stop after a provisional answer ends only the review and keeps the stream current', async () => {
    const value = panel();
    showPending(value);
    const ordinal = value.conversationRequestOrdinal;
    await value.cancelConversationAnalysis();
    expect(cancelConversationRun).toHaveBeenCalledWith(expect.anything(), 'conv-1', 'run-1');
    expect(value.conversationRequestOrdinal).toBe(ordinal);
    expect(value.activeConversationRun).toBe(receipt);
    expect(value.setLoadingState).not.toHaveBeenCalledWith(false);
  });

  it('a new message first stops the review and waits for the verdict, not for the cancel response', async () => {
    const value = panel();
    showPending(value);
    const settlement = deferred();
    value.conversationRunSettlement = settlement;
    const order: string[] = [];
    // The backend answers the stop only after the run settled; never wait on that response.
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      order.push(`stop-review:${String(url).endsWith('/conversation/conv-1/cancel')}`);
      queueMicrotask(() => {order.push('verdict'); settlement.resolve();});
      return new Promise<Response>(() => {});
    }));
    try {
      await value.settleProvisionalConversationRun(config);
    } finally {vi.unstubAllGlobals();}
    order.push('continue');
    expect(order).toEqual(['stop-review:true', 'verdict', 'continue']);
  });

  it('bounds the wait when the verdict never lands', async () => {
    vi.useFakeTimers();
    try {
      const value = panel();
      showPending(value);
      value.conversationRunSettlement = deferred();
      vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
      const waiting = value.settleProvisionalConversationRun(config);
      await vi.advanceTimersByTimeAsync(5_000);
      await expect(waiting).resolves.toBeUndefined();
    } finally {vi.useRealTimers(); vi.unstubAllGlobals();}
  });
});
