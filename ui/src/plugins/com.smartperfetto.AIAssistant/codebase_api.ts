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

import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import {
  buildSmartPerfettoContextHeaders,
  type SmartPerfettoRequestContext,
} from '../../core/smartperfetto_request_context';
import {uiText as text} from './ui_language';

export type CodebaseKind = 'app_source' | 'aosp' | 'kernel_source' | 'oem_sdk';

/** Why a registered root cannot be read (fixed codes; never a path). */
export type CodebaseUnavailableReason =
  | 'deleting'
  | 'root_missing'
  | 'root_identity_changed'
  | 'root_not_directory'
  | 'outside_allowlist'
  | 'unreadable';

export function codebaseUnavailableReasonText(reason: CodebaseUnavailableReason | undefined): string {
  switch (reason) {
    case 'deleting':
      return text('正在删除，已停止检索。', 'Being deleted; retrieval is stopped.');
    case 'root_missing':
      return text('源码文件夹不存在或已被移动。', 'The source folder is missing or was moved.');
    case 'root_identity_changed':
      return text('源码文件夹已被替换，与登记时不是同一个目录。', 'The source folder was replaced; it is not the registered directory.');
    case 'root_not_directory':
      return text('登记的路径已不是文件夹。', 'The registered path is no longer a folder.');
    case 'outside_allowlist':
      return text('源码文件夹不在后端允许访问的范围内。', 'The source folder is outside what the backend may access.');
    case 'unreadable':
      return text('后端没有读取该文件夹的权限。', 'The backend cannot read this folder.');
    default:
      return text('源码当前不可访问。', 'Source is currently unavailable.');
  }
}

/** Whether a codebase can serve a run in this source mode: live root, and text consent for sending text. */
export function codebaseUsableInMode(
  codebase: CodebaseSummary,
  mode: 'off' | 'metadata_only' | 'provider_send',
): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' && codebase.rootAvailable !== false &&
    (mode !== 'provider_send' || codebase.eligibleForSendToProvider === true);
}

/**
 * What granting source text would authorize now, computed by the server with
 * its token: show exactly these lists, then grant with this token.
 */
export interface ContentDisclosure {
  token: string;
  includePrefixes: string[];
  excludeGlobs: string[];
  extensions: string[];
}

