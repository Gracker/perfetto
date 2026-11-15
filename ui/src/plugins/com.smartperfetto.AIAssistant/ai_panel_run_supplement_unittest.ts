// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {AIPanel} from './ai_panel';
import {resetAISharedState} from './ai_shared_state';
import {projectMessageForStorage} from './private_message_storage';
import {sessionManager} from './session_manager';
import type {Message} from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- these tests drive private panel members.
type PanelInternals = any;

const QUESTION: Message = {id: 'q', role: 'user', content: 'private question', timestamp: 1, privateContent: true};
const SUPPLEMENT: Message = {
  id: 's',
  role: 'user',
  content: 'private supplement',
  timestamp: 2,
  flowTag: 'run_supplement',
  privateContent: true,
  runSupplement: {key: 's', state: 'restart_required', reason: 'scope_changed'},
};

function panel(): PanelInternals {
  const value = new AIPanel() as PanelInternals;
  value.state.backendTraceId = 'trace-a';
  value.state.messages = [{...QUESTION}, {...SUPPLEMENT}];
  value.shouldBlockModelBackedRequest = vi.fn(() => false);
  value.tryStartNaturalLanguageResultComparison = vi.fn(async () => false);
  value.handleChatMessage = vi.fn(async () => {});
  value.listenToAgentSSE = vi.fn(async () => {});
  return value;
}

