// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import type {
  AnalysisReceiptV2,
  ExternalIssueReviewCandidateV1,
} from './generated/data_contract.types';
import {
  createExternalIssueUiState,
  externalIssueCandidateCanDraft,
  externalIssueFeedbackRequest,
  externalIssueSourceRefs,
  isSafeExternalIssueUrl,
  parseExternalIssueDraftResponse,
  parseExternalIssueOpportunityResponse,
} from './external_issue_reporting';

const receipt: AnalysisReceiptV2 = {
  schemaVersion: 2,
  runId: 'run-1',
  sessionId: 'session-1',
  traceId: 'trace-1',
  mode: 'full',
  resolvedMode: 'full',
  providerId: null,
  generatedAt: 1,
  runManifestId: 'manifest-1',
  traceEvidence: {
    sqlCount: 1,
    skillCount: 1,
    dataEnvelopeCount: 1,
    artifactCount: 0,
    evidenceRefCount: 0,
  },
  nonEvidenceContext: {
    frontendPrequeryCount: 0,
    memoryHintCount: 0,
    conversationContextCount: 0,
    strategyHintCount: 0,
  },
  claimAudit: {
    totalClaims: 0,
    verifiedClaims: 0,
    unsupportedClaims: 0,
    uncertainClaims: 0,
  },
  qualityGates: {
    finalReportContract: 'passed',
    claimVerification: 'passed',
    identityResolution: 'passed',
  },
  outputs: {resultSnapshotId: 'snapshot-1'},
};

const candidate: ExternalIssueReviewCandidateV1 = {
  candidateId: 'candidate-1',
  decision: 'needs_user_input',
  ownership: 'skill',
  contributionKind: 'skill_improvement',
  confidence: 'medium',
  title: 'Skill failed',
  agentAssessment: 'A failure was recorded.',
  basisSignalIds: ['signal-1'],
  references: {
    claimIds: [],
    findingIds: [],
    evidenceRefIds: [],
    skillIds: ['skill-1'],
  },
  missingEvidence: ['Reproduction'],
  userQuestions: [{
    questionId: 'question-1',
    prompt: 'How can it be reproduced?',
    required: true,
  }],
  draftSeed: {
    problemStatement: 'Failure',
    expectedBehavior: 'Success',
    reproductionHint: 'Run it',
    suggestedContribution: 'Fixture',
  },
};

describe('external issue reporting UI contract', () => {
  it('uses only version-2 receipt references for historical run requests', () => {
    expect(externalIssueSourceRefs(receipt)).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      runManifestId: 'manifest-1',
      resultSnapshotId: 'snapshot-1',
    });
    expect(externalIssueSourceRefs({...receipt, schemaVersion: 1} as never))
      .toBeUndefined();
    expect(externalIssueFeedbackRequest(receipt, 'negative', 4)).toEqual({
      rating: 'negative',
      turnIndex: 4,
      runId: 'run-1',
      targetKind: 'conclusion',
      targetId: 'run-1',
    });
  });

  it('requires answers and an explicit sensitive-data review before drafting', () => {
    const state = createExternalIssueUiState();
    expect(externalIssueCandidateCanDraft(candidate, state)).toBe(false);
    state.answers['question-1'] = 'Use the scrolling preset';
    state.sensitiveDataReviewed = true;
    expect(externalIssueCandidateCanDraft(candidate, state)).toBe(true);
    state.securitySensitive = true;
    expect(externalIssueCandidateCanDraft(candidate, state)).toBe(false);
  });

  it('accepts versioned API payloads and rejects unsafe open targets', () => {
    expect(parseExternalIssueOpportunityResponse({
      success: true,
      opportunity: {
        schemaVersion: 'external_issue_opportunity@1',
        runId: 'run-1',
        runManifestId: 'manifest-1',
        status: 'available',
        signals: [],
        agentReviewAvailable: true,
      },
    })?.runId).toBe('run-1');
    expect(parseExternalIssueDraftResponse({
      success: true,
      draft: {
        schemaVersion: 'external_issue_draft@1',
        runId: 'run-1',
        candidateId: 'candidate-1',
        title: 'Title',
        body: 'Body',
        githubUrl: 'https://github.com/Gracker/SmartPerfetto/issues/new',
        fingerprint: 'fingerprint',
        redactions: [],
        notSubmitted: true,
      },
    })?.notSubmitted).toBe(true);
    const allowed =
      'https://github.com/Gracker/SmartPerfetto/issues/new';
    expect(isSafeExternalIssueUrl(
      `${allowed}?title=Title&body=Body`,
      allowed,
    )).toBe(true);
    expect(isSafeExternalIssueUrl(
      'https://evil.example/Gracker/SmartPerfetto/issues/new?title=Title&body=Body',
      allowed,
    )).toBe(false);
    expect(isSafeExternalIssueUrl(
      'https://github.com/other/repo/issues/new?title=Title&body=Body',
      allowed,
    )).toBe(false);
    expect(isSafeExternalIssueUrl(
      'https://github.com/Gracker/SmartPerfetto/issues?title=Title&body=Body',
      allowed,
    )).toBe(false);
    expect(isSafeExternalIssueUrl('javascript:alert(1)', allowed)).toBe(false);
  });
});