export interface CodebaseSummary {
  codebaseId: string;
  lifecycleState?: 'active' | 'deleting';
  kind: CodebaseKind;
  displayName: string;
  rootAvailable?: boolean;
  unavailableReason?: CodebaseUnavailableReason;
  contentDisclosure?: ContentDisclosure;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  indexGeneration: number;
  activeGeneration?: string;
  activeIndexState?: 'active' | 'none';
  selectionPolicyRevision?: number;
  grantRevision?: number;
  providerGrantScopeCurrent?: boolean;
  availableNotConsentedExtensions?: string[];
  maintenanceWarning?: 'inactive_chunk_cleanup_failed' | 'pending_generation_expired';
  reindexRequired?:
    | 'selection_scope_narrowed'
    | 'selection_scope_changed'
    | 'provider_language_scope_expanded';
  activeIndexCoverage?: IndexCoverage;
  pendingGeneration?: PendingGeneration;
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

export interface IndexCoverage {
  selectionPolicyRevision: number;
  enumerationBackend: 'ripgrep' | 'git' | 'node-walk';
  backendFidelity: 'exact' | 'degraded';
  enumerationComplete: boolean;
  deterministic: boolean;
  filesEnumerated: number;
  filesSelected: number;
  bytesSelected: number;
  chunksIndexed: number;
  truncated: boolean;
  complete: boolean;
  truncationReason?: string;
}

export interface PendingGeneration {
  candidateGenerationId: string;
  coverage: IndexCoverage;
  chunkCount: number;
  createdAt: number;
}

export interface CodebasePreview {
  blocked: boolean;
  blockedReason?: string;
  acceptedFileCount: number;
  skippedFileCount: number;
  complete?: boolean;
  enumerationComplete?: boolean;
  filesEnumerated?: number;
  filesSelected?: number;
  bytesSelected?: number;
  truncationReason?: string;
  enumerationBackend?: 'ripgrep' | 'git' | 'node-walk';
  backendFidelity?: 'exact' | 'degraded';
  deterministic?: boolean;
  recommendedAction?: 'narrow_scope';
  scopeSuggestions?: Array<{prefix: string; fileCount: number}>;
  manifestProjects?: Array<{name: string; path: string; groups: string[]}>;
  manifestGroups?: string[];
  manifestUnavailableReason?: string;
  acceptedFiles: Array<string | {relativePath: string; sizeBytes: number}>;
  skippedFiles: Array<string | {relativePath: string; reason: string}>;
}

export interface CodebaseAudit {
  codebaseId: string;
  kind: CodebaseKind;
  indexGeneration: number;
  activeGeneration?: string;
  activeIndexState?: 'active' | 'none';
  selectionPolicyRevision?: number;
  grantRevision?: number;
  activeIndexCoverage?: IndexCoverage;
  pendingGeneration?: PendingGeneration;
  maintenanceWarning?: string;
  reindexRequired?: string;
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

export interface RegisterCodebaseInput {
  kind: CodebaseKind;
  displayName?: string;
  rootPath: string;
  directorySelectionId?: string;
  commitHash?: string;
  vendor?: string;
  buildId?: string;
  pathFilters?: string[];
  excludeGlobs?: string[];
  symbolMapPaths?: string[];
  licenseTag?: string;
  sendToProvider: boolean;
}

/** Complete replacement of the two repeatable source-selection fields. */
export interface UpdateCodebaseSelectionInput {
  pathFilters: string[];
  excludeGlobs: string[];
}

/**
 * A proposed selection enumerated as the save enumerates it. `complete`
 * counts are exact; `partial` is a lower bound; `unavailable` enumerated
 * nothing (not zero files).
 */
export interface CodebaseSelectionPreview {
  status: 'complete' | 'partial' | 'unavailable';
  selectionPolicyRevision: number;
  unavailableReason?: CodebaseUnavailableReason | 'enumeration_failed';
  preview?: {acceptedFileCount: number; truncationReason?: string};
}

export interface CodebaseDirectoryPickerCapability {
  available: boolean;
  platform: string;
  provider?: 'macos' | 'windows' | 'windows_wsl' | 'zenity' | 'kdialog';
  reason?:
    | 'unsupported_distribution'
    | 'enterprise_mode'
    | 'non_loopback_bind'
    | 'no_graphical_session'
    | 'no_supported_dialog'
    | 'remote_request';
}

export type CodebaseDirectoryPickerResult =
  | {
      selected: true;
      rootPath: string;
      directorySelectionId: string;
      displayNameSuggestion: string;
      expiresAt: number;
    }
  | {
      selected: false;
      cancelled: true;
    };

export interface ReindexCodebaseResult {
  codebaseId: string;
  filesProcessed?: number;
  chunksAdded?: number;
  blockedFiles?: number;
  redactionHitCount?: number;
  success?: boolean;
  activationDisposition?: 'active' | 'pending';
  coverage?: IndexCoverage;
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

function buildHeaders(apiKey?: string, context?: SmartPerfettoRequestContext): Record<string, string> {
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  if (context) {
    headers['X-Tenant-Id'] = context.tenantId;
    headers['X-Workspace-Id'] = context.workspaceId;
    headers['X-Window-Id'] = context.windowId;
  }
  return buildSmartPerfettoContextHeaders(headers);
}

export class CodebaseApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly onDemandAvailable?: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'CodebaseApiError';
  }
}

async function readJsonOrThrow<T>(res: Response): Promise<T> {
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok || body?.success === false) {
    const guidance = [body?.message, body?.hint]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join(' ');
    throw new CodebaseApiError(
      guidance || body?.error || `Codebase API failed: ${res.status}`,
      typeof body?.code === 'string' ? body.code : undefined,
      typeof body?.onDemandAvailable === 'boolean' ? body.onDemandAvailable : undefined,
      res.status,
    );
  }
  return body as T;
}

