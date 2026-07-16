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

import {buildSmartPerfettoContextHeaders} from '../../core/smartperfetto_request_context';

export type CodebaseKind = 'app_source' | 'aosp' | 'kernel_source' | 'oem_sdk';

export interface CodebaseSummary {
  codebaseId: string;
  lifecycleState?: 'active' | 'deleting';
  kind: CodebaseKind;
  displayName: string;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  indexGeneration: number;
  activeGeneration?: string;
  contentFingerprint?: string;
  indexedRevision?: string;
  indexedDirty?: boolean;
  commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
  lastIngestAt?: number | string;
  lastIngestStatus?: string;
  lastIngestError?: string;
  chunkCount?: number;
  blockedFileCount?: number;
  redactionHitCount?: number;
  eligibleForSendToProvider?: boolean;
  consent?: {
    sendToProvider: boolean;
    consentedAt?: number | string;
    consentedBy?: string;
    consentHash?: string;
  };
}

export interface ExternalKnowledgeSourceSummary {
  sourceId: string;
  kind: 'android_internals_wiki';
  displayName: string;
  revision: string;
  contentFingerprint: string;
  dirty: boolean;
  license: string;
  rightsAcknowledged: boolean;
  sendToProvider: boolean;
  activeGeneration?: string;
  indexGeneration: number;
  indexedArticleCount?: number;
  indexedChunkCount?: number;
}

export interface CodebasePreview {
  blocked: boolean;
  blockedReason?: string;
  acceptedFileCount: number;
  skippedFileCount: number;
  acceptedFiles: string[];
  skippedFiles: string[];
}

export interface CodebaseAudit {
  codebaseId: string;
  kind: CodebaseKind;
  indexGeneration: number;
  activeGeneration?: string;
  contentFingerprint?: string;
  indexedRevision?: string;
  indexedDirty?: boolean;
  commitProvenance?: 'clean_git_revision' | 'dirty_git_worktree' | 'content_only';
  lastIngestAt?: number | string;
  lastIngestStatus?: string;
  lastIngestError?: string;
  chunkCount: number;
  blockedFileCount: number;
  redactionHitCount: number;
}

export interface CodeExcerpt {
  chunkId: string;
  codebaseId: string;
  filePath?: string;
  lineRange?: {start?: number; end?: number};
  symbol?: string;
  language?: string;
  text: string;
  truncated: boolean;
}

export interface RegisterCodebaseInput {
  kind: CodebaseKind;
  displayName: string;
  rootPath: string;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  sendToProvider: boolean;
}

export interface ReindexCodebaseResult {
  codebaseId: string;
  filesProcessed?: number;
  chunksAdded?: number;
  blockedFiles?: number;
  redactionHitCount?: number;
  success?: boolean;
}

export interface RegisterExternalKnowledgeSourceInput {
  rootPath: string;
  displayName: string;
  rightsAcknowledged: true;
  sendToProvider: boolean;
}

function trimTrailingSlash(value: string): string {
  return String(value || '').replace(/\/+$/, '');
}

function ensureLeadingSlash(value: string): string {
  return String(value || '').startsWith('/') ? String(value) : `/${String(value)}`;
}

export function buildCodebaseApiUrl(backendUrl: string, path: string): string {
  return `${trimTrailingSlash(backendUrl)}/api/rag${ensureLeadingSlash(path)}`;
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return buildSmartPerfettoContextHeaders(headers);
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || body?.success === false) {
    throw new Error(body?.error || `Codebase API failed: ${res.status}`);
  }
  return body as T;
}

export async function listCodebases(
  backendUrl: string,
  apiKey?: string,
): Promise<{featureEnabled: boolean; codebases: CodebaseSummary[]}> {
  const res = await fetch(buildCodebaseApiUrl(backendUrl, '/codebases'), {
    headers: buildHeaders(apiKey),
  });
  const body = await readJsonOrThrow<{
    featureEnabled?: boolean;
    codebases?: CodebaseSummary[];
  }>(res);
  return {
    featureEnabled: body.featureEnabled !== false,
    codebases: body.codebases || [],
  };
}

