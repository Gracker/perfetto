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