export async function listCodebases(
  backendUrl: string,
  apiKey?: string,
): Promise<{featureEnabled: boolean; codebases: CodebaseSummary[]}> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/codebases'),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{
    featureEnabled?: boolean;
    codebases?: CodebaseSummary[];
  }>(res);
  return {
    featureEnabled: body.featureEnabled !== false,
    codebases: body.codebases || [],
  };
}

export async function previewCodebaseRoot(
  backendUrl: string,
  rootPath: string,
  apiKey?: string,
  directorySelectionId?: string,
  selection?: Pick<RegisterCodebaseInput, 'kind' | 'pathFilters' | 'excludeGlobs'>,
): Promise<CodebasePreview> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/codebases/preview'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        rootPath,
        ...(directorySelectionId ? {directorySelectionId} : {}),
        ...(selection ?? {}),
      }),
    },
  );
  const body = await readJsonOrThrow<{preview: CodebasePreview}>(res);
  return body.preview;
}

export async function acceptPendingCodebaseGeneration(
  backendUrl: string,
  codebase: CodebaseSummary,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const candidateGenerationId = codebase.pendingGeneration?.candidateGenerationId;
  if (!candidateGenerationId) throw new Error('pending_generation_not_found');
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebase.codebaseId)}/pending/accept`),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        selectionPolicyRevision: codebase.selectionPolicyRevision ?? 1,
        grantRevision: codebase.grantRevision ?? 1,
        candidateGenerationId,
      }),
    },
  );
  return (await readJsonOrThrow<{codebase: CodebaseSummary}>(res)).codebase;
}

export async function rejectPendingCodebaseGeneration(
  backendUrl: string,
  codebaseId: string,
  candidateGenerationId: string,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/pending/reject`),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({candidateGenerationId}),
    },
  );
  return (await readJsonOrThrow<{codebase: CodebaseSummary}>(res)).codebase;
}

export async function getCodebaseDirectoryPickerCapability(
  backendUrl: string,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<CodebaseDirectoryPickerCapability> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/codebases/directory-picker'),
    {headers: buildHeaders(apiKey, context)},
  );
  const body = await readJsonOrThrow<{
    capability: CodebaseDirectoryPickerCapability;
  }>(res);
  return body.capability;
}

/** Open the local folder picker (local UI only) for a codebase or a documents folder. */
export async function selectDirectory(
  backendUrl: string,
  purpose: 'codebase' | 'knowledge',
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<CodebaseDirectoryPickerResult> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/codebases/directory-picker'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey, context),
      body: JSON.stringify({purpose}),
    },
  );
  return readJsonOrThrow<CodebaseDirectoryPickerResult>(res);
}

export async function registerCodebase(
  backendUrl: string,
  input: RegisterCodebaseInput,
  apiKey?: string,
): Promise<{codebase: CodebaseSummary; preview?: CodebasePreview}> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/codebases/register'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(input),
    },
  );
  return readJsonOrThrow<{codebase: CodebaseSummary; preview?: CodebasePreview}>(res);
}

export async function reindexCodebase(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<ReindexCodebaseResult> {
  const res = await smartPerfettoFetch(
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
  const res = await smartPerfettoFetch(
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

/** Withdraw provider-send consent. Granting goes through `authorizeCodebaseContent`. */
export async function revokeCodebaseContentConsent(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/consent`),
    {
      method: 'PATCH',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({sendToProvider: false}),
    },
  );
  const body = await readJsonOrThrow<{codebase: CodebaseSummary}>(res);
  return body.codebase;
}

/**
 * Grant source text for the disclosed scope: the current selection and every
 * language, bound to the token of the disclosure the user saw. A stale token
 * is refused (`CODEBASE_CONSENT_DISCLOSURE_STALE`) and changes nothing.
 */
export async function authorizeCodebaseContent(
  backendUrl: string,
  codebaseId: string,
  contentDisclosureToken: string,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/consent`),
    {
      method: 'PATCH',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({authorizeContent: true, contentDisclosureToken}),
    },
  );
  return (await readJsonOrThrow<{codebase: CodebaseSummary}>(res)).codebase;
}

/** Enumerate a proposed selection without saving it (relative counts only). */
export async function previewCodebaseSelection(
  backendUrl: string,
  codebaseId: string,
  input: UpdateCodebaseSelectionInput,
  apiKey?: string,
): Promise<CodebaseSelectionPreview> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(
      backendUrl,
      `/codebases/${encodeURIComponent(codebaseId)}/selection/preview`,
    ),
    {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        pathFilters: [...input.pathFilters],
        excludeGlobs: [...input.excludeGlobs],
      }),
    },
  );
  return (await readJsonOrThrow<{selectionPreview: CodebaseSelectionPreview}>(res)).selectionPreview;
}

