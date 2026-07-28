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
import {Icon} from '../../widgets/icon';

import type {
  CodebaseDirectoryPickerCapability,
  CodebaseKind,
  CodebasePreview,
  CodebaseSummary,
  RegisterCodebaseInput,
} from './codebase_api';
import {
  getCodebaseDirectoryPickerCapability,
  previewCodebaseRoot,
  registerCodebase,
  selectCodebaseDirectory,
} from './codebase_api';
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
  intro: {
    marginBottom: '16px',
    color: 'var(--chat-text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
    textWrap: 'pretty',
  },
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
  requirement: {
    marginLeft: '5px',
    fontSize: '11px',
    fontWeight: 500,
    color: 'var(--chat-text-secondary)',
  },
  input: {
    width: '100%',
    minHeight: '40px',
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
    lineHeight: 1.45,
    textWrap: 'pretty',
  },
  selectedHint: {
    color: 'var(--chat-success, #2e7d32)',
  },
  row: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '10px',
  },
  pathRow: {
    display: 'flex',
    alignItems: 'stretch',
    gap: '8px',
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: '8px',
    marginTop: '16px',
  },
  button: {
    minHeight: '40px',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '9px 12px',
    cursor: 'pointer',
    fontSize: '13px',
    fontFamily: 'inherit',
  },
  chooseButton: {
    flex: '0 0 auto',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    whiteSpace: 'nowrap',
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
    textWrap: 'pretty',
  },
  preview: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    padding: '10px',
    fontSize: '12px',
    background: 'var(--chat-bg-secondary)',
    marginTop: '8px',
    fontVariantNumeric: 'tabular-nums',
  },
  advanced: {
    borderTop: '1px solid var(--chat-border)',
    borderBottom: '1px solid var(--chat-border)',
    margin: '4px 0 14px',
    padding: '2px 0',
  },
  advancedSummary: {
    minHeight: '40px',
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer',
    color: 'var(--chat-text)',
    fontSize: '12px',
    fontWeight: 600,
  },
  advancedBody: {
    paddingTop: '10px',
  },
  consent: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    minHeight: '40px',
    color: 'var(--chat-text)',
    fontSize: '12px',
    lineHeight: 1.45,
    cursor: 'pointer',
  },
} as const;

export interface CodebaseFieldRequirements {
  vendor: boolean;
  licenseTag: boolean;
  pathFilters: boolean;
}

export function codebaseFieldRequirements(
  kind: CodebaseKind,
): CodebaseFieldRequirements {
  return {
    vendor: kind === 'kernel_source' || kind === 'oem_sdk',
    licenseTag: kind === 'aosp' || kind === 'oem_sdk',
    pathFilters: kind === 'kernel_source',
  };
}

function kindLabel(kind: CodebaseKind): string {
  switch (kind) {
    case 'app_source':
      return text('应用源码', 'App source');
    case 'aosp':
      return text('AOSP 源码', 'AOSP source');
    case 'kernel_source':
      return text('内核源码', 'Kernel source');
    case 'oem_sdk':
      return text('OEM SDK', 'OEM SDK');
  }
}

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

function pickerUnavailableHint(
  capability: CodebaseDirectoryPickerCapability,
): string {
  switch (capability.reason) {
    case 'unsupported_distribution':
      return text(
        '当前 Docker/部署模式无法打开宿主机文件夹选择器，请输入后端容器可访问且已加入 allowlist 的路径。',
        'This Docker/deployment mode cannot open a host folder picker. Enter a backend-accessible allowlisted path.',
      );
    case 'enterprise_mode':
      return text(
        '共享部署不允许后端弹出本机选择器，请输入管理员已授权的后端路径。',
        'Shared deployments do not open a local system picker. Enter a backend path authorized by an administrator.',
      );
    case 'non_loopback_bind':
    case 'remote_request':
      return text(
        '系统文件夹选择仅对本机 SmartPerfetto 开放；远程后端请填写后端可访问路径。',
        'System folder selection is available only for local SmartPerfetto. Enter a path accessible to the remote backend.',
      );
    case 'no_graphical_session':
      return text(
        '后端当前没有图形会话，请手动输入已加入 allowlist 的路径。',
        'The backend has no graphical session. Enter an allowlisted path manually.',
      );
    case 'no_supported_dialog':
    default:
      return text(
        '当前平台未找到可用的系统文件夹选择器，请手动输入已加入 allowlist 的路径。',
        'No supported system folder picker is available. Enter an allowlisted path manually.',
      );
  }
}

