// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {buildSmartPerfettoStorageKey} from '../../core/smartperfetto_request_context';
import {
  getSmartPerfettoAuthSessionGeneration,
  isSmartPerfettoOidcMode,
} from '../../core/smartperfetto_auth';
import type {
  ConversationEvidenceRef,
  ConversationFullHandoff,
  ConversationOutcome,
} from './conversation_client';
import {projectMessageForStorage} from './private_message_storage';
import type {ConversationSourceEnrichmentUpdate} from './types';

const CONVERSATION_STORE_KEY = 'smartperfetto-conversation';

interface ConversationRuntimeIdentity {
  sessionId?: string;
  traceId?: string;
}

const oidcRuntimeIdentities = new Map<string, ConversationRuntimeIdentity>();
let oidcRuntimeGeneration = getSmartPerfettoAuthSessionGeneration();
let activeOidcStorageKey: string | undefined;

export interface StoredConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  privateContent?: boolean;
  evidence?: ConversationEvidenceRef[];
  outcomeKind?: ConversationOutcome['kind'];
  fullHandoff?: ConversationFullHandoff;
  sourceEnrichment?: ConversationSourceEnrichmentUpdate;
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

function bindOidcRuntime(storageKeyValue: string): void {
  const generation = getSmartPerfettoAuthSessionGeneration();
  if (
    generation !== oidcRuntimeGeneration ||
    (activeOidcStorageKey && activeOidcStorageKey !== storageKeyValue)
  ) {
    oidcRuntimeIdentities.clear();
  }
  oidcRuntimeGeneration = generation;
  activeOidcStorageKey = storageKeyValue;
}

function runtimeIdentityKey(storageKeyValue: string, backendUrl: string): string {
  return `${storageKeyValue}\0${backendUrl}`;
}

export function loadConversationStore(backendUrl: string): StoredConversation {
  try {
    const key = storageKey();
    const oidcMode = isSmartPerfettoOidcMode();
    if (oidcMode) bindOidcRuntime(key);
    const parsed = JSON.parse(localStorage.getItem(key) || '{}') as Partial<StoredConversation>;
    if (
      oidcMode &&
      (Object.prototype.hasOwnProperty.call(parsed, 'sessionId') ||
        Object.prototype.hasOwnProperty.call(parsed, 'traceId'))
    ) {
      const {
        sessionId: _legacySessionId,
        traceId: _legacyTraceId,
        ...durableStore
      } = parsed;
      localStorage.setItem(key, JSON.stringify(durableStore));
    }
    if (parsed.backendUrl !== backendUrl || !Array.isArray(parsed.messages)) {
      return {backendUrl, messages: [], updatedAt: Date.now()};
    }
    const runtimeIdentity = oidcMode
      ? oidcRuntimeIdentities.get(runtimeIdentityKey(key, backendUrl))
      : undefined;
    return {
      backendUrl,
      sessionId: oidcMode
        ? runtimeIdentity?.sessionId
        : typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
      traceId: oidcMode
        ? runtimeIdentity?.traceId
        : typeof parsed.traceId === 'string' ? parsed.traceId : undefined,
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
    const key = storageKey();
    const oidcMode = isSmartPerfettoOidcMode();
    if (oidcMode) {
      bindOidcRuntime(key);
      const identityKey = runtimeIdentityKey(key, store.backendUrl);
      const runtimeIdentity = {
        sessionId: store.sessionId,
        traceId: store.traceId,
      };
      if (runtimeIdentity.sessionId || runtimeIdentity.traceId) {
        oidcRuntimeIdentities.set(identityKey, runtimeIdentity);
      } else {
        oidcRuntimeIdentities.delete(identityKey);
      }
    }
    localStorage.setItem(key, JSON.stringify({
      backendUrl: store.backendUrl,
      messages: store.messages.slice(-200).map(projectMessageForStorage),
      updatedAt: Date.now(),
      ...(!oidcMode ? {sessionId: store.sessionId, traceId: store.traceId} : {}),
    }));
  } catch {
    // Storage is best-effort in private browsing and quota-constrained contexts.
  }
}

/** Clears OIDC page-runtime continuation IDs without touching durable text. */
export function clearConversationRuntimeIdentities(): void {
  oidcRuntimeIdentities.clear();
  activeOidcStorageKey = undefined;
  oidcRuntimeGeneration = getSmartPerfettoAuthSessionGeneration();
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

export function updateConversationMessageSourceEnrichment(
  backendUrl: string,
  messageId: string,
  sourceEnrichment: ConversationSourceEnrichmentUpdate,
): StoredConversation {
  const store = loadConversationStore(backendUrl);
  const messages = store.messages.map(message => message.id === messageId
    ? {...message, sourceEnrichment}
    : message);
  const next = {...store, messages, updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}

export function clearConversationStore(backendUrl: string): StoredConversation {
  const next = {backendUrl, messages: [], updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}
