// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {buildSmartPerfettoStorageKey} from '../../core/smartperfetto_request_context';
import type {
  ConversationEvidenceRef,
  ConversationFullHandoff,
  ConversationOutcome,
} from './conversation_client';
import {projectMessageForStorage} from './private_message_storage';

const CONVERSATION_STORE_KEY = 'smartperfetto-conversation';

export interface StoredConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  privateContent?: boolean;
  evidence?: ConversationEvidenceRef[];
  outcomeKind?: ConversationOutcome['kind'];
  fullHandoff?: ConversationFullHandoff;
}

export interface StoredConversation {
  backendUrl: string;
  sessionId?: string;
  traceId?: string;
  messages: StoredConversationMessage[];
  updatedAt: number;
}

function storageKey(): string {
  return buildSmartPerfettoStorageKey(CONVERSATION_STORE_KEY, 'workspace');
}

export function loadConversationStore(backendUrl: string): StoredConversation {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey()) || '{}') as Partial<StoredConversation>;
    if (parsed.backendUrl !== backendUrl || !Array.isArray(parsed.messages)) {
      return {backendUrl, messages: [], updatedAt: Date.now()};
    }
    return {
      backendUrl,
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      traceId: typeof parsed.traceId === 'string' ? parsed.traceId : undefined,
      messages: parsed.messages.filter((message): message is StoredConversationMessage => (
        Boolean(message) &&
        typeof message.id === 'string' &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        typeof message.timestamp === 'number'
      )),
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return {backendUrl, messages: [], updatedAt: Date.now()};
  }
}

export function saveConversationStore(store: StoredConversation): void {
  try {
    localStorage.setItem(storageKey(), JSON.stringify({
      ...store,
      messages: store.messages.slice(-200).map(projectMessageForStorage),
      updatedAt: Date.now(),
    }));
  } catch {
    // Storage is best-effort in private browsing and quota-constrained contexts.
  }
}

export function appendConversationMessage(
  backendUrl: string,
  message: StoredConversationMessage,
  sessionId?: string,
): StoredConversation {
  const store = loadConversationStore(backendUrl);
  const messages = store.messages.some((existing) => existing.id === message.id)
    ? store.messages
    : [...store.messages, message];
  const next = {...store, messages, sessionId: sessionId ?? store.sessionId, updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}

export function clearConversationStore(backendUrl: string): StoredConversation {
  const next = {backendUrl, messages: [], updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}
