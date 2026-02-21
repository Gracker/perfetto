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
} as const;
