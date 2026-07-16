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

import type {CodebaseAudit, CodebaseSummary} from './codebase_api';
import {loadCodebaseAudit} from './codebase_api';
import {uiText as text} from './ui_language';

export interface CodebaseAuditViewAttrs {
  backendUrl: string;
  apiKey?: string;
  scopeKey: string;
  codebase: CodebaseSummary;
}

const STYLES = {
  shell: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    padding: '12px',
    background: 'var(--chat-bg-secondary)',
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '12px',
    padding: '5px 0',
    fontSize: '12px',
  },
  label: {
    color: 'var(--chat-text-secondary)',
  },
  value: {
    color: 'var(--chat-text)',
    fontFamily: 'monospace',
    textAlign: 'right',
    overflowWrap: 'anywhere',
  },
  error: {
    color: 'var(--chat-error)',
    fontSize: '12px',
  },
} as const;

function formatAuditValue(value: unknown): string {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function compactFingerprint(value: string | undefined): string {
  return value && value.length > 20 ? `${value.slice(0, 16)}…` : formatAuditValue(value);
}

export function formatAuditDate(value: number | string | undefined): string {
  if (value === undefined || value === '') return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

export class CodebaseAuditView implements m.ClassComponent<CodebaseAuditViewAttrs> {
  private audit: CodebaseAudit | null = null;
  private loading = true;
  private error: string | null = null;
  private requestEpoch = 0;
  private mounted = false;
  private identity = '';

  oninit(vnode: m.Vnode<CodebaseAuditViewAttrs>) {
    this.mounted = true;
    this.identity = this.requestIdentity(vnode.attrs);
    this.load(vnode.attrs);
  }

  onupdate(vnode: m.Vnode<CodebaseAuditViewAttrs>) {
    const identity = this.requestIdentity(vnode.attrs);
    if (identity !== this.identity) {
      this.identity = identity;
      this.load(vnode.attrs);
    }
  }

  onremove() {
    this.mounted = false;
    this.requestEpoch++;
  }

  private requestIdentity(attrs: CodebaseAuditViewAttrs): string {
    return [attrs.backendUrl, attrs.apiKey ?? '', attrs.scopeKey, attrs.codebase.codebaseId].join('\0');
  }

  private async load(attrs: CodebaseAuditViewAttrs) {
    const epoch = ++this.requestEpoch;
    const identity = this.requestIdentity(attrs);
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      const audit = await loadCodebaseAudit(
        attrs.backendUrl,
        attrs.codebase.codebaseId,
        attrs.apiKey,
      );
      if (!this.mounted || epoch !== this.requestEpoch || identity !== this.identity) return;
      this.audit = audit;
    } catch (e: unknown) {
      if (!this.mounted || epoch !== this.requestEpoch || identity !== this.identity) return;
      this.error = e instanceof Error ? e.message : text('加载审计信息失败', 'Failed to load audit');
    } finally {
      if (!this.mounted || epoch !== this.requestEpoch || identity !== this.identity) return;
      this.loading = false;
      m.redraw();
    }
  }

  private renderRow(label: string, value: unknown, title?: string): m.Children {
    return m('div', {style: STYLES.row}, [
      m('span', {style: STYLES.label}, label),
      m('span', {style: STYLES.value, title}, formatAuditValue(value)),
    ]);
  }

  view(vnode: m.Vnode<CodebaseAuditViewAttrs>): m.Children {
    if (this.loading) {
      return m('div', {style: STYLES.shell}, text('正在加载审计信息…', 'Loading audit…'));
    }
    if (this.error) {
      return m('div', {style: {...STYLES.shell, ...STYLES.error}}, this.error);
    }
    const audit = this.audit;
    return m('div', {style: STYLES.shell}, [
      this.renderRow(text('源码库', 'Codebase'), vnode.attrs.codebase.displayName),
      this.renderRow('ID', vnode.attrs.codebase.codebaseId),
      this.renderRow(text('类型', 'Kind'), audit?.kind || vnode.attrs.codebase.kind),
      this.renderRow(text('索引代次', 'Index generation'), audit?.indexGeneration),
      this.renderRow(text('活动代次', 'Active generation'), audit?.activeGeneration),
      this.renderRow(
        text('内容指纹', 'Content fingerprint'),
        compactFingerprint(audit?.contentFingerprint),
        audit?.contentFingerprint,
      ),
      this.renderRow(text('索引版本', 'Indexed revision'), audit?.indexedRevision),
      this.renderRow(
        text('工作区状态', 'Worktree state'),
        audit?.indexedDirty === undefined
          ? '-'
          : audit.indexedDirty
            ? text('有未提交内容', 'dirty')
            : text('干净', 'clean'),
      ),
      this.renderRow(text('版本来源', 'Commit provenance'), audit?.commitProvenance),
      this.renderRow(text('分片数', 'Chunks'), audit?.chunkCount),
      this.renderRow(text('阻止文件', 'Blocked files'), audit?.blockedFileCount),
      this.renderRow(text('脱敏命中', 'Redaction hits'), audit?.redactionHitCount),
      this.renderRow(text('最近索引状态', 'Last ingest status'), audit?.lastIngestStatus),
      this.renderRow(
        text('最近索引时间', 'Last ingest at'),
        formatAuditDate(audit?.lastIngestAt),
      ),
      audit?.lastIngestError
        ? this.renderRow(text('最近错误', 'Last error'), audit.lastIngestError)
        : null,
    ]);
  }
}
