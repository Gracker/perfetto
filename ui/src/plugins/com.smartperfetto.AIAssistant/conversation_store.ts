// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  buildSmartPerfettoStorageKey,
  getSmartPerfettoRequestContext,
} from '../../core/smartperfetto_request_context';
import {
  getSmartPerfettoAuthSessionGeneration,
  isSmartPerfettoOidcMode,
} from '../../core/smartperfetto_auth';
import {
  getConversation,
  type ConversationClientConfig,
  type ConversationHistoryTurn,
  type ConversationEvidenceRef,
  type ConversationFullHandoff,
  type ConversationOutcome,
} from './conversation_client';
import {projectMessageForStorage} from './private_message_storage';
import type {ConversationSourceEnrichmentUpdate} from './types';
import {uiText} from './ui_language';

const CONVERSATION_STORE_KEY = 'smartperfetto-conversation';

type ConversationOwner = [string, string, string];
interface ConversationLocator {
  version: 1;
  owner: ConversationOwner;
  backendUrl: string;
  /** Logical conversation only: never an SDK session or trace handle. */
  conversationId: string;
}

function normalizedBackendUrl(backendUrl: string): string {
  return backendUrl.trim().replace(/\/+$/, '');
}

function conversationOwner(): ConversationOwner {
  const {tenantId, userId, workspaceId} = getSmartPerfettoRequestContext();
  return [tenantId, userId, workspaceId];
}

/** Exact tuples avoid collisions between identifiers that themselves contain ':'. */
export function conversationAuthorityKey(backendUrl: string): string {
  return JSON.stringify([
    ...conversationOwner(), normalizedBackendUrl(backendUrl),
    getSmartPerfettoAuthSessionGeneration(),
  ]);
}

const pendingRestores = new Map<string, {
  controller: AbortController;
  promise: Promise<StoredConversation>;
}>();

interface ConversationRuntimeIdentity {
  sessionId?: string;
  traceId?: string;
}

const oidcRuntimeIdentities = new Map<string, ConversationRuntimeIdentity>();
const runtimeStores = new Map<string, StoredConversation>();
let oidcRuntimeGeneration = getSmartPerfettoAuthSessionGeneration();

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
  turn?: ConversationHistoryTurn;
  recoveryStatus?: 'unavailable';
}

export interface StoredConversation {
  backendUrl: string;
  /** Candidate locator; GET authorization is required before binding sessionId. */
  conversationId?: string;
  recoveryStatus?: 'available' | 'unavailable' | 'interrupted';
  historyOmittedMessages?: number;
  historyUnavailableMessages?: number;
  /** GET-authorized active execution; never persisted as a continuation token. */
  activeRunId?: string;
  sessionId?: string;
  traceId?: string;
  messages: StoredConversationMessage[];
  updatedAt: number;
}

function storageKey(backendUrl: string): string {
  return `${CONVERSATION_STORE_KEY}:v2:${JSON.stringify([
    ...conversationOwner(), normalizedBackendUrl(backendUrl),
  ])}`;
}

function bindOidcRuntime(): void {
  const generation = getSmartPerfettoAuthSessionGeneration();
  if (generation !== oidcRuntimeGeneration) {
    oidcRuntimeIdentities.clear();
    runtimeStores.clear();
  }
  oidcRuntimeGeneration = generation;
}

function runtimeIdentityKey(storageKeyValue: string, backendUrl: string): string {
  return `${storageKeyValue}\0${backendUrl}`;
}

