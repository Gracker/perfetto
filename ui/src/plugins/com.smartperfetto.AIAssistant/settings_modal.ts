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
import type {AISettings, ServerStatus} from './types';
import {ProviderPanel} from './provider_panel';
import {CodebasePanel} from './codebase_panel';
import {providerRuntimeLabel} from './provider_types';
import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';

export interface SettingsModalAttrs {
  settings: AISettings;
  workspaceContext: SmartPerfettoRequestContext;
  onClose: () => void;
  onSave: (settings: AISettings) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onCheckStatus: (backendUrl: string, apiKey: string) => Promise<ServerStatus>;
  initialStatus?: ServerStatus;
}

// Dark-mode-aware color scheme using CSS variables from the plugin's
// --chat-* token layer (defined in styles.scss). Fallback hex values match
// the light-mode defaults so the modal looks correct even outside .ai-panel.
const COLORS = {
  primary: 'var(--chat-primary, #3d5688)',
  primaryHover: 'var(--chat-primary-hover, #2e4470)',
  primaryLight:
    'color-mix(in srgb, var(--chat-primary, #3d5688) 12%, transparent)',
  success: 'var(--chat-success, #10b981)',
  successLight:
    'color-mix(in srgb, var(--chat-success, #10b981) 12%, transparent)',
  warning: 'var(--chat-warning, #f59e0b)',
  warningLight:
    'color-mix(in srgb, var(--chat-warning, #f59e0b) 12%, transparent)',
  error: 'var(--chat-error, #ef4444)',
  errorLight: 'color-mix(in srgb, var(--chat-error, #ef4444) 12%, transparent)',
  info: 'var(--chat-primary, #3b82f6)',
  infoLight:
    'color-mix(in srgb, var(--chat-primary, #3b82f6) 12%, transparent)',
};