export async function updateCodebaseSelection(
  backendUrl: string,
  codebaseId: string,
  input: UpdateCodebaseSelectionInput & {expectedSelectionPolicyRevision?: number},
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(
      backendUrl,
      `/codebases/${encodeURIComponent(codebaseId)}/selection`,
    ),
    {
      method: 'PATCH',
      headers: buildHeaders(apiKey),
      body: JSON.stringify({
        pathFilters: [...input.pathFilters],
        excludeGlobs: [...input.excludeGlobs],
        ...(input.expectedSelectionPolicyRevision !== undefined
          ? {expectedSelectionPolicyRevision: input.expectedSelectionPolicyRevision}
          : {}),
      }),
    },
  );
  return (await readJsonOrThrow<{codebase: CodebaseSummary}>(res)).codebase;
}

export async function loadCodebaseAudit(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<CodebaseAudit> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}/audit`),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{audit: CodebaseAudit}>(res);
  return body.audit;
}


// ---------------------------------------------------------------------------
// Knowledge bases (`/api/rag/knowledge`): document collections, plus records
// of the retired legacy Wiki connector that stay listed until deleted.
// Responses never carry a registered root.
// ---------------------------------------------------------------------------

export type KnowledgeBaseKind = 'document_collection' | 'android_internals_wiki';

export interface KnowledgeBaseSummary {
  sourceId: string;
  kind: KnowledgeBaseKind;
  displayName: string;
  description?: string;
  attribution?: string;
  license?: string;
  rightsAcknowledged: boolean;
  sendToProvider: boolean;
  activeGeneration?: string;
  indexGeneration: number;
  indexedChunkCount?: number;
  documentCount: number;
  hasActiveIndex: boolean;
  /** The backend no longer serves this kind (the legacy Wiki connector); listed only so it can be deleted. */
  retired?: boolean;
  lifecycleState?: 'active' | 'deleting';
}

export interface KnowledgeCollectionPreview {
  documentCount: number;
  sectionCount: number;
  chunkCount: number;
  skipped: Record<string, number>;
}

export interface KnowledgeSearchHit {
  chunkId: string;
  relativePath: string;
  title: string;
  heading: string;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface KnowledgeCollectionSelection {
  rootPath: string;
  directorySelectionId?: string;
}

export interface RegisterKnowledgeCollectionInput extends KnowledgeCollectionSelection {
  displayName?: string;
  description?: string;
  rightsAcknowledged: true;
  sendToProvider: boolean;
}

/**
 * A record the backend reports as retired (the legacy Wiki connector's kind).
 * It is never served to a run (the run start answers
 * `ANALYSIS_CONTEXT_SOURCE_RETIRED`) and stays listed only so it can be deleted.
 */
export function knowledgeBaseRetired(source: KnowledgeBaseSummary): boolean {
  return source.retired === true;
}

/** Why a retired knowledge base cannot be chosen, and what replaces it. */
export function knowledgeBaseRetiredText(): string {
  return text(
    '已停用：旧版 Wiki 连接器。请将 Wiki 的 src/ 目录重新注册为文档知识库。',
    "Retired: legacy Wiki connector. Re-register the Wiki's src/ folder as a document knowledge base.",
  );
}

/** A document collection the model may search this run: not retired, indexed, rights acknowledged, text consented. */
export function knowledgeBaseSelectable(source: KnowledgeBaseSummary): boolean {
  return !knowledgeBaseRetired(source) &&
    (source.lifecycleState ?? 'active') === 'active' &&
    source.rightsAcknowledged === true &&
    source.sendToProvider === true &&
    source.hasActiveIndex === true;
}

export async function listKnowledgeBases(
  backendUrl: string,
  apiKey?: string,
): Promise<KnowledgeBaseSummary[]> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/knowledge'),
    {headers: buildHeaders(apiKey)},
  );
  const body = await readJsonOrThrow<{sources?: KnowledgeBaseSummary[]}>(res);
  return body.sources || [];
}

function knowledgeSelectionBody(input: KnowledgeCollectionSelection): Record<string, string> {
  return {
    rootPath: input.rootPath,
    ...(input.directorySelectionId ? {directorySelectionId: input.directorySelectionId} : {}),
  };
}

export async function previewKnowledgeCollection(
  backendUrl: string,
  input: KnowledgeCollectionSelection,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<KnowledgeCollectionPreview> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/knowledge/preview'),
    {method: 'POST', headers: buildHeaders(apiKey, context), body: JSON.stringify(knowledgeSelectionBody(input))},
  );
  return (await readJsonOrThrow<{preview: KnowledgeCollectionPreview}>(res)).preview;
}

export async function registerKnowledgeCollection(
  backendUrl: string,
  input: RegisterKnowledgeCollectionInput,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<KnowledgeBaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, '/knowledge/register'),
    {
      method: 'POST',
      headers: buildHeaders(apiKey, context),
      body: JSON.stringify({
        ...knowledgeSelectionBody(input),
        ...(input.displayName ? {displayName: input.displayName} : {}),
        ...(input.description ? {description: input.description} : {}),
        rightsAcknowledged: true,
        sendToProvider: input.sendToProvider,
      }),
    },
  );
  return (await readJsonOrThrow<{source: KnowledgeBaseSummary}>(res)).source;
}

export async function reindexKnowledgeCollection(
  backendUrl: string,
  sourceId: string,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<{documentCount: number; chunkCount: number}> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/knowledge/${encodeURIComponent(sourceId)}/reindex`),
    {method: 'POST', headers: buildHeaders(apiKey, context), body: JSON.stringify({})},
  );
  return (await readJsonOrThrow<{result: {documentCount: number; chunkCount: number}}>(res)).result;
}

