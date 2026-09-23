// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {AIPanel} from './ai_panel';
import {
  clearPendingComposerDraft,
  emitComposerDraft,
  peekPendingComposerDraft,
  subscribeComposerDraft,
} from './assistant_command_bus';
import {resetAISharedState} from './ai_shared_state';

function panel(): any {
  const value = new AIPanel() as any;
  value.state.backendTraceId = 'trace-a';
  value.sendMessage = vi.fn();
  return value;
}

describe('AIPanel composer drafts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearPendingComposerDraft();
    resetAISharedState();
  });

  it('pre-fills the composer for its own trace and never sends', () => {
    const value = panel();
    const unsubscribe = subscribeComposerDraft((draft) => value.acceptComposerDraft(draft));

    emitComposerDraft({text: 'Continue analyzing thread_state_id=7', traceId: 'trace-a'});

    expect(value.state.input).toBe('Continue analyzing thread_state_id=7');
    expect(value.sendMessage).not.toHaveBeenCalled();
    expect(peekPendingComposerDraft()).toBeNull();
    unsubscribe();
  });

  it('keeps what the user already typed above the draft', () => {
    const value = panel();
    value.state.input = 'my own note';

    expect(value.acceptComposerDraft({text: 'draft', traceId: 'trace-a'})).toBe(true);
    expect(value.state.input).toBe('my own note\n\ndraft');
  });

  it('refuses a draft built for another trace', () => {
    const value = panel();

    expect(value.acceptComposerDraft({text: 'draft', traceId: 'trace-b'})).toBe(false);
    expect(value.state.input).toBe('');
  });

  it('drops an undelivered draft when the trace or the session changes', () => {
    const value = panel();
    value.saveHistory = vi.fn();
    value.addWelcomeMessage = vi.fn();

    emitComposerDraft({text: 'draft', traceId: 'trace-a'});
    value.createNewSession();
    expect(peekPendingComposerDraft()).toBeNull();

    emitComposerDraft({text: 'draft', traceId: 'trace-a'});
    value.resetStateForNewTrace();
    expect(peekPendingComposerDraft()).toBeNull();
  });
});
