// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {
  fetchEnterpriseAuthConfig,
  fetchEnterpriseAuthSession,
  identityFromEnterpriseSession,
  logoutEnterpriseSession,
  selectEnterpriseWorkspace,
  signInWithOidc,
  type EnterpriseAuthConfig,
  type EnterpriseAuthIdentity,
  type EnterpriseAuthSession,
} from './enterprise_auth';
import {uiText} from './ui_language';

export interface EnterpriseAuthCardAttrs {
  backendUrl: string;
  readOnly?: boolean;
  onIdentityChange: (identity: EnterpriseAuthIdentity | null) => void;
}

const CARD_STYLE = {
  border: '1px solid var(--chat-border)',
  borderRadius: '10px',
  padding: '14px',
  background: 'var(--chat-bg-secondary)',
};

const BUTTON_STYLE = {
  minHeight: '40px',
  padding: '8px 14px',
  borderRadius: '8px',
  border: '1px solid var(--chat-border)',
  cursor: 'pointer',
  fontWeight: 600,
};

function statusText(status: string): string {
  switch (status) {
    case 'needs_workspace_selection':
      return uiText('请选择工作区', 'Choose a workspace');
    case 'no_workspace_membership':
      return uiText(
        '当前账户还没有工作区权限，请联系管理员授权。',
        'This account has no workspace membership. Ask an administrator for access.',
      );
    case 'needs_tenant_join':
      return uiText(
        '当前身份未映射到 SmartPerfetto 租户。',
        'This identity is not mapped to a SmartPerfetto tenant.',
      );
    case 'provider_error':
      return uiText('身份提供商取消或拒绝了登录。', 'The identity provider cancelled or rejected sign-in.');
    case 'callback_error':
      return uiText('OIDC 回调校验失败。', 'OIDC callback validation failed.');
    case 'cancelled':
      return uiText('登录窗口已关闭。', 'The sign-in window was closed.');
    default:
      return status;
  }
}

