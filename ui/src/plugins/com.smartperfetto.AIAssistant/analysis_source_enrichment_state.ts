// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Message} from './types';

export function hasRunningAnalysisSourceEnrichment(
  messages: readonly Message[],
): boolean {
  return messages.some(
    (message) => message.analysisSourceEnrichment?.status === 'running',
  );
}