// Inline styles for modal
const MODAL_STYLES = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    zIndex: 10000,
    animation: 'fadeIn 0.2s ease-out',
  },
  modal: {
    backgroundColor: 'var(--chat-bg)',
    color: 'var(--chat-text)',
    borderRadius: '12px',
    width: '540px',
    maxWidth: '90vw',
    height: '80vh',
    maxHeight: '90vh',
    overflow: 'hidden' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    boxShadow:
      '0 20px 60px rgba(0, 0, 0, 0.4), 0 0 1px rgba(255, 255, 255, 0.1)',
    border: '1px solid var(--chat-border)',
    animation: 'slideUp 0.3s ease-out',
  },
  header: {
    display: 'flex' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '20px 24px',
    borderBottom: '1px solid var(--chat-border)',
    background: 'var(--chat-bg-secondary)',
  },
  headerLeft: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '12px',
  },
  headerIcon: {
    fontSize: '20px',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--chat-text)',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '22px',
    cursor: 'pointer',
    color: 'var(--chat-text-secondary)',
    padding: '4px',
    width: '32px',
    height: '32px',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: '6px',
    transition: 'all 0.15s ease',
  },
  content: {
    padding: '24px',
    overflowY: 'auto' as const,
    flex: 1,
    animation: 'fadeSlideIn 0.2s ease-out',
  },
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    margin: '0 0 16px 0',
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--chat-text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
  },
  field: {
    marginBottom: '20px',
  },
  fieldLabel: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    marginBottom: '8px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'var(--chat-text)',
  },
  fieldIcon: {
    fontSize: '14px',
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    backgroundColor: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    fontSize: '14px',
    boxSizing: 'border-box' as const,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
  },
  hint: {
    fontSize: '12px',
    color: 'var(--chat-text-secondary)',
    marginTop: '6px',
    lineHeight: '1.4',
  },
  alertBox: {
    display: 'flex' as const,
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  alertInfo: {
    background: COLORS.infoLight,
    border: `1px solid color-mix(in srgb, var(--chat-primary, #3b82f6) 25%, transparent)`,
    color: COLORS.info,
  },
  alertWarning: {
    background: COLORS.warningLight,
    border: `1px solid color-mix(in srgb, var(--chat-warning, #f59e0b) 25%, transparent)`,
    color: COLORS.warning,
  },
  alertIcon: {
    fontSize: '16px',
    flexShrink: 0,
  },
  statusBtn: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    padding: '10px 18px',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    backgroundColor: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    transition: 'all 0.15s ease',
  },
  statusBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  statusCard: {
    marginTop: '14px',
    padding: '16px',
    borderRadius: '10px',
    border: '1px solid var(--chat-border)',
    backgroundColor: 'var(--chat-bg-secondary)',
  },
  statusRow: {
    display: 'flex' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    gap: '12px',
    padding: '6px 0',
    fontSize: '13px',
  },
  statusLabel: {
    color: 'var(--chat-text-secondary)',
    fontWeight: 500,
    flexShrink: 0,
  },
  statusValue: {
    color: 'var(--chat-text)',
    fontWeight: 600,
    minWidth: 0,
    textAlign: 'right' as const,
    overflowWrap: 'anywhere' as const,
  },
  statusValueMono: {
    fontFamily: 'monospace',
    fontSize: '12px',
    wordBreak: 'break-all' as const,
  },
  debugDetails: {
    marginTop: '12px',
    borderTop: '1px solid var(--chat-border)',
    paddingTop: '10px',
  },
  debugSummary: {
    cursor: 'pointer',
    color: 'var(--chat-text)',
    fontSize: '13px',
    fontWeight: 600,
    userSelect: 'none' as const,
  },
  debugRows: {
    marginTop: '8px',
  },
  statusDot: {
    display: 'inline-block',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    marginRight: '6px',
  },
  statusHeaderRow: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '8px',
  },
  statusHeaderText: {
    fontWeight: 600,
    fontSize: '14px',
  },
  footer: {
    display: 'flex' as const,
    justifyContent: 'flex-end' as const,
    gap: '10px',
    padding: '16px 24px',
    borderTop: '1px solid var(--chat-border)',
    background: 'var(--chat-bg-secondary)',
  },
  btn: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    padding: '10px 20px',
    border: 'none',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    color: 'var(--chat-text-secondary)',
    border: '1px solid var(--chat-border)',
  },
  btnPrimary: {
    backgroundColor: COLORS.primary,
    color: 'white',
  },
};

const TAB_STYLES = {
  tabBar: {
    display: 'flex' as const,
    borderBottom: '1px solid var(--chat-border)',
    background: 'var(--chat-bg-secondary)',
    padding: '0 24px',
  },
  tab: {
    padding: '12px 20px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    color: 'var(--chat-text-secondary)',
    borderBottom: '2px solid transparent',
    transition: 'all 0.15s ease',
    background: 'transparent',
    border: 'none',
    borderBottomWidth: '2px',
    borderBottomStyle: 'solid' as const,
    borderBottomColor: 'transparent',
  },
  tabActive: {
    color: 'var(--chat-primary, #3d5688)',
    borderBottomColor: 'var(--chat-primary, #3d5688)',
  },
};

type SettingsTab = 'connection' | 'providers' | 'codebases';

function formatRuntimeSource(source: ServerStatus['source']): string {
  switch (source) {
    case 'provider':
      return 'Provider Manager';
    case 'snapshot':
      return 'Session snapshot';
    case 'env':
      return 'backend/.env / environment';
    case 'default':
      return 'Default runtime';
    default:
      return 'Unknown';
  }
}

function formatList(values: readonly string[] | undefined): string {
  return values && values.length > 0 ? values.join(', ') : 'None';
}

function formatBoolean(value: boolean | undefined): string {
  if (value === undefined) return 'Unknown';
  return value ? 'Yes' : 'No';
}

