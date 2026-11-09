// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  settleRunSupplementEntryForStorage,
  type RunSupplementEntry,
} from './run_supplement_state';
import {uiText} from './ui_language';

const PRIVATE_QUERY_PLACEHOLDER_MARKER = '[PRIVATE_QUERY_REFERENCE]';

export interface PrivateMessageStorageMarker {
  content: string;
  privateContent?: boolean;
  serverVerificationDetails?: string;
  serverVerificationNotice?: string;
  serverVerificationBinding?: unknown;
  answerVerification?: 'unfinished';
  answerDraft?: boolean;
  runSupplement?: RunSupplementEntry;
}

/** A display-only answer draft is never stored; its replacement is. */
export function isStorableMessage(message: {answerDraft?: boolean}): boolean {
  return message.answerDraft !== true;
}

export function privateQueryStoragePlaceholder(): string {
  return uiText(
    `${PRIVATE_QUERY_PLACEHOLDER_MARKER} 私有源码或知识库请求（原文未保存）`,
    `${PRIVATE_QUERY_PLACEHOLDER_MARKER} Private source or knowledge request (original text not saved)`,
  );
}

/** True for a restored private message whose original text was never stored. */
export function isPrivateQueryStoragePlaceholder(content: string): boolean {
  return content.startsWith(PRIVATE_QUERY_PLACEHOLDER_MARKER);
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
  return projected.runSupplement
    ? {...projected, runSupplement: settleRunSupplementEntryForStorage(projected.runSupplement)}
    : projected;
}
