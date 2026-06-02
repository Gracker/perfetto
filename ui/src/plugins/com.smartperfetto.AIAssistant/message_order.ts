// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Message} from './types';

function buildRoundIndexMap(messages: readonly Message[]): Map<string, number> {
  const roundIndexMap = new Map<string, number>();
  let currentRound = 0;

  for (const msg of messages) {
    if (msg.flowTag === 'round_separator') currentRound++;
    roundIndexMap.set(msg.id, currentRound);
  }

  return roundIndexMap;
}

/**
 * Return the messages in the same order they should appear in the chat panel.
 *
 * The assistant can append streaming timeline and answer bubbles out of order
 * while an analysis is running. We still keep pre-turn assistant/system cards
 * (notably the initial "AI Assistant ready" card) before the first user prompt.
 */
export function orderMessagesForDisplay(
  messages: readonly Message[],
): Message[] {
  const hasConversationTimeline = messages.some(
    (msg) => msg.flowTag === 'streaming_flow',
  );
  const filteredMessages = messages.filter((msg) => {
    // Hide progress_note bubbles when conversation timeline is active
    // (same info is already shown in the timeline).
    return !(hasConversationTimeline && msg.flowTag === 'progress_note');
  });

  const roundIndexMap = buildRoundIndexMap(filteredMessages);
  const originalIndexMap = new Map<string, number>();
  const firstUserIndexByRound = new Map<number, number>();

  filteredMessages.forEach((msg, index) => {
    originalIndexMap.set(msg.id, index);
    if (msg.role !== 'user') return;

    const round = roundIndexMap.get(msg.id) ?? 0;
    const current = firstUserIndexByRound.get(round);
    if (current === undefined || index < current) {
      firstUserIndexByRound.set(round, index);
    }
  });

  const phase = (msg: Message): number => {
    const round = roundIndexMap.get(msg.id) ?? 0;
    const index = originalIndexMap.get(msg.id) ?? 0;
    const firstUserIndex = firstUserIndexByRound.get(round);

    if (firstUserIndex !== undefined && index < firstUserIndex) return 0;
    if (msg.role === 'user') return 1;
    if (msg.flowTag === 'streaming_flow') return 2;
    if (msg.flowTag === 'answer_stream') return 4;
    return 3;
  };

  return [...filteredMessages].sort((a, b) => {
    const roundA = roundIndexMap.get(a.id) ?? 0;
    const roundB = roundIndexMap.get(b.id) ?? 0;
    if (roundA !== roundB) return roundA - roundB;

    const phaseDiff = phase(a) - phase(b);
    if (phaseDiff !== 0) return phaseDiff;

    const indexA = originalIndexMap.get(a.id) ?? 0;
    const indexB = originalIndexMap.get(b.id) ?? 0;
    return indexA - indexB;
  });
}