export class SettingsModal implements m.ClassComponent<SettingsModalAttrs> {
  private settings!: AISettings;
  private isChecking = false;
  private serverStatus: ServerStatus | null = null;
  private onCheckStatus!: SettingsModalAttrs['onCheckStatus'];
  private currentTab: SettingsTab = 'connection';
  private workspaceId = '';
  private showBackendAuth = false;

  oninit(vnode: m.Vnode<SettingsModalAttrs>) {
    this.settings = {...vnode.attrs.settings};
    this.onCheckStatus = vnode.attrs.onCheckStatus;
    this.serverStatus = vnode.attrs.initialStatus ?? null;
    this.workspaceId = vnode.attrs.workspaceContext.workspaceId;
    this.showBackendAuth =
      !!this.settings.backendApiKey || !!vnode.attrs.initialStatus?.authRequired;
  }

  private async checkStatus() {
    this.isChecking = true;
    this.serverStatus = null;
    m.redraw();

    this.serverStatus = await this.onCheckStatus(
      this.settings.backendUrl,
      this.settings.backendApiKey || '',
    );
    this.isChecking = false;
    m.redraw();
  }

  private renderStatusRow(
    label: string,
    value: m.Children,
    mono = false,
  ): m.Children {
    return m('div', {style: MODAL_STYLES.statusRow}, [
      m('span', {style: MODAL_STYLES.statusLabel}, label),
      m(
        'span',
        {
          style: {
            ...MODAL_STYLES.statusValue,
            ...(mono ? MODAL_STYLES.statusValueMono : {}),
          },
        },
        value,
      ),
    ]);
  }

  private renderEffectiveConfigDebug(status: ServerStatus): m.Children {
    const diagnostics = status.diagnostics || {};
    const providerMode = status.providerMode || diagnostics.providerMode;
    const lightModel = diagnostics.lightModel;
    const protocol = diagnostics.protocol;
    const baseUrl = diagnostics.baseUrl
      || (diagnostics.baseUrlConfigured === false ? 'SDK default / not set' : undefined);
    const outputLanguage = diagnostics.outputLanguage?.displayName
      || diagnostics.outputLanguage?.value;
    const sdkBinary = diagnostics.sdkBinary;
    const sdkBinaryLabel = sdkBinary
      ? [
          sdkBinary.source || 'unknown',
          sdkBinary.fallbackUsed ? 'fallback' : '',
          sdkBinary.chosenPath || sdkBinary.error || '',
        ].filter(Boolean).join(' | ')
      : undefined;

    return m('details', {style: MODAL_STYLES.debugDetails, open: true}, [
      m('summary', {style: MODAL_STYLES.debugSummary}, 'Effective Configuration'),
      m('div', {style: MODAL_STYLES.debugRows}, [
        this.renderStatusRow('Config Source', formatRuntimeSource(status.source)),
        status.credentialSource
          ? this.renderStatusRow('Credential Source', status.credentialSource, true)
          : null,
        status.activeProvider
          ? this.renderStatusRow(
              'Active Provider',
              `${status.activeProvider.name} (${status.activeProvider.type})`,
            )
          : null,
        providerMode
          ? this.renderStatusRow('Provider Mode', providerMode, true)
          : null,
        protocol
          ? this.renderStatusRow('Protocol', protocol, true)
          : null,
        baseUrl
          ? this.renderStatusRow('Base URL', baseUrl, true)
          : null,
        lightModel
          ? this.renderStatusRow('Light Model', lightModel, true)
          : null,
        diagnostics.credentialSources
          ? this.renderStatusRow(
              'Effective Credentials',
              formatList(diagnostics.credentialSources),
              true,
            )
          : null,
        this.renderStatusRow(
          'Env Credentials Present',
          formatList(status.envCredentialSources),
          true,
        ),
        this.renderStatusRow(
          'Provider Overrides Env',
          formatBoolean(status.providerOverridesEnv),
        ),
        outputLanguage
          ? this.renderStatusRow('Output Language', outputLanguage)
          : null,
        sdkBinaryLabel
          ? this.renderStatusRow('Claude SDK Binary', sdkBinaryLabel, true)
          : null,
      ]),
      status.providerOverridesEnv
        ? m(
            'div',
            {
              style: {
                ...MODAL_STYLES.alertBox,
                ...MODAL_STYLES.alertWarning,
                marginTop: '10px',
              },
            },
            [
              m('span', {style: MODAL_STYLES.alertIcon}, '!'),
              m(
                'div',
                `Active provider is overriding backend/.env. Env credentials still present: ${formatList(status.envCredentialSources)}.`,
              ),
            ],
          )
        : null,
      diagnostics.configHint
        ? m(
            'div',
            {style: {...MODAL_STYLES.hint, marginTop: '8px'}},
            diagnostics.configHint,
          )
        : null,
    ]);
  }