export function loadConversationStore(backendUrl: string): StoredConversation {
  const empty = {backendUrl, messages: [], updatedAt: Date.now()};
  try {
    const key = storageKey(backendUrl);
    bindOidcRuntime();
    // Scrub legacy OIDC runtime handles without promoting them to locators.
    const legacyKey = buildSmartPerfettoStorageKey(CONVERSATION_STORE_KEY, 'workspace');
    if (isSmartPerfettoOidcMode()) {
      try {
        const legacy = JSON.parse(localStorage.getItem(legacyKey) || '{}') as Partial<StoredConversation>;
        if (Object.prototype.hasOwnProperty.call(legacy, 'sessionId') ||
            Object.prototype.hasOwnProperty.call(legacy, 'traceId')) {
          delete legacy.sessionId;
          delete legacy.traceId;
          localStorage.setItem(legacyKey, JSON.stringify(legacy));
        }
      } catch {
        // Invalid legacy data must not prevent reading an exact-owner v2 store.
      }
    }
    const parsed = JSON.parse(localStorage.getItem(key) || '{}') as
      Partial<StoredConversation> & {owner?: ConversationOwner; locator?: ConversationLocator};
    if (JSON.stringify(parsed.owner) !== JSON.stringify(conversationOwner()) ||
        normalizedBackendUrl(parsed.backendUrl ?? '') !== normalizedBackendUrl(backendUrl) ||
        !Array.isArray(parsed.messages)) {
      return empty;
    }
    const locator = parsed.locator;
    const conversationId = locator?.version === 1 &&
      JSON.stringify(locator.owner) === JSON.stringify(conversationOwner()) &&
      locator.backendUrl === normalizedBackendUrl(backendUrl) &&
      typeof locator.conversationId === 'string'
        ? locator.conversationId : undefined;
    const identity = oidcRuntimeIdentities.get(runtimeIdentityKey(key, normalizedBackendUrl(backendUrl)));
    return {
      backendUrl,
      conversationId,
      sessionId: identity?.sessionId,
      traceId: identity?.traceId,
      messages: parsed.messages.filter((message): message is StoredConversationMessage => (
        Boolean(message) && typeof message.id === 'string' &&
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' && typeof message.timestamp === 'number'
      )),
      historyUnavailableMessages: parsed.historyUnavailableMessages,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return empty;
  }
}

export function saveConversationStore(store: StoredConversation): void {
  try {
    const key = storageKey(store.backendUrl);
    bindOidcRuntime();
    const backendUrl = normalizedBackendUrl(store.backendUrl);
    const identityKey = runtimeIdentityKey(key, backendUrl);
    runtimeStores.set(identityKey, store);
    if (store.sessionId || store.traceId) {
      oidcRuntimeIdentities.set(identityKey, {
        sessionId: store.sessionId, traceId: store.traceId,
      });
    } else {
      oidcRuntimeIdentities.delete(identityKey);
    }
    const owner = conversationOwner();
    const conversationId = store.sessionId ?? store.conversationId;
    const locator: ConversationLocator | undefined = conversationId
      ? {version: 1, owner, backendUrl, conversationId} : undefined;
    localStorage.setItem(key, JSON.stringify({
      owner, backendUrl, locator,
      historyUnavailableMessages: store.historyUnavailableMessages,
      messages: store.messages.slice(-200).map((message) => {
        const projected = projectMessageForStorage(message);
        // Source-derived metadata and supplements can also contain private text.
        return message.privateContent
          ? {id: projected.id, role: projected.role, content: projected.content,
              timestamp: projected.timestamp, privateContent: true}
          : {...projected, turn: projected.turn ? projectConversationHistoryTurn(projected.turn) : undefined};
      }),
      updatedAt: Date.now(),
    }));
  } catch {
    // Storage is best-effort in private browsing and quota-constrained contexts.
  }
}

export class ConversationRestoreInvalidatedError extends Error {
  constructor() {
    super('Conversation restoration was invalidated');
    this.name = 'ConversationRestoreInvalidatedError';
  }
}

export function invalidateConversationRestore(backendUrl: string): void {
  try {
    const key = conversationAuthorityKey(backendUrl);
    pendingRestores.get(key)?.controller.abort();
    pendingRestores.delete(key);
  } catch {
    // The auth lifecycle clears all bindings when no owner is available.
  }
}

/** Reauthorize the logical locator before exposing history or a continuation ID. */
export function restoreConversationStore(
  config: ConversationClientConfig,
  isCurrent: () => boolean = () => true,
): Promise<StoredConversation> {
  const key = conversationAuthorityKey(config.backendUrl);
  const pending = pendingRestores.get(key);
  if (pending) return pending.promise;
  const stored = loadConversationStore(config.backendUrl);
  if (!stored.conversationId) return Promise.resolve(stored);
  const controller = new AbortController();
  const promise = (async () => {
    const restored = await getConversation(config, stored.conversationId!, controller.signal);
    if (controller.signal.aborted || !isCurrent() || conversationAuthorityKey(config.backendUrl) !== key ||
        loadConversationStore(config.backendUrl).conversationId !== stored.conversationId) {
      throw new ConversationRestoreInvalidatedError();
    }
    const now = Date.now();
    const messages: StoredConversationMessage[] = restored.history.map((message, index) => ({
      id: `conversation-${restored.sessionId}-${message.turnId ?? message.turn?.id ?? index}-${message.role}`,
      role: message.role,
      content: message.content,
      timestamp: now + index,
      privateContent: message.sourceDerived === true,
      turn: message.turn ? projectConversationHistoryTurn(message.turn) : undefined,
      ...(message.role === 'assistant' && index === restored.history.length - 1 &&
          restored.fullHandoff
        ? {fullHandoff: restored.fullHandoff} : {}),
    }));
    const next: StoredConversation = {
      backendUrl: config.backendUrl,
      conversationId: restored.sessionId,
      sessionId: restored.sessionId,
      traceId: restored.traceContext.kind === 'attached' ? restored.traceContext.traceId : undefined,
      messages,
      recoveryStatus: restored.recoveryStatus,
      activeRunId: restored.activeRunId,
      historyOmittedMessages: restored.historyOmittedMessages,
      historyUnavailableMessages: restored.historyUnavailableMessages,
      updatedAt: now,
    };
    saveConversationStore(next);
    return next;
  })().finally(() => {
    if (pendingRestores.get(key)?.promise === promise) pendingRestores.delete(key);
  });
  pendingRestores.set(key, {controller, promise});
  return promise;
}

/** Keep only public history metadata; SDK and trace handles cannot enter storage. */
function projectConversationHistoryTurn(turn: ConversationHistoryTurn): ConversationHistoryTurn {
  return {
    id: turn.id, turnIndex: turn.turnIndex,
    partial: turn.partial, completionStatus: turn.completionStatus,
    terminationReason: turn.terminationReason, terminationMessage: turn.terminationMessage,
    uncertainties: turn.uncertainties, nextSteps: turn.nextSteps,
    evidence: turn.evidence.map(ref => ({
      artifactId: ref.artifactId, evidenceRefId: ref.evidenceRefId,
      sourceToolCallId: ref.sourceToolCallId,
    })),
  };
}

/** Match the existing analysis completeness notice without changing the answer. */
export function conversationMessageContent(message: StoredConversationMessage): string {
  const turn = message.turn;
  const notices: string[] = [];
  if (message.role === 'assistant' && turn && (turn.partial || turn.completionStatus !== 'completed')) {
    const interrupted = turn.terminationMessage === 'conversation_run_interrupted_before_final_commit';
    const reason = interrupted ? uiText(
      '上一轮在保存最终结论前被中断，请基于已有证据和未完成项继续提问。',
      'The previous turn was interrupted before its final conclusion was saved. Continue with the available evidence and open questions.',
    ) : turn.terminationMessage || turn.terminationReason || uiText(
      '本轮结论不完整，请结合已知证据和待查问题继续追问。',
      'This turn is incomplete. Continue with the available evidence and open questions.',
    );
    notices.push(uiText('> **结果完整性提示**', '> **Result completeness notice**'),
      ...reason.split(/\r?\n/).filter(Boolean).map(line => `> ${line}`));
    if (turn.uncertainties?.length) notices.push(`> ${uiText('不足：', 'Limitations: ')}${turn.uncertainties.join('; ')}`);
    if (turn.nextSteps?.length) notices.push(`> ${uiText('待查：', 'Next steps: ')}${turn.nextSteps.join('; ')}`);
  }
  if (message.recoveryStatus === 'unavailable') notices.push(`> ${conversationRecoveryNotice('unavailable')}`);
  return notices.length ? `${notices.join('\n')}\n\n${message.content}` : message.content;
}

export function conversationOutcomeTurn(
  outcome: ConversationOutcome,
  runId: string,
): ConversationHistoryTurn | undefined {
  const result = outcome.finalResult;
  if (!result) return undefined;
  const partial = result.partial === true || (result.completion !== undefined && result.completion.status !== 'completed');
  return {
    id: runId, turnIndex: 0, partial,
    completionStatus: partial ? 'incomplete' : result.completion ? 'completed' : 'unknown',
    terminationReason: result.terminationReason ?? result.completion?.reason,
    terminationMessage: result.terminationMessage,
    uncertainties: result.uncertainties ?? [], nextSteps: result.nextSteps ?? [], evidence: [],
  };
}

export function conversationRestoreErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return uiText(
    `无法恢复已有对话：${detail}。请检查登录、Provider 和来源权限后刷新重试，或显式选择新对话。`,
    `Could not restore the saved conversation: ${detail}. Check sign-in, provider and source access, then reload, or explicitly start a new conversation.`,
  );
}

