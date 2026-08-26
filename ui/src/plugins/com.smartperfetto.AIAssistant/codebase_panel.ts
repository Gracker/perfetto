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

import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
} from './types';
import type {
  CodebaseSummary,
  ExternalKnowledgeSourceSummary,
} from './codebase_api';
import {
  acceptPendingCodebaseGeneration,
  authorizeAvailableCodebaseExtensions,
  deleteCodebase,
  listCodebases,
  listExternalKnowledgeSources,
  registerExternalKnowledgeSource,
  rejectPendingCodebaseGeneration,
  reindexCodebase,
  reindexExternalKnowledgeSource,
  updateCodebaseConsent,
  updateExternalKnowledgeSourceConsent,
} from './codebase_api';
import {normalizeAnalysisContext, sameAnalysisContext} from './analysis_context';
import {CodebaseAuditView} from './codebase_audit_view';
import {CodebaseForm} from './codebase_form';
import {codebaseExcerptCache} from './codebase_excerpt_cache';
import {uiText as text} from './ui_language';

export interface CodebasePanelAttrs {
  backendUrl: string;
  apiKey?: string;
  /** Stable backend + tenant + workspace + user partition identity. */
  scopeKey: string;
  selection: AnalysisContextSelection;
  readOnly?: boolean;
  onSelectionChange: (selection: AnalysisContextSelection) => void;
}

type ViewMode = 'list' | 'add-codebase' | 'add-knowledge';

export function externalKnowledgeSourceHasActiveIndex(
  source: ExternalKnowledgeSourceSummary,
): boolean {
  return source.rightsAcknowledged === true &&
    source.sendToProvider === true &&
    Boolean(source.activeGeneration) &&
    Boolean(source.contentFingerprint?.trim()) &&
    (source.indexedChunkCount ?? 0) > 0;
}

const STYLES = {
  shell: {
    padding: '18px',
    minHeight: '420px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
  },
  title: {
    margin: 0,
    color: 'var(--chat-text)',
    fontSize: '15px',
    fontWeight: 700,
  },
  subtitle: {
    color: 'var(--chat-text-secondary)',
    fontSize: '12px',
    marginTop: '4px',
  },
  button: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '8px 11px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  primary: {
    background: 'var(--chat-primary)',
    borderColor: 'var(--chat-primary)',
    color: 'white',
  },
  list: {
    display: 'grid',
    gap: '10px',
  },
  card: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg)',
    padding: '12px',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '12px',
  },
  name: {
    color: 'var(--chat-text)',
    fontSize: '13px',
    fontWeight: 700,
  },
  meta: {
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
    fontFamily: 'monospace',
    overflowWrap: 'anywhere',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '8px',
  },
  chip: {
    border: '1px solid var(--chat-border)',
    borderRadius: '999px',
    padding: '2px 7px',
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '10px',
  },
  context: {
    border: '1px solid var(--chat-border)',
    borderRadius: '10px',
    background: 'var(--chat-bg-secondary)',
    padding: '12px',
    marginBottom: '14px',
  },
  modeRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '9px',
  },
  check: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    color: 'var(--chat-text)',
    cursor: 'pointer',
  },
  empty: {
    border: '1px dashed var(--chat-border)',
    borderRadius: '8px',
    padding: '22px',
    textAlign: 'center',
    color: 'var(--chat-text-secondary)',
  },
  error: {
    color: 'var(--chat-error)',
    fontSize: '12px',
    marginBottom: '10px',
  },
  success: {
    color: 'var(--chat-success)',
    fontSize: '12px',
    marginBottom: '10px',
  },
} as const;

export function codebaseHasActiveIndex(codebase: CodebaseSummary): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' &&
    Boolean(codebase.activeGeneration) &&
    Boolean(codebase.contentFingerprint) &&
    (codebase.chunkCount ?? 0) > 0;
}

export function codebaseAvailableForOnDemandAccess(
  codebase: CodebaseSummary,
): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' &&
    codebase.rootAvailable !== false;
}

