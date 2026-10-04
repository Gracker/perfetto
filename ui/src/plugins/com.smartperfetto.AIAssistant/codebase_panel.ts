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

import m from 'mithril';

import type {AnalysisContextSelection} from './types';
import type {
  CodebaseSummary,
  ExternalKnowledgeSourceSummary,
  KnowledgeBaseSummary,
} from './codebase_api';
import {
  CodebaseApiError,
  acceptPendingCodebaseGeneration,
  codebaseUnavailableReasonText,
  codebaseUsableInMode,
  deleteCodebase,
  knowledgeBaseSelectable,
  registerExternalKnowledgeSource,
  rejectPendingCodebaseGeneration,
  reindexCodebase,
  reindexExternalKnowledgeSource,
  revokeCodebaseContentConsent,
  updateExternalKnowledgeSourceConsent,
} from './codebase_api';
import {
  bumpAnalysisContextAuthorizationEpoch,
  normalizeAnalysisContext,
  sameAnalysisContext,
} from './analysis_context';
import {CodebaseAuditView} from './codebase_audit_view';
import {KnowledgeBaseSection} from './knowledge_base_section';
import {CodebaseForm} from './codebase_form';
import {ContentDisclosureReview} from './content_disclosure_review';
import {analysisCatalog} from './analysis_catalog';
import {uiText as text} from './ui_language';
import {MANAGEMENT_STYLES} from './management_ui';
import {knowledgeConsentQuestion} from './source_analysis_disclosure';

export interface CodebasePanelAttrs {
  backendUrl: string;
  apiKey?: string;
  /** Stable backend + tenant + workspace + user partition identity. */
  scopeKey: string;
  selection: AnalysisContextSelection;
  readOnly?: boolean;
  onSelectionChange: (selection: AnalysisContextSelection) => void;
  /** Invalidate the parent agent session after a successful policy mutation. */
  onAuthorizationChange?: () => void;
}

type ViewMode = 'list' | 'add-codebase' | 'edit-codebase' | 'add-knowledge';

const STYLES = MANAGEMENT_STYLES;

export function codebaseHasActiveIndex(codebase: CodebaseSummary): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' &&
    Boolean(codebase.activeGeneration) &&
    Boolean(codebase.contentFingerprint) &&
    (codebase.chunkCount ?? 0) > 0;
}

export function optionalIndexCopyForActiveRoot(): string {
  return text(
    '无需索引即可按当前授权范围搜索和读取。索引是可选的检索加速项。',
    'Search and read within the current authorization scope without an index. Indexing is optional retrieval acceleration.',
  );
}

/** This action authorizes only the newly added folder; latent selections stay off. */
export function analysisContextAfterCodebaseRegistration(
  selection: AnalysisContextSelection,
  codebase: CodebaseSummary,
  codebases: readonly CodebaseSummary[],
): AnalysisContextSelection {
  const mode = selection.codeAwareMode === 'off' ? 'provider_send' : selection.codeAwareMode;
  if (!codebaseUsableInMode(codebase, mode)) return selection;
  const retained = selection.codeAwareMode === 'off' ? [] : selection.codebaseIds.filter(id => {
    const source = codebases.find(candidate => candidate.codebaseId === id);
    return source !== undefined && codebaseUsableInMode(source, mode);
  });
  return normalizeAnalysisContext({
    ...selection,
    codeAwareMode: mode,
    codebaseIds: [...retained, codebase.codebaseId],
  });
}

export function codebaseIndexFailureMessage(
  error: unknown,
  refreshed?: CodebaseSummary,
): string {
  const capacity = error instanceof CodebaseApiError &&
    error.code === 'CODEBASE_INDEX_CAPACITY_EXCEEDED';
  const reason = capacity
    ? text('源码较大，未能构建可选索引。', 'This source tree exceeds the optional index capacity.')
    : text('可选索引构建失败。', 'The optional index could not be built.');
  const available = error instanceof CodebaseApiError
    ? error.status === 401 || error.status === 403 ? false : error.onDemandAvailable
    : undefined;
  const access = available === false || refreshed?.rootAvailable === false
    ? text('当前无法按需访问，请检查源码文件夹与访问权限。', 'On-demand access is unavailable. Check the source folder and permissions.')
    : available === true
      ? text('已确认仍可按当前授权范围按需访问，无需先完成索引。', 'On-demand access within the current authorization scope is still available; indexing is not required.')
      : refreshed?.rootAvailable === true
        ? text('源码文件夹仍可访问；实际搜索和读取取决于当前授权。', 'The source folder remains accessible; search and reads depend on current authorization.')
        : text('尚未确认按需访问是否可用，请刷新列表后检查。', 'On-demand availability could not be confirmed. Refresh the list to check.');
  return `${reason} ${access}`;
}

export function codebaseDeletionPending(codebase: CodebaseSummary): boolean {
  return codebase.lifecycleState === 'deleting';
}

/**
 * Whether granting source text would change anything: no consent yet, a grant
 * that no longer equals the current selection, or languages it lacks.
 */
export function codebaseNeedsContentAuthorization(codebase: CodebaseSummary): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' &&
    Boolean(codebase.contentDisclosure?.token) &&
    (codebase.eligibleForSendToProvider !== true ||
      codebase.providerGrantScopeCurrent === false ||
      (codebase.availableNotConsentedExtensions?.length ?? 0) > 0);
}

export function analysisContextForFeatureAvailability(
  selection: AnalysisContextSelection,
  featureEnabled: boolean,
): AnalysisContextSelection {
  return featureEnabled ? selection : {
    ...selection,
    codeAwareMode: 'off',
    codebaseIds: [],
  };
}

export function analysisContextAfterCodebaseDelete(
  selection: AnalysisContextSelection,
  codebaseId: string,
): AnalysisContextSelection {
  return bumpAnalysisContextAuthorizationEpoch({
    ...selection,
    codebaseIds: selection.codebaseIds.filter((id) => id !== codebaseId),
  });
}

