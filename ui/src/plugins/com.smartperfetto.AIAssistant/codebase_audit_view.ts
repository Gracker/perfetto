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

export interface CodebaseAuditViewAttrs {
  backendUrl: string;
  apiKey?: string;
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

export class CodebaseAuditView implements m.ClassComponent<CodebaseAuditViewAttrs> {
  private audit: CodebaseAudit | null = null;
  private loading = true;
  private error: string | null = null;

  oninit(vnode: m.Vnode<CodebaseAuditViewAttrs>) {
    this.load(vnode.attrs);
  }

  onupdate(vnode: m.Vnode<CodebaseAuditViewAttrs>) {
    if (this.audit?.codebaseId !== vnode.attrs.codebase.codebaseId) {
      this.load(vnode.attrs);
    }
  }

  private async load(attrs: CodebaseAuditViewAttrs) {
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      this.audit = await loadCodebaseAudit(
        attrs.backendUrl,
        attrs.codebase.codebaseId,
        attrs.apiKey,
      );
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Failed to load audit';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private renderRow(label: string, value: unknown): m.Children {
    return m('div', {style: STYLES.row}, [
      m('span', {style: STYLES.label}, label),
      m('span', {style: STYLES.value}, formatAuditValue(value)),
    ]);
  }

  view(vnode: m.Vnode<CodebaseAuditViewAttrs>): m.Children {
    if (this.loading) {
      return m('div', {style: STYLES.shell}, 'Loading audit...');
    }
    if (this.error) {
      return m('div', {style: {...STYLES.shell, ...STYLES.error}}, this.error);
    }
    const audit = this.audit;
    return m('div', {style: STYLES.shell}, [
      this.renderRow('Codebase', vnode.attrs.codebase.displayName),
      this.renderRow('ID', vnode.attrs.codebase.codebaseId),
      this.renderRow('Kind', audit?.kind || vnode.attrs.codebase.kind),
      this.renderRow('Index generation', audit?.indexGeneration),
      this.renderRow('Chunks', audit?.chunkCount),
      this.renderRow('Blocked files', audit?.blockedFileCount),
      this.renderRow('Redaction hits', audit?.redactionHitCount),
      this.renderRow('Last ingest status', audit?.lastIngestStatus),
      this.renderRow('Last ingest at', audit?.lastIngestAt),
      audit?.lastIngestError
        ? this.renderRow('Last error', audit.lastIngestError)
        : null,
    ]);
  }
}
