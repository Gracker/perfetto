// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {orderMessagesForDisplay} from './message_order';
import type {Message} from './types';

function message(
  id: string,
  role: Message['role'],
  flowTag?: Message['flowTag'],
): Message {
  return {
    id,
    role,
    content: id,
    timestamp: 1000,
    ...(flowTag === undefined ? {} : {flowTag}),
  };
}

function ids(messages: readonly Message[]): string[] {
  return messages.map((msg) => msg.id);
}

describe('AI Assistant message display order', () => {
  it('keeps the initial ready card before the first user turn', () => {
    const messages = [
      message('ready', 'assistant'),
      message('user', 'user'),
      message('progress-note', 'assistant', 'progress_note'),
      message('timeline', 'assistant', 'streaming_flow'),
      message('answer', 'assistant', 'answer_stream'),
    ];

    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      'ready',
      'user',
      'timeline',
      'answer',
    ]);
  });

  it('keeps streaming timeline reordering inside a conversation round', () => {
    const messages = [
      message('ready', 'assistant'),
      message('user-1', 'user'),
      message('answer-1', 'assistant', 'answer_stream'),
      message('timeline-1', 'assistant', 'streaming_flow'),
      message('round-2', 'system', 'round_separator'),
      message('user-2', 'user'),
      message('answer-2', 'assistant', 'answer_stream'),
      message('timeline-2', 'assistant', 'streaming_flow'),
    ];

    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      'ready',
      'user-1',
      'timeline-1',
      'answer-1',
      'round-2',
      'user-2',
      'timeline-2',
      'answer-2',
    ]);
  });

  it('keeps standalone progress notes when no timeline is active', () => {
    const messages = [
      message('ready', 'assistant'),
      message('progress-note', 'assistant', 'progress_note'),
    ];

    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      'ready',
      'progress-note',
    ]);
  });
});
