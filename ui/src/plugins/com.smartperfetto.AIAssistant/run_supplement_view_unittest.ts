// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it} from 'vitest';

import {privateQueryStoragePlaceholder} from './private_message_storage';
import type {RunSupplementEntry} from './run_supplement_state';
import {
  composeRestartQuery,
  runSupplementMessageActions,
  runSupplementRestartSubmission,
  runSupplementStatusText,
} from './run_supplement_view';
import {setUiLanguagePreference} from './ui_language';

const base: RunSupplementEntry = {key: 'k', state: 'classifying'};
const open = {windowOpen: true, textAvailable: true};

afterEach(() => setUiLanguagePreference('auto'));

describe('runSupplementStatusText', () => {
  it('describes delivered as entering the context in both languages', () => {
    setUiLanguagePreference('en');
    expect(runSupplementStatusText({...base, state: 'delivered'})).toBe(
      "Entered the agent's context",
    );
    setUiLanguagePreference('zh-CN');
    expect(runSupplementStatusText({...base, state: 'delivered'})).toBe('已进入 Agent 上下文');
  });

  it('gives the six states distinct text and uses reason or failure code where sampled', () => {
    setUiLanguagePreference('en');
    const seen = new Set(
      (['classifying', 'queued', 'delivered', 'rejected', 'not_applied', 'restart_required'] as const)
        .map((state) => runSupplementStatusText({...base, state})),
    );
    expect(seen.size).toBe(6);
    expect(runSupplementStatusText({...base, state: 'restart_required', reason: 'needs_selection'}))
      .toContain('selection');
    expect(runSupplementStatusText({...base, state: 'rejected', failureCode: 'request_failed'}))
      .toContain('duplicate');
    expect(runSupplementStatusText({...base, state: 'not_applied', failureCode: 'outcome_unknown'}))
      .toContain('Not confirmed');
    expect(runSupplementStatusText({...base, state: 'not_applied', reason: 'turn_budget'}))
      .toContain('turns');
  });
});

describe('runSupplementMessageActions', () => {
  it('offers retry and edit for rejected, retry only while the window is open', () => {
    expect(runSupplementMessageActions({...base, state: 'rejected', reason: 'policy'}, open))
      .toEqual(['retry', 'edit']);
    expect(runSupplementMessageActions({...base, state: 'rejected'}, {...open, windowOpen: false}))
      .toEqual(['edit']);
  });

  it('does not offer retry for a body the server would refuse again', () => {
    expect(runSupplementMessageActions({...base, state: 'rejected', failureCode: 'RUN_SUPPLEMENT_TOO_LARGE'}, open))
      .toEqual(['edit']);
  });

  it('keeps not_applied reachable through edit only', () => {
    expect(runSupplementMessageActions({...base, state: 'not_applied'}, open)).toEqual(['edit']);
  });

  it('offers no restart while a later run is active', () => {
    expect(runSupplementMessageActions({...base, state: 'restart_required', reason: 'scope_changed'},
      {...open, supersededByActiveRun: true})).toEqual([]);
  });

  it('offers restart only once', () => {
    expect(runSupplementMessageActions({...base, state: 'restart_required', reason: 'scope_changed', restartConsumed: true}, open))
      .toEqual([]);
  });

  it('offers restart unless the supplement needs a new selection', () => {
    expect(runSupplementMessageActions({...base, state: 'restart_required', reason: 'scope_changed'}, open))
      .toEqual(['restart']);
    expect(runSupplementMessageActions({...base, state: 'restart_required', reason: 'needs_selection'}, open))
      .toEqual([]);
  });

  it('offers nothing while pending or once the private text is gone', () => {
    expect(runSupplementMessageActions({...base, state: 'queued'}, open)).toEqual([]);
    expect(runSupplementMessageActions({...base, state: 'rejected'}, {...open, textAvailable: false})).toEqual([]);
  });
});

describe('composeRestartQuery', () => {
  it('lets a changed goal replace the question', () => {
    expect(composeRestartQuery('why jank', 'analyze startup instead', 'goal_changed')).toBe('analyze startup instead');
  });

  it('combines the original question and the supplement', () => {
    setUiLanguagePreference('en');
    expect(composeRestartQuery('  why jank ', ' check binder ')).toBe(
      'why jank\n\nAdditional note:\ncheck binder',
    );
  });

  it('falls back to the supplement alone for a missing or slash-command question', () => {
    expect(composeRestartQuery(undefined, 'x')).toBe('x');
    expect(composeRestartQuery('   ', 'x')).toBe('x');
    expect(composeRestartQuery('/sql select 1', 'x')).toBe('x');
  });
});

describe('runSupplementRestartSubmission', () => {
  const question = {id: 'q', role: 'user', content: 'why jank'};
  const flow = {id: 'flow', role: 'assistant', flowTag: 'streaming_flow', content: ''};
  const earlier = {id: 's1', role: 'user', flowTag: 'run_supplement', content: 'earlier'};
  const later = {id: 's2', role: 'user', flowTag: 'run_supplement', content: 'later'};

  it('skips earlier supplements to find the question', () => {
    setUiLanguagePreference('en');
    expect(runSupplementRestartSubmission([question, flow, earlier, later], later)).toEqual({
      query: 'why jank\n\nAdditional note:\nlater',
      privateContent: false,
    });
  });

  it('sends the supplement alone when no question precedes it', () => {
    expect(runSupplementRestartSubmission([flow, earlier], earlier).query).toBe('earlier');
  });

  it('refuses to reuse a private placeholder as the question but stays private', () => {
    const restored = {...question, content: privateQueryStoragePlaceholder(), privateContent: true};
    expect(runSupplementRestartSubmission([restored, later], later)).toEqual({
      query: 'later',
      privateContent: true,
    });
  });

  it('is private when only the question is private', () => {
    expect(
      runSupplementRestartSubmission([{...question, privateContent: true}, later], later).privateContent,
    ).toBe(true);
  });

  it('is private when only the supplement is private', () => {
    const privateLater = {...later, privateContent: true};
    expect(runSupplementRestartSubmission([question, privateLater], privateLater).privateContent).toBe(true);
  });

  it('stays private for a changed goal even though the question is not sent', () => {
    const goal = {...later, runSupplement: {reason: 'goal_changed' as const}};
    expect(runSupplementRestartSubmission([{...question, privateContent: true}, goal], goal)).toEqual({
      query: 'later',
      privateContent: true,
    });
  });
});