function supplement(value: PanelInternals): Message {
  return value.state.messages.find((msg: Message) => msg.id === 's');
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('AIPanel summarize current run', () => {
  afterEach(() => {vi.restoreAllMocks(); resetAISharedState();});

  function activePanel(): PanelInternals {
    const value = panel();
    value.state.agentSessionId = 'summary-session';
    value.state.agentRunId = 'summary-run';
    value.state.isLoading = true;
    value.cancelSSEConnection = vi.fn();
    value.cancelAnalysis = vi.fn();
    value.activeAgentRequest = {};
    return value;
  }
  const accepted = (runId = 'summary-run') => new Response(JSON.stringify({
    success: true, sessionId: 'summary-session', runId, outcome: 'accepted',
  }));

  it('requests the matching run once and keeps its stream and cancel action available', async () => {
    const value = activePanel();
    let resolve!: (response: Response) => void;
    value.fetchBackend = vi.fn(() => new Promise(done => {resolve = done;}));
    const button = value.renderSummaryButton();
    expect(button.attrs['aria-label']).toBe('Summarize current results');
    button.attrs.onclick();
    await value.requestCurrentRunSummary();
    expect(value.fetchBackend).toHaveBeenCalledOnce();
    expect(value.fetchBackend.mock.calls[0][0]).toContain('/summary-session/summarize');
    expect(JSON.parse(value.fetchBackend.mock.calls[0][1].body)).toEqual({runId: 'summary-run'});
    expect(value.renderSummaryButton().attrs.disabled).toBe(true);
    resolve(accepted()); await flush();
    expect(value.summaryRequest.status).toBe('accepted');
    expect(value.state.isLoading).toBe(true);
    expect(value.state.agentRunId).toBe('summary-run');
    expect(value.cancelSSEConnection).not.toHaveBeenCalled();
    expect(value.cancelAnalysis).not.toHaveBeenCalled();
    await value.requestCurrentRunSummary();
    expect(value.fetchBackend).toHaveBeenCalledOnce();
    value.setLoadingState(false);
    expect(value.summaryRequest).toBeUndefined();
  });

  it.each(['new_run', 'backend_changed', 'terminal', 'handoff', 'cancel'] as const)
  ('ignores a late summary response after %s', async reason => {
    const value = activePanel();
    let resolve!: (response: Response) => void;
    value.fetchBackend = vi.fn(() => new Promise(done => {resolve = done;}));
    const pending = value.requestCurrentRunSummary();
    if (reason === 'new_run') value.state.agentRunId = 'successor';
    if (reason === 'backend_changed') value.state.settings.backendUrl = 'http://127.0.0.1:9999';
    if (reason === 'terminal') value.setLoadingState(false);
    if (reason === 'handoff') value.clearSummaryRequest();
    if (reason === 'cancel') value.analysisCancellationPending = true;
    value.state.loadingPhase = 'new owner phase';
    resolve(accepted()); await pending;
    expect(value.state.loadingPhase).toBe('new owner phase');
    value.clearSummaryRequest();
  });

  it.each(['http_error', 'invalid_receipt', 'network'] as const)('allows a retry after %s', async failure => {
    const value = activePanel();
    value.fetchBackend = vi.fn().mockImplementationOnce(() => failure === 'network'
      ? Promise.reject(new Error('offline')) : Promise.resolve(failure === 'http_error'
        ? new Response('{}', {status: 409}) : accepted('foreign-run'))).mockResolvedValue(accepted());
    await value.requestCurrentRunSummary();
    expect(value.summaryRequest).toBeUndefined();
    expect(value.state.isLoading).toBe(true);
    expect(value.state.loadingPhase).toContain('still running');
    await value.requestCurrentRunSummary();
    expect(value.summaryRequest.status).toBe('accepted');
    value.clearSummaryRequest();
  });

  it('times out only the control handshake and leaves the analysis running', async () => {
    vi.useFakeTimers();
    const value = activePanel();
    value.fetchBackend = vi.fn((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('request aborted')), {once: true});
    }));
    try {
      const pending = value.requestCurrentRunSummary();
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(value.summaryRequest).toBeUndefined();
      expect(value.state.isLoading).toBe(true);
      expect(value.state.agentRunId).toBe('summary-run');
      expect(value.cancelAnalysis).not.toHaveBeenCalled();
      expect(value.cancelSSEConnection).not.toHaveBeenCalled();
    } finally {vi.useRealTimers(); value.clearSummaryRequest();}
  });

  it('disables only the unsupported run and hides the control outside a normal active analysis', async () => {
    const value = activePanel();
    value.fetchBackend = vi.fn(async () => new Response(JSON.stringify({runId: 'summary-run', code: 'SUMMARY_UNSUPPORTED'}), {status: 409}));
    await value.requestCurrentRunSummary();
    expect(value.renderSummaryButton().attrs.disabled).toBe(true);
    value.state.agentRunId = 'next-run';
    expect(value.renderSummaryButton().attrs.disabled).toBe(false);
    value.state.storyState.status = 'running';
    expect(value.renderSummaryButton()).toBeNull();
    value.state.storyState.status = 'idle'; value.activeAgentRequest = undefined;
    value.activeConversationRun = {runId: 'conversation-run'};
    expect(value.renderSummaryButton()).toBeNull();
    value.activeConversationRun = undefined; value.state.isLoading = false;
    expect(value.renderSummaryButton()).toBeNull();
    value.clearSummaryRequest();
  });
});