  private renderStatusCard(): m.Children {
    const status = this.serverStatus;
    if (!status) return null;

    if (!status.connected) {
      return m('div', {style: MODAL_STYLES.statusCard}, [
        m(
          'div',
          {style: {...MODAL_STYLES.statusHeaderRow, color: COLORS.error}},
          [
            m('span', {
              style: {...MODAL_STYLES.statusDot, backgroundColor: COLORS.error},
            }),
            m(
              'span',
              {style: MODAL_STYLES.statusHeaderText},
              'Connection Failed',
            ),
          ],
        ),
        m(
          'div',
          {style: {...MODAL_STYLES.hint, marginTop: '8px', lineHeight: '1.5'}},
          'Cannot reach backend. Make sure the backend is running and the URL is correct.',
        ),
      ]);
    }

    const runtimeLabel = status.runtime
      ? providerRuntimeLabel(status.runtime)
      : 'Unknown';

    return m('div', {style: MODAL_STYLES.statusCard}, [
      m(
        'div',
        {
          style: {
            ...MODAL_STYLES.statusHeaderRow,
            color: COLORS.success,
            marginBottom: '12px',
          },
        },
        [
          m('span', {
            style: {...MODAL_STYLES.statusDot, backgroundColor: COLORS.success},
          }),
          m('span', {style: MODAL_STYLES.statusHeaderText}, 'Connected'),
        ],
      ),
      m('div', {style: MODAL_STYLES.statusRow}, [
        m('span', {style: MODAL_STYLES.statusLabel}, 'Engine'),
        m('span', {style: MODAL_STYLES.statusValue}, runtimeLabel),
      ]),
      status.version
        ? m('div', {style: MODAL_STYLES.statusRow}, [
            m('span', {style: MODAL_STYLES.statusLabel}, 'Version'),
            m(
              'span',
              {
                style: {
                  ...MODAL_STYLES.statusValue,
                  ...MODAL_STYLES.statusValueMono,
                },
              },
              `v${status.version}`,
            ),
          ])
        : null,
      status.model
        ? m('div', {style: MODAL_STYLES.statusRow}, [
            m('span', {style: MODAL_STYLES.statusLabel}, 'Model'),
            m(
              'span',
              {
                style: {
                  ...MODAL_STYLES.statusValue,
                  fontFamily: 'monospace',
                  fontSize: '12px',
                },
              },
              status.model,
            ),
          ])
        : null,
      m('div', {style: MODAL_STYLES.statusRow}, [
        m('span', {style: MODAL_STYLES.statusLabel}, 'AI Ready'),
        m(
          'span',
          {
            style: {
              ...MODAL_STYLES.statusValue,
              color: status.configured ? COLORS.success : COLORS.error,
            },
          },
          status.configured ? 'Yes' : 'No (API key missing)',
        ),
      ]),
      status.environment
        ? m('div', {style: MODAL_STYLES.statusRow}, [
            m('span', {style: MODAL_STYLES.statusLabel}, 'Environment'),
            m('span', {style: MODAL_STYLES.statusValue}, status.environment),
          ])
        : null,
      this.renderEffectiveConfigDebug(status),
      // Auth warning
      status.authRequired
        ? m(
            'div',
            {
              style: {
                ...MODAL_STYLES.alertBox,
                ...MODAL_STYLES.alertWarning,
                marginTop: '12px',
              },
            },
            [
              m('span', {style: MODAL_STYLES.alertIcon}, '!'),
              m(
                'div',
                'Backend requires SMARTPERFETTO_API_KEY authentication. Open Advanced backend auth and enter the same value configured on the backend.',
              ),
            ],
          )
        : null,
    ]);
  }

