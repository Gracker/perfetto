// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

/** A delivered answer whose verification did not finish (read from stored messages). */
export type AnswerVerificationState = 'unfinished';

export function answerVerificationCueText(): string {
  return uiText('未完成核验：此结论未经核验', 'Verification did not finish: this answer is unverified');
}
