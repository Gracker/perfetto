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

export interface CodebaseFormAttrs {
  backendUrl: string;
  apiKey?: string;
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
  private symbolMapPaths = '';
  private sendToProvider = false;
  private preview: CodebasePreview | null = null;
  private loading = false;
  private error: string | null = null;

  private async previewRoot(attrs: CodebaseFormAttrs) {
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      this.preview = await previewCodebaseRoot(
        attrs.backendUrl,
        this.rootPath,
        attrs.apiKey,
      );
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Preview failed';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async register(attrs: CodebaseFormAttrs) {
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
      ...(splitLines(this.symbolMapPaths).length > 0 ? {symbolMapPaths: splitLines(this.symbolMapPaths)} : {}),
    };
    try {
      const result = await registerCodebase(attrs.backendUrl, input, attrs.apiKey);
      attrs.onRegistered(result.codebase);
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Registration failed';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private renderField(
    label: string,
    value: string,
    oninput: (value: string) => void,
    attrs?: Partial<HTMLInputElement> & {hint?: string},
  ): m.Children {
    const hint = attrs?.hint;
    return m('div', {style: STYLES.field}, [
      m('label', {style: STYLES.label}, label),
      m('input[type=text]', {
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
      m('div', `Accepted files: ${this.preview.acceptedFileCount}`),
      m('div', `Skipped files: ${this.preview.skippedFileCount}`),
      this.preview.blocked
        ? m('div', {style: STYLES.error}, this.preview.blockedReason || 'Blocked')
        : null,
    ]);
  }

  view(vnode: m.Vnode<CodebaseFormAttrs>): m.Children {
    return m('div', [
      m('div', {style: STYLES.row}, [
        m('div', {style: STYLES.field}, [
          m('label', {style: STYLES.label}, 'Kind'),
          m(
            'select',
            {
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
          'Display name',
          this.displayName,
          (value) => {
            this.displayName = value;
          },
          {placeholder: 'MyApp source'},
        ),
      ]),
      this.renderField(
        'Root path',
        this.rootPath,
        (value) => {
          this.rootPath = value;
        },
        {placeholder: '/Users/me/MyApp'},
      ),
      m('div', {style: STYLES.row}, [
        this.renderField('Vendor', this.vendor, (value) => {
          this.vendor = value;
        }),
        this.renderField('Build ID', this.buildId, (value) => {
          this.buildId = value;
        }),
      ]),
      m('div', {style: STYLES.row}, [
        this.renderField('Commit', this.commitHash, (value) => {
          this.commitHash = value;
        }),
        this.renderField('License tag', this.licenseTag, (value) => {
          this.licenseTag = value;
        }),
      ]),
      this.renderField(
        'Path filters',
        this.pathFilters,
        (value) => {
          this.pathFilters = value;
        },
        {hint: 'Comma or newline separated relative prefixes.'},
      ),
      this.renderField('Exclude globs', this.excludeGlobs, (value) => {
        this.excludeGlobs = value;
      }),
      this.renderField('Symbol maps', this.symbolMapPaths, (value) => {
        this.symbolMapPaths = value;
      }),
      m('label', {style: {...STYLES.label, display: 'flex', gap: '8px'}}, [
        m('input[type=checkbox]', {
          checked: this.sendToProvider,
          onchange: (e: Event) => {
            this.sendToProvider = (e.target as HTMLInputElement).checked;
          },
        }),
        'Allow selected excerpts to be sent to the configured model provider',
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
          'Cancel',
        ),
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onclick: () => this.previewRoot(vnode.attrs),
            disabled: this.loading || !this.rootPath.trim(),
          },
          'Preview',
        ),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.primary},
            onclick: () => this.register(vnode.attrs),
            disabled: this.loading || !this.rootPath.trim() || !this.displayName.trim(),
          },
          'Register',
        ),
      ]),
    ]);
  }
}