export function conversationRecoveryNotice(
  status: StoredConversation['recoveryStatus'],
  historyUnavailableMessages = 0,
): string {
  const notices: string[] = [];
  if (status === 'unavailable') notices.push(uiText(
    '回答已收到，但本轮未能保存为可恢复记录；后端重启后可能无法继续。',
    'The answer was received, but this turn could not be saved for recovery after a backend restart.',
  ));
  if (status === 'interrupted') notices.push(uiText(
    '已恢复可读取的对话记录。上一轮被后端重启中断，请针对未完成项继续提问。',
    'Readable conversation records restored. The previous turn was interrupted by a backend restart; continue with its open questions.',
  ));
  if (historyUnavailableMessages > 0) notices.push(uiText(
    '部分来源历史当前不可读取，未带入本轮上下文；请检查当前来源权限后再追问相关内容。',
    'Some source history is currently unavailable and was not included in this turn. Check current source access before following up on it.',
  ));
  return notices.join('\n');
}

/** Clears active bindings and pending recovery without deleting logical locators. */
export function clearConversationRuntimeIdentities(): void {
  oidcRuntimeIdentities.clear();
  runtimeStores.clear();
  for (const pending of pendingRestores.values()) pending.controller.abort();
  pendingRestores.clear();
  oidcRuntimeGeneration = getSmartPerfettoAuthSessionGeneration();
}

/** Mutations retain the authorized page-memory body; only save projects it. */
export function loadConversationStoreForUpdate(backendUrl: string): StoredConversation {
  try {
    bindOidcRuntime();
    return runtimeStores.get(runtimeIdentityKey(storageKey(backendUrl), normalizedBackendUrl(backendUrl)))
      ?? loadConversationStore(backendUrl);
  } catch {
    return loadConversationStore(backendUrl);
  }
}

export function appendConversationMessage(
  backendUrl: string,
  message: StoredConversationMessage,
  sessionId?: string,
): StoredConversation {
  const store = loadConversationStoreForUpdate(backendUrl);
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
  const store = loadConversationStoreForUpdate(backendUrl);
  const messages = store.messages.map(message => message.id === messageId
    ? {...message, sourceEnrichment}
    : message);
  const next = {...store, messages, updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}

export function clearConversationStore(backendUrl: string): StoredConversation {
  invalidateConversationRestore(backendUrl);
  const next = {backendUrl, messages: [], updatedAt: Date.now()};
  saveConversationStore(next);
  return next;
}
