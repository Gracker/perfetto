// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

export interface PrivateMessageStorageMarker {
  content: string;
  privateContent?: boolean;
  analysisSourceEnrichment?: {status: string};
  serverVerificationDetails?: string;
  serverVerificationNotice?: string;
  serverVerificationBinding?: unknown;
  answerVerification?: 'pending' | 'unfinished';
  answerDraft?: boolean;
}

/** A display-only answer draft is never stored; its replacement is. */
export function isStorableMessage(message: {answerDraft?: boolean}): boolean {
  return message.answerDraft !== true;
}

export function privateQueryStoragePlaceholder(): string {
  return uiText(
    '[PRIVATE_QUERY_REFERENCE] 私有源码或知识库请求（原文未保存）',
    '[PRIVATE_QUERY_REFERENCE] Private source or knowledge request (original text not saved)',
  );
}

/** Keep raw private prompts in memory while all browser persistence gets a marker. */
export function projectMessageForStorage<T extends PrivateMessageStorageMarker>(
  message: T,
): T {
  const projected = message.privateContent
    ? {
        ...message,
        content: privateQueryStoragePlaceholder(),
        serverVerificationDetails: undefined,
        serverVerificationNotice: undefined,
        serverVerificationBinding: undefined,
      }
    : message;
  // A reload cannot resume a review; a stored answer is never still pending.
  const settled = projected.answerVerification === 'pending'
    ? {...projected, answerVerification: 'unfinished' as const}
    : projected;
  return settled.analysisSourceEnrichment?.status === 'running'
    ? {
        ...settled,
        analysisSourceEnrichment: {status: 'cancelled'},
      } as T
    : settled;
}
