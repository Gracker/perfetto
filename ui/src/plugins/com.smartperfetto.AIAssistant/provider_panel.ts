// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import type {
  ProviderConfig,
  ProviderTemplate,
  ProviderPanelAttrs,
  HealthStatus,
} from './provider_types';
import {
  providerRuntimeLabel,
  resolveProviderRuntime,
  buildHeaders,
  apiUrl,
} from './provider_types';
import {renderProviderIcon} from './provider_icons';
import {getTokens, STYLES as getStyles} from './provider_styles';
import {ProviderForm} from './provider_form';

export type {ProviderPanelAttrs};

export class ProviderPanel implements m.ClassComponent<ProviderPanelAttrs> {
  private providers: ProviderConfig[] = [];
  private templates: ProviderTemplate[] = [];
  private loading = true;
  private error: string | null = null;
  private success: string | null = null;
  private view_mode: 'list' | 'add' | 'edit' = 'list';
  private editingId: string | null = null;
  private testingId: string | null = null;
  private testResult: {
    success: boolean;
    latencyMs?: number;
    error?: string;
    modelVerified?: boolean;
  } | null = null;
  private deleting: string | null = null;
  private backendUrl = '';
  private apiKey?: string;
  private healthMap = new Map<string, HealthStatus>();
  private effectiveConfig: Record<string, string> | null = null;
  private effectiveExpanded = false;
  private effectiveRevealedKeys = new Set<string>();
  private loadingEffective = false;
  private cloneSource: ProviderConfig | null = null;
  private expandedId: string | null = null;
  private hoveredId: string | null = null;

  oninit(vnode: m.Vnode<ProviderPanelAttrs>) {
    this.backendUrl = vnode.attrs.backendUrl;
    this.apiKey = vnode.attrs.apiKey;
    this.loadData();
  }

  onupdate(vnode: m.Vnode<ProviderPanelAttrs>) {
    if (
      vnode.attrs.backendUrl !== this.backendUrl ||
      vnode.attrs.apiKey !== this.apiKey
    ) {
      this.backendUrl = vnode.attrs.backendUrl;
      this.apiKey = vnode.attrs.apiKey;
      this.loadData();
    }
  }

  private async loadData() {
    this.loading = true;
    this.error = null;
    m.redraw();

    try {
      const [providersRes, templatesRes] = await Promise.all([
        fetch(apiUrl(this.backendUrl, ''), {
          headers: buildHeaders(this.apiKey),
        }),
        fetch(apiUrl(this.backendUrl, '/templates'), {
          headers: buildHeaders(this.apiKey),
        }),
      ]);

      if (!providersRes.ok)
        throw new Error(`Failed to load providers: ${providersRes.status}`);
      if (!templatesRes.ok)
        throw new Error(`Failed to load templates: ${templatesRes.status}`);

      const providersData = await providersRes.json();
      const templatesData = await templatesRes.json();

      this.providers = providersData.providers || [];
      this.templates = templatesData.templates || [];

      if (this.providers.some((p) => p.isActive)) {
        this.loadEffectiveConfig();
      }
    } catch (e: unknown) {
      this.error =
        e instanceof Error ? e.message : 'Failed to load provider data';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async loadEffectiveConfig() {
    this.loadingEffective = true;
    m.redraw();
    try {
      const res = await fetch(apiUrl(this.backendUrl, '/effective'), {
        headers: buildHeaders(this.apiKey),
      });
      if (res.ok) {
        const data = await res.json();
        this.effectiveConfig = data.env || null;
      }
    } catch {
      this.effectiveConfig = null;
    } finally {
      this.loadingEffective = false;
      m.redraw();
    }
  }

  private async activateProvider(id: string) {
    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}/activate`), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`Activation failed: ${res.status}`);
      this.success = 'Provider activated successfully';
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Activation failed';
      m.redraw();
    }
  }

  private async deactivateAll() {
    try {
      const res = await fetch(apiUrl(this.backendUrl, '/deactivate'), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`Deactivation failed: ${res.status}`);
      this.success = 'Switched to system default (.env)';
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Deactivation failed';
      m.redraw();
    }
  }

  private async deleteProvider(id: string) {
    this.deleting = id;
    m.redraw();

    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}`), {
        method: 'DELETE',
        headers: buildHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      this.success = 'Provider deleted';
      this.deleting = null;
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Delete failed';
      this.deleting = null;
      m.redraw();
    }
  }

