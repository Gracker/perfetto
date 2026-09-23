// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type AssistantCommand = 'clear-chat' | 'open-settings';

type CommandListener = () => void;

const listeners: Record<AssistantCommand, Set<CommandListener>> = {
  'clear-chat': new Set<CommandListener>(),
  'open-settings': new Set<CommandListener>(),
};

function subscribe(command: AssistantCommand, listener: CommandListener): () => void {
  listeners[command].add(listener);
  return () => {
    listeners[command].delete(listener);
  };
}

function emit(command: AssistantCommand): void {
  for (const listener of listeners[command]) {
    try {
      listener();
    } catch (error) {
      console.warn(`[AIAssistantCommandBus] Listener for ${command} failed:`, error);
    }
  }
}

export function subscribeClearChat(listener: CommandListener): () => void {
  return subscribe('clear-chat', listener);
}

export function subscribeOpenSettings(listener: CommandListener): () => void {
  return subscribe('open-settings', listener);
}

export function emitClearChatCommand(): void {
  emit('clear-chat');
}

export function emitOpenSettingsCommand(): void {
  emit('open-settings');
}
/**
 * A question another surface hands to the conversation composer. It is only
 * ever pre-filled, never sent: the user reads and sends it. `traceId` binds it
 * to the backend trace it was built from; the panel refuses it for any other.
 */
export interface ComposerDraft {
  text: string;
  traceId: string;
}

/** Returns true when the draft was taken; false leaves it pending. */
type ComposerDraftListener = (draft: ComposerDraft) => boolean;

const composerDraftListeners = new Set<ComposerDraftListener>();
let pendingComposerDraft: ComposerDraft | null = null;

/** Whether `listener` took the draft; a throwing listener did not. */
function deliverComposerDraft(listener: ComposerDraftListener, draft: ComposerDraft): boolean {
  try {
    return listener(draft);
  } catch (error) {
    console.warn('[AIAssistantCommandBus] Composer draft listener failed:', error);
    return false;
  }
}

function offerComposerDraft(draft: ComposerDraft): boolean {
  return [...composerDraftListeners].some((listener) => deliverComposerDraft(listener, draft));
}

/**
 * Hand a draft to the composer. With no panel mounted it waits, as the only
 * pending draft, until one subscribes; a newer draft replaces it.
 */
export function emitComposerDraft(draft: ComposerDraft): void {
  pendingComposerDraft = offerComposerDraft(draft) ? null : draft;
}

export function subscribeComposerDraft(listener: ComposerDraftListener): () => void {
  composerDraftListeners.add(listener);
  if (pendingComposerDraft && deliverComposerDraft(listener, pendingComposerDraft)) pendingComposerDraft = null;
  return () => {
    composerDraftListeners.delete(listener);
  };
}

/** Drop a draft that was not delivered yet, e.g. when the trace or session changes. */
export function clearPendingComposerDraft(): void {
  pendingComposerDraft = null;
}

/** Test hook: the draft still waiting for a panel, if any. */
export function peekPendingComposerDraft(): ComposerDraft | null {
  return pendingComposerDraft;
}
