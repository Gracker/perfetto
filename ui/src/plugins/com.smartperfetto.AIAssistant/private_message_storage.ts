// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

export interface PrivateMessageStorageMarker {
  content: string;
  privateContent?: boolean;
  analysisSourceEnrichment?: {status: string};
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
    ? {...message, content: privateQueryStoragePlaceholder()}
    : message;
  return projected.analysisSourceEnrichment?.status === 'running'
    ? {
        ...projected,
        analysisSourceEnrichment: {status: 'cancelled'},
      } as T
    : projected;
}
