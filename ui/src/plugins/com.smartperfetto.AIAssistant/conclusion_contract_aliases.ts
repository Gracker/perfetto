// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export const CONTRACT_ALIASES = {
  root: {
    conclusions: ['conclusion', 'conclusions'],
    clusters: ['clusters'],
    evidenceChain: ['evidence_chain', 'evidenceChain'],
    claims: ['claims', 'claim_refs', 'claimRefs', 'claimReferences'],
    uncertainties: ['uncertainties'],
    nextSteps: ['next_steps', 'nextSteps'],
    metadata: ['metadata'],
    sceneId: ['sceneId', 'scene_id'],
    confidence: ['confidencePercent', 'confidence'],
    rounds: ['rounds'],
  },
  metadata: {
    sceneId: ['sceneId', 'scene_id'],
    clusterPolicy: ['clusterPolicy', 'cluster_policy'],
    maxClusters: ['maxClusters', 'max_clusters'],
    confidencePercent: ['confidencePercent'],
    rounds: ['rounds'],
  },
  conclusion: {
    statement: ['statement'],
    trigger: ['trigger'],
    supply: ['supply'],
    amplification: ['amplification'],
    confidence: ['confidencePercent', 'confidence'],
  },
  cluster: {
    cluster: ['cluster'],
    description: ['description'],
    frames: ['frames'],
    percentage: ['percentage'],
    frameRefs: ['frameRefs', 'frame_refs', 'frameIds', 'frame_ids'],
    omittedFrames: ['omittedFrameRefs', 'omitted_frame_refs', 'omittedFrames', 'omitted_frames'],
  },
  evidence: {
    conclusionId: ['conclusionId', 'conclusion_id', 'conclusion'],
    evidence: ['evidence'],
    text: ['text'],
    statement: ['statement'],
    data: ['data'],
  },
  claim: {
    id: ['id', 'claimId', 'claim_id'],
    conclusionId: ['conclusionId', 'conclusion_id', 'conclusion'],
    text: ['text', 'statement', 'claim'],
    references: ['references', 'refs', 'evidenceRefs', 'evidence_refs'],
  },
  claimRef: {
    evidenceRefId: ['evidenceRefId', 'evidence_ref_id', 'evidenceId', 'evidence_id'],
    rowIndex: ['rowIndex', 'row_index'],
    rowSelector: ['rowSelector', 'row_selector'],
    column: ['column', 'col'],
    value: ['value'],
    sourceRef: ['sourceRef', 'source_ref', 'ref'],
    sourceToolCallId: ['sourceToolCallId', 'source_tool_call_id', 'toolCallId', 'tool_call_id'],
  },
} as const;
