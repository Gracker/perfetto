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
  AISettings,
  AnalysisContextSelection,
  ServerStatus,
} from './types';
import {ProviderPanel} from './provider_panel';
import {CodebasePanel} from './codebase_panel';
import {providerRuntimeLabel} from './provider_types';
import type {SmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {analysisContextScopeKey} from './analysis_context';
import {uiText} from './ui_language';

export interface SettingsModalAttrs {
  settings: AISettings;
  analysisContext?: AnalysisContextSelection;
  workspaceContext: SmartPerfettoRequestContext;
  readOnly?: boolean;
  onClose: () => void;
  onSave: (settings: AISettings) => void;
  onWorkspaceChange: (workspaceId: string) => void;
  onCheckStatus: (backendUrl: string, apiKey: string) => Promise<ServerStatus>;
  onProviderSelectionChange: () => void;
  onAnalysisContextChange?: (selection: AnalysisContextSelection) => void;
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

export function settingsBackendBindingChanged(
  committed: AISettings,
  draft: AISettings,
): boolean {
  return committed.backendUrl.replace(/\/+$/, '') !== draft.backendUrl.replace(/\/+$/, '') ||
    committed.backendApiKey !== draft.backendApiKey;
}

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
  private dialogElement?: HTMLElement;
  private previouslyFocusedElement?: HTMLElement;

  oninit(vnode: m.Vnode<SettingsModalAttrs>) {
    this.settings = {...vnode.attrs.settings};
    this.onCheckStatus = vnode.attrs.onCheckStatus;
    this.serverStatus = vnode.attrs.initialStatus ?? null;
    this.workspaceId = vnode.attrs.workspaceContext.workspaceId;
    this.showBackendAuth =
      !!this.settings.backendApiKey ||
      !!vnode.attrs.initialStatus?.authRequired;
  }

  onupdate(vnode: m.Vnode<SettingsModalAttrs>) {
    if (vnode.attrs.readOnly && this.currentTab === 'providers') {
      this.currentTab = 'connection';
    }
  }

  oncreate(vnode: m.VnodeDOM<SettingsModalAttrs>) {
    this.previouslyFocusedElement = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : undefined;
    this.dialogElement = vnode.dom.querySelector<HTMLElement>('[role="dialog"]') ?? undefined;
    this.dialogElement
      ?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex="0"]')
      ?.focus();
  }

  onremove() {
    this.previouslyFocusedElement?.focus();
    this.dialogElement = undefined;
    this.previouslyFocusedElement = undefined;
  }

  private handleDialogKeyDown(event: KeyboardEvent, onClose: () => void): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !this.dialogElement) return;
    const focusable = Array.from(this.dialogElement.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    if (focusable.length === 0) {
      event.preventDefault();
      this.dialogElement.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private handleTabKeyDown(
    event: KeyboardEvent,
    providersDisabled: boolean,
  ): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs: SettingsTab[] = providersDisabled
      ? ['connection', 'codebases']
      : ['connection', 'providers', 'codebases'];
    const currentIndex = Math.max(0, tabs.indexOf(this.currentTab));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    this.currentTab = tabs[nextIndex];
    setTimeout(() => document.getElementById(`smartperfetto-settings-tab-${this.currentTab}`)?.focus(), 0);
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
    const baseUrl =
      diagnostics.baseUrl ||
      (diagnostics.baseUrlConfigured === false
        ? 'SDK default / not set'
        : undefined);
    const outputLanguage =
      diagnostics.outputLanguage?.displayName ||
      diagnostics.outputLanguage?.value;
    const sdkBinary = diagnostics.sdkBinary;
    const sdkBinaryLabel = sdkBinary
      ? [
          sdkBinary.source || 'unknown',
          sdkBinary.fallbackUsed ? 'fallback' : '',
          sdkBinary.chosenPath || sdkBinary.error || '',
        ]
          .filter(Boolean)
          .join(' | ')
      : undefined;

    return m('details', {style: MODAL_STYLES.debugDetails, open: true}, [
      m(
        'summary',
        {style: MODAL_STYLES.debugSummary},
        'Effective Configuration',
      ),
      m('div', {style: MODAL_STYLES.debugRows}, [
        this.renderStatusRow(
          'Config Source',
          formatRuntimeSource(status.source),
        ),
        status.credentialSource
          ? this.renderStatusRow(
              'Credential Source',
              status.credentialSource,
              true,
            )
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
        protocol ? this.renderStatusRow('Protocol', protocol, true) : null,
        baseUrl ? this.renderStatusRow('Base URL', baseUrl, true) : null,
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
        status.aiPolicy
          ? this.renderStatusRow(
              'AI Policy',
              `${status.aiPolicy.aiEnabled ? 'enabled' : 'disabled'} (${status.aiPolicy.source})`,
            )
          : null,
        status.aiPolicy?.env
          ? this.renderStatusRow(
              status.aiPolicy.env.key,
              `${status.aiPolicy.env.valid ? 'valid' : 'invalid'} value`,
              true,
            )
          : null,
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
      m('div', {style: MODAL_STYLES.statusRow}, [
        m('span', {style: MODAL_STYLES.statusLabel}, 'AI Enabled'),
        m(
          'span',
          {
            style: {
              ...MODAL_STYLES.statusValue,
              color:
                status.aiEnabled === false ? COLORS.warning : COLORS.success,
            },
          },
          status.aiEnabled === false ? 'No' : 'Yes',
        ),
      ]),
      status.aiEnabled === false
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
                status.disabledReason ||
                  status.aiPolicy?.disabledReason ||
                  'AI model-backed features are disabled by backend policy.',
              ),
            ],
          )
        : null,
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
    const readOnly = vnode.attrs.readOnly === true;
    const backendBindingDirty = settingsBackendBindingChanged(
      vnode.attrs.settings,
      this.settings,
    );
    return m(
      'div',
      {style: MODAL_STYLES.overlay},
      m('div', {
        style: MODAL_STYLES.modal,
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'smartperfetto-settings-title',
        tabindex: -1,
        onkeydown: (event: KeyboardEvent) => this.handleDialogKeyDown(event, vnode.attrs.onClose),
      }, [
        m('div', {style: MODAL_STYLES.header}, [
          m('div', {style: MODAL_STYLES.headerLeft}, [
            m('span', {style: MODAL_STYLES.headerIcon}, '⚙️'),
            m('h3', {
              id: 'smartperfetto-settings-title',
              style: MODAL_STYLES.title,
            }, uiText('AI 助手设置', 'AI Assistant Settings')),
          ]),
          m(
            'button',
            {
              type: 'button',
              style: MODAL_STYLES.closeBtn,
              onclick: () => vnode.attrs.onClose(),
              title: uiText('关闭设置', 'Close settings'),
              'aria-label': uiText('关闭设置', 'Close settings'),
            },
            '×',
          ),
        ]),

        m('div', {
          style: TAB_STYLES.tabBar,
          role: 'tablist',
          'aria-label': uiText('设置分类', 'Settings sections'),
        }, [
          m(
            'button',
            {
              type: 'button',
              id: 'smartperfetto-settings-tab-connection',
              role: 'tab',
              'aria-selected': this.currentTab === 'connection' ? 'true' : 'false',
              'aria-controls': 'smartperfetto-settings-panel-connection',
              tabindex: this.currentTab === 'connection' ? 0 : -1,
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'connection'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'connection';
              },
              onkeydown: (event: KeyboardEvent) =>
                this.handleTabKeyDown(event, readOnly || backendBindingDirty),
            },
            uiText('\u{1F50C} 连接', '\u{1F50C} Connection'),
          ),
          m(
            'button',
            {
              type: 'button',
              id: 'smartperfetto-settings-tab-providers',
              role: 'tab',
              'aria-selected': this.currentTab === 'providers' ? 'true' : 'false',
              'aria-controls': 'smartperfetto-settings-panel-providers',
              tabindex: this.currentTab === 'providers' ? 0 : -1,
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'providers'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'providers';
              },
              disabled: readOnly || backendBindingDirty,
              title: readOnly
                ? uiText(
                    '分析运行中，Provider 配置保持只读',
                    'Provider settings are read-only while analysis is running',
                  )
                : backendBindingDirty
                  ? uiText(
                      '请先保存连接地址或凭证，再管理 Provider',
                      'Save backend URL or credential changes before managing providers',
                    )
                : undefined,
              onkeydown: (event: KeyboardEvent) =>
                this.handleTabKeyDown(event, readOnly || backendBindingDirty),
            },
            uiText('\u{1F916} 提供商', '\u{1F916} Providers'),
          ),
          m(
            'button',
            {
              type: 'button',
              id: 'smartperfetto-settings-tab-codebases',
              role: 'tab',
              'aria-selected': this.currentTab === 'codebases' ? 'true' : 'false',
              'aria-controls': 'smartperfetto-settings-panel-codebases',
              tabindex: this.currentTab === 'codebases' ? 0 : -1,
              style: {
                ...TAB_STYLES.tab,
                ...(this.currentTab === 'codebases'
                  ? TAB_STYLES.tabActive
                  : {}),
              },
              onclick: () => {
                this.currentTab = 'codebases';
              },
              onkeydown: (event: KeyboardEvent) =>
                this.handleTabKeyDown(event, readOnly || backendBindingDirty),
            },
            uiText('源码库', 'Codebases'),
          ),
        ]),

        this.currentTab === 'providers'
          ? backendBindingDirty
            ? m(
                'div',
                {
                  style: MODAL_STYLES.content,
                  role: 'tabpanel',
                  id: 'smartperfetto-settings-panel-providers',
                  'aria-labelledby': 'smartperfetto-settings-tab-providers',
                },
                m('div', {
                  style: {
                    ...MODAL_STYLES.alertBox,
                    ...MODAL_STYLES.alertWarning,
                  },
                }, uiText(
                  '连接地址或凭证有未保存的修改。请先保存连接设置，再管理 Provider。',
                  'Backend URL or credentials have unsaved changes. Save connection settings before managing providers.',
                )),
              )
            : readOnly
            ? m(
                'div',
                {
                  style: MODAL_STYLES.content,
                  role: 'tabpanel',
                  id: 'smartperfetto-settings-panel-providers',
                  'aria-labelledby': 'smartperfetto-settings-tab-providers',
                },
                m(
                  'div',
                  {
                    style: {
                      ...MODAL_STYLES.alertBox,
                      ...MODAL_STYLES.alertWarning,
                    },
                  },
                  uiText(
                    '分析运行中，Provider 配置与切换保持只读。',
                    'Provider settings and switching are read-only while analysis is running.',
                  ),
                ),
              )
            : m('div', {
                style: {...MODAL_STYLES.content, padding: 0},
                role: 'tabpanel',
                id: 'smartperfetto-settings-panel-providers',
                'aria-labelledby': 'smartperfetto-settings-tab-providers',
              }, [
                m(ProviderPanel, {
                  backendUrl: vnode.attrs.settings.backendUrl,
                  apiKey: vnode.attrs.settings.backendApiKey || undefined,
                  aiEnabled: this.serverStatus?.aiEnabled,
                  aiDisabledReason:
                    this.serverStatus?.disabledReason ||
                    this.serverStatus?.aiPolicy?.disabledReason,
                  onClose: () => vnode.attrs.onClose(),
                  onProviderSelectionChange: () =>
                    vnode.attrs.onProviderSelectionChange(),
                }),
              ])
          : this.currentTab === 'codebases'
            ? m('div', {
                style: {...MODAL_STYLES.content, padding: 0},
                role: 'tabpanel',
                id: 'smartperfetto-settings-panel-codebases',
                'aria-labelledby': 'smartperfetto-settings-tab-codebases',
              }, [
                backendBindingDirty
                  ? m('div', {
                      style: {
                        ...MODAL_STYLES.alertBox,
                        ...MODAL_STYLES.alertWarning,
                        margin: '16px 16px 0',
                      },
                    }, uiText(
                      '连接地址或凭证有未保存的修改。请先保存连接设置，再管理该后端的源码库。',
                      'Backend URL or credentials have unsaved changes. Save connection settings before managing codebases for that backend.',
                    ))
                  : null,
                m(CodebasePanel, {
                  backendUrl: vnode.attrs.settings.backendUrl,
                  apiKey: vnode.attrs.settings.backendApiKey || undefined,
                  scopeKey: analysisContextScopeKey(
                    vnode.attrs.settings.backendUrl,
                    vnode.attrs.workspaceContext,
                  ),
                  selection: vnode.attrs.analysisContext ?? {
                    codeAwareMode: 'off',
                    codebaseIds: [],
                    knowledgeSourceIds: [],
                  },
                  readOnly: readOnly || backendBindingDirty,
                  onSelectionChange: vnode.attrs.onAnalysisContextChange ?? (() => {}),
                }),
              ])
            : m('div', {
                style: MODAL_STYLES.content,
                role: 'tabpanel',
                id: 'smartperfetto-settings-panel-connection',
                'aria-labelledby': 'smartperfetto-settings-tab-connection',
              }, [
                readOnly
                  ? m(
                      'div',
                      {
                        style: {
                          ...MODAL_STYLES.alertBox,
                          ...MODAL_STYLES.alertWarning,
                          marginBottom: '16px',
                        },
                      },
                      uiText(
                        '分析运行中，Workspace、Backend URL、访问凭据与 Provider 保持只读。',
                        'Workspace, backend URL, credentials, and provider are read-only while analysis is running.',
                      ),
                    )
                  : null,
                m('div', {style: MODAL_STYLES.section}, [
                  m(
                    'h4',
                    {style: MODAL_STYLES.sectionTitle},
                    uiText('后端连接', 'Backend Connection'),
                  ),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {for: 'smartperfetto-workspace-id', style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🏢'),
                      uiText('工作区 ID', 'Workspace ID'),
                    ]),
                    m('input[type=text]', {
                      id: 'smartperfetto-workspace-id',
                      style: MODAL_STYLES.input,
                      value: this.workspaceId,
                      onchange: (e: Event) => {
                        if (readOnly) return;
                        this.workspaceId = (e.target as HTMLInputElement).value;
                      },
                      disabled: readOnly,
                      placeholder: vnode.attrs.workspaceContext.workspaceId,
                    }),
                    m(
                      'div',
                      {style: MODAL_STYLES.hint},
                      `Tenant: ${vnode.attrs.workspaceContext.tenantId} · User: ${vnode.attrs.workspaceContext.userId} · Window: ${vnode.attrs.workspaceContext.windowId}`,
                    ),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {for: 'smartperfetto-backend-url', style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🖥️'),
                      uiText('后端 URL', 'Backend URL'),
                    ]),
                    m('input[type=text]', {
                      id: 'smartperfetto-backend-url',
                      style: MODAL_STYLES.input,
                      value: this.settings.backendUrl,
                      onchange: (e: Event) => {
                        if (readOnly) return;
                        this.settings.backendUrl = (
                          e.target as HTMLInputElement
                        ).value;
                      },
                      disabled: readOnly,
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
                          if (readOnly) return;
                          this.showBackendAuth = !this.showBackendAuth;
                        },
                        disabled: readOnly,
                      },
                      [
                        m('span', uiText('高级后端认证', 'Advanced backend auth')),
                        m('span', this.showBackendAuth ? '▲' : '▼'),
                      ],
                    ),
                    m(
                      'div',
                      {style: {...MODAL_STYLES.hint, marginTop: '6px'}},
                      uiText(
                        '本地单用户运行请留空。仅在后端使用 SMARTPERFETTO_API_KEY 启动时填写。',
                        'Leave this empty for local single-user runs. Only fill it when the backend was started with SMARTPERFETTO_API_KEY.',
                      ),
                    ),
                  ]),
                  this.showBackendAuth
                    ? m('div', {style: MODAL_STYLES.field}, [
                        m('label', {for: 'smartperfetto-backend-token', style: MODAL_STYLES.fieldLabel}, [
                          m('span', {style: MODAL_STYLES.fieldIcon}, '🔐'),
                          uiText('后端访问令牌', 'Backend Access Token'),
                        ]),
                        m('input[type=password]', {
                          id: 'smartperfetto-backend-token',
                          style: MODAL_STYLES.input,
                          value: this.settings.backendApiKey || '',
                          onchange: (e: Event) => {
                            if (readOnly) return;
                            this.settings.backendApiKey = (
                              e.target as HTMLInputElement
                            ).value;
                          },
                          disabled: readOnly,
                          placeholder: 'Optional SMARTPERFETTO_API_KEY',
                        }),
                        m(
                          'div',
                          {style: MODAL_STYLES.hint},
                          uiText(
                            '该令牌用于保护 SmartPerfetto 后端 API，不是模型提供商密钥；模型密钥应在“提供商”页签中配置。',
                            'This protects SmartPerfetto backend APIs. It is not a model provider key; model provider keys belong on the Providers tab.',
                          ),
                        ),
                      ])
                    : null,
                ]),

                m('div', {style: MODAL_STYLES.section}, [
                  m('h4', {style: MODAL_STYLES.sectionTitle}, uiText('服务状态', 'Server Status')),
                  m(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                      },
                    },
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
                  {
                    style: {
                      ...MODAL_STYLES.alertBox,
                      ...MODAL_STYLES.alertInfo,
                    },
                  },
                  [
                    m('span', {style: MODAL_STYLES.alertIcon}, 'ℹ️'),
                    m('div', uiText(
                      '在“提供商”页签中添加、测试、激活和切换 AI 提供商。仅保存配置不会生效；当前激活的配置才会覆盖 backend/.env。',
                      'Use the Providers tab to add, test, activate, and switch AI provider profiles. Saving a provider is not enough; the active profile is what overrides backend/.env.',
                    )),
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
                uiText('取消', 'Cancel'),
              ),
              m(
                'button',
                {
                  style: {...MODAL_STYLES.btn, ...MODAL_STYLES.btnPrimary},
                  onclick: () => {
                    if (readOnly) return;
                    vnode.attrs.onWorkspaceChange(this.workspaceId);
                    vnode.attrs.onSave(this.settings);
                  },
                  disabled: readOnly,
                  title: readOnly
                    ? uiText(
                        '分析运行中无法保存身份相关设置',
                        'Identity settings cannot be saved while analysis is running',
                      )
                    : undefined,
                },
                uiText('\u{1F4BE} 保存设置', '\u{1F4BE} Save Settings'),
              ),
            ])
          : null,
      ]),
    );
  }
}
