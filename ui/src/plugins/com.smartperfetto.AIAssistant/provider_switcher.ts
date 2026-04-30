// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {
  ProviderConfig,
  ProviderQuickSwitcherAttrs,
  HealthStatus,
  TYPE_ICONS,
  buildHeaders,
  apiUrl,
} from './provider_types';
import {getTokens, STYLES as getStyles} from './provider_styles';

export class ProviderQuickSwitcher implements m.ClassComponent<ProviderQuickSwitcherAttrs> {
  private providers: ProviderConfig[] = [];
  private open = false;
  private loading = false;
  private activating = false;
  private backendUrl = '';
  private apiKey?: string;
  private toastMessage: string | null = null;
  private toastTimeout: ReturnType<typeof setTimeout> | null = null;
  private focusIndex = -1;
  private healthMap = new Map<string, HealthStatus>();
  private outsideClickHandler: ((e: Event) => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  oninit(vnode: m.Vnode<ProviderQuickSwitcherAttrs>) {
    this.backendUrl = vnode.attrs.backendUrl;
    this.apiKey = vnode.attrs.apiKey;
    this.loadProviders();
  }

  oncreate(_vnode: m.VnodeDOM<ProviderQuickSwitcherAttrs>) {
    this.outsideClickHandler = (e: Event) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-switcher]')) {
        if (this.open) {
          this.open = false;
          this.focusIndex = -1;
          m.redraw();
        }
      }
    };
    document.addEventListener('click', this.outsideClickHandler, true);

    this.keydownHandler = (e: KeyboardEvent) => {
      if (!this.open) return;
      if (e.key === 'Escape') {
        this.open = false;
        this.focusIndex = -1;
        m.redraw();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.focusIndex = Math.min(this.focusIndex + 1, this.providers.length - 1);
        m.redraw();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.focusIndex = Math.max(this.focusIndex - 1, 0);
        m.redraw();
      } else if (e.key === 'Enter') {
        if (this.focusIndex >= 0 && this.focusIndex < this.providers.length) {
          const p = this.providers[this.focusIndex];
          if (p && !p.isActive) {
            void this.activate(p.id);
          } else if (p) {
            this.open = false;
            this.focusIndex = -1;
            m.redraw();
          }
        }
      }
    };
    document.addEventListener('keydown', this.keydownHandler);
  }

  onupdate(vnode: m.Vnode<ProviderQuickSwitcherAttrs>) {
    if (vnode.attrs.backendUrl !== this.backendUrl || vnode.attrs.apiKey !== this.apiKey) {
      this.backendUrl = vnode.attrs.backendUrl;
      this.apiKey = vnode.attrs.apiKey;
      void this.loadProviders();
    }
  }

  onremove() {
    if (this.outsideClickHandler) {
      document.removeEventListener('click', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.toastTimeout !== null) {
      clearTimeout(this.toastTimeout);
      this.toastTimeout = null;
    }
    this.open = false;
  }

  private async loadProviders() {
    this.loading = true;
    try {
      const res = await fetch(apiUrl(this.backendUrl, ''), {
        headers: buildHeaders(this.apiKey),
      });
      if (res.ok) {
        const data = await res.json();
        this.providers = data.providers || [];
      }
    } catch {
      // Silent fail for switcher
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async activate(id: string) {
    this.activating = true;
    m.redraw();
    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}/activate`), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      if (res.ok) {
        await this.loadProviders();
        const activated = this.providers.find((p) => p.id === id);
        if (activated) {
          this.showToast(`✶ Switched to ${activated.name}`);
        }
      }
    } catch {
      // Silent fail
    } finally {
      this.activating = false;
      this.open = false;
      this.focusIndex = -1;
      m.redraw();
    }
  }

  private showToast(message: string) {
    this.toastMessage = message;
    if (this.toastTimeout !== null) {
      clearTimeout(this.toastTimeout);
    }
    this.toastTimeout = setTimeout(() => {
      this.toastMessage = null;
      this.toastTimeout = null;
      m.redraw();
    }, 2000);
  }

  setHealth(id: string, status: HealthStatus) {
    this.healthMap.set(id, status);
    m.redraw();
  }

  view(_vnode: m.Vnode<ProviderQuickSwitcherAttrs>): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const active = this.providers.find((p) => p.isActive);

    if (this.loading && this.providers.length === 0) {
      return m('div', {'data-switcher': true, style: s.switcherContainer}, [
        m('span', {style: {fontSize: '12px', color: t.textSecondary}}, '⏳'),
      ]);
    }

    if (this.providers.length === 0) {
      return null;
    }

    return m('div', {'data-switcher': true, style: s.switcherContainer}, [
      m('button', {
        style: s.switcherBtn,
        onclick: (e: Event) => {
          e.stopPropagation();
          if (!this.activating) {
            this.open = !this.open;
            if (this.open) this.focusIndex = -1;
          }
        },
        disabled: this.activating,
      }, [
        this.activating
          ? m('span', {style: {fontSize: '12px'}}, '⏳')
          : m('span', TYPE_ICONS[active?.type || 'custom']),
        m('span', {style: {maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis'}},
          active?.name || 'No provider'),
        m('span', {style: {fontSize: '10px', opacity: 0.6}}, this.open ? '▲' : '▼'),
      ]),

      this.open ? this.renderDropdown() : null,

      this.toastMessage ? this.renderToast() : null,
    ]);
  }

  private renderHealthDot(id: string): m.Children {
    const t = getTokens();
    const status = this.healthMap.get(id);
    const color = status === 'passed' ? t.success
      : status === 'failed' ? t.error
      : t.textMuted;
    const title = status === 'passed' ? 'Healthy'
      : status === 'failed' ? 'Unhealthy'
      : 'Not tested';
    return m('span', {
      title,
      style: {
        width: '7px',
        height: '7px',
        borderRadius: '50%',
        backgroundColor: color,
        display: 'inline-block',
        flexShrink: 0,
      },
    });
  }

  private renderDropdown(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    return m('div', {
      style: s.switcherDropdown,
      onclick: (e: Event) => e.stopPropagation(),
    }, [
      ...this.providers.map((p, i) =>
        m('div', {
          style: {
            ...s.switcherItem,
            ...(p.isActive ? s.switcherItemActive : {}),
            ...(i === this.focusIndex ? {
              backgroundColor: t.surfaceHover,
              outline: `1px solid ${t.accent}`,
            } : {}),
          },
          key: p.id,
          onclick: () => {
            if (!p.isActive) void this.activate(p.id);
            else {
              this.open = false;
              this.focusIndex = -1;
            }
          },
          onmouseenter: () => {
            this.focusIndex = i;
          },
        }, [
          m('span', {style: {fontSize: '16px'}}, TYPE_ICONS[p.type]),
          m('div', {style: {flex: 1, minWidth: 0}}, [
            m('div', {style: {fontSize: '13px', fontWeight: 500}}, p.name),
            m('div', {style: {fontSize: '11px', color: t.textSecondary, fontFamily: 'monospace'}},
              p.models.primary),
          ]),
          this.renderHealthDot(p.id),
          p.isActive ? m('div', {style: s.activeDot}) : null,
        ]),
      ),
    ]);
  }

  private renderToast(): m.Children {
    const t = getTokens();
    return m('div', {
      style: {
        position: 'absolute' as const,
        bottom: '110%',
        left: '50%',
        transform: 'translateX(-50%)',
        backgroundColor: t.surface,
        color: t.accent,
        border: `1px solid ${t.accent}`,
        borderRadius: '6px',
        padding: '5px 10px',
        fontSize: '12px',
        whiteSpace: 'nowrap' as const,
        pointerEvents: 'none' as const,
        zIndex: 9999,
        boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
        animation: 'fadeIn 0.15s ease',
      },
    }, this.toastMessage);
  }
}
