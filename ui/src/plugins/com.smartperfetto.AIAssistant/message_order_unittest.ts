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

  it('ends each round with its own answer regardless of arrival order', () => {
    const messages = [
      message('ready', 'assistant'),
      message('user-1', 'user'),
      message('answer-1', 'assistant', 'answer_stream'),
      message('timeline-1', 'assistant', 'streaming_flow'),
      message('round-2', 'system', 'round_separator'),
      message('user-2', 'user'),
      message('timeline-2', 'assistant', 'streaming_flow'),
      message('answer-2', 'assistant', 'answer_stream'),
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

  it('keeps other assistant cards above both the answer and the process', () => {
    const messages = [
      message('user', 'user'),
      message('timeline', 'assistant', 'streaming_flow'),
      message('answer', 'assistant', 'answer_stream'),
      message('data-card', 'assistant'),
    ];

    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      'user',
      'data-card',
      'timeline',
      'answer',
    ]);
  });

  it('keeps earlier rounds intact while the current round streams and updates its steps', () => {
    const firstRound = [
      message('user-1', 'user'),
      message('answer-1', 'assistant', 'answer_stream'),
      message('timeline-1', 'assistant', 'streaming_flow'),
    ];
    const secondRound = [
      message('round-2', 'system', 'round_separator'),
      message('user-2', 'user'),
      message('timeline-2', 'assistant', 'streaming_flow'),
    ];
    const messages = [...firstRound, ...secondRound];
    const firstRoundOrder = ['user-1', 'timeline-1', 'answer-1'];
    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      ...firstRoundOrder, 'round-2', 'user-2', 'timeline-2',
    ]);

    messages.push(message('answer-2', 'assistant', 'answer_stream'));
    secondRound[2].content = 'Updated second-round steps';
    secondRound[2].timestamp = 2000;
    messages.push(message('late-data-2', 'assistant'));
    const originalOrder = ids(messages);

    expect(ids(orderMessagesForDisplay(messages))).toEqual([
      ...firstRoundOrder,
      'round-2', 'user-2', 'late-data-2', 'timeline-2', 'answer-2',
    ]);
    expect(ids(messages)).toEqual(originalOrder);
    expect(firstRound[1].content).toBe('answer-1');
    expect(firstRound[2].content).toBe('timeline-1');
  });
});