export async function setKnowledgeBaseConsent(
  backendUrl: string,
  sourceId: string,
  sendToProvider: boolean,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<KnowledgeBaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/knowledge/${encodeURIComponent(sourceId)}/consent`),
    {method: 'PATCH', headers: buildHeaders(apiKey, context), body: JSON.stringify({sendToProvider})},
  );
  return (await readJsonOrThrow<{source: KnowledgeBaseSummary}>(res)).source;
}

export async function searchKnowledgeCollection(
  backendUrl: string,
  sourceId: string,
  query: string,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<KnowledgeSearchHit[]> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/knowledge/${encodeURIComponent(sourceId)}/search`),
    {method: 'POST', headers: buildHeaders(apiKey, context), body: JSON.stringify({query, topK: 5})},
  );
  return (await readJsonOrThrow<{hits?: KnowledgeSearchHit[]}>(res)).hits || [];
}

export async function deleteKnowledgeBase(
  backendUrl: string,
  sourceId: string,
  apiKey?: string,
  /** The scope an operation pinned when it started; headers name it, not a later global scope. */
  context?: SmartPerfettoRequestContext,
): Promise<void> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/knowledge/${encodeURIComponent(sourceId)}`),
    {method: 'DELETE', headers: buildHeaders(apiKey, context)},
  );
  await readJsonOrThrow(res);
}

export async function getCodebase(
  backendUrl: string,
  codebaseId: string,
  apiKey?: string,
): Promise<CodebaseSummary> {
  const res = await smartPerfettoFetch(
    buildCodebaseApiUrl(backendUrl, `/codebases/${encodeURIComponent(codebaseId)}`),
    {headers: buildHeaders(apiKey)},
  );
  return (await readJsonOrThrow<{codebase: CodebaseSummary}>(res)).codebase;
}
