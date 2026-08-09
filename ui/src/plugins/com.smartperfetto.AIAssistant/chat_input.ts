// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ChatInputKeyAction =
  | 'submit'
  | 'newline'
  | 'history_previous'
  | 'history_next'
  | 'ignore';

export interface ChatInputKeyEvent {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}

/**
 * Resolves keyboard intent without coupling IME handling to a particular chat
 * surface. keyCode 229 covers browsers which report composition completion
 * after the Enter keydown event.
 */
export function resolveChatInputKeyAction(
  event: ChatInputKeyEvent,
  compositionActive: boolean,
): ChatInputKeyAction {
  if (event.key === 'Enter') {
    if (compositionActive || event.isComposing || event.keyCode === 229) {
      return 'ignore';
    }
    return event.shiftKey ? 'newline' : 'submit';
  }
  if (event.key === 'ArrowUp') return 'history_previous';
  if (event.key === 'ArrowDown') return 'history_next';
  return 'ignore';
}
