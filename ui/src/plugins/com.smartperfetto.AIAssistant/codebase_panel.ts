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

import type {CodebaseSummary} from './codebase_api';
import {listCodebases, reindexCodebase} from './codebase_api';
import {CodebaseAuditView} from './codebase_audit_view';
import {CodebaseForm} from './codebase_form';
import {codebaseExcerptCache} from './codebase_excerpt_cache';

export interface CodebasePanelAttrs {
  backendUrl: string;
  apiKey?: string;
}

type ViewMode = 'list' | 'add';

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
    gap: '6px',
    marginTop: '10px',
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

function formatDate(value: string | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export class CodebasePanel implements m.ClassComponent<CodebasePanelAttrs> {
  private codebases: CodebaseSummary[] = [];
  private loading = true;
  private error: string | null = null;
  private success: string | null = null;
  private featureEnabled = true;
  private viewMode: ViewMode = 'list';
  private expandedAuditId: string | null = null;
  private reindexingId: string | null = null;
  private backendUrl = '';
  private apiKey?: string;

  oninit(vnode: m.Vnode<CodebasePanelAttrs>) {
    this.backendUrl = vnode.attrs.backendUrl;
    this.apiKey = vnode.attrs.apiKey;
    this.load();
  }

  onupdate(vnode: m.Vnode<CodebasePanelAttrs>) {
    if (vnode.attrs.backendUrl !== this.backendUrl || vnode.attrs.apiKey !== this.apiKey) {
      this.backendUrl = vnode.attrs.backendUrl;
      this.apiKey = vnode.attrs.apiKey;
      this.load();
    }
  }

  onremove() {
    codebaseExcerptCache.clearForPanelUnmount();
  }

  private async load() {
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      const result = await listCodebases(this.backendUrl, this.apiKey);
      this.featureEnabled = result.featureEnabled;
      this.codebases = result.codebases;
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Failed to load codebases';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async reindex(codebase: CodebaseSummary) {
    this.reindexingId = codebase.codebaseId;
    this.error = null;
    this.success = null;
    m.redraw();
    try {
      const result = await reindexCodebase(
        this.backendUrl,
        codebase.codebaseId,
        this.apiKey,
      );
      codebaseExcerptCache.clearForCodebaseReindex(
        codebase.codebaseId,
        codebase.indexGeneration + 1,
      );
      this.success = `Reindexed ${codebase.displayName}: ${result.chunksAdded ?? 0} chunks`;
      await this.load();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Reindex failed';
    } finally {
      this.reindexingId = null;
      m.redraw();
    }
  }

  private renderCodebase(codebase: CodebaseSummary): m.Children {
    const isExpanded = this.expandedAuditId === codebase.codebaseId;
    const isReindexing = this.reindexingId === codebase.codebaseId;
    return m('div', {style: STYLES.card}, [
      m('div', {style: STYLES.cardHeader}, [
        m('div', [
          m('div', {style: STYLES.name}, codebase.displayName),
          m('div', {style: STYLES.meta}, codebase.codebaseId),
        ]),
        m('div', {style: STYLES.meta}, codebase.kind),
      ]),
      m('div', {style: STYLES.chips}, [
        m('span', {style: STYLES.chip}, `chunks ${codebase.chunkCount ?? 0}`),
        m('span', {style: STYLES.chip}, `gen ${codebase.indexGeneration}`),
        m('span', {style: STYLES.chip}, `ingest ${formatDate(codebase.lastIngestAt)}`),
        codebase.vendor ? m('span', {style: STYLES.chip}, codebase.vendor) : null,
        codebase.buildId ? m('span', {style: STYLES.chip}, codebase.buildId) : null,
        codebase.eligibleForSendToProvider
          ? m('span', {style: STYLES.chip}, 'provider consent')
          : m('span', {style: STYLES.chip}, 'metadata only'),
      ]),
      codebase.lastIngestError
        ? m('div', {style: STYLES.error}, codebase.lastIngestError)
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
          isExpanded ? 'Hide audit' : 'Audit',
        ),
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            disabled: isReindexing,
            onclick: () => this.reindex(codebase),
          },
          isReindexing ? 'Reindexing...' : 'Reindex',
        ),
      ]),
      isExpanded
        ? m(CodebaseAuditView, {
            backendUrl: this.backendUrl,
            apiKey: this.apiKey,
            codebase,
          })
        : null,
    ]);
  }

  view(_vnode: m.Vnode<CodebasePanelAttrs>): m.Children {
    if (this.viewMode === 'add') {
      return m('div', {style: STYLES.shell}, [
        m('div', {style: STYLES.header}, [
          m('div', [
            m('h4', {style: STYLES.title}, 'Register codebase'),
            m('div', {style: STYLES.subtitle}, 'Preview runs before registration on the backend.'),
          ]),
        ]),
        m(CodebaseForm, {
          backendUrl: this.backendUrl,
          apiKey: this.apiKey,
          onRegistered: (codebase) => {
            this.success = `Registered ${codebase.displayName}`;
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
          m('h4', {style: STYLES.title}, 'Codebases'),
          m(
            'div',
            {style: STYLES.subtitle},
            this.featureEnabled
              ? 'Registered source trees available to code-aware analysis.'
              : 'Code-aware analysis is disabled on the backend.',
          ),
        ]),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.primary},
            onclick: () => {
              this.viewMode = 'add';
            },
          },
          'Add',
        ),
      ]),
      this.error ? m('div', {style: STYLES.error}, this.error) : null,
      this.success ? m('div', {style: STYLES.success}, this.success) : null,
      this.loading
        ? m('div', {style: STYLES.empty}, 'Loading codebases...')
        : this.codebases.length === 0
          ? m('div', {style: STYLES.empty}, 'No codebases registered.')
          : m('div', {style: STYLES.list}, this.codebases.map((codebase) =>
              this.renderCodebase(codebase)
            )),
    ]);
  }
}
