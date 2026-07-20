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
  CodebaseKind,
  CodebasePreview,
  CodebaseSummary,
  RegisterCodebaseInput,
} from './codebase_api';
import {previewCodebaseRoot, registerCodebase} from './codebase_api';
import {uiText as text} from './ui_language';

export interface CodebaseFormAttrs {
  backendUrl: string;
  apiKey?: string;
  scopeKey: string;
  onRegistered: (codebase: CodebaseSummary) => void;
  onCancel: () => void;
}

const CODEBASE_KINDS: CodebaseKind[] = [
  'app_source',
  'aosp',
  'kernel_source',
  'oem_sdk',
];

const STYLES = {
  field: {
    marginBottom: '14px',
  },
  label: {
    display: 'block',
    marginBottom: '6px',
    fontSize: '12px',
    color: 'var(--chat-text-secondary)',
    fontWeight: 600,
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '9px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
  },
  hint: {
    marginTop: '5px',
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
    lineHeight: 1.4,
  },
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    marginTop: '14px',
  },
  button: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '9px 12px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  primary: {
    background: 'var(--chat-primary)',
    color: 'white',
    borderColor: 'var(--chat-primary)',
  },
  error: {
    color: 'var(--chat-error)',
    fontSize: '12px',
    marginTop: '8px',
  },
  preview: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    padding: '10px',
    fontSize: '12px',
    background: 'var(--chat-bg-secondary)',
    marginTop: '8px',
  },
} as const;

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n|,/g)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export class CodebaseForm implements m.ClassComponent<CodebaseFormAttrs> {
  private kind: CodebaseKind = 'app_source';
  private displayName = '';
  private rootPath = '';
  private commitHash = '';
  private vendor = '';
  private buildId = '';
  private licenseTag = '';
  private pathFilters = '';
  private excludeGlobs = '';
  private sendToProvider = false;
  private preview: CodebasePreview | null = null;
  private loading = false;
  private error: string | null = null;
  private requestEpoch = 0;
  private mounted = false;
  private backendUrl = '';
  private apiKey?: string;
  private scopeKey = '';
  private onRegistered: CodebaseFormAttrs['onRegistered'] = () => {};

  oninit(vnode: m.Vnode<CodebaseFormAttrs>) {
    this.mounted = true;
    this.syncAttrs(vnode.attrs);
  }

  onbeforeupdate(vnode: m.Vnode<CodebaseFormAttrs>) {
    this.syncAttrs(vnode.attrs);
    return true;
  }

  onremove() {
    this.mounted = false;
    this.requestEpoch += 1;
    this.loading = false;
  }

  private syncAttrs(attrs: CodebaseFormAttrs) {
    if (
      attrs.backendUrl !== this.backendUrl ||
      attrs.apiKey !== this.apiKey ||
      attrs.scopeKey !== this.scopeKey
    ) {
      this.requestEpoch += 1;
      this.loading = false;
      this.preview = null;
      this.error = null;
    }
    this.backendUrl = attrs.backendUrl;
    this.apiKey = attrs.apiKey;
    this.scopeKey = attrs.scopeKey;
    this.onRegistered = attrs.onRegistered;
  }

  private requestIsCurrent(
    epoch: number,
    backendUrl: string,
    apiKey: string | undefined,
    scopeKey: string,
  ): boolean {
    return this.mounted &&
      epoch === this.requestEpoch &&
      backendUrl === this.backendUrl &&
      apiKey === this.apiKey &&
      scopeKey === this.scopeKey;
  }

  private async previewRoot(attrs: CodebaseFormAttrs) {
    const epoch = ++this.requestEpoch;
    const backendUrl = attrs.backendUrl;
    const apiKey = attrs.apiKey;
    const scopeKey = attrs.scopeKey;
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      const preview = await previewCodebaseRoot(
        backendUrl,
        this.rootPath,
        apiKey,
      );
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.preview = preview;
    } catch (e: unknown) {
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.error = e instanceof Error ? e.message : text('预览失败', 'Preview failed');
    } finally {
      if (this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) {
        this.loading = false;
        m.redraw();
      }
    }
  }

  private async register(attrs: CodebaseFormAttrs) {
    const epoch = ++this.requestEpoch;
    const backendUrl = attrs.backendUrl;
    const apiKey = attrs.apiKey;
    const scopeKey = attrs.scopeKey;
    this.loading = true;
    this.error = null;
    m.redraw();
    const input: RegisterCodebaseInput = {
      kind: this.kind,
      displayName: this.displayName.trim(),
      rootPath: this.rootPath.trim(),
      sendToProvider: this.sendToProvider,
      ...(optionalString(this.commitHash) ? {commitHash: optionalString(this.commitHash)} : {}),
      ...(optionalString(this.vendor) ? {vendor: optionalString(this.vendor)} : {}),
      ...(optionalString(this.buildId) ? {buildId: optionalString(this.buildId)} : {}),
      ...(optionalString(this.licenseTag) ? {licenseTag: optionalString(this.licenseTag)} : {}),
      ...(splitLines(this.pathFilters).length > 0 ? {pathFilters: splitLines(this.pathFilters)} : {}),
      ...(splitLines(this.excludeGlobs).length > 0 ? {excludeGlobs: splitLines(this.excludeGlobs)} : {}),
    };
    try {
      const result = await registerCodebase(backendUrl, input, apiKey);
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.onRegistered(result.codebase);
    } catch (e: unknown) {
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.error = e instanceof Error ? e.message : text('注册失败', 'Registration failed');
    } finally {
      if (this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) {
        this.loading = false;
        m.redraw();
      }
    }
  }

  private renderField(
    id: string,
    label: string,
    value: string,
    oninput: (value: string) => void,
    attrs?: Partial<HTMLInputElement> & {hint?: string},
  ): m.Children {
    const hint = attrs?.hint;
    return m('div', {style: STYLES.field}, [
      m('label', {for: id, style: STYLES.label}, label),
      m('input[type=text]', {
        id,
        style: STYLES.input,
        value,
        placeholder: attrs?.placeholder || '',
        oninput: (e: Event) => oninput((e.target as HTMLInputElement).value),
      }),
      hint ? m('div', {style: STYLES.hint}, hint) : null,
    ]);
  }

  private renderPreview(): m.Children {
    if (!this.preview) return null;
    return m('div', {style: STYLES.preview}, [
      m('div', text(
        `可接受文件：${this.preview.acceptedFileCount}`,
        `Accepted files: ${this.preview.acceptedFileCount}`,
      )),
      m('div', text(
        `已跳过文件：${this.preview.skippedFileCount}`,
        `Skipped files: ${this.preview.skippedFileCount}`,
      )),
      this.preview.blocked
        ? m('div', {style: STYLES.error}, this.preview.blockedReason || text('已阻止', 'Blocked'))
        : null,
    ]);
  }

  view(vnode: m.Vnode<CodebaseFormAttrs>): m.Children {
    this.syncAttrs(vnode.attrs);
    return m('div', [
      m('div', {style: STYLES.row}, [
        m('div', {style: STYLES.field}, [
          m('label', {for: 'smartperfetto-codebase-kind', style: STYLES.label}, text('类型', 'Kind')),
          m(
            'select',
            {
              id: 'smartperfetto-codebase-kind',
              style: STYLES.input,
              value: this.kind,
              onchange: (e: Event) => {
                this.kind = (e.target as HTMLSelectElement).value as CodebaseKind;
              },
            },
            CODEBASE_KINDS.map((kind) => m('option', {value: kind}, kind)),
          ),
        ]),
        this.renderField(
          'smartperfetto-codebase-display-name',
          text('显示名称', 'Display name'),
          this.displayName,
          (value) => {
            this.displayName = value;
          },
          {placeholder: text('MyApp 源码', 'MyApp source')},
        ),
      ]),
      this.renderField(
        'smartperfetto-codebase-root-path',
        text('源码根路径', 'Root path'),
        this.rootPath,
        (value) => {
          this.rootPath = value;
        },
        {placeholder: '/Users/me/MyApp'},
      ),
      m('div', {style: STYLES.row}, [
        this.renderField('smartperfetto-codebase-vendor', text('厂商', 'Vendor'), this.vendor, (value) => {
          this.vendor = value;
        }),
        this.renderField('smartperfetto-codebase-build-id', text('构建 ID', 'Build ID'), this.buildId, (value) => {
          this.buildId = value;
        }),
      ]),
      m('div', {style: STYLES.row}, [
        this.renderField('smartperfetto-codebase-commit', text('提交版本', 'Commit'), this.commitHash, (value) => {
          this.commitHash = value;
        }),
        this.renderField('smartperfetto-codebase-license', text('许可证标记', 'License tag'), this.licenseTag, (value) => {
          this.licenseTag = value;
        }),
      ]),
      this.renderField(
        'smartperfetto-codebase-path-filters',
        text('路径过滤', 'Path filters'),
        this.pathFilters,
        (value) => {
          this.pathFilters = value;
        },
        {hint: text('使用逗号或换行分隔相对路径前缀。', 'Comma or newline separated relative prefixes.')},
      ),
      this.renderField('smartperfetto-codebase-exclude-globs', text('排除规则', 'Exclude globs'), this.excludeGlobs, (value) => {
        this.excludeGlobs = value;
      }),
      m('div', {style: STYLES.hint},
        text(
          '原生符号产物导入尚未配置；当前符号查询来自已索引源码文本中提取的符号。',
          'Native symbol artifact ingestion is not configured. Symbol lookup currently uses symbols derived from the indexed source text.',
        )),
      m('label', {style: {...STYLES.label, display: 'flex', gap: '8px'}}, [
        m('input[type=checkbox]', {
          checked: this.sendToProvider,
          onchange: (e: Event) => {
            this.sendToProvider = (e.target as HTMLInputElement).checked;
          },
        }),
        text(
          '允许将选中的脱敏源码片段发送给已配置的模型提供商',
          'Allow selected redacted excerpts to be sent to the configured model provider',
        ),
      ]),
      this.renderPreview(),
      this.error ? m('div', {style: STYLES.error}, this.error) : null,
      m('div', {style: STYLES.actions}, [
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onclick: () => vnode.attrs.onCancel(),
            disabled: this.loading,
          },
          text('取消', 'Cancel'),
        ),
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onclick: () => this.previewRoot(vnode.attrs),
            disabled: this.loading || !this.rootPath.trim(),
          },
          text('预览', 'Preview'),
        ),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.primary},
            onclick: () => this.register(vnode.attrs),
            disabled: this.loading || !this.rootPath.trim() || !this.displayName.trim(),
          },
          text('注册', 'Register'),
        ),
      ]),
    ]);
  }
}