export class CodebaseForm implements m.ClassComponent<CodebaseFormAttrs> {
  private kind: CodebaseKind = 'app_source';
  private displayName = '';
  private displayNameWasSuggested = false;
  private rootPath = '';
  private directorySelectionId: string | null = null;
  private vendor = '';
  private buildId = '';
  private licenseTag = '';
  private pathFilters = '';
  private excludeGlobs = '';
  private sendToProvider = false;
  private preview: CodebasePreview | null = null;
  private loading = false;
  private choosingDirectory = false;
  private capabilityLoading = false;
  private directoryPickerCapability: CodebaseDirectoryPickerCapability | null = null;
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
    this.choosingDirectory = false;
    this.capabilityLoading = false;
  }

  private syncAttrs(attrs: CodebaseFormAttrs) {
    if (
      attrs.backendUrl !== this.backendUrl ||
      attrs.apiKey !== this.apiKey ||
      attrs.scopeKey !== this.scopeKey
    ) {
      this.requestEpoch += 1;
      this.loading = false;
      this.choosingDirectory = false;
      this.preview = null;
      this.error = null;
      this.directoryPickerCapability = null;
      if (this.directorySelectionId) {
        this.rootPath = '';
        this.directorySelectionId = null;
        if (this.displayNameWasSuggested) {
          this.displayName = '';
          this.displayNameWasSuggested = false;
        }
      }
      this.backendUrl = attrs.backendUrl;
      this.apiKey = attrs.apiKey;
      this.scopeKey = attrs.scopeKey;
      void this.loadDirectoryPickerCapability(attrs);
    } else {
      this.backendUrl = attrs.backendUrl;
      this.apiKey = attrs.apiKey;
      this.scopeKey = attrs.scopeKey;
    }
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

  private async loadDirectoryPickerCapability(attrs: CodebaseFormAttrs) {
    const epoch = this.requestEpoch;
    const backendUrl = attrs.backendUrl;
    const apiKey = attrs.apiKey;
    const scopeKey = attrs.scopeKey;
    this.capabilityLoading = true;
    try {
      const capability = await getCodebaseDirectoryPickerCapability(
        backendUrl,
        apiKey,
      );
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.directoryPickerCapability = capability;
    } catch {
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.directoryPickerCapability = {
        available: false,
        platform: 'unknown',
        reason: 'no_supported_dialog',
      };
    } finally {
      if (this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) {
        this.capabilityLoading = false;
        m.redraw();
      }
    }
  }

  private async chooseDirectory(attrs: CodebaseFormAttrs) {
    const epoch = ++this.requestEpoch;
    const backendUrl = attrs.backendUrl;
    const apiKey = attrs.apiKey;
    const scopeKey = attrs.scopeKey;
    this.choosingDirectory = true;
    this.error = null;
    m.redraw();
    try {
      const result = await selectCodebaseDirectory(backendUrl, apiKey);
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      if (!result.selected) return;
      this.rootPath = result.rootPath;
      this.directorySelectionId = result.directorySelectionId;
      this.preview = null;
      if (!this.displayName.trim() || this.displayNameWasSuggested) {
        this.displayName = result.displayNameSuggestion;
        this.displayNameWasSuggested = true;
      }
    } catch (e: unknown) {
      if (!this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) return;
      this.error = e instanceof Error
        ? e.message
        : text('无法打开系统文件夹选择器', 'Unable to open the system folder picker');
    } finally {
      if (this.requestIsCurrent(epoch, backendUrl, apiKey, scopeKey)) {
        this.choosingDirectory = false;
        m.redraw();
      }
    }
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
        this.directorySelectionId ?? undefined,
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
    const requirements = codebaseFieldRequirements(this.kind);
    const input: RegisterCodebaseInput = {
      kind: this.kind,
      rootPath: this.rootPath.trim(),
      sendToProvider: this.sendToProvider,
      ...(this.directorySelectionId
        ? {directorySelectionId: this.directorySelectionId}
        : {}),
      ...(optionalString(this.displayName)
        ? {displayName: optionalString(this.displayName)}
        : {}),
      ...(requirements.vendor && optionalString(this.vendor)
        ? {vendor: optionalString(this.vendor)}
        : {}),
      ...(optionalString(this.buildId)
        ? {buildId: optionalString(this.buildId)}
        : {}),
      ...(this.kind !== 'app_source' && optionalString(this.licenseTag)
        ? {licenseTag: optionalString(this.licenseTag)}
        : {}),
      ...(splitLines(this.pathFilters).length > 0
        ? {pathFilters: splitLines(this.pathFilters)}
        : {}),
      ...(splitLines(this.excludeGlobs).length > 0
        ? {excludeGlobs: splitLines(this.excludeGlobs)}
        : {}),
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

  private renderLabel(
    id: string,
    label: string,
    required: boolean,
  ): m.Children {
    return m('label', {for: id, style: STYLES.label}, [
      label,
      m(
        'span',
        {style: STYLES.requirement},
        required ? text('（必填）', '(Required)') : text('（可选）', '(Optional)'),
      ),
    ]);
  }

  private renderField(
    id: string,
    label: string,
    value: string,
    oninput: (value: string) => void,
    attrs: Partial<HTMLInputElement> & {
      hint?: string;
      required?: boolean;
    } = {},
  ): m.Children {
    const hint = attrs.hint;
    const required = attrs.required === true;
    return m('div', {style: STYLES.field}, [
      this.renderLabel(id, label, required),
      m('input[type=text]', {
        id,
        style: STYLES.input,
        value,
        required,
        'aria-required': required ? 'true' : 'false',
        placeholder: attrs.placeholder || '',
        oninput: (e: Event) => oninput((e.target as HTMLInputElement).value),
      }),
      hint ? m('div', {style: STYLES.hint}, hint) : null,
    ]);
  }

  private renderRootPath(attrs: CodebaseFormAttrs): m.Children {
    const capability = this.directoryPickerCapability;
    const pickerAvailable = capability?.available === true;
    const pickerDisabled = this.capabilityLoading ||
      !pickerAvailable ||
      this.loading ||
      this.choosingDirectory;
    let hint: string;
    if (this.directorySelectionId) {
      hint = text(
        '已通过本机系统选择器授权；手动修改路径会清除此授权。',
        'Authorized by the local system picker. Editing the path clears this authorization.',
      );
    } else if (this.capabilityLoading) {
      hint = text('正在检测系统文件夹选择能力…', 'Checking system folder selection…');
    } else if (capability?.available) {
      hint = text(
        '建议使用“选择文件夹”。手动输入仅适用于已配置 allowlist 的后端路径。',
        'Prefer “Choose folder.” Manual entry is for backend paths already covered by the configured allowlist.',
      );
    } else {
      hint = pickerUnavailableHint(capability ?? {
        available: false,
        platform: 'unknown',
        reason: 'no_supported_dialog',
      });
    }
    const hintStyle = this.directorySelectionId
      ? {...STYLES.hint, ...STYLES.selectedHint}
      : STYLES.hint;
    return m('div', {style: STYLES.field}, [
      this.renderLabel(
        'smartperfetto-codebase-root-path',
        text('源码文件夹', 'Source folder'),
        true,
      ),
      m('div', {style: STYLES.pathRow}, [
        m('input[type=text]', {
          id: 'smartperfetto-codebase-root-path',
          style: STYLES.input,
          value: this.rootPath,
          required: true,
          'aria-required': 'true',
          placeholder: text(
            '选择文件夹，或输入后端可访问路径',
            'Choose a folder, or enter a backend-accessible path',
          ),
          oninput: (e: Event) => {
            this.rootPath = (e.target as HTMLInputElement).value;
            this.directorySelectionId = null;
            if (this.displayNameWasSuggested) {
              this.displayName = '';
              this.displayNameWasSuggested = false;
            }
            this.preview = null;
            this.error = null;
          },
        }),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.chooseButton},
            disabled: pickerDisabled,
            'aria-busy': this.choosingDirectory ? 'true' : 'false',
            onclick: () => this.chooseDirectory(attrs),
          },
          this.choosingDirectory
            ? text('选择中…', 'Choosing…')
            : [
                m(Icon, {icon: 'folder_open', style: 'font-size: 16px'}),
                m('span', text('选择文件夹', 'Choose folder')),
              ],
        ),
      ]),
      m('div', {style: hintStyle}, hint),
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

  private renderRequiredMetadata(
    requirements: CodebaseFieldRequirements,
  ): m.Children {
    if (!requirements.vendor && !requirements.licenseTag) return null;
    return m('div', {style: STYLES.row}, [
      requirements.vendor
        ? this.renderField(
            'smartperfetto-codebase-vendor',
            text('厂商', 'Vendor'),
            this.vendor,
            (value) => {
              this.vendor = value;
            },
            {
              required: true,
              placeholder: text('例如 qualcomm、samsung', 'For example: qualcomm, samsung'),
              hint: text(
                '用于内核/OEM 符号与源码匹配。',
                'Used to match kernel/OEM symbols and source.',
              ),
            },
          )
        : null,
      requirements.licenseTag
        ? this.renderField(
            'smartperfetto-codebase-license',
            text('许可证标记', 'License tag'),
            this.licenseTag,
            (value) => {
              this.licenseTag = value;
            },
            {
              required: true,
              placeholder: text('例如 Apache-2.0', 'For example: Apache-2.0'),
              hint: text(
                '填写该源码库实际适用的 SPDX 许可证标识。',
                'Enter the SPDX license identifier that actually applies to this source.',
              ),
            },
          )
        : null,
    ]);
  }

  private renderAdvancedSettings(
    requirements: CodebaseFieldRequirements,
  ): m.Children {
    return m('details', {style: STYLES.advanced}, [
      m(
        'summary',
        {style: STYLES.advancedSummary},
        text('高级设置（可选）', 'Advanced settings (optional)'),
      ),
      m('div', {style: STYLES.advancedBody}, [
        this.renderField(
          'smartperfetto-codebase-build-id',
          text('构建 ID', 'Build ID'),
          this.buildId,
          (value) => {
            this.buildId = value;
          },
          {
            hint: text(
              '仅在需要把源码与特定系统/应用构建关联时填写。',
              'Use only when source must be associated with a specific system or app build.',
            ),
          },
        ),
        !requirements.pathFilters
          ? this.renderField(
              'smartperfetto-codebase-path-filters',
              text('索引路径范围', 'Index path scope'),
              this.pathFilters,
              (value) => {
                this.pathFilters = value;
              },
              {
                hint: text(
                  '使用逗号或换行分隔相对路径前缀；留空表示扫描全部受支持源码。',
                  'Comma or newline separated relative path prefixes. Leave empty to scan all supported source files.',
                ),
              },
            )
          : null,
        this.renderField(
          'smartperfetto-codebase-exclude-globs',
          text('额外排除规则', 'Additional exclude globs'),
          this.excludeGlobs,
          (value) => {
            this.excludeGlobs = value;
          },
          {
            hint: text(
              '使用逗号或换行分隔相对 glob；默认已排除 .git、build、node_modules 等目录。',
              'Comma or newline separated relative globs. Common directories such as .git, build, and node_modules are already excluded.',
            ),
          },
        ),
        this.kind === 'kernel_source'
          ? this.renderField(
              'smartperfetto-codebase-license',
              text('许可证标记', 'License tag'),
              this.licenseTag,
              (value) => {
                this.licenseTag = value;
              },
              {
                hint: text(
                  '可选 SPDX 覆盖；留空时从源码文件头识别。',
                  'Optional SPDX override. When omitted, licenses are detected from source headers.',
                ),
              },
            )
          : null,
        m('div', {style: STYLES.hint},
          text(
            '提交版本会在索引时从真实 Git HEAD 自动识别，并同时记录工作区是否有未提交修改，无需手动填写。',
            'The real Git HEAD and dirty-worktree state are detected automatically during indexing; no manual commit field is needed.',
          )),
        m('div', {style: STYLES.hint},
          text(
            '原生符号产物导入尚未配置；当前符号查询来自已索引源码文本中提取的符号。',
            'Native symbol artifact ingestion is not configured. Symbol lookup currently uses symbols derived from indexed source text.',
          )),
      ]),
    ]);
  }

  view(vnode: m.Vnode<CodebaseFormAttrs>): m.Children {
    this.syncAttrs(vnode.attrs);
    const requirements = codebaseFieldRequirements(this.kind);
    const registrationReady = this.rootPath.trim().length > 0 &&
      (!requirements.vendor || this.vendor.trim().length > 0) &&
      (!requirements.licenseTag || this.licenseTag.trim().length > 0) &&
      (!requirements.pathFilters || splitLines(this.pathFilters).length > 0);
    return m('div', [
      m(
        'div',
        {style: STYLES.intro},
        text(
          '先选择源码类型和文件夹。只有当前类型确实需要的元数据才会显示为必填。',
          'Choose the source type and folder first. Only metadata required by that source type is marked as required.',
        ),
      ),
      m('div', {style: STYLES.row}, [
        m('div', {style: STYLES.field}, [
          this.renderLabel(
            'smartperfetto-codebase-kind',
            text('源码类型', 'Source type'),
            true,
          ),
          m(
            'select',
            {
              id: 'smartperfetto-codebase-kind',
              style: STYLES.input,
              value: this.kind,
              required: true,
              'aria-required': 'true',
              onchange: (e: Event) => {
                this.kind = (e.target as HTMLSelectElement).value as CodebaseKind;
                this.error = null;
              },
            },
            CODEBASE_KINDS.map((kind) => m(
              'option',
              {value: kind},
              kindLabel(kind),
            )),
          ),
        ]),
        this.renderField(
          'smartperfetto-codebase-display-name',
          text('显示名称', 'Display name'),
          this.displayName,
          (value) => {
            this.displayName = value;
            this.displayNameWasSuggested = false;
          },
          {
            placeholder: text('默认使用文件夹名称', 'Defaults to the folder name'),
            hint: text(
              '只影响界面显示，不参与源码身份判断。',
              'Affects display only; it is not part of source identity.',
            ),
          },
        ),
      ]),
      this.renderRootPath(vnode.attrs),
      this.renderRequiredMetadata(requirements),
      requirements.pathFilters
        ? this.renderField(
            'smartperfetto-codebase-path-filters',
            text('索引路径范围', 'Index path scope'),
            this.pathFilters,
            (value) => {
              this.pathFilters = value;
            },
            {
              required: true,
              placeholder: text('例如 kernel/, drivers/', 'For example: kernel/, drivers/'),
              hint: text(
                '内核源码必须限定相对路径前缀，使用逗号或换行分隔。',
                'Kernel source requires relative path prefixes, separated by commas or new lines.',
              ),
            },
          )
        : null,
      this.renderAdvancedSettings(requirements),
      m('label', {style: STYLES.consent}, [
        m('input[type=checkbox]', {
          checked: this.sendToProvider,
          onchange: (e: Event) => {
            this.sendToProvider = (e.target as HTMLInputElement).checked;
          },
        }),
        m('span', [
          m('div', text(
            '允许将选中的脱敏源码片段发送给模型提供商（可选，默认关闭）',
            'Allow selected redacted excerpts to be sent to the model provider (optional, off by default)',
          )),
          m('div', {style: STYLES.hint}, text(
            '关闭时仍可建立本地索引；每次分析还需要再次显式选择允许发送的模式。',
            'Local indexing still works when off. Each analysis must separately opt into provider-send mode.',
          )),
        ]),
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
            disabled: this.loading || this.choosingDirectory,
          },
          text('取消', 'Cancel'),
        ),
        m(
          'button',
          {
            type: 'button',
            style: STYLES.button,
            onclick: () => this.previewRoot(vnode.attrs),
            disabled: this.loading ||
              this.choosingDirectory ||
              !this.rootPath.trim(),
          },
          text('预览', 'Preview'),
        ),
        m(
          'button',
          {
            type: 'button',
            style: {...STYLES.button, ...STYLES.primary},
            onclick: () => this.register(vnode.attrs),
            disabled: this.loading ||
              this.choosingDirectory ||
              !registrationReady,
          },
          text('注册', 'Register'),
        ),
      ]),
    ]);
  }
}
