// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

export function conversationTraceContextResetNotice(): string {
  return uiText(
    '附加的 Trace 已变化，已开始新的 AI 会话。上方历史仅供查看，不会作为新会话上下文发送。',
    'The attached trace changed, so a new AI session has started. Earlier messages remain visible only and are not sent as context for the new session.',
  );
}