function formatDate(value: number | string | undefined): string {
  if (!value) return text('从未', 'never');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function compactIdentity(value: string | undefined, maxLength = 18): string {
  if (!value) return text('未知', 'unknown');
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export class CodebasePanel implements m.ClassComponent<CodebasePanelAttrs> {
  private codebases: CodebaseSummary[] = [];
  private knowledgeSources: ExternalKnowledgeSourceSummary[] = [];
  /** Document collections from `/knowledge`; the Wiki keeps its legacy list. */
  private knowledgeBases: KnowledgeBaseSummary[] = [];
  private loading = true;
  /** A first load finished: later refreshes keep the lists (and their children) mounted. */
  private loaded = false;
  private error: string | null = null;
  private success: string | null = null;
  private featureEnabled = true;
  private viewMode: ViewMode = 'list';
  private editingCodebaseId: string | null = null;
  private expandedAuditId: string | null = null;
  private reindexingId: string | null = null;
  private pendingAction: {codebaseId: string; action: 'accept' | 'reject'} | null = null;
  private deletingId: string | null = null;
  private updatingConsentId: string | null = null;
  /** The codebase whose source-text disclosure is under review. */
  private reviewingCodebaseId: string | null = null;
  private reindexingKnowledgeId: string | null = null;
  private registeringKnowledge = false;
  private knowledgeRootPath = '';
  private knowledgeDisplayName = 'Android Internals Wiki';
  private knowledgeRightsAcknowledged = false;
  private knowledgeSendToProvider = false;
  private loadEpoch = 0;
  private identityEpoch = 0;
  private registrationBoundaryRevision = 0;
  private unavailableCodebaseIds = new Set<string>();
  private backendUrl = '';
  private apiKey?: string;
  private scopeKey = '';
  private selection = normalizeAnalysisContext(null);
  private readOnly = false;
  private onSelectionChange: (selection: AnalysisContextSelection) => void = () => {};
  private onAuthorizationChange: (() => void) | undefined;

  oninit(vnode: m.Vnode<CodebasePanelAttrs>) {
    this.backendUrl = vnode.attrs.backendUrl;
    this.apiKey = vnode.attrs.apiKey;
    this.scopeKey = vnode.attrs.scopeKey;
    this.syncAttrs(vnode.attrs);
    this.load();
  }

  onupdate(vnode: m.Vnode<CodebasePanelAttrs>) {
    const identityChanged = vnode.attrs.backendUrl !== this.backendUrl ||
      vnode.attrs.apiKey !== this.apiKey ||
      vnode.attrs.scopeKey !== this.scopeKey;
    this.syncAttrs(vnode.attrs);
    if (identityChanged) {
      this.backendUrl = vnode.attrs.backendUrl;
      this.apiKey = vnode.attrs.apiKey;
      this.scopeKey = vnode.attrs.scopeKey;
      this.loadEpoch++;
      this.identityEpoch++;
      this.codebases = [];
      this.loaded = false;
      this.unavailableCodebaseIds.clear();
      this.knowledgeSources = [];
      this.knowledgeBases = [];
      this.error = null;
      this.reindexingId = null;
      this.pendingAction = null;
      this.deletingId = null;
      this.updatingConsentId = null;
      this.reviewingCodebaseId = null;
      this.reindexingKnowledgeId = null;
      this.registeringKnowledge = false;
      this.success = null;
      this.expandedAuditId = null;
      this.editingCodebaseId = null;
      this.viewMode = 'list';
      this.load();
    }
  }

  onbeforeupdate(vnode: m.Vnode<CodebasePanelAttrs>) {
    // Rebind before rendering children so a stale form never sees a new callback.
    this.onupdate(vnode);
    return true;
  }

  private syncAttrs(attrs: CodebasePanelAttrs): void {
    if (!sameAnalysisContext(this.selection, attrs.selection) ||
        this.readOnly !== (attrs.readOnly === true)) {
      this.registrationBoundaryRevision++;
    }
    this.selection = normalizeAnalysisContext(attrs.selection);
    this.readOnly = attrs.readOnly === true;
    this.onSelectionChange = attrs.onSelectionChange;
    this.onAuthorizationChange = attrs.onAuthorizationChange;
  }

  onremove() {
    this.loadEpoch++;
    this.identityEpoch++;
  }

  private catalogIdentity() {
    return {backendUrl: this.backendUrl, apiKey: this.apiKey, scopeKey: this.scopeKey};
  }

  /**
   * Copy the lists the shared catalog's latest refresh actually read (a
   * refresh by any view lands here); a list it failed to read keeps what this
   * view holds, such as a codebase it just registered.
   */
  private syncFromCatalog(): void {
    const state = analysisCatalog.read(this.catalogIdentity());
    if (state.loaded.codebases) {
      this.featureEnabled = state.featureEnabled;
      this.codebases = state.codebases;
    }
    if (state.loaded.wikiSources) this.knowledgeSources = state.wikiSources;
    if (state.loaded.knowledgeBases) this.knowledgeBases = state.knowledgeBases;
  }

  private async load(): Promise<boolean> {
    const epoch = ++this.loadEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    const scopeKey = this.scopeKey;
    this.loading = true;
    this.error = null;
    m.redraw();
    const state = await analysisCatalog.refresh(this.catalogIdentity());
    if (!state || !this.requestIdentityIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return false;
    if (state.loaded.codebases) this.unavailableCodebaseIds.clear();
    this.syncFromCatalog();
    this.loaded = true;
    this.loading = false;
    this.error = state.errors.length > 0 ? state.errors.join(' · ') : null;
    this.reconcileSelection({
      codebasesLoaded: state.loaded.codebases,
      knowledgeLoaded: state.loaded.knowledgeBases,
    });
    m.redraw();
    return state.loaded.codebases;
  }

  private confirmProviderConsent(displayName: string): boolean {
    return typeof window === 'undefined' || window.confirm(knowledgeConsentQuestion(displayName));
  }

  private codebaseMutationInProgress(): boolean {
    return this.reindexingId !== null ||
      this.deletingId !== null ||
      this.pendingAction !== null ||
      this.updatingConsentId?.startsWith('codebase:') === true;
  }

  private requestIdentityIsCurrent(
    epoch: number,
    backendUrl: string,
    apiKey: string | undefined,
    scopeKey = this.scopeKey,
  ): boolean {
    return epoch === this.loadEpoch &&
      backendUrl === this.backendUrl &&
      apiKey === this.apiKey &&
      scopeKey === this.scopeKey;
  }

  private operationIdentityIsCurrent(
    identityEpoch: number,
    backendUrl: string,
    apiKey: string | undefined,
    scopeKey = this.scopeKey,
  ): boolean {
    return identityEpoch === this.identityEpoch &&
      backendUrl === this.backendUrl &&
      apiKey === this.apiKey &&
      scopeKey === this.scopeKey;
  }

  private async revokeCodebaseContent(codebase: CodebaseSummary) {
    if (this.readOnly || this.codebaseMutationInProgress()) return;
    const operationId = `codebase:${codebase.codebaseId}`;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.updatingConsentId = operationId;
    this.error = null;
    this.success = null;
    try {
      await revokeCodebaseContentConsent(backendUrl, codebase.codebaseId, apiKey);
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = text(`已撤销 ${codebase.displayName} 的正文发送授权`, `Revoked source-text consent for ${codebase.displayName}`);
      this.emitAuthorizationChange();
      if (this.updatingConsentId === operationId) this.updatingConsentId = null;
      await this.load();
    } catch (e: unknown) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = e instanceof Error ? e.message : text('更新授权失败', 'Failed to update consent');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        if (this.updatingConsentId === operationId) this.updatingConsentId = null;
        m.redraw();
      }
    }
  }

  private async setKnowledgeSourceConsent(
    source: ExternalKnowledgeSourceSummary,
    sendToProvider: boolean,
  ) {
    if (this.readOnly || (sendToProvider && !this.confirmProviderConsent(source.displayName))) return;
    const operationId = `knowledge:${source.sourceId}`;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.updatingConsentId = operationId;
    this.error = null;
    this.success = null;
    try {
      await updateExternalKnowledgeSourceConsent(
        backendUrl,
        source.sourceId,
        sendToProvider,
        apiKey,
      );
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = sendToProvider
        ? text(`已允许发送 ${source.displayName} 的正文`, `Allowed text from ${source.displayName}`)
        : text(`已撤销 ${source.displayName} 的正文发送授权`, `Revoked text for ${source.displayName}`);
      this.emitAuthorizationChange();
      if (this.updatingConsentId === operationId) this.updatingConsentId = null;
      await this.load();
    } catch (e: unknown) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = e instanceof Error ? e.message : text('更新授权失败', 'Failed to update consent');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        if (this.updatingConsentId === operationId) this.updatingConsentId = null;
        m.redraw();
      }
    }
  }

  private emitSelection(selection: AnalysisContextSelection): void {
    const normalized = normalizeAnalysisContext(selection);
    if (sameAnalysisContext(normalized, this.selection)) return;
    this.selection = normalized;
    this.onSelectionChange(normalized);
  }

  /** Force a new agent session after a source/RAG authorization boundary changes. */
  private emitAuthorizationChange(): void {
    if (this.onAuthorizationChange) {
      this.onAuthorizationChange();
      return;
    }
    this.emitSelection(bumpAnalysisContextAuthorizationEpoch(this.selection));
  }

  private reconcileSelection(input: {
    codebasesLoaded: boolean;
    knowledgeLoaded: boolean;
  }): void {
    const codebases = new Map(this.codebases.map((codebase) => [codebase.codebaseId, codebase]));
    // `/knowledge` lists every kind, the Wiki included: one predicate decides.
    const usableSources = new Set(this.knowledgeBases.filter(knowledgeBaseSelectable).map((source) => source.sourceId));
    let next = normalizeAnalysisContext(this.selection);
    if (input.codebasesLoaded) {
      const availableSelection = analysisContextForFeatureAvailability(
        next,
        this.featureEnabled,
      );
      next = {
        ...availableSelection,
        codebaseIds: availableSelection.codebaseIds.filter((id) => {
          const codebase = codebases.get(id);
          return !!codebase && !this.unavailableCodebaseIds.has(id) &&
            codebaseUsableInMode(codebase, availableSelection.codeAwareMode);
        }),
      };
    }
    if (input.knowledgeLoaded) {
      next = {
        ...next,
        knowledgeSourceIds: next.knowledgeSourceIds.filter((id) => usableSources.has(id)),
      };
    }
    this.emitSelection(next);
  }

  private async registerKnowledgeSource(): Promise<void> {
    if (
      this.readOnly ||
      this.registeringKnowledge ||
      !this.knowledgeRootPath.trim() ||
      !this.knowledgeRightsAcknowledged
    ) return;
    if (this.knowledgeSendToProvider && !this.confirmProviderConsent(this.knowledgeDisplayName)) return;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.registeringKnowledge = true;
    this.error = null;
    try {
      const source = await registerExternalKnowledgeSource(backendUrl, {
        rootPath: this.knowledgeRootPath.trim(),
        displayName: this.knowledgeDisplayName.trim() || 'Android Internals Wiki',
        rightsAcknowledged: true,
        sendToProvider: this.knowledgeSendToProvider,
      }, apiKey);
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = text(`已注册 ${source.displayName}`, `Registered ${source.displayName}`);
      this.viewMode = 'list';
      this.knowledgeRootPath = '';
      this.knowledgeRightsAcknowledged = false;
      this.knowledgeSendToProvider = false;
      this.registeringKnowledge = false;
      await this.load();
    } catch (error) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = error instanceof Error ? error.message : text('注册知识源失败', 'Failed to register knowledge source');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        this.registeringKnowledge = false;
        m.redraw();
      }
    }
  }

  private async reindexKnowledgeSource(source: ExternalKnowledgeSourceSummary): Promise<void> {
    if (this.readOnly || this.reindexingKnowledgeId) return;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.reindexingKnowledgeId = source.sourceId;
    this.error = null;
    try {
      await reindexExternalKnowledgeSource(backendUrl, source.sourceId, apiKey);
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      // An index rebuild changes no authorization: sessions continue (runs pin their generation).
      this.success = text(`已重新索引 ${source.displayName}`, `Reindexed ${source.displayName}`);
      this.reindexingKnowledgeId = null;
      await this.load();
    } catch (error) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = error instanceof Error ? error.message : text('知识源索引失败', 'Failed to reindex knowledge source');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        this.reindexingKnowledgeId = null;
        m.redraw();
      }
    }
  }

  private async reindex(codebase: CodebaseSummary) {
    if (this.readOnly || this.codebaseMutationInProgress()) return;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.reindexingId = codebase.codebaseId;
    this.error = null;
    this.success = null;
    m.redraw();
    try {
      const result = await reindexCodebase(
        backendUrl,
        codebase.codebaseId,
        apiKey,
      );
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      if (result.activationDisposition === 'active') {
        this.success = text(
          `已更新 ${codebase.displayName} 的可选索引：${result.chunksAdded ?? 0} 个分片`,
          `Updated the optional index for ${codebase.displayName}: ${result.chunksAdded ?? 0} chunks`,
        );
      } else if (result.activationDisposition === 'pending') {
        this.success = text(
          `已生成受限索引候选（${result.coverage?.filesSelected ?? 0}/${result.coverage?.filesEnumerated ?? 0} 个文件），等待确认；当前完整索引仍保持启用。`,
          `Created a limited index candidate (${result.coverage?.filesSelected ?? 0}/${result.coverage?.filesEnumerated ?? 0} files) awaiting acceptance; the complete index remains active.`,
        );
      } else {
        throw new Error('codebase_reindex_incomplete');
      }
      this.reindexingId = null;
      await this.load();
    } catch (e: unknown) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      const refreshed = await this.load();
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      if (e instanceof CodebaseApiError && (e.onDemandAvailable === false ||
          e.status === 401 || e.status === 403)) {
        this.unavailableCodebaseIds.add(codebase.codebaseId);
        this.emitSelection({
          ...this.selection,
          codebaseIds: this.selection.codebaseIds.filter(id => id !== codebase.codebaseId),
        });
      }
      const refreshError = this.error;
      this.error = codebaseIndexFailureMessage(e, refreshed
        ? this.codebases.find(candidate => candidate.codebaseId === codebase.codebaseId)
        : undefined);
      if (refreshError) this.error += ` ${refreshError}`;
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        this.reindexingId = null;
        m.redraw();
      }
    }
  }

  private async resolvePendingGeneration(codebase: CodebaseSummary, accept: boolean) {
    if (this.readOnly || this.codebaseMutationInProgress()) return;
    const pending = codebase.pendingGeneration;
    if (!pending) return;
    if (accept) {
      const confirmed = typeof window === 'undefined' || window.confirm(text(
        `确认启用受限索引候选（${pending.coverage.filesSelected}/${pending.coverage.filesEnumerated} 个文件，截断原因：${pending.coverage.truncationReason ?? 'unknown'}）？这会替换当前完整活动索引。`,
        `Accept the limited index candidate (${pending.coverage.filesSelected}/${pending.coverage.filesEnumerated} files; truncation reason: ${pending.coverage.truncationReason ?? 'unknown'})? This will replace the current complete active index.`,
      ));
      if (!confirmed) return;
    }
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    const action = accept ? 'accept' : 'reject';
    this.pendingAction = {codebaseId: codebase.codebaseId, action};
    this.error = null;
    this.success = null;
    try {
      if (accept) await acceptPendingCodebaseGeneration(backendUrl, codebase, apiKey);
      else await rejectPendingCodebaseGeneration(
        backendUrl,
        codebase.codebaseId,
        codebase.pendingGeneration!.candidateGenerationId,
        apiKey,
      );
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = accept
        ? text('已启用受限索引候选。', 'Accepted the limited index candidate.')
        : text('已丢弃受限索引候选。', 'Rejected the limited index candidate.');
      if (
        this.pendingAction?.codebaseId === codebase.codebaseId &&
        this.pendingAction.action === action
      ) this.pendingAction = null;
      await this.load();
    } catch (error) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = error instanceof Error ? error.message : text('候选索引操作失败', 'Pending index action failed');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        if (
          this.pendingAction?.codebaseId === codebase.codebaseId &&
          this.pendingAction.action === action
        ) this.pendingAction = null;
        m.redraw();
      }
    }
  }

  private async deleteRegisteredCodebase(codebase: CodebaseSummary) {
    if (this.readOnly || this.codebaseMutationInProgress()) return;
    const confirmed = typeof window === 'undefined' || window.confirm(text(
      `确认永久删除源码库“${codebase.displayName}”及其全部索引代际？已发送给模型的历史内容无法撤回。`,
      `Permanently delete “${codebase.displayName}” and every indexed generation? Content already sent to a model cannot be recalled.`,
    ));
    if (!confirmed) return;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.deletingId = codebase.codebaseId;
    this.error = null;
    this.success = null;
    m.redraw();
    try {
      const result = await deleteCodebase(
        backendUrl,
        codebase.codebaseId,
        apiKey,
      );
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.emitSelection(analysisContextAfterCodebaseDelete(
        this.selection,
        codebase.codebaseId,
      ));
      if (this.expandedAuditId === codebase.codebaseId) this.expandedAuditId = null;
      this.success = text(
        `已删除 ${codebase.displayName} 及 ${result.removedChunkCount} 个索引分片`,
        `Deleted ${codebase.displayName} and ${result.removedChunkCount} indexed chunks`,
      );
      this.deletingId = null;
      await this.load();
    } catch (e: unknown) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = e instanceof Error ? e.message : text('删除源码库失败', 'Failed to delete codebase');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        this.deletingId = null;
        m.redraw();
      }
    }
  }

  private renderCodebase(codebase: CodebaseSummary): m.Children {
    const isExpanded = this.expandedAuditId === codebase.codebaseId;
    const isReindexing = this.reindexingId === codebase.codebaseId;
    const pendingAction = this.pendingAction?.codebaseId === codebase.codebaseId
      ? this.pendingAction.action
      : undefined;
    const reviewing = this.reviewingCodebaseId === codebase.codebaseId;
    const mutationBusy = this.codebaseMutationInProgress();
    const isDeleting = this.deletingId === codebase.codebaseId;
    const deletionPending = codebaseDeletionPending(codebase);
    const selected = this.selection.codebaseIds.includes(codebase.codebaseId);
    const hasActiveIndex = codebaseHasActiveIndex(codebase);
    const availableForOnDemandAccess = codebaseUsableInMode(codebase, 'metadata_only') &&
      !this.unavailableCodebaseIds.has(codebase.codebaseId);
    // Which codebases a turn uses is chosen beside the input box; this view manages them.
    return m('div', {style: STYLES.card}, [
      m('div', {style: STYLES.name}, codebase.displayName),
      m('div', {style: STYLES.subtitle}, !availableForOnDemandAccess
        ? codebaseUnavailableReasonText(codebase.unavailableReason)
        : selected && this.selection.codeAwareMode !== 'off'
          ? this.selection.codeAwareMode === 'metadata_only'
            ? text('已选中 · 仅定位文件和符号', 'Selected · file and symbol locations only')
            : text('已选中 · 模型可按需读取源码片段', 'Selected · model may read snippets on demand')
          : text('已添加 · 尚未用于分析', 'Added · not selected for analysis')),
      m('details', [
        m('summary', {style: {...STYLES.subtitle, minHeight: '40px', cursor: 'pointer', display: 'flex', alignItems: 'center'}},
          text('访问范围、索引与管理', 'Access scope, indexing, and management')),
      m('div', {style: STYLES.chips}, [
        m('span', {style: STYLES.chip}, `${text('分片', 'chunks')} ${codebase.chunkCount ?? 0}`),
        m('span', {style: STYLES.chip}, `${text('代际', 'gen')} ${codebase.indexGeneration}`),
        m('span', {style: STYLES.chip}, text(
          `选择 ${codebase.selectionPolicyRevision ?? 1}`,
          `selection ${codebase.selectionPolicyRevision ?? 1}`,
        )),
        m('span', {style: STYLES.chip}, text(
          `授权 ${codebase.grantRevision ?? 1}`,
          `grant ${codebase.grantRevision ?? 1}`,
        )),
        m('span', {style: STYLES.chip}, text(
          `活动索引 ${codebase.activeIndexState ?? (codebase.activeGeneration ? 'active' : 'none')}`,
          `active index ${codebase.activeIndexState ?? (codebase.activeGeneration ? 'active' : 'none')}`,
        )),
        m('span', {style: STYLES.chip}, `${text('索引', 'ingest')} ${formatDate(codebase.lastIngestAt)}`),
        codebase.vendor ? m('span', {style: STYLES.chip}, codebase.vendor) : null,
        codebase.buildId ? m('span', {style: STYLES.chip}, codebase.buildId) : null,
        codebase.eligibleForSendToProvider
          ? m('span', {style: STYLES.chip}, text('已授权发送内容', 'provider content consent'))
          : m('span', {style: STYLES.chip}, text('仅元数据', 'metadata only')),
        codebase.lifecycleState === 'deleting'
          ? m('span', {style: STYLES.chip}, text('等待删除重试', 'deletion pending'))
          : null,
      ]),
      m('div', {style: {...STYLES.meta, marginTop: '8px'}}, text(
        `包含范围：${codebase.pathFilters?.length ? codebase.pathFilters.join(', ') : '全部'}；排除规则：${codebase.excludeGlobs?.length ? codebase.excludeGlobs.join(', ') : '无'}`,
        `Included scope: ${codebase.pathFilters?.length ? codebase.pathFilters.join(', ') : 'all'}; exclude globs: ${codebase.excludeGlobs?.length ? codebase.excludeGlobs.join(', ') : 'none'}`,
      )),
      codebase.lastIngestError
        ? m('div', {style: STYLES.error}, codebaseIndexFailureMessage(
            new CodebaseApiError('', codebase.lastIngestError.startsWith('source_chunk_limit_exceeded:')
              ? 'CODEBASE_INDEX_CAPACITY_EXCEEDED' : 'CODEBASE_INDEX_FAILED'),
            codebase,
          ))
        : null,
      codebase.activeIndexCoverage
        ? m('div', {
            style: codebase.activeIndexCoverage.complete ? STYLES.meta : STYLES.error,
          }, text(
            `索引覆盖：${codebase.activeIndexCoverage.filesSelected}/${codebase.activeIndexCoverage.filesEnumerated} 个文件，${codebase.activeIndexCoverage.chunksIndexed} 个分片；${codebase.activeIndexCoverage.enumerationBackend}/${codebase.activeIndexCoverage.backendFidelity}${codebase.activeIndexCoverage.truncationReason ? `；${codebase.activeIndexCoverage.truncationReason}` : ''}`,
            `Index coverage: ${codebase.activeIndexCoverage.filesSelected}/${codebase.activeIndexCoverage.filesEnumerated} files, ${codebase.activeIndexCoverage.chunksIndexed} chunks; ${codebase.activeIndexCoverage.enumerationBackend}/${codebase.activeIndexCoverage.backendFidelity}${codebase.activeIndexCoverage.truncationReason ? `; ${codebase.activeIndexCoverage.truncationReason}` : ''}`,
          ))
        : null,
      codebase.maintenanceWarning
        ? m('div', {style: STYLES.error}, text(
            `索引维护提示：${codebase.maintenanceWarning}`,
            `Index maintenance warning: ${codebase.maintenanceWarning}`,
          ))
        : null,
      codebase.reindexRequired
        ? m('div', {style: STYLES.error}, text(
            `需要重建可选索引：${codebase.reindexRequired}`,
            `Optional index rebuild required: ${codebase.reindexRequired}`,
          ))
        : null,
      (codebase.availableNotConsentedExtensions?.length ?? 0) > 0 && codebase.eligibleForSendToProvider
        ? m('div', {style: {...STYLES.meta, marginTop: '8px'}}, text(
            `这些语言尚未允许发送正文，只用于定位：${codebase.availableNotConsentedExtensions!.join(', ')}。`,
            `These languages are not allowed to send source text and are used for locating only: ${codebase.availableNotConsentedExtensions!.join(', ')}.`,
          ))
        : null,
      codebase.providerGrantScopeCurrent === false && codebase.eligibleForSendToProvider
        ? m('div', {style: {...STYLES.meta, marginTop: '8px'}}, text(
            '正文发送授权与当前源码范围不一致：授权外的文件只用于定位，不发送正文。重新“允许发送正文”即按当前范围授权；超出原授权的范围编辑会撤销授权。',
            'Source-text consent does not match the current scope: files outside it are used for locating only. Allow source text again to grant the current scope; a scope edit beyond the original grant revokes it.',
          ))
        : null,
      codebase.pendingGeneration && !deletionPending
        ? m('div', {style: STYLES.error}, text(
            `受限索引候选：${codebase.pendingGeneration.coverage.filesSelected}/${codebase.pendingGeneration.coverage.filesEnumerated} 个文件。完整索引仍保持启用。`,
            `Limited index candidate: ${codebase.pendingGeneration.coverage.filesSelected}/${codebase.pendingGeneration.coverage.filesEnumerated} files. The complete index remains active.`,
          ))
        : null,
      deletionPending
        ? m(
            'div',
            {style: STYLES.error},
            text(
              '上次删除清理尚未完成。该源码库已停止检索，请重试“删除源码库”完成物理清理。',
              'Previous deletion cleanup is incomplete. Retrieval is already disabled; retry “Delete codebase” to finish physical cleanup.',
            ),
          )
        : !availableForOnDemandAccess
        ? m(
            'div',
            {style: STYLES.error},
            `${codebaseUnavailableReasonText(codebase.unavailableReason)} ${text(
              '恢复后才能选择该源码库。',
              'Restore it before selecting this codebase.',
            )}`,
          )
        : !hasActiveIndex
        ? m(
            'div',
            {style: {...STYLES.meta, marginTop: '8px'}},
            optionalIndexCopyForActiveRoot(),
          )
        : null,
      m('div', {style: STYLES.actions}, [
        m('button', {
          type: 'button',
          style: STYLES.button,
          disabled: this.readOnly || mutationBusy || deletionPending,
          onclick: () => {
            this.editingCodebaseId = codebase.codebaseId;
            this.viewMode = 'edit-codebase';
          },
        }, text('编辑范围', 'Edit scope')),
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onclick: () => {
              this.expandedAuditId = isExpanded ? null : codebase.codebaseId;
            },
          },
          isExpanded ? text('收起审计', 'Hide audit') : text('审计', 'Audit'),
        ),
        codebase.pendingGeneration && !deletionPending
          ? m('button', {
              type: 'button',
              style: STYLES.button,
              disabled: this.readOnly || mutationBusy,
              'aria-busy': pendingAction === 'accept' ? 'true' : 'false',
              onclick: () => this.resolvePendingGeneration(codebase, true),
            }, pendingAction === 'accept'
              ? text('接受中…', 'Accepting…')
              : text('接受受限索引', 'Accept limited index'))
          : null,
        codebase.pendingGeneration && !deletionPending
          ? m('button', {
              type: 'button',
              style: STYLES.button,
              disabled: this.readOnly || mutationBusy,
              'aria-busy': pendingAction === 'reject' ? 'true' : 'false',
              onclick: () => this.resolvePendingGeneration(codebase, false),
            }, pendingAction === 'reject'
              ? text('丢弃中…', 'Rejecting…')
              : text('丢弃候选', 'Reject candidate'))
          : null,
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            disabled: mutationBusy || this.readOnly || deletionPending,
            onclick: () => this.reindex(codebase),
          },
          isReindexing
            ? text('构建中…', 'Building...')
            : hasActiveIndex
              ? text('更新可选索引', 'Update optional index')
              : text('构建可选索引', 'Build optional index'),
        ),
        codebaseNeedsContentAuthorization(codebase)
          ? m('button', {
              type: 'button',
              style: STYLES.button,
              disabled: this.readOnly || mutationBusy || deletionPending || reviewing,
              onclick: () => {
                this.reviewingCodebaseId = codebase.codebaseId;
                this.error = null;
                this.success = null;
              },
            }, text('允许发送正文', 'Allow source text'))
          : null,
        codebase.eligibleForSendToProvider
          ? m('button', {
              type: 'button',
              style: STYLES.button,
              disabled: this.readOnly || mutationBusy || deletionPending,
              onclick: () => this.revokeCodebaseContent(codebase),
            }, this.updatingConsentId === `codebase:${codebase.codebaseId}`
              ? text('更新中…', 'Updating...')
              : text('撤销正文授权', 'Revoke source text'))
          : null,
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            disabled: this.readOnly || mutationBusy,
            onclick: () => this.deleteRegisteredCodebase(codebase),
          },
          isDeleting ? text('删除中…', 'Deleting...') : text('删除源码库', 'Delete codebase'),
        ),
      ]),
      m('div', {'aria-live': 'polite', style: STYLES.meta}, [
        pendingAction === 'accept' ? text('正在接受索引候选。', 'Accepting index candidate.') : null,
        pendingAction === 'reject' ? text('正在丢弃索引候选。', 'Rejecting index candidate.') : null,
      ]),
      reviewing
        ? m(ContentDisclosureReview, {
            backendUrl: this.backendUrl,
            apiKey: this.apiKey,
            readOnly: this.readOnly,
            codebase,
            onGranted: (updated: CodebaseSummary) => {
              this.reviewingCodebaseId = null;
              this.success = text(`已允许发送 ${updated.displayName} 的源码正文`,
                `Allowed source text from ${updated.displayName}`);
              // The server confirmed the grant: notify before refreshing the list.
              this.emitAuthorizationChange();
              void this.load();
            },
            onCancel: () => {
              this.reviewingCodebaseId = null;
            },
          })
        : null,
      isExpanded
        ? m(CodebaseAuditView, {
            backendUrl: this.backendUrl,
            apiKey: this.apiKey,
            scopeKey: this.scopeKey,
            codebase,
          })
        : null,
      ]),
    ]);
  }

  private renderKnowledgeSources(): m.Children {
    return m('div', {style: {marginTop: '18px'}}, [
      m('div', {style: STYLES.header}, [
        m('h4', {style: STYLES.title}, text('Android Internals Wiki', 'Android Internals Wiki')),
        m('button', {
          type: 'button',
          style: STYLES.button,
          disabled: this.readOnly,
          onclick: () => { this.viewMode = 'add-knowledge'; },
        }, text('新增知识源', 'Add knowledge source')),
      ]),
      m('div', {style: STYLES.subtitle}, text(
        '建好索引并允许发送正文后，可在输入框旁的上下文选择中用于分析。',
        'Once indexed and its text allowed, choose it for a turn beside the input box.',
      )),
      this.knowledgeSources.length === 0
        ? m('div', {style: {...STYLES.empty, marginTop: '10px'}}, text(
            '尚未注册外部知识源。可在这里登记后端允许访问的 Android Internals Wiki 路径。',
            'No external knowledge sources are registered. Add an Android Internals Wiki path allowed by the backend.',
          ))
        : m('div', {style: {...STYLES.list, marginTop: '10px'}},
        this.knowledgeSources.map((source) => {
          // The `/knowledge` row of the same source decides, as for every knowledge base.
          const listed = this.knowledgeBases.find(candidate => candidate.sourceId === source.sourceId);
          const usable = listed !== undefined && knowledgeBaseSelectable(listed);
          return m('div', {style: STYLES.card}, [
            m('div', {style: STYLES.name}, source.displayName),
            m('div', {style: STYLES.meta}, source.sourceId),
            m('div', {style: STYLES.chips}, [
              m('span', {style: STYLES.chip}, `${text('文章', 'articles')} ${source.indexedArticleCount ?? 0}`),
              m('span', {style: STYLES.chip}, `${text('分片', 'chunks')} ${source.indexedChunkCount ?? 0}`),
              m('span', {
                style: STYLES.chip,
                title: source.revision,
              }, `${text('修订', 'revision')} ${compactIdentity(source.revision)}`),
              m('span', {style: STYLES.chip}, source.dirty
                ? text('工作区有改动', 'dirty checkout')
                : text('工作区干净', 'clean checkout')),
              m('span', {
                style: STYLES.chip,
                title: source.activeGeneration,
              }, `${text('活动代际', 'active generation')} ${compactIdentity(source.activeGeneration)}`),
              m('span', {
                style: STYLES.chip,
                title: source.contentFingerprint,
              }, `${text('内容指纹', 'fingerprint')} ${compactIdentity(source.contentFingerprint, 14)}`),
              m('span', {style: STYLES.chip}, source.license),
              m('span', {style: STYLES.chip}, usable
                ? text('可用于分析', 'ready')
                : text('未索引或未授权', 'inactive or not consented')),
            ]),
            m('div', {style: STYLES.actions}, [
              m('button', {
                type: 'button',
                style: STYLES.button,
                disabled: this.readOnly || this.reindexingKnowledgeId !== null,
                onclick: () => this.reindexKnowledgeSource(source),
              }, this.reindexingKnowledgeId === source.sourceId
                ? text('索引中…', 'Indexing...')
                : text('重新索引', 'Reindex')),
              m('button', {
                type: 'button',
                style: STYLES.button,
                disabled: this.readOnly ||
                  this.updatingConsentId !== null ||
                  !source.rightsAcknowledged,
                onclick: () => this.setKnowledgeSourceConsent(source, !source.sendToProvider),
              }, this.updatingConsentId === `knowledge:${source.sourceId}`
                ? text('更新中…', 'Updating...')
                : source.sendToProvider
                  ? text('撤销正文授权', 'Revoke text')
                  : text('允许发送正文', 'Allow text')),
            ]),
          ]);
        })),
    ]);
  }

  private renderKnowledgeSourceForm(): m.Children {
    return m('div', {style: STYLES.shell}, [
      m('div', {style: STYLES.header}, [
        m('div', [
          m('h4', {style: STYLES.title}, text('注册外部知识源', 'Register external knowledge source')),
          m('div', {style: STYLES.subtitle}, text(
            '路径必须位于后端允许的知识根目录内；注册后执行一次索引才能用于分析。',
            'The path must be under a backend-approved knowledge root; reindex once before analysis.',
          )),
        ]),
      ]),
      m('label', {style: STYLES.check}, [
        m('span', {style: {minWidth: '110px'}}, text('显示名称', 'Display name')),
        m('input[type=text]', {
          value: this.knowledgeDisplayName,
          disabled: this.readOnly || this.registeringKnowledge,
          oninput: (event: InputEvent) => {
            this.knowledgeDisplayName = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
      m('label', {style: {...STYLES.check, marginTop: '10px'}}, [
        m('span', {style: {minWidth: '110px'}}, text('后端路径', 'Backend path')),
        m('input[type=text]', {
          value: this.knowledgeRootPath,
          placeholder: '/knowledge/android-internals-wiki',
          disabled: this.readOnly || this.registeringKnowledge,
          oninput: (event: InputEvent) => {
            this.knowledgeRootPath = (event.target as HTMLInputElement).value;
          },
        }),
      ]),
      m('label', {style: {...STYLES.check, marginTop: '12px'}}, [
        m('input[type=checkbox]', {
          checked: this.knowledgeRightsAcknowledged,
          disabled: this.readOnly || this.registeringKnowledge,
          onchange: (event: Event) => {
            this.knowledgeRightsAcknowledged = (event.target as HTMLInputElement).checked;
          },
        }),
        text('我确认有权按 CC-BY-NC-SA-4.0 使用该内容。', 'I confirm the content may be used under CC-BY-NC-SA-4.0.'),
      ]),
      m('label', {style: {...STYLES.check, marginTop: '10px'}}, [
        m('input[type=checkbox]', {
          checked: this.knowledgeSendToProvider,
          disabled: this.readOnly || this.registeringKnowledge,
          onchange: (event: Event) => {
            this.knowledgeSendToProvider = (event.target as HTMLInputElement).checked;
          },
        }),
        text('允许把脱敏片段发送给模型提供商。', 'Allow redacted snippets to be sent to the model provider.'),
      ]),
      this.error ? m('div', {style: {...STYLES.error, marginTop: '10px'}}, this.error) : null,
      m('div', {style: STYLES.actions}, [
        m('button', {
          type: 'button',
          style: {...STYLES.button, ...STYLES.primary},
          disabled: this.readOnly || this.registeringKnowledge ||
            !this.knowledgeRootPath.trim() || !this.knowledgeRightsAcknowledged,
          onclick: () => this.registerKnowledgeSource(),
        }, this.registeringKnowledge ? text('注册中…', 'Registering...') : text('注册', 'Register')),
        m('button', {
          type: 'button',
          style: STYLES.button,
          disabled: this.registeringKnowledge,
          onclick: () => { this.viewMode = 'list'; },
        }, text('取消', 'Cancel')),
      ]),
    ]);
  }

  private completeCodebaseRegistration(
    codebase: CodebaseSummary,
    useForAnalysis: boolean,
    identityEpoch: number,
    boundaryRevision: number,
    selectionAtRegistration: AnalysisContextSelection,
  ): void {
    if (identityEpoch !== this.identityEpoch) return;
    // Retain the returned identity before refreshing, including refresh failure.
    this.codebases = [
      ...this.codebases.filter(candidate => candidate.codebaseId !== codebase.codebaseId),
      codebase,
    ];
    const canSelect = useForAnalysis && !this.readOnly && this.featureEnabled &&
      boundaryRevision === this.registrationBoundaryRevision &&
      sameAnalysisContext(selectionAtRegistration, this.selection);
    if (canSelect) {
      this.emitSelection(analysisContextAfterCodebaseRegistration(
        this.selection, codebase, this.codebases,
      ));
    }
    const selected = canSelect && this.selection.codebaseIds.includes(codebase.codebaseId);
    this.success = selected
      ? this.selection.codeAwareMode === 'metadata_only'
        ? text(`已添加 ${codebase.displayName}，用于源码定位。`, `Added ${codebase.displayName} for locate-only analysis.`)
        : text(`已添加 ${codebase.displayName}，下一次分析可按需读取。`, `Added ${codebase.displayName}; the next analysis can read it on demand.`)
      : text(`已添加 ${codebase.displayName}，尚未用于分析。`, `Added ${codebase.displayName} without selecting it for analysis.`);
    this.viewMode = 'list';
    void this.load();
  }

  view(_vnode: m.Vnode<CodebasePanelAttrs>): m.Children {
    if (this.viewMode === 'add-knowledge') return this.renderKnowledgeSourceForm();
    if (this.viewMode === 'edit-codebase') {
      const codebase = this.codebases.find(
        (candidate) => candidate.codebaseId === this.editingCodebaseId,
      );
      if (!codebase) {
        this.viewMode = 'list';
        this.editingCodebaseId = null;
      } else {
        return m('div', {style: STYLES.shell}, [
          m('div', {style: STYLES.header}, [
            m('div', [
              m('h4', {style: STYLES.title}, text('编辑源码范围', 'Edit source scope')),
              m('div', {style: STYLES.subtitle}, codebase.displayName),
            ]),
          ]),
          m(CodebaseForm, {
            backendUrl: this.backendUrl,
            apiKey: this.apiKey,
            scopeKey: this.scopeKey,
            readOnly: this.readOnly,
            codebase,
            onRegistered: () => {},
            onUpdated: (updated) => {
              this.emitAuthorizationChange();
              this.success = text(
                `已保存 ${updated.displayName} 的源码范围`,
                `Saved the source scope for ${updated.displayName}`,
              );
              this.editingCodebaseId = null;
              this.viewMode = 'list';
              void this.load();
            },
            onCancel: () => {
              this.editingCodebaseId = null;
              this.viewMode = 'list';
            },
          }),
        ]);
      }
    }
    if (this.viewMode === 'add-codebase') {
      const identityEpoch = this.identityEpoch;
      const boundaryRevision = this.registrationBoundaryRevision;
      const selection = normalizeAnalysisContext(this.selection);
      return m('div', {style: STYLES.shell}, [
        m('div', {style: STYLES.header}, [
          m('div', [
            m('h4', {style: STYLES.title}, text('添加源码', 'Add source')),
          ]),
        ]),
        m(CodebaseForm, {
          backendUrl: this.backendUrl,
          apiKey: this.apiKey,
          scopeKey: this.scopeKey,
          readOnly: this.readOnly,
          codeAwareMode: selection.codeAwareMode,
          onRegistered: (codebase, useForAnalysis) => this.completeCodebaseRegistration(
            codebase, useForAnalysis, identityEpoch, boundaryRevision, selection,
          ),
          onCancel: () => {
            this.viewMode = 'list';
          },
        }),
      ]);
    }

    if (this.loaded) this.syncFromCatalog();
    const initialLoading = this.loading && !this.loaded;
    return m('div', {style: STYLES.shell}, [
      m('div', {style: STYLES.header}, [
        m('div', [
          m('h4', {style: STYLES.title}, text('源码库', 'Codebases')),
          m(
            'div',
            {style: STYLES.subtitle},
            this.featureEnabled
              ? text(
                  '注册路径后即可按需搜索与读取；索引仅作为可选加速项。',
                  'Registered paths are searchable and readable on demand; indexing is optional acceleration.',
                )
              : text('后端已禁用源码感知分析。', 'Code-aware analysis is disabled on the backend.'),
          ),
        ]),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.primary},
            disabled: this.readOnly || !this.featureEnabled,
            onclick: () => {
              this.viewMode = 'add-codebase';
            },
          },
          text('新增', 'Add'),
        ),
      ]),
      m('div', {style: STYLES.subtitle}, text(
        '这里管理源码库与知识库；每轮用哪些，在输入框旁的上下文选择中设置。',
        'Manage codebases and knowledge bases here; choose what each turn uses beside the input box.',
      )),
      this.error ? m('div', {style: STYLES.error, role: 'alert'}, this.error) : null,
      this.success
        ? m('div', {style: STYLES.success, role: 'status', 'aria-live': 'polite'}, this.success)
        : null,
      initialLoading
        ? m('div', {style: STYLES.empty}, text('正在加载分析上下文…', 'Loading analysis context...'))
        : this.codebases.length === 0
          ? m('div', {style: STYLES.empty}, text('尚未注册源码库。', 'No codebases registered.'))
          : m('div', {style: STYLES.list}, this.codebases.map((codebase) =>
              this.renderCodebase(codebase)
            )),
      initialLoading ? null : m(KnowledgeBaseSection, {
        backendUrl: this.backendUrl,
        apiKey: this.apiKey,
        scopeKey: this.scopeKey,
        readOnly: this.readOnly,
        sources: this.knowledgeBases.filter(source => source.kind === 'document_collection'),
        selectedIds: this.selection.knowledgeSourceIds,
        onChanged: () => this.load(),
        onAuthorizationChange: () => this.emitAuthorizationChange(),
      }),
      initialLoading ? null : this.renderKnowledgeSources(),
    ]);
  }
}
