// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  clearPendingComposerDraft,
  emitComposerDraft,
  peekPendingComposerDraft,
  subscribeComposerDraft,
} from './assistant_command_bus';

describe('composer draft channel', () => {
  afterEach(() => {
    clearPendingComposerDraft();
  });

  it('keeps one draft for a panel that subscribes later, and the newest wins', () => {
    emitComposerDraft({text: 'first', traceId: 'trace-a'});
    emitComposerDraft({text: 'second', traceId: 'trace-a'});
    const listener = vi.fn(() => true);

    const unsubscribe = subscribeComposerDraft(listener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({text: 'second', traceId: 'trace-a'});
    expect(peekPendingComposerDraft()).toBeNull();
    unsubscribe();
  });

  it('leaves a refused draft pending and drops it on clear', () => {
    const unsubscribe = subscribeComposerDraft(() => false);

    emitComposerDraft({text: 'other trace', traceId: 'trace-b'});
    expect(peekPendingComposerDraft()).toEqual({text: 'other trace', traceId: 'trace-b'});

    clearPendingComposerDraft();
    expect(peekPendingComposerDraft()).toBeNull();
    unsubscribe();
  });

  it('delivers directly to a mounted panel without keeping a copy', () => {
    const received: string[] = [];
    const unsubscribe = subscribeComposerDraft((draft) => {
      received.push(draft.text);
      return true;
    });

    emitComposerDraft({text: 'now', traceId: 'trace-a'});

    expect(received).toEqual(['now']);
    expect(peekPendingComposerDraft()).toBeNull();
    unsubscribe();
  });
});
