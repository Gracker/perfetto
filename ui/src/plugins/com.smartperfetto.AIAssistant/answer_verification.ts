// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

/**
 * Deliver first, verify after: the answer body is final when it first appears,
 * while its one semantic review may still run. The cue says which of the two
 * non-final verification states the message is in; a finished verdict removes it.
 */
export type AnswerVerificationState = 'pending' | 'unfinished';

/** Loading phase while a review-only stop is being honoured. */
export function reviewStopPhaseText(): string {
  return uiText('正在结束核验…', 'Stopping verification…');
}

export function answerVerificationCueText(state: AnswerVerificationState): string {
  return state === 'pending'
    ? uiText('结论已生成，正在核验…', 'Answer ready; verification in progress…')
    : uiText('未完成核验：此结论未经核验', 'Verification did not finish: this answer is unverified');
}
