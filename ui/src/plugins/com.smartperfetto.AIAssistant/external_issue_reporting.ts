// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  AnalysisReceipt,
  ExternalIssueDraftV1,
  ExternalIssueOpportunityV1,
  ExternalIssueReviewCandidateV1,
  ExternalIssueReviewV1,
} from './generated/data_contract.types';

export interface ExternalIssueSourceRefs {
  sessionId: string;
  runId: string;
  runManifestId: string;
  resultSnapshotId?: string;
}

export interface ExternalIssueFeedbackRequest {
  rating: 'positive' | 'negative';
  turnIndex: number;
  runId?: string;
  targetKind?: 'conclusion';
  targetId?: string;
}

export interface ExternalIssueUiState {
  phase:
    | 'loading_opportunity'
    | 'ready'
    | 'reviewing'
    | 'reviewed'
    | 'drafting'
    | 'draft_ready'
    | 'error';
  opportunity?: ExternalIssueOpportunityV1;
  review?: ExternalIssueReviewV1;
  draft?: ExternalIssueDraftV1;
  selectedCandidateId?: string;
  answers: Record<string, string>;
  sensitiveDataReviewed: boolean;
  securitySensitive: boolean;
  error?: string;
}

export function externalIssueSourceRefs(
  receipt: AnalysisReceipt | undefined,
): ExternalIssueSourceRefs | undefined {
  if (
    !receipt ||
    receipt.schemaVersion !== 2 ||
    typeof receipt.runManifestId !== 'string' ||
    !receipt.runManifestId
  ) {
    return undefined;
  }
  return {
    sessionId: receipt.sessionId,
    runId: receipt.runId,
    runManifestId: receipt.runManifestId,
    ...(receipt.outputs.resultSnapshotId
      ? {resultSnapshotId: receipt.outputs.resultSnapshotId}
      : {}),
  };
}

export function createExternalIssueUiState(): ExternalIssueUiState {
  return {
    phase: 'loading_opportunity',
    answers: {},
    sensitiveDataReviewed: false,
    securitySensitive: false,
  };
}

export function externalIssueFeedbackRequest(
  receipt: AnalysisReceipt | undefined,
  rating: 'positive' | 'negative',
  turnIndex: number,
): ExternalIssueFeedbackRequest {
  const refs = externalIssueSourceRefs(receipt);
  return {
    rating,
    turnIndex,
    ...(refs
      ? {
          runId: refs.runId,
          targetKind: 'conclusion' as const,
          targetId: refs.runId,
        }
      : {}),
  };
}

export function parseExternalIssueOpportunityResponse(
  value: unknown,
): ExternalIssueOpportunityV1 | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.opportunity)) {
    return undefined;
  }
  const opportunity = value.opportunity;
  if (
    opportunity.schemaVersion !== 'external_issue_opportunity@1' ||
    typeof opportunity.runId !== 'string' ||
    typeof opportunity.runManifestId !== 'string' ||
    !['available', 'not_needed', 'disabled'].includes(
      String(opportunity.status),
    ) ||
    !Array.isArray(opportunity.signals) ||
    typeof opportunity.agentReviewAvailable !== 'boolean'
  ) {
    return undefined;
  }
  return opportunity as unknown as ExternalIssueOpportunityV1;
}

export function parseExternalIssueReviewResponse(
  value: unknown,
): ExternalIssueReviewV1 | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.review)) {
    return undefined;
  }
  const review = value.review;
  if (
    review.schemaVersion !== 'external_issue_review@1' ||
    typeof review.runId !== 'string' ||
    typeof review.runManifestId !== 'string' ||
    (review.source !== 'agent' &&
      review.source !== 'deterministic_fallback') ||
    !Array.isArray(review.candidates)
  ) {
    return undefined;
  }
  return review as unknown as ExternalIssueReviewV1;
}

export function parseExternalIssueDraftResponse(
  value: unknown,
): ExternalIssueDraftV1 | undefined {
  if (!isRecord(value) || value.success !== true || !isRecord(value.draft)) {
    return undefined;
  }
  const draft = value.draft;
  if (
    draft.schemaVersion !== 'external_issue_draft@1' ||
    typeof draft.runId !== 'string' ||
    typeof draft.candidateId !== 'string' ||
    typeof draft.title !== 'string' ||
    typeof draft.body !== 'string' ||
    typeof draft.githubUrl !== 'string' ||
    typeof draft.fingerprint !== 'string' ||
    !Array.isArray(draft.redactions) ||
    draft.notSubmitted !== true
  ) {
    return undefined;
  }
  return draft as unknown as ExternalIssueDraftV1;
}

export function externalIssueCandidateCanDraft(
  candidate: ExternalIssueReviewCandidateV1,
  state: Pick<
    ExternalIssueUiState,
    'answers' | 'sensitiveDataReviewed' | 'securitySensitive'
  >,
): boolean {
  if (
    state.securitySensitive ||
    !state.sensitiveDataReviewed ||
    (
      candidate.decision !== 'report' &&
      candidate.decision !== 'needs_user_input'
    )
  ) {
    return false;
  }
  return candidate.userQuestions.every(
    question =>
      !question.required ||
      Boolean(state.answers[question.questionId]?.trim()),
  );
}

export function isSafeExternalIssueUrl(
  value: string,
  allowedBaseUrl: string,
): boolean {
  try {
    const url = new URL(value);
    const allowed = new URL(allowedBaseUrl);
    const normalizedPath = url.pathname.replace(/\/+$/, '');
    const allowedPath = allowed.pathname.replace(/\/+$/, '');
    return (
      url.protocol === 'https:' &&
      allowed.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      url.origin === allowed.origin &&
      normalizedPath === allowedPath &&
      allowedPath.endsWith('/issues/new') &&
      url.searchParams.has('title') &&
      url.searchParams.has('body')
    );
  } catch {
    return false;
  }
}

export function externalIssueResponseError(
  value: unknown,
  fallback: string,
): string {
  return isRecord(value) && typeof value.error === 'string' && value.error
    ? value.error
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