describe('AIPanel run supplement restart', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetAISharedState();
  });

  it('keeps a restart private after the context stopped being private', async () => {
    const value = panel();
    value.state.analysisContext = {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []};

    value.restartWithRunSupplement(supplement(value));
    await flush();

    const sent: Message = value.state.messages.at(-1);
    expect(sent.content).toContain('private question');
    expect(sent.content).toContain('private supplement');
    expect(sent.privateContent).toBe(true);
    const stored = projectMessageForStorage(sent);
    expect(stored.content).not.toContain('private question');
    expect(stored.content).not.toContain('private supplement');
    expect(supplement(value).runSupplement?.restartConsumed).toBe(true);
  });

  it('gives the action back when the stop fails', () => {
    const value = panel();
    value.state.isLoading = true;
    value.cancelAnalysis = vi.fn(async () => {});

    value.restartWithRunSupplement(supplement(value));
    expect(supplement(value).runSupplement?.restartConsumed).toBe(true);
    expect(value.redirectIntent?.kind).toBe('restart');

    value.handleCancellationFailure('', new Error('stop failed'));

    expect(value.redirectIntent).toBeUndefined();
    expect(supplement(value).runSupplement?.restartConsumed).toBe(false);
    expect(value.handleChatMessage).not.toHaveBeenCalled();
  });

  it('gives the action back when the resubmission is refused', async () => {
    const value = panel();
    value.shouldBlockModelBackedRequest = vi.fn(() => true);
    value.addAiDisabledMessage = vi.fn();

    value.restartWithRunSupplement(supplement(value));
    await flush();

    expect(value.handleChatMessage).not.toHaveBeenCalled();
    expect(supplement(value).runSupplement?.restartConsumed).toBe(false);
  });

  it('resubmits once the stopped run is terminal', async () => {
    const value = panel();
    value.state.isLoading = true;
    value.cancelAnalysis = vi.fn(async () => {});

    value.restartWithRunSupplement(supplement(value));
    expect(value.handleChatMessage).not.toHaveBeenCalled();

    value.state.isLoading = false;
    value.consumeRedirectIntent();
    await flush();

    expect(value.handleChatMessage).toHaveBeenCalledOnce();
    expect(value.redirectIntent).toBeUndefined();
    expect(supplement(value).runSupplement?.restartConsumed).toBe(true);
  });

  it('persists a ledger change once however many entries it settles', () => {
    const value = panel();
    value.state.messages = [
      {id: 'a', role: 'user', content: 'a', timestamp: 1, flowTag: 'run_supplement', runSupplement: {key: 'a', state: 'classifying'}},
      {id: 'b', role: 'user', content: 'b', timestamp: 2, flowTag: 'run_supplement', runSupplement: {key: 'b', state: 'classifying'}},
    ];
    value.dispatchRunSupplement({type: 'run_started', runId: 'run-a', supported: true});
    value.dispatchRunSupplement({type: 'submitted', key: 'a', runId: 'run-a'});
    value.dispatchRunSupplement({type: 'submitted', key: 'b', runId: 'run-a'});
    value.saveHistory = vi.fn();
    value.saveCurrentSession = vi.fn();
    value.debouncedSaveSession = vi.fn();

    value.dispatchRunSupplement({type: 'terminal', runId: 'run-a', outcome: 'completed'});

    expect(value.state.messages.map((msg: Message) => msg.runSupplement?.state)).toEqual(['not_applied', 'not_applied']);
    expect(value.saveHistory).not.toHaveBeenCalled();
    expect(value.saveCurrentSession).not.toHaveBeenCalled();
    expect(value.debouncedSaveSession).toHaveBeenCalledOnce();
  });

  it('abandons a pending restart on handoff and leaves no save timer behind', () => {
    const value = panel();
    value.state.isLoading = true;
    value.cancelAnalysis = vi.fn(async () => {});
    value.saveCurrentSession = vi.fn();
    value.restartWithRunSupplement(supplement(value));

    value.saveCurrentSession.mockImplementation(() => {
      expect(supplement(value).runSupplement?.restartConsumed).toBe(false);
    });
    value.handOffTransientState();

    expect(value.saveCurrentSession).toHaveBeenCalledOnce();
    expect(value.saveSessionTimer).toBeNull();
    expect(value.redirectIntent).toBeUndefined();
  });

  it('leaves supplements out of the command history rebuilt from a session', () => {
    const value = panel();
    const session = {
      sessionId: 'session-a',
      traceFingerprint: 'fp',
      createdAt: 1,
      lastActiveAt: 1,
      messages: [{...QUESTION, privateContent: false}, {...SUPPLEMENT, privateContent: false}],
      pinnedResults: [],
      bookmarks: [],
    };
    vi.spyOn(sessionManager, 'loadSession').mockReturnValue(session as never);

    expect(value.loadSession('session-a')).toBe(true);

    expect(value.state.commandHistory).toEqual(['private question']);
  });
});
