// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {
  getSmartPerfettoAuthSession,
  getSmartPerfettoAuthSessionGeneration,
  isSmartPerfettoOidcMode,
} from '../../core/smartperfetto_auth';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {
  getSmartPerfettoRequestContext,
  tryGetSmartPerfettoRequestContext,
  type SmartPerfettoRequestContext,
} from '../../core/smartperfetto_request_context';
import {uiText} from './ui_language';

export type PageAuthGateState =
  | {kind: 'ready'; authority: PageAuthority}
  | {kind: 'recovering'}
  | {kind: 'unauthenticated'};

export interface PageAuthority {
  readonly oidc: boolean;
  readonly authGeneration: number;
  readonly identityKey: string;
  readonly context: SmartPerfettoRequestContext;
}

export interface PageAuthorityToken extends PageAuthority {
  readonly pageGeneration: number;
}

export interface PageAuthTransition {
  readonly previous: PageAuthGateState;
  readonly current: PageAuthGateState;
  readonly authorityChanged: boolean;
}

function authorityIdentityKey(context: SmartPerfettoRequestContext): string {
  return [context.tenantId, context.userId, context.workspaceId].join('\0');
}

export function readPageAuthGateState(): PageAuthGateState {
  if (!isSmartPerfettoOidcMode()) {
    const context = getSmartPerfettoRequestContext();
    return {
      kind: 'ready',
      authority: {
        oidc: false,
        authGeneration: getSmartPerfettoAuthSessionGeneration(),
        identityKey: authorityIdentityKey(context),
        context,
      },
    };
  }

  const session = getSmartPerfettoAuthSession();
  const context = tryGetSmartPerfettoRequestContext();
  if (session && context) {
    return {
      kind: 'ready',
      authority: {
        oidc: true,
        authGeneration: getSmartPerfettoAuthSessionGeneration(),
        identityKey: authorityIdentityKey(context),
        context,
      },
    };
  }

  const rawSession = window.__SMARTPERFETTO_AUTH_SESSION__;
  return rawSession?.authenticated === true
    ? {kind: 'recovering'}
    : {kind: 'unauthenticated'};
}

function sameAuthority(
  left: PageAuthGateState,
  right: PageAuthGateState,
): boolean {
  if (left.kind !== 'ready' || right.kind !== 'ready') {
    return left.kind === right.kind;
  }
  return left.authority.oidc === right.authority.oidc &&
    left.authority.authGeneration === right.authority.authGeneration &&
    left.authority.identityKey === right.authority.identityKey;
}

/**
 * One page/component owner for OIDC authority, async aborts and stale-result
 * rejection. It deliberately does not persist identity or perform login/logout.
 */
export class PageAuthLifecycle {
  private state = readPageAuthGateState();
  private pageGeneration = 0;
  private mounted = false;
  private disposed = false;
  private readonly controllers = new Set<AbortController>();

  constructor(
    private readonly onTransition?: (transition: PageAuthTransition) => void,
  ) {}

  mount(): void {
    if (this.mounted || this.disposed) return;
    this.mounted = true;
    window.addEventListener(
      'smartperfetto-auth-session-changed',
      this.handleAuthSessionChanged,
    );
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pageGeneration++;
    this.abortAll();
    if (this.mounted) {
      window.removeEventListener(
        'smartperfetto-auth-session-changed',
        this.handleAuthSessionChanged,
      );
      this.mounted = false;
    }
  }

  getState(): PageAuthGateState {
    this.refresh(false);
    return this.state;
  }

  capture(): PageAuthorityToken | undefined {
    const state = this.getState();
    if (this.disposed || state.kind !== 'ready') return undefined;
    return {...state.authority, pageGeneration: this.pageGeneration};
  }

  isCurrent(token: PageAuthorityToken | undefined): boolean {
    if (!token || this.disposed || token.pageGeneration !== this.pageGeneration) {
      return false;
    }
    const state = readPageAuthGateState();
    return state.kind === 'ready' &&
      state.authority.oidc === token.oidc &&
      state.authority.authGeneration === token.authGeneration &&
      state.authority.identityKey === token.identityKey;
  }

