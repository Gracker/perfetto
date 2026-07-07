// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  CaptureConfigSuggestionState,
  TraceConfigProposalRequestPayload,
} from './types';

export function createCaptureConfigSuggestionState(): CaptureConfigSuggestionState {
  return {
    visible: false,
    request: '',
    app: '',
    durationSeconds: '',
    categories: '',
    loading: false,
    error: null,
    proposal: null,
  };
}

export type TraceConfigProposalPayloadResult =
  | {ok: true; payload: TraceConfigProposalRequestPayload}
  | {ok: false; error: string};

export function buildTraceConfigProposalPayload(
  state: Pick<CaptureConfigSuggestionState, 'request' | 'app' | 'durationSeconds' | 'categories'>,
): TraceConfigProposalPayloadResult {
  const request = state.request.trim();
  if (!request) {
    return {ok: false, error: 'Capture intent is required'};
  }

  const payload: TraceConfigProposalRequestPayload = {request};
  const app = state.app.trim();
  if (app) payload.app = app;

  const durationText = state.durationSeconds.trim();
  if (durationText) {
    const durationSeconds = Number(durationText);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return {ok: false, error: 'Duration must be a positive number of seconds'};
    }
    payload.durationSeconds = durationSeconds;
  }

  const categories = parseCaptureCategories(state.categories);
  if (categories.length > 0) payload.categories = categories;
  return {ok: true, payload};
}

export function parseCaptureCategories(input: string): string[] {
  const seen = new Set<string>();
  const categories: string[] = [];
  for (const raw of input.split(',')) {
    const category = raw.trim();
    if (!category || seen.has(category)) continue;
    seen.add(category);
    categories.push(category);
  }
  return categories;
}

export function formatTraceConfigCommand(parts: string[]): string {
  return parts.map(formatCommandPart).join(' ');
}

function formatCommandPart(part: string): string {
  if (/^[A-Za-z0-9._/:=+@%-]+$/.test(part)) return part;
  return `"${part.replace(/(["\\$`])/g, '\\$1')}"`;
}