  private async testConnection(id: string) {
    this.testingId = id;
    this.testResult = null;
    m.redraw();

    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}/test`), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      const data = await res.json();
      const result = data.result || data;
      this.testResult = {
        success: result.success,
        latencyMs: result.latencyMs,
        error: result.error,
        modelVerified: result.modelVerified,
      };
      this.healthMap.set(id, this.testResult.success ? 'passed' : 'failed');
    } catch (e: unknown) {
      this.testResult = {
        success: false,
        error: e instanceof Error ? e.message : 'Connection test failed',
      };
      this.healthMap.set(id, 'failed');
    } finally {
      this.testingId = null;
      m.redraw();
    }
  }

  private startEdit(provider: ProviderConfig) {
    this.view_mode = 'edit';
    this.editingId = provider.id;
    this.error = null;
    this.success = null;
    this.testResult = null;
    m.redraw();
  }

  private startAdd() {
    this.view_mode = 'add';
    this.editingId = null;
    this.cloneSource = null;
    this.error = null;
    this.success = null;
    this.testResult = null;
    m.redraw();
  }

  private cloneProvider(provider: ProviderConfig) {
    this.view_mode = 'add';
    this.editingId = null;
    this.cloneSource = provider;
    this.error = null;
    this.success = null;
    this.testResult = null;
    m.redraw();
  }

  private clearSuccessAfterDelay() {
    setTimeout(() => {
      this.success = null;
      m.redraw();
    }, 3000);
  }

  view(_vnode: m.Vnode<ProviderPanelAttrs>): m.Children {
    if (this.view_mode === 'add' || this.view_mode === 'edit') {
      const editProvider =
        this.view_mode === 'edit'
          ? this.providers.find((p) => p.id === this.editingId)
          : undefined;
      return m(ProviderForm, {
        backendUrl: this.backendUrl,
        apiKey: this.apiKey,
        editingProvider: editProvider,
        cloneSource: this.cloneSource || undefined,
        templates: this.templates,
        onSaved: () => {
          this.success =
            this.view_mode === 'edit'
              ? 'Provider updated. Test it again if credentials changed.'
              : 'Provider created. Test it, then activate it to use it.';
          this.view_mode = 'list';
          this.editingId = null;
          this.cloneSource = null;
          this.loadData();
          this.clearSuccessAfterDelay();
        },
        onCancel: () => {
          this.view_mode = 'list';
          this.editingId = null;
          this.cloneSource = null;
          this.error = null;
          this.testResult = null;
          m.redraw();
        },
      });
    }
    return this.renderList();
  }

  private renderList(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const hasActive = this.providers.some((p) => p.isActive);

    return m(
      'div',
      {
        style: {
          ...s.container,
          display: 'flex',
          flexDirection: 'column' as const,
          position: 'relative' as const,
        },
      },
      [
        this.error
          ? m('div', {style: s.errorBanner}, [
              m('span', '⚠️'),
              m('span', this.error),
            ])
          : null,
        this.success
          ? m('div', {style: s.successBanner}, [
              m('span', '✅'),
              m('span', this.success),
            ])
          : null,

        m('div', {style: s.header}, [
          m('div', [
            m('h3', {style: s.title}, 'Provider Management'),
            m(
              'p',
              {style: s.subtitle},
              'Model provider credentials live here; backend auth stays on the Connection tab',
            ),
          ]),
          m(
            'button',
            {
              style: s.addBtn,
              onclick: () => this.startAdd(),
            },
            '+ Add Provider',
          ),
        ]),

        this.renderProviderGuide(),

        m(
          'div',
          {
            style: {
              flex: 1,
              overflowY: 'auto' as const,
              paddingBottom: hasActive ? '56px' : '0',
            },
          },
          [
            this.loading
              ? m('div', {style: s.loadingState}, [
                  m('span', '⏳'),
                  'Loading providers...',
                ])
              : this.providers.length === 0
                ? this.renderEmpty()
                : this.renderGrid(),
            this.renderTestResult(),
          ],
        ),

        this.renderEffectiveConfig(),
      ],
    );
  }

  private renderProviderGuide(): m.Children {
    const t = getTokens();
    return m(
      'div',
      {
        style: {
          marginBottom: '14px',
          padding: '10px 12px',
          borderRadius: '8px',
          border: `1px solid ${t.border}`,
          backgroundColor: t.surface,
          color: t.textSecondary,
          fontSize: '12px',
          lineHeight: '1.5',
        },
      },
      [
        m('strong', {style: {color: t.text}}, 'Provider Manager priority: '),
        'a saved profile only affects analysis after it is active. Active profiles override backend/.env or Docker .env; System Default returns to env or local Claude Code config.',
      ],
    );
  }

  private renderEmpty(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    return m('div', {style: s.emptyState}, [
      m('div', {style: s.emptyIcon}, '\u{1F50C}'),
      m(
        'h4',
        {style: {margin: '0 0 8px', color: t.text}},
        'No providers configured',
      ),
      m(
        'p',
        {style: {margin: 0, fontSize: '14px'}},
        'Add a UI provider profile, or use System Default for backend/.env, Docker .env, or local Claude Code config.',
      ),
      m(
        'button',
        {
          style: {...s.btn, ...s.btnPrimary, marginTop: '16px'},
          onclick: () => this.startAdd(),
        },
        '+ Add Your First Provider',
      ),
    ]);
  }

  private renderGrid(): m.Children {
    const t = getTokens();
    const noActiveProvider = !this.providers.some((p) => p.isActive);
    return m(
      'div',
      {style: {display: 'flex', flexDirection: 'column' as const, gap: '6px'}},
      [
        this.renderEnvFallbackItem(t, noActiveProvider),
        ...this.providers.map((p) => this.renderListItem(p, t)),
      ],
    );
  }

  private renderEnvFallbackItem(
    t: ReturnType<typeof getTokens>,
    isActive: boolean,
  ): m.Children {
    const isHovered = this.hoveredId === '__env__';
    return m(
      'div',
      {
        key: '__env__',
        style: {
          padding: '12px 14px',
          borderRadius: '8px',
          cursor: isActive ? 'default' : 'pointer',
          backgroundColor: isActive
            ? `${t.accent}15`
            : isHovered
              ? t.surfaceHover
              : t.surface,
          border: isActive
            ? `1px solid ${t.accent}44`
            : `1px solid ${isHovered ? t.border : 'transparent'}`,
          borderLeft: isActive
            ? `3px solid ${t.accent}`
            : `3px solid ${isHovered ? t.textMuted : 'transparent'}`,
          transition: 'all 0.15s ease',
          boxShadow: isHovered ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
        },
        onclick: () => {
          if (!isActive) this.deactivateAll();
        },
        onmouseenter: () => {
          this.hoveredId = '__env__';
        },
        onmouseleave: () => {
          this.hoveredId = null;
        },
      },
      [
        m(
          'div',
          {style: {display: 'flex', alignItems: 'center', gap: '10px'}},
          [
            m(
              'div',
              {
                style: {
                  fontSize: '20px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  backgroundColor: t.surface,
                  flexShrink: 0,
                },
              },
              '\u{1F4BB}',
            ),
            m(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column' as const,
                  justifyContent: 'center',
                },
              },
              [
                m(
                  'div',
                  {style: {display: 'flex', alignItems: 'center', gap: '6px'}},
                  [
                    m(
                      'span',
                      {
                        style: {
                          fontSize: '14px',
                          fontWeight: 500,
                          color: t.text,
                        },
                      },
                      'System Default',
                    ),
                    isActive
                      ? m('span', {
                          style: {
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: t.accentGradient,
                            display: 'inline-block',
                            flexShrink: 0,
                            boxShadow: `0 0 4px ${t.accent}`,
                          },
                        })
                      : null,
                  ],
                ),
                m(
                  'div',
                  {
                    style: {
                      fontSize: '12px',
                      color: t.textMuted,
                      marginTop: '2px',
                    },
                  },
                  'Uses local Claude Code, backend/.env, or Docker .env. Select this to ignore active UI providers.',
                ),
              ],
            ),
          ],
        ),
      ],
    );
  }

  private renderListItem(
    provider: ProviderConfig,
    t: ReturnType<typeof getTokens>,
  ): m.Children {
    const isActive = provider.isActive;
    const isHovered = this.hoveredId === provider.id;
    const isExpanded = this.expandedId === provider.id;
    const health = this.healthMap.get(provider.id) || 'untested';
    const hasSubtitle = true;

    return m(
      'div',
      {
        key: provider.id,
        style: {
          padding: '12px 14px',
          borderRadius: '8px',
          cursor: isActive ? 'default' : 'pointer',
          backgroundColor: isActive
            ? `${t.accent}15`
            : isHovered
              ? t.surfaceHover
              : t.surface,
          border: isActive
            ? `1px solid ${t.accent}44`
            : `1px solid ${isHovered ? t.border : 'transparent'}`,
          borderLeft: isActive
            ? `3px solid ${t.accent}`
            : `3px solid ${isHovered ? t.textMuted : 'transparent'}`,
          transition: 'all 0.15s ease',
          boxShadow: isHovered ? '0 2px 8px rgba(0,0,0,0.1)' : 'none',
        },
        onclick: () => {
          if (!isActive) this.activateProvider(provider.id);
        },
        onmouseenter: () => {
          this.hoveredId = provider.id;
        },
        onmouseleave: () => {
          this.hoveredId = null;
        },
      },
      [
        m(
          'div',
          {style: {display: 'flex', alignItems: 'center', gap: '10px'}},
          [
            m(
              'div',
              {
                style: {
                  fontSize: '20px',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '6px',
                  backgroundColor: t.surface,
                  flexShrink: 0,
                },
              },
              renderProviderIcon(provider.type, 20),
            ),

            m(
              'div',
              {
                style: {
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column' as const,
                  justifyContent: 'center',
                },
              },
              [
                m(
                  'div',
                  {style: {display: 'flex', alignItems: 'center', gap: '6px'}},
                  [
                    m(
                      'span',
                      {
                        style: {
                          fontSize: '14px',
                          fontWeight: 500,
                          color: t.text,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap' as const,
                        },
                      },
                      provider.name,
                    ),
                    isActive
                      ? m('span', {
                          style: {
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: t.accentGradient,
                            display: 'inline-block',
                            flexShrink: 0,
                            boxShadow: `0 0 4px ${t.accent}`,
                          },
                        })
                      : null,
                    health !== 'untested'
                      ? m('span', {
                          style: {
                            width: '6px',
                            height: '6px',
                            borderRadius: '50%',
                            backgroundColor:
                              health === 'passed' ? t.success : t.error,
                            display: 'inline-block',
                            flexShrink: 0,
                          },
                        })
                      : null,
                  ],
                ),
                hasSubtitle
                  ? m(
                      'div',
                      {style: {display: 'flex', gap: '4px', marginTop: '2px'}},
                      [
                        provider.category === 'official'
                          ? m(
                              'span',
                              {
                                style: {
                                  fontSize: '10px',
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  backgroundColor: `${t.accent}20`,
                                  color: t.accent,
                                  fontWeight: 500,
                                },
                              },
                              'Official',
                            )
                          : null,
                        m(
                          'span',
                          {
                            style: {
                              fontSize: '10px',
                              padding: '1px 5px',
                              borderRadius: '3px',
                              backgroundColor: `${t.textMuted}20`,
                              color: t.textSecondary,
                              fontWeight: 500,
                            },
                          },
                          providerRuntimeLabel(resolveProviderRuntime(provider)),
                        ),
                        isActive
                          ? m(
                              'span',
                              {
                                style: {
                                  fontSize: '10px',
                                  padding: '1px 5px',
                                  borderRadius: '3px',
                                  background: t.accentGradient,
                                  color: '#1a1a1a',
                                  fontWeight: 600,
                                },
                              },
                              'Active',
                            )
                          : null,
                      ],
                    )
                  : null,
              ],
            ),

            m(
              'div',
              {
                style: {display: 'flex', gap: '4px', flexShrink: 0},
                onclick: (e: Event) => e.stopPropagation(),
              },
              [
                m(
                  'button',
                  {
                    style: this.listActionBtnStyle(t),
                    onclick: () => this.testConnection(provider.id),
                    disabled: this.testingId === provider.id,
                    title: 'Test Connection',
                    'aria-label': 'Test Connection',
                  },
                  this.testingId === provider.id ? '⏳' : '\u{1F50C}',
                ),
                m(
                  'button',
                  {
                    style: this.listActionBtnStyle(t),
                    onclick: () => this.startEdit(provider),
                    title: 'Edit Provider',
                    'aria-label': 'Edit Provider',
                  },
                  '✏️',
                ),
                m(
                  'button',
                  {
                    style: this.listActionBtnStyle(t),
                    onclick: () => this.cloneProvider(provider),
                    title: 'Clone Provider',
                    'aria-label': 'Clone Provider',
                  },
                  '📋',
                ),
                m(
                  'button',
                  {
                    style: {...this.listActionBtnStyle(t), color: t.error},
                    onclick: () => this.deleteProvider(provider.id),
                    disabled: this.deleting === provider.id || isActive,
                    title: isActive
                      ? 'Cannot delete active provider'
                      : 'Delete Provider',
                    'aria-label': 'Delete Provider',
                  },
                  this.deleting === provider.id ? '⏳' : '\u{1F5D1}️',
                ),
              ],
            ),

            m(
              'button',
              {
                style: {
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px',
                  fontSize: '11px',
                  color: t.textMuted,
                  transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.15s ease',
                  flexShrink: 0,
                },
                onclick: (e: Event) => {
                  e.stopPropagation();
                  this.expandedId = isExpanded ? null : provider.id;
                },
                title: 'Show model details',
              },
              '▶',
            ),
          ],
        ),

        isExpanded
          ? m(
              'div',
              {
                style: {
                  marginTop: '8px',
                  marginLeft: '42px',
                  padding: '8px 10px',
                  fontSize: '12px',
                  color: t.textSecondary,
                  fontFamily: 'monospace',
                  backgroundColor: t.surface,
                  borderRadius: '6px',
                  lineHeight: '1.6',
                  animation: 'fadeSlideIn 0.15s ease-out',
                },
                onclick: (e: Event) => e.stopPropagation(),
              },
              [
                m('div', `Runtime: ${providerRuntimeLabel(resolveProviderRuntime(provider))}`),
                m('div', `Primary: ${provider.models.primary}`),
                m('div', `Light: ${provider.models.light}`),
                provider.models.subAgent
                  ? m('div', `Sub-agent: ${provider.models.subAgent}`)
                  : null,
                provider.connection.claudeBaseUrl
                  ? m('div', `Claude URL: ${provider.connection.claudeBaseUrl}`)
                  : null,
                provider.connection.openaiBaseUrl
                  ? m('div', `OpenAI URL: ${provider.connection.openaiBaseUrl}`)
                  : null,
                provider.tuning && Object.keys(provider.tuning).length > 0
                  ? m(
                      'div',
                      {
                        style: {
                          marginTop: '4px',
                          borderTop: `1px solid ${t.border}`,
                          paddingTop: '4px',
                        },
                      },
                      Object.entries(provider.tuning).map(([k, v]) =>
                        m('div', {key: k}, `${k}: ${v}`),
                      ),
                    )
                  : null,
              ],
            )
          : null,
      ],
    );
  }

  private listActionBtnStyle(t: ReturnType<typeof getTokens>) {
    return {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '26px',
      height: '26px',
      border: `1px solid ${t.border}`,
      borderRadius: '5px',
      fontSize: '12px',
      cursor: 'pointer',
      backgroundColor: t.surface,
      color: t.textSecondary,
      transition: 'all 0.15s ease',
      padding: 0,
    };
  }

  private renderTestResult(): m.Children {
    if (!this.testResult) return null;

    const t = getTokens();
    const s = getStyles(t);
    const isWarning = this.testResult.success && this.testResult.error;
    const colorKey = !this.testResult.success
      ? t.error
      : isWarning
        ? '#f59e0b'
        : t.success;
    const style = {
      ...s.testResult,
      backgroundColor: `${colorKey}15`,
      color: colorKey,
      border: `1px solid ${colorKey}`,
      marginTop: '16px',
    };

    let message: string;
    if (!this.testResult.success) {
      message = `❌ ${this.testResult.error || 'Connection failed'}`;
    } else if (isWarning) {
      message = `⚠️ Connected (${this.testResult.latencyMs}ms) — ${this.testResult.error}`;
    } else {
      const verified = this.testResult.modelVerified ? ', model verified' : '';
      message = `✅ Connection successful (${this.testResult.latencyMs}ms${verified})`;
    }

    return m('div', {style}, m('span', message));
  }

  private renderEffectiveConfig(): m.Children {
    const t = getTokens();
    const s = getStyles(t);

    if (!this.providers.some((p) => p.isActive)) return null;

    return m(
      'div',
      {
        style: {
          position: 'absolute' as const,
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: t.bg,
          borderTop: `1px solid ${t.border}`,
          borderRadius: '0 0 8px 8px',
          zIndex: 10,
        },
      },
      [
        m(
          'div',
          {
            style: {
              ...s.effectiveHeader,
              padding: '10px 20px',
              cursor: 'pointer',
            },
            onclick: () => {
              this.effectiveExpanded = !this.effectiveExpanded;
              if (this.effectiveExpanded && !this.effectiveConfig) {
                this.loadEffectiveConfig();
              }
            },
          },
          [
            m(
              'span',
              {style: {fontSize: '13px', fontWeight: 600, color: t.text}},
              'Active Provider Env Override',
            ),
            m(
              'span',
              {
                style: {
                  fontSize: '11px',
                  color: t.textMuted,
                  transition: 'transform 0.15s ease',
                  display: 'inline-block',
                  transform: this.effectiveExpanded
                    ? 'rotate(180deg)'
                    : 'rotate(0deg)',
                },
              },
              '▲',
            ),
          ],
        ),
        this.effectiveExpanded
          ? m(
              'div',
              {
                style: {
                  maxHeight: '200px',
                  overflowY: 'auto' as const,
                  padding: '0 20px 12px',
                  animation: 'fadeSlideIn 0.15s ease-out',
                },
              },
              [
                m(
                  'div',
                  {
                    style: {
                      fontSize: '12px',
                      color: t.textSecondary,
                      margin: '2px 0 8px',
                      lineHeight: '1.4',
                    },
                  },
                  'These values are what the active Provider Manager profile sends to the backend runtime. They override backend/.env until you switch to System Default.',
                ),
                this.renderEffectiveBody(),
              ],
            )
          : null,
      ],
    );
  }

  private renderEffectiveBody(): m.Children {
    const t = getTokens();
    const s = getStyles(t);

    if (this.loadingEffective) {
      return m(
        'div',
        {
          style: {
            padding: '16px',
            textAlign: 'center' as const,
            color: t.textMuted,
            fontSize: '13px',
          },
        },
        '⏳ Loading...',
      );
    }
    if (!this.effectiveConfig) {
      return m(
        'div',
        {style: {padding: '16px', color: t.textMuted, fontSize: '13px'}},
        'No active provider',
      );
    }

    return m(
      'div',
      Object.entries(this.effectiveConfig).map(([key, value]) => {
        const isRevealed = this.effectiveRevealedKeys.has(key);
        const isSensitive = ['KEY', 'TOKEN', 'SECRET'].some((p) =>
          key.includes(p),
        );
        const displayValue = isSensitive && !isRevealed ? '••••••••' : value;

        return m('div', {style: s.effectiveRow}, [
          m('span', {style: s.effectiveKey}, key),
          m(
            'div',
            {
              style: {
                display: 'flex' as const,
                alignItems: 'center' as const,
                gap: '6px',
              },
            },
            [
              m('span', {style: s.effectiveValue}, displayValue),
              isSensitive
                ? m(
                    'button',
                    {
                      style: s.effectiveEyeBtn,
                      onclick: () => {
                        if (isRevealed) this.effectiveRevealedKeys.delete(key);
                        else this.effectiveRevealedKeys.add(key);
                        m.redraw();
                      },
                    },
                    isRevealed ? '🙈' : '👁️',
                  )
                : null,
            ],
          ),
        ]);
      }),
    );
  }
}