export async function listExternalKnowledgeSources(
  backendUrl: string,
  apiKey?: string,
): Promise<ExternalKnowledgeSourceSummary[]> {
  const res = await fetch(
    buildCodebaseApiUrl(backendUrl, '/android-internals/sources'),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{
    sources?: ExternalKnowledgeSourceSummary[];
  }>(res);
  return body.sources || [];
}

export async function registerExternalKnowledgeSource(
  backendUrl: string,
  input: RegisterExternalKnowledgeSourceInput,
  apiKey?: string,
): Promise<ExternalKnowledgeSourceSummary> {
  const res = await fetch(buildCodebaseApiUrl(backendUrl, '/android-internals/sources'), {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(input),
  });
  const body = await readJsonOrThrow<{source: ExternalKnowledgeSourceSummary}>(res);
  return body.source;
}

export async function reindexExternalKnowledgeSource(
  backendUrl: string,
  sourceId: string,
  apiKey?: string,
): Promise<void> {
  const res = await fetch(buildCodebaseApiUrl(
    backendUrl,
    `/android-internals/sources/${encodeURIComponent(sourceId)}/reindex`,
  ), {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({}),
  });
  await readJsonOrThrow(res);
}

export async function previewCodebaseRoot(
  backendUrl: string,
  rootPath: string,
  apiKey?: string,
): Promise<CodebasePreview> {
  const res = await fetch(buildCodebaseApiUrl(backendUrl, '/codebases/preview'), {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({rootPath}),
  });
  const body = await readJsonOrThrow<{preview: CodebasePreview}>(res);
  return body.preview;
}

export async function registerCodebase(
  backendUrl: string,
  input: RegisterCodebaseInput,
  apiKey?: string,
): Promise<{codebase: CodebaseSummary; preview?: CodebasePreview}> {
  const res = await fetch(buildCodebaseApiUrl(backendUrl, '/codebases/register'), {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify(input),
  });
  return readJsonOrThrow<{codebase: CodebaseSummary; preview?: CodebasePreview}>(res);
}

export async function reindexCodebase(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<ReindexCodebaseResult> {
  const res = await fetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/reindex`),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({}),
    },
  );
  const body = await readJsonOrThrow<{result: ReindexCodebaseResult}>(res);
  return body.result;
}

export async function deleteCodebase(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<{codebaseId: string; removedChunkCount: number; alreadyDeleted?: boolean}> {
  const res = await fetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}`),
    {
      method: 'DELETE',
      headers: buildHeaders(apiKey),
    },
  );
  return readJsonOrThrow<{
    codebaseId: string;
    removedChunkCount: number;
    alreadyDeleted?: boolean;
  }>(res);
}

export async function updateCodebaseConsent(
  backendUrl: string,
  codebaseId: string,
  sendToProvider: boolean,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await fetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/consent`),
    {
      method: 'PATCH',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({sendToProvider}),
    },
  );
  const body = await readJsonOrThrow<{codebase: CodebaseSummary}>(res);
  return body.codebase;
}

export async function updateExternalKnowledgeSourceConsent(
  backendUrl: string,
  sourceId: string,
  sendToProvider: boolean,
  apiKey?: string,
): Promise<ExternalKnowledgeSourceSummary> {
  const res = await fetch(
    buildCodebaseApiUrl(
      backendUrl,
      `/android-internals/sources/${encodeURIComponent(sourceId)}/consent`,
    ),
    {
      method: 'PATCH',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({sendToProvider}),
    },
  );
  const body = await readJsonOrThrow<{source: ExternalKnowledgeSourceSummary}>(res);
  return body.source;
}

export async function loadCodebaseAudit(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<CodebaseAudit> {
  const res = await fetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/audit`),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{audit: CodebaseAudit}>(res);
  return body.audit;
}

export async function loadCodeExcerpt(
  backendUrl: string,
  codebaseId: string,
  chunkId: string,
  apiKey?: string,
): Promise<CodeExcerpt> {
  const params = new URLSearchParams({chunkId});
  const res = await fetch(
    buildCodebaseApiUrl(
      backendUrl,
      `/codebases/${encodeURIComponent(codebaseId)}/excerpt?${params.toString()}`,
    ),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{excerpt: CodeExcerpt}>(res);
  return body.excerpt;
}