export class EnterpriseAuthCard
implements m.ClassComponent<EnterpriseAuthCardAttrs> {
  private config: EnterpriseAuthConfig | null = null;
  private session: EnterpriseAuthSession | null = null;
  private loading = true;
  private actionPending = false;
  private error: string | null = null;
  private backendUrl = '';
  private selectedWorkspaceId = '';
  private lastIdentityKey: string | null | undefined;

  oninit(vnode: m.Vnode<EnterpriseAuthCardAttrs>): void {
    this.backendUrl = vnode.attrs.backendUrl;
    void this.refresh(vnode.attrs);
  }

  onbeforeupdate(vnode: m.Vnode<EnterpriseAuthCardAttrs>): void {
    if (vnode.attrs.backendUrl === this.backendUrl) return;
    if (this.config?.enterprise || this.config?.oidc.enabled) {
      vnode.attrs.onIdentityChange(null);
    }
    this.backendUrl = vnode.attrs.backendUrl;
    this.config = null;
    this.session = null;
    this.lastIdentityKey = undefined;
    void this.refresh(vnode.attrs);
  }

  private async refresh(attrs: EnterpriseAuthCardAttrs): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const [config, session] = await Promise.all([
        fetchEnterpriseAuthConfig(attrs.backendUrl),
        fetchEnterpriseAuthSession(attrs.backendUrl),
      ]);
      this.config = config;
      this.session = session;
      if (session.authenticated) {
        this.selectedWorkspaceId =
          session.workspaceId || session.workspaces[0]?.workspaceId || '';
      }
      this.notifyIdentity(attrs, session);
    } catch (error) {
      this.config = null;
      this.session = null;
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private notifyIdentity(
    attrs: EnterpriseAuthCardAttrs,
    session: EnterpriseAuthSession,
  ): void {
    const identity = identityFromEnterpriseSession(session);
    const key = identity
      ? `${identity.tenantId}:${identity.userId}:${identity.workspaceId}`
      : null;
    if (!identity && !this.config?.enterprise && !this.config?.oidc.enabled) {
      return;
    }
    if (key === this.lastIdentityKey) return;
    this.lastIdentityKey = key;
    attrs.onIdentityChange(identity);
  }

  private async signIn(attrs: EnterpriseAuthCardAttrs): Promise<void> {
    this.actionPending = true;
    this.error = null;
    m.redraw();
    try {
      const result = await signInWithOidc(attrs.backendUrl);
      if (result.status === 'redirecting') return;
      if (!result.ok) {
        this.error = statusText(result.status);
        return;
      }
      await this.refresh(attrs);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
      m.redraw();
    }
  }

  private async selectWorkspace(
    attrs: EnterpriseAuthCardAttrs,
  ): Promise<void> {
    if (!this.selectedWorkspaceId) return;
    this.actionPending = true;
    this.error = null;
    m.redraw();
    try {
      const session = await selectEnterpriseWorkspace(
        attrs.backendUrl,
        this.selectedWorkspaceId,
      );
      this.session = session;
      this.notifyIdentity(attrs, session);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
      m.redraw();
    }
  }

  private async logout(attrs: EnterpriseAuthCardAttrs): Promise<void> {
    this.actionPending = true;
    this.error = null;
    m.redraw();
    try {
      await logoutEnterpriseSession(attrs.backendUrl);
      this.session = {success: true, authenticated: false};
      this.lastIdentityKey = null;
      attrs.onIdentityChange(null);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.actionPending = false;
      m.redraw();
    }
  }

  view(vnode: m.Vnode<EnterpriseAuthCardAttrs>): m.Children {
    if (this.loading) {
      return m('div', {style: CARD_STYLE}, uiText(
        '正在读取企业登录状态……',
        'Loading enterprise sign-in status…',
      ));
    }
    if (!this.config) {
      return this.error
        ? m('div', {
            style: {
              ...CARD_STYLE,
              color: 'var(--chat-error)',
            },
          }, [
            m('strong', uiText('认证状态不可用', 'Authentication status unavailable')),
            m('div', {style: {marginTop: '6px'}}, this.error),
          ])
        : null;
    }
    if (!this.config.enterprise && !this.config.oidc.enabled) return null;

    const readOnly = vnode.attrs.readOnly || this.actionPending;
    const session = this.session;
    return m('section', {
      style: CARD_STYLE,
      'aria-label': uiText('企业登录', 'Enterprise sign-in'),
    }, [
      m('div', {
        style: {
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '12px',
        },
      }, [
        m('div', [
          m('strong', uiText('企业 OIDC 登录', 'Enterprise OIDC sign-in')),
          this.config.oidc.issuerUrl
            ? m('div', {
                style: {
                  marginTop: '4px',
                  color: 'var(--chat-text-muted)',
                  fontSize: '12px',
                  overflowWrap: 'anywhere',
                },
              }, this.config.oidc.issuerUrl)
            : null,
        ]),
        session?.authenticated
          ? m('span', {
              style: {color: 'var(--chat-success)', fontWeight: 600},
            }, uiText('已登录', 'Signed in'))
          : null,
      ]),
      !this.config.oidc.enabled
        ? m('div', {
            style: {marginTop: '10px', color: 'var(--chat-warning)'},
          }, uiText(
            '企业模式已启用，但后端还没有完成 OIDC 配置。',
            'Enterprise mode is enabled, but backend OIDC is not configured.',
          ))
        : null,
      this.config.oidc.enabled && !session?.authenticated
        ? m('div', {style: {marginTop: '12px'}}, [
            m('button', {
              type: 'button',
              style: {
                ...BUTTON_STYLE,
                background: 'var(--chat-primary)',
                color: '#fff',
              },
              disabled: readOnly,
              onclick: () => void this.signIn(vnode.attrs),
            }, this.actionPending
              ? uiText('正在登录……', 'Signing in…')
              : uiText('使用企业账户登录', 'Sign in with enterprise account')),
          ])
        : null,
      session?.authenticated
        ? m('div', {style: {marginTop: '12px'}}, [
            m('div', {style: {lineHeight: 1.6}}, [
              m('div', session.displayName || session.email || session.userId),
              session.displayName && session.email
                ? m('div', {
                    style: {fontSize: '12px', color: 'var(--chat-text-muted)'},
                  }, session.email)
                : null,
              m('div', {
                style: {fontSize: '12px', color: 'var(--chat-text-muted)'},
              }, `${session.tenantId} · ${session.userId}`),
            ]),
            session.status !== 'ready'
              ? m('div', {
                  style: {marginTop: '8px', color: 'var(--chat-warning)'},
                }, statusText(session.status))
              : null,
            session.workspaces.length > 0
              ? m('div', {
                  style: {
                    display: 'flex',
                    gap: '8px',
                    alignItems: 'center',
                    marginTop: '12px',
                    flexWrap: 'wrap',
                  },
                }, [
                  m('label', {for: 'smartperfetto-oidc-workspace'}, uiText(
                    '工作区',
                    'Workspace',
                  )),
                  m('select', {
                    id: 'smartperfetto-oidc-workspace',
                    value: this.selectedWorkspaceId,
                    disabled: readOnly,
                    style: {
                      minHeight: '40px',
                      flex: '1 1 220px',
                      border: '1px solid var(--chat-border)',
                      borderRadius: '8px',
                      background: 'var(--chat-bg)',
                      color: 'var(--chat-text)',
                      padding: '8px',
                    },
                    onchange: (event: Event) => {
                      this.selectedWorkspaceId = (
                        event.target as HTMLSelectElement
                      ).value;
                    },
                  }, session.workspaces.map(workspace => m('option', {
                    value: workspace.workspaceId,
                  }, `${workspace.name} · ${workspace.role}`))),
                  m('button', {
                    type: 'button',
                    style: BUTTON_STYLE,
                    disabled:
                      readOnly
                      || !this.selectedWorkspaceId
                      || this.selectedWorkspaceId === session.workspaceId,
                    onclick: () => void this.selectWorkspace(vnode.attrs),
                  }, uiText('切换', 'Switch')),
                ])
              : null,
            m('div', {style: {marginTop: '12px'}}, [
              m('button', {
                type: 'button',
                style: BUTTON_STYLE,
                disabled: readOnly,
                onclick: () => void this.logout(vnode.attrs),
              }, uiText('退出 SmartPerfetto', 'Sign out of SmartPerfetto')),
              m('div', {
                style: {
                  marginTop: '6px',
                  fontSize: '12px',
                  color: 'var(--chat-text-muted)',
                },
              }, uiText(
                '退出只撤销本应用会话，不会退出身份提供商的全局会话。',
                'Sign-out revokes this app session only; it does not end the identity provider session.',
              )),
            ]),
          ])
        : null,
      this.error
        ? m('div', {
            role: 'alert',
            style: {marginTop: '10px', color: 'var(--chat-error)'},
          }, this.error)
        : null,
    ]);
  }
}