  createAbortController(token: PageAuthorityToken): AbortController {
    const controller = new AbortController();
    if (!this.isCurrent(token)) {
      controller.abort();
      return controller;
    }
    this.controllers.add(controller);
    controller.signal.addEventListener(
      'abort',
      () => this.controllers.delete(controller),
      {once: true},
    );
    return controller;
  }

  releaseAbortController(controller: AbortController): void {
    this.controllers.delete(controller);
  }

  invalidatePage(): void {
    if (this.disposed) return;
    this.pageGeneration++;
    this.abortAll();
  }

  private readonly handleAuthSessionChanged = (): void => {
    this.refresh(true);
  };

  private refresh(notify = true): void {
    if (this.disposed) return;
    const previous = this.state;
    const current = readPageAuthGateState();
    const authorityChanged = !sameAuthority(previous, current);
    if (authorityChanged) {
      this.pageGeneration++;
      this.abortAll();
    }
    this.state = current;
    if (notify && authorityChanged) {
      this.onTransition?.({previous, current, authorityChanged});
    }
  }

  private abortAll(): void {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
  }
}

export function buildOidcLoginUrl(backendUrl: string): string {
  const base = backendUrl.replace(/\/+$/, '');
  const loginUrl = new URL(`${base}/api/auth/oidc/login`, window.location.href);
  const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}` || '/';
  loginUrl.searchParams.set('returnTo', returnTo);
  return loginUrl.toString();
}

export function renderPageAuthUnavailable(
  state: Exclude<PageAuthGateState, {kind: 'ready'}>,
  backendUrl = getDefaultSmartPerfettoBackendUrl(),
): m.Children {
  const recovering = state.kind === 'recovering';
  return m('main.ai-page-auth-unavailable', {
    'data-ai-auth-state': state.kind,
    'role': 'status',
  }, [
    m('i.pf-icon', recovering ? 'sync' : 'lock'),
    m('h2', recovering
      ? uiText('正在恢复登录会话', 'Restoring your sign-in session')
      : uiText('登录会话已失效', 'Your sign-in session has expired')),
    m('p', recovering
      ? uiText(
          '会话恢复完成后即可继续使用 AI 助手。',
          'You can continue when session recovery completes.',
        )
      : uiText(
          '请重新登录后继续。旧页面的运行中请求已停止。',
          'Sign in again to continue. In-flight work from the old page has stopped.',
        )),
    recovering
      ? null
      : m('a.ai-page-auth-login', {
          href: buildOidcLoginUrl(backendUrl),
          'data-ai-auth-relogin': 'true',
        }, uiText('重新登录', 'Sign in again')),
  ]);
}

export interface PageAuthGateAttrs {
  content: m.Children;
  backendUrl?: string;
}

interface PageAuthReadyAttrs {
  content: m.Children;
}

const PageAuthReadyEven: m.Component<PageAuthReadyAttrs> = {
  view: ({attrs}) => m('.ai-page-auth-ready', attrs.content),
};

const PageAuthReadyOdd: m.Component<PageAuthReadyAttrs> = {
  view: ({attrs}) => m('.ai-page-auth-ready', attrs.content),
};

/** Mounts identity-bound content only while the current authority is ready. */
export class PageAuthGate implements m.ClassComponent<PageAuthGateAttrs> {
  private readyBoundaryVersion = 0;
  private readonly lifecycle = new PageAuthLifecycle(() => {
    this.readyBoundaryVersion++;
    m.redraw();
  });

  oncreate(): void {
    this.lifecycle.mount();
  }

  onremove(): void {
    this.lifecycle.dispose();
  }

  view({attrs}: m.Vnode<PageAuthGateAttrs>): m.Children {
    const state = this.lifecycle.getState();
    if (state.kind !== 'ready') {
      return renderPageAuthUnavailable(state, attrs.backendUrl);
    }
    const Boundary = this.readyBoundaryVersion % 2 === 0
      ? PageAuthReadyEven
      : PageAuthReadyOdd;
    return m(Boundary, {content: attrs.content});
  }
}