  view(vnode: m.Vnode<SettingsModalAttrs>) {
    return m(
      'div',
      {style: MODAL_STYLES.overlay},
      m('div', {style: MODAL_STYLES.modal}, [
        m('div', {style: MODAL_STYLES.header}, [
          m('div', {style: MODAL_STYLES.headerLeft}, [
            m('span', {style: MODAL_STYLES.headerIcon}, '⚙️'),
            m('h3', {style: MODAL_STYLES.title}, 'AI Assistant Settings'),
          ]),
          m(
            'button',
            {
              style: MODAL_STYLES.closeBtn,
              onclick: () => vnode.attrs.onClose(),
            },
            '×',
          ),
        ]),

        m('div', {style: TAB_STYLES.tabBar}, [
          m(
            'button',
            {
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'connection'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'connection';
              },
            },
            '\u{1F50C} Connection',
          ),
          m(
            'button',
            {
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'providers'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'providers';
              },
            },
            '\u{1F916} Providers',
          ),
          m(
            'button',
            {
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'codebases'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'codebases';
              },
            },
            'Codebases',
          ),
        ]),

        this.currentTab === 'providers'
          ? m('div', {style: {...MODAL_STYLES.content, padding: 0}}, [
              m(ProviderPanel, {
                backendUrl: this.settings.backendUrl,
                apiKey: this.settings.backendApiKey || undefined,
                onClose: () => vnode.attrs.onClose(),
              }),
            ])
          : this.currentTab === 'codebases'
            ? m('div', {style: {...MODAL_STYLES.content, padding: 0}}, [
                m(CodebasePanel, {
                  backendUrl: this.settings.backendUrl,
                  apiKey: this.settings.backendApiKey || undefined,
                }),
              ])
          : m('div', {style: MODAL_STYLES.content}, [
              m('div', {style: MODAL_STYLES.section}, [
                m(
                  'h4',
                  {style: MODAL_STYLES.sectionTitle},
                  'Backend Connection',
                ),
                m('div', {style: MODAL_STYLES.field}, [
                  m('label', {style: MODAL_STYLES.fieldLabel}, [
                    m('span', {style: MODAL_STYLES.fieldIcon}, '🏢'),
                    'Workspace ID',
                  ]),
                  m('input[type=text]', {
                    style: MODAL_STYLES.input,
                    value: this.workspaceId,
                    onchange: (e: Event) => {
                      this.workspaceId = (e.target as HTMLInputElement).value;
                    },
                    placeholder: vnode.attrs.workspaceContext.workspaceId,
                  }),
                  m(
                    'div',
                    {style: MODAL_STYLES.hint},
                    `Tenant: ${vnode.attrs.workspaceContext.tenantId} · User: ${vnode.attrs.workspaceContext.userId} · Window: ${vnode.attrs.workspaceContext.windowId}`,
                  ),
                ]),
                m('div', {style: MODAL_STYLES.field}, [
                  m('label', {style: MODAL_STYLES.fieldLabel}, [
                    m('span', {style: MODAL_STYLES.fieldIcon}, '🖥️'),
                    'Backend URL',
                  ]),
                  m('input[type=text]', {
                    style: MODAL_STYLES.input,
                    value: this.settings.backendUrl,
                    onchange: (e: Event) => {
                      this.settings.backendUrl = (
                        e.target as HTMLInputElement
                      ).value;
                    },
                    placeholder: getDefaultSmartPerfettoBackendUrl(),
                  }),
                ]),
                m('div', {style: MODAL_STYLES.field}, [
                  m(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...MODAL_STYLES.btn,
                        ...MODAL_STYLES.btnSecondary,
                        width: '100%',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                      },
                      onclick: () => {
                        this.showBackendAuth = !this.showBackendAuth;
                      },
                    },
                    [
                      m('span', 'Advanced backend auth'),
                      m('span', this.showBackendAuth ? '▲' : '▼'),
                    ],
                  ),
                  m(
                    'div',
                    {style: {...MODAL_STYLES.hint, marginTop: '6px'}},
                    'Leave this empty for local single-user runs. Only fill it when the backend was started with SMARTPERFETTO_API_KEY.',
                  ),
                ]),
                this.showBackendAuth
                  ? m('div', {style: MODAL_STYLES.field}, [
                      m('label', {style: MODAL_STYLES.fieldLabel}, [
                        m('span', {style: MODAL_STYLES.fieldIcon}, '🔐'),
                        'Backend Access Token',
                      ]),
                      m('input[type=password]', {
                        style: MODAL_STYLES.input,
                        value: this.settings.backendApiKey || '',
                        onchange: (e: Event) => {
                          this.settings.backendApiKey = (
                            e.target as HTMLInputElement
                          ).value;
                        },
                        placeholder: 'Optional SMARTPERFETTO_API_KEY',
                      }),
                      m(
                        'div',
                        {style: MODAL_STYLES.hint},
                        'This protects SmartPerfetto backend APIs. It is not a model provider key; model provider keys belong on the Providers tab.',
                      ),
                    ])
                  : null,
              ]),

              m('div', {style: MODAL_STYLES.section}, [
                m('h4', {style: MODAL_STYLES.sectionTitle}, 'Server Status'),
                m(
                  'div',
                  {style: {display: 'flex', alignItems: 'center', gap: '12px'}},
                  [
                    m(
                      'button',
                      {
                        style: {
                          ...MODAL_STYLES.statusBtn,
                          ...(this.isChecking
                            ? MODAL_STYLES.statusBtnDisabled
                            : {}),
                        },
                        onclick: () => this.checkStatus(),
                        disabled: this.isChecking,
                      },
                      this.isChecking ? '⏳ Checking...' : '🔌 Check Status',
                    ),
                  ],
                ),
                this.renderStatusCard(),
              ]),

              m(
                'div',
                {style: {...MODAL_STYLES.alertBox, ...MODAL_STYLES.alertInfo}},
                [
                  m('span', {style: MODAL_STYLES.alertIcon}, 'ℹ️'),
                  m('div', [
                    m('span', 'Use the '),
                    m('strong', 'Providers'),
                    m(
                      'span',
                      ' tab to add, test, activate, and switch AI provider profiles. Saving a provider is not enough; the active profile is what overrides backend/.env.',
                    ),
                  ]),
                ],
              ),
            ]),

        this.currentTab === 'connection'
          ? m('div', {style: MODAL_STYLES.footer}, [
              m(
                'button',
                {
                  style: {...MODAL_STYLES.btn, ...MODAL_STYLES.btnSecondary},
                  onclick: () => vnode.attrs.onClose(),
                },
                'Cancel',
              ),
              m(
                'button',
                {
                  style: {...MODAL_STYLES.btn, ...MODAL_STYLES.btnPrimary},
                  onclick: () => {
                    vnode.attrs.onWorkspaceChange(this.workspaceId);
                    vnode.attrs.onSave(this.settings);
                  },
                },
                '\u{1F4BE} Save Settings',
              ),
            ])
          : null,
      ]),
    );
  }
}