export function optionalIndexCopyForActiveRoot(): string {
  return text(
    '该注册路径已可直接按需搜索/读取，无需重建。GitNexus 本地索引若已安装或可用，只作为可选导航；缺失、过期或失败时会回退。SmartPerfetto 索引仍是可选的语义/补丁加速。',
    'This registered path is ready for bounded search/read and needs no rebuild. A local GitNexus index, when installed or available, is optional navigation only; missing, stale, or failed indexes fall back. The SmartPerfetto index remains optional semantic and patch acceleration.',
  );
}

export function codebaseDeletionPending(codebase: CodebaseSummary): boolean {
  return codebase.lifecycleState === 'deleting';
}

export function codebaseCanAuthorizeAvailableExtensions(codebase: CodebaseSummary): boolean {
  return (codebase.lifecycleState ?? 'active') === 'active' &&
    codebase.eligibleForSendToProvider === true &&
    (codebase.availableNotConsentedExtensions?.length ?? 0) > 0;
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
  return normalizeAnalysisContext({
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
  private loading = true;
  private error: string | null = null;
  private success: string | null = null;
  private featureEnabled = true;
  private viewMode: ViewMode = 'list';
  private expandedAuditId: string | null = null;
  private reindexingId: string | null = null;
  private pendingAction: {codebaseId: string; action: 'accept' | 'reject'} | null = null;
  private deletingId: string | null = null;
  private updatingConsentId: string | null = null;
  private extensionAuthorizationId: string | null = null;
  private reindexingKnowledgeId: string | null = null;
  private registeringKnowledge = false;
  private knowledgeRootPath = '';
  private knowledgeDisplayName = 'Android Internals Wiki';
  private knowledgeRightsAcknowledged = false;
  private knowledgeSendToProvider = false;
  private loadEpoch = 0;
  private identityEpoch = 0;
  private backendUrl = '';
  private apiKey?: string;
  private scopeKey = '';
  private selection = normalizeAnalysisContext(null);
  private readOnly = false;
  private onSelectionChange: (selection: AnalysisContextSelection) => void = () => {};

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
      this.knowledgeSources = [];
      this.error = null;
      this.reindexingId = null;
      this.pendingAction = null;
      this.deletingId = null;
      this.updatingConsentId = null;
      this.extensionAuthorizationId = null;
      this.reindexingKnowledgeId = null;
      this.registeringKnowledge = false;
      this.success = null;
      this.expandedAuditId = null;
      this.viewMode = 'list';
      codebaseExcerptCache.clearForPanelUnmount();
      this.load();
    }
  }

  private syncAttrs(attrs: CodebasePanelAttrs): void {
    this.selection = normalizeAnalysisContext(attrs.selection);
    this.readOnly = attrs.readOnly === true;
    this.onSelectionChange = attrs.onSelectionChange;
  }

  onremove() {
    this.loadEpoch++;
    this.identityEpoch++;
    codebaseExcerptCache.clearForPanelUnmount();
  }

  private async load() {
    const epoch = ++this.loadEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    const scopeKey = this.scopeKey;
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      const [codebaseResult, knowledgeResult] = await Promise.allSettled([
        listCodebases(backendUrl, apiKey),
        listExternalKnowledgeSources(backendUrl, apiKey),
      ]);
      if (!this.requestIdentityIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      const failures: string[] = [];
      if (codebaseResult.status === 'fulfilled') {
        this.featureEnabled = codebaseResult.value.featureEnabled;
        this.codebases = codebaseResult.value.codebases;
      } else {
        failures.push(codebaseResult.reason instanceof Error
          ? codebaseResult.reason.message
          : text('源码列表加载失败', 'Failed to load codebases'));
      }
      if (knowledgeResult.status === 'fulfilled') {
        this.knowledgeSources = knowledgeResult.value;
      } else {
        failures.push(knowledgeResult.reason instanceof Error
          ? knowledgeResult.reason.message
          : text('外部知识源加载失败', 'Failed to load external knowledge sources'));
      }
      this.error = failures.length > 0 ? failures.join(' · ') : null;
      this.reconcileSelection({
        codebasesLoaded: codebaseResult.status === 'fulfilled',
        knowledgeLoaded: knowledgeResult.status === 'fulfilled',
      });
    } catch (e: unknown) {
      if (!this.requestIdentityIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.error = e instanceof Error ? e.message : text('加载分析上下文失败', 'Failed to load analysis context');
    } finally {
      if (!this.requestIdentityIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.loading = false;
      m.redraw();
    }
  }

  private confirmProviderConsent(displayName: string): boolean {
    return typeof window === 'undefined' || window.confirm(text(
      `确认授权将 ${displayName} 的脱敏内容发送给已配置的模型提供商？此授权在切换提供商后仍然有效。`,
      `Allow redacted content from ${displayName} to be sent to configured model providers? This consent remains active after switching providers.`,
    ));
  }

  private codebaseMutationInProgress(): boolean {
    return this.reindexingId !== null ||
      this.deletingId !== null ||
      this.pendingAction !== null ||
      this.extensionAuthorizationId !== null ||
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

  private async setCodebaseConsent(codebase: CodebaseSummary, sendToProvider: boolean) {
    if (
      this.readOnly ||
      this.codebaseMutationInProgress() ||
      (sendToProvider && !this.confirmProviderConsent(codebase.displayName))
    ) return;
    const operationId = `codebase:${codebase.codebaseId}`;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.updatingConsentId = operationId;
    this.error = null;
    this.success = null;
    try {
      await updateCodebaseConsent(
        backendUrl,
        codebase.codebaseId,
        sendToProvider,
        apiKey,
      );
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = sendToProvider
        ? text(`已授权 ${codebase.displayName}`, `Authorized ${codebase.displayName}`)
        : text(`已撤销 ${codebase.displayName} 的内容发送权限`, `Revoked provider content access for ${codebase.displayName}`);
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
        ? text(`已授权 ${source.displayName}`, `Authorized ${source.displayName}`)
        : text(`已撤销 ${source.displayName} 的内容发送权限`, `Revoked provider content access for ${source.displayName}`);
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

  private reconcileSelection(input: {
    codebasesLoaded: boolean;
    knowledgeLoaded: boolean;
  }): void {
    const codebases = new Map(this.codebases.map((codebase) => [codebase.codebaseId, codebase]));
    const usableSources = new Set(this.knowledgeSources
      .filter(externalKnowledgeSourceHasActiveIndex)
      .map((source) => source.sourceId));
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
          return !!codebase && codebaseAvailableForOnDemandAccess(codebase) &&
            (availableSelection.codeAwareMode !== 'provider_send' ||
              codebase.eligibleForSendToProvider === true);
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

  private setCodeAwareMode(codeAwareMode: CodeAwareAnalysisMode): void {
    if (this.readOnly) return;
    this.emitSelection({
      ...this.selection,
      codeAwareMode,
      codebaseIds: codeAwareMode === 'provider_send'
        ? this.selection.codebaseIds.filter((id) =>
            this.codebases.find((codebase) => codebase.codebaseId === id)
              ?.eligibleForSendToProvider === true)
        : this.selection.codebaseIds,
    });
  }

  private toggleCodebase(codebase: CodebaseSummary): void {
    if (
      this.readOnly ||
      this.selection.codeAwareMode === 'off' ||
      !codebaseAvailableForOnDemandAccess(codebase) ||
      (this.selection.codeAwareMode === 'provider_send' && !codebase.eligibleForSendToProvider)
    ) return;
    const selected = new Set(this.selection.codebaseIds);
    selected.has(codebase.codebaseId)
      ? selected.delete(codebase.codebaseId)
      : selected.add(codebase.codebaseId);
    this.emitSelection({...this.selection, codebaseIds: [...selected]});
  }

  private toggleKnowledgeSource(source: ExternalKnowledgeSourceSummary): void {
    const usable = externalKnowledgeSourceHasActiveIndex(source);
    if (this.readOnly || !usable) return;
    const selected = new Set(this.selection.knowledgeSourceIds);
    selected.has(source.sourceId)
      ? selected.delete(source.sourceId)
      : selected.add(source.sourceId);
    this.emitSelection({...this.selection, knowledgeSourceIds: [...selected]});
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
        codebaseExcerptCache.clearForCodebaseReindex(
          codebase.codebaseId,
          codebase.indexGeneration + 1,
        );
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
      this.error = e instanceof Error
        ? text(
            `${e.message}；这不影响按需源码读取。`,
            `${e.message}; on-demand source access remains available.`,
          )
        : text(
            '可选索引构建失败；按需源码读取仍可使用。',
            'Optional index build failed; on-demand source access remains available.',
          );
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

  private async authorizeAvailableExtensions(codebase: CodebaseSummary) {
    if (this.readOnly || this.codebaseMutationInProgress()) return;
    const extensions = codebase.availableNotConsentedExtensions ?? [];
    if (extensions.length === 0) return;
    const confirmed = typeof window === 'undefined' || window.confirm(text(
      `确认把以下新语言扩展加入 ${codebase.displayName} 的 provider 内容授权：${extensions.join(', ')}？`,
      `Add these newly available extensions to provider content consent for ${codebase.displayName}: ${extensions.join(', ')}?`,
    ));
    if (!confirmed) return;
    const identityEpoch = this.identityEpoch;
    const backendUrl = this.backendUrl;
    const apiKey = this.apiKey;
    this.extensionAuthorizationId = codebase.codebaseId;
    this.error = null;
    this.success = null;
    try {
      await authorizeAvailableCodebaseExtensions(backendUrl, codebase.codebaseId, apiKey);
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.success = text('已授权新语言范围。', 'Authorized the newly available languages.');
      if (this.extensionAuthorizationId === codebase.codebaseId) {
        this.extensionAuthorizationId = null;
      }
      await this.load();
    } catch (error) {
      if (!this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) return;
      this.error = error instanceof Error ? error.message : text('授权新语言失败', 'Failed to authorize new languages');
    } finally {
      if (this.operationIdentityIsCurrent(identityEpoch, backendUrl, apiKey)) {
        if (this.extensionAuthorizationId === codebase.codebaseId) {
          this.extensionAuthorizationId = null;
        }
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
      codebaseExcerptCache.clearForCodebaseDelete(codebase.codebaseId);
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
    const authorizingExtensions = this.extensionAuthorizationId === codebase.codebaseId;
    const mutationBusy = this.codebaseMutationInProgress();
    const isDeleting = this.deletingId === codebase.codebaseId;
    const deletionPending = codebaseDeletionPending(codebase);
    const selected = this.selection.codebaseIds.includes(codebase.codebaseId);
    const hasActiveIndex = codebaseHasActiveIndex(codebase);
    const availableForOnDemandAccess = codebaseAvailableForOnDemandAccess(codebase);
    const selectionDisabled = this.readOnly ||
      this.selection.codeAwareMode === 'off' ||
      !availableForOnDemandAccess ||
      (this.selection.codeAwareMode === 'provider_send' && !codebase.eligibleForSendToProvider);
    return m('div', {style: STYLES.card}, [
      m('div', {style: STYLES.cardHeader}, [
        m('label', {style: STYLES.check}, [
          m('input[type=checkbox]', {
            checked: selected,
            disabled: selectionDisabled,
            onchange: () => this.toggleCodebase(codebase),
          }),
          m('span', [
            m('div', {style: STYLES.name}, codebase.displayName),
            m('div', {style: STYLES.meta}, codebase.codebaseId),
          ]),
        ]),
        m('div', {style: STYLES.meta}, codebase.kind),
      ]),
      m('div', {style: STYLES.chips}, [
        m('span', {style: STYLES.chip}, `${text('分片', 'chunks')} ${codebase.chunkCount ?? 0}`),
        m('span', {style: STYLES.chip}, `${text('代际', 'gen')} ${codebase.indexGeneration}`),
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
      codebase.lastIngestError
        ? m('div', {style: STYLES.error}, codebase.lastIngestError)
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
      (codebase.availableNotConsentedExtensions?.length ?? 0) > 0
        ? m('div', {style: {...STYLES.meta, marginTop: '8px'}}, [
            text(
              `新语言可用但尚未授权发送：${codebase.availableNotConsentedExtensions!.join(', ')}。`,
              `Newly available languages are not consented for provider send: ${codebase.availableNotConsentedExtensions!.join(', ')}.`,
            ),
            codebaseCanAuthorizeAvailableExtensions(codebase)
              ? m('button', {
                  type: 'button',
                  style: {...STYLES.button, marginLeft: '8px'},
                  disabled: this.readOnly || mutationBusy,
                  'aria-busy': authorizingExtensions ? 'true' : 'false',
                  onclick: () => this.authorizeAvailableExtensions(codebase),
                }, authorizingExtensions
                  ? text('授权中…', 'Authorizing…')
                  : text('授权新语言', 'Authorize languages'))
              : null,
          ])
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
            text(
              '已注册的源码路径当前不可用，请恢复该路径后再选择。',
              'The registered source path is unavailable. Restore it before selecting this codebase.',
            ),
          )
        : !hasActiveIndex
        ? m(
            'div',
            {style: {...STYLES.meta, marginTop: '8px'}},
            optionalIndexCopyForActiveRoot(),
          )
        : null,
      m('div', {style: STYLES.actions}, [
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
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            disabled: this.readOnly || mutationBusy || deletionPending,
            onclick: () => this.setCodebaseConsent(
              codebase,
              !codebase.eligibleForSendToProvider,
            ),
          },
          this.updatingConsentId === `codebase:${codebase.codebaseId}`
            ? text('更新中…', 'Updating...')
            : codebase.eligibleForSendToProvider
              ? text('撤销内容授权', 'Revoke content access')
              : text('授权脱敏内容', 'Authorize redacted content'),
        ),
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
        authorizingExtensions ? text('正在更新语言授权。', 'Updating language consent.') : null,
      ]),
      isExpanded
        ? m(CodebaseAuditView, {
            backendUrl: this.backendUrl,
            apiKey: this.apiKey,
            scopeKey: this.scopeKey,
            codebase,
          })
        : null,
    ]);
  }

  private renderContextControls(): m.Children {
    const modes: Array<{id: CodeAwareAnalysisMode; label: string; detail: string}> = [
      {
        id: 'off',
        label: text('关闭源码', 'Source off'),
        detail: text('不向本轮分析提供已注册源码。', 'Do not use registered source trees.'),
      },
      {
        id: 'metadata_only',
        label: text('仅元数据', 'Metadata only'),
        detail: text('只提供文件、符号与行号引用，不发送源码正文。', 'Use file, symbol, and line references without source text.'),
      },
      {
        id: 'provider_send',
        label: text('完整源码', 'Full source'),
        detail: text('仅对已明确授权的源码发送脱敏片段。', 'Send redacted snippets only from explicitly consented codebases.'),
      },
    ];
    const current = modes.find((mode) => mode.id === this.selection.codeAwareMode) ?? modes[0];
    return m('div', {style: STYLES.context}, [
      m('div', {style: STYLES.name}, text('分析上下文', 'Analysis context')),
      m('div', {style: STYLES.subtitle}, current.detail),
      m('div', {style: STYLES.modeRow}, modes.map((mode) =>
        m('button', {
          type: 'button',
          style: {
            ...STYLES.button,
            ...(mode.id === this.selection.codeAwareMode ? STYLES.primary : {}),
          },
          disabled: this.readOnly || !this.featureEnabled,
          onclick: () => this.setCodeAwareMode(mode.id),
        }, mode.label))),
      this.readOnly
        ? m('div', {style: STYLES.subtitle}, text('分析运行中，上下文保持只读。', 'Context is read-only while analysis is running.'))
        : null,
    ]);
  }

  private renderKnowledgeSources(): m.Children {
    return m('div', {style: {marginTop: '18px'}}, [
      m('div', {style: STYLES.header}, [
        m('h4', {style: STYLES.title}, text('外部知识 RAG', 'External knowledge RAG')),
        m('button', {
          type: 'button',
          style: STYLES.button,
          disabled: this.readOnly,
          onclick: () => { this.viewMode = 'add-knowledge'; },
        }, text('新增知识源', 'Add knowledge source')),
      ]),
      m('div', {style: STYLES.subtitle}, text(
        '可与源码单独或叠加使用；只有已授权并完成索引的知识源可选。',
        'Can be used alone or with source context; only consented, indexed sources are selectable.',
      )),
      this.knowledgeSources.length === 0
        ? m('div', {style: {...STYLES.empty, marginTop: '10px'}}, text(
            '尚未注册外部知识源。可在这里登记后端允许访问的 Android Internals Wiki 路径。',
            'No external knowledge sources are registered. Add an Android Internals Wiki path allowed by the backend.',
          ))
        : m('div', {style: {...STYLES.list, marginTop: '10px'}},
        this.knowledgeSources.map((source) => {
          const usable = externalKnowledgeSourceHasActiveIndex(source);
          const selected = this.selection.knowledgeSourceIds.includes(source.sourceId);
          return m('div', {style: STYLES.card}, [
            m('label', {style: STYLES.check}, [
              m('input[type=checkbox]', {
                checked: selected,
                disabled: this.readOnly || !usable,
                onchange: () => this.toggleKnowledgeSource(source),
              }),
              m('span', [
                m('div', {style: STYLES.name}, source.displayName),
                m('div', {style: STYLES.meta}, source.sourceId),
              ]),
            ]),
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
                  ? text('撤销内容授权', 'Revoke content access')
                  : text('授权脱敏内容', 'Authorize redacted content')),
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

  view(_vnode: m.Vnode<CodebasePanelAttrs>): m.Children {
    if (this.viewMode === 'add-knowledge') return this.renderKnowledgeSourceForm();
    if (this.viewMode === 'add-codebase') {
      return m('div', {style: STYLES.shell}, [
        m('div', {style: STYLES.header}, [
          m('div', [
            m('h4', {style: STYLES.title}, text('注册源码库', 'Register codebase')),
            m('div', {style: STYLES.subtitle}, text(
              '注册前会由后端先执行安全预览。',
              'The backend runs a security preview before registration.',
            )),
          ]),
        ]),
        m(CodebaseForm, {
          backendUrl: this.backendUrl,
          apiKey: this.apiKey,
          scopeKey: this.scopeKey,
          onRegistered: (codebase) => {
            this.success = text(`已注册 ${codebase.displayName}`, `Registered ${codebase.displayName}`);
            this.viewMode = 'list';
            this.load();
          },
          onCancel: () => {
            this.viewMode = 'list';
          },
        }),
      ]);
    }

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
      this.renderContextControls(),
      this.error ? m('div', {style: STYLES.error, role: 'alert'}, this.error) : null,
      this.success
        ? m('div', {style: STYLES.success, role: 'status', 'aria-live': 'polite'}, this.success)
        : null,
      this.loading
        ? m('div', {style: STYLES.empty}, text('正在加载分析上下文…', 'Loading analysis context...'))
        : this.codebases.length === 0
          ? m('div', {style: STYLES.empty}, text('尚未注册源码库。', 'No codebases registered.'))
          : m('div', {style: STYLES.list}, this.codebases.map((codebase) =>
              this.renderCodebase(codebase)
            )),
      this.loading ? null : this.renderKnowledgeSources(),
    ]);
  }
}
