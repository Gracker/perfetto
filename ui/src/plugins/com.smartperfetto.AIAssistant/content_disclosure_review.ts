// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The one way the Web UI grants source text for a codebase: show the
 * server's own disclosure (scope, exclusions, languages) and, on
 * confirmation, grant with that disclosure's token. The snapshot is taken
 * when the review opens and never follows later list refreshes; a stale
 * refusal re-reads the codebase, shows the new disclosure and asks again,
 * never retrying on its own. Used by the codebase list and by "Add and use".
 */

import m from 'mithril';

import {
  authorizeCodebaseContent,
  CodebaseApiError,
  getCodebase,
  type CodebaseSummary,
  type ContentDisclosure,
} from './codebase_api';
import {errorMessage, MANAGEMENT_STYLES as STYLES, runWhileCurrent} from './management_ui';
import {sourceAnalysisDisclosure} from './source_analysis_disclosure';
import {uiText as text} from './ui_language';

/** A detached copy of the server's disclosure, so a refresh cannot change what is shown. */
export function contentDisclosureSnapshot(codebase: CodebaseSummary): ContentDisclosure | undefined {
  const disclosure = codebase.contentDisclosure;
  if (!disclosure || typeof disclosure.token !== 'string' || !disclosure.token) return undefined;
  const list = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  return {
    token: disclosure.token,
    includePrefixes: list(disclosure.includePrefixes),
    excludeGlobs: list(disclosure.excludeGlobs),
    extensions: list(disclosure.extensions),
  };
}

export interface ContentDisclosureReviewAttrs {
  backendUrl: string;
  apiKey?: string;
  readOnly: boolean;
  /** Read once, when the review opens. */
  codebase: CodebaseSummary;
  onGranted(updated: CodebaseSummary): void;
  onCancel(): void;
}

export class ContentDisclosureReview implements m.ClassComponent<ContentDisclosureReviewAttrs> {
  private codebaseId = '';
  private displayName = '';
  private disclosure: ContentDisclosure | undefined;
  private refreshed = false;
  private busy = false;
  private error: string | null = null;
  private mounted = true;

  oninit({attrs}: m.Vnode<ContentDisclosureReviewAttrs>): void {
    this.take(attrs.codebase);
  }

  onremove(): void {
    this.mounted = false;
  }

  private take(codebase: CodebaseSummary): void {
    this.codebaseId = codebase.codebaseId;
    this.displayName = codebase.displayName;
    this.disclosure = contentDisclosureSnapshot(codebase);
  }

  private async confirm(attrs: ContentDisclosureReviewAttrs): Promise<void> {
    const disclosure = this.disclosure;
    if (!disclosure || this.busy || attrs.readOnly) return;
    const isCurrent = () => this.mounted;
    this.busy = true;
    this.error = null;
    const granted = await runWhileCurrent(isCurrent, () =>
      authorizeCodebaseContent(attrs.backendUrl, this.codebaseId, disclosure.token, attrs.apiKey));
    if (!granted) return;
    if (granted.ok) {
      this.busy = false;
      attrs.onGranted(granted.value);
      return;
    }
    if (granted.error instanceof CodebaseApiError && granted.error.code === 'CODEBASE_CONSENT_DISCLOSURE_STALE') {
      // Show what would be granted now; the user decides again.
      const fresh = await runWhileCurrent(isCurrent, () => getCodebase(attrs.backendUrl, this.codebaseId, attrs.apiKey));
      if (!fresh) return;
      if (fresh.ok) {
        this.take(fresh.value);
        this.refreshed = true;
      } else {
        this.disclosure = undefined;
      }
      this.error = text(
        '源码范围或语言在你确认前发生了变化；请查看更新后的范围，再决定是否允许。',
        'The source scope or languages changed before you confirmed. Review the updated scope before allowing it.',
      );
    } else {
      this.error = errorMessage(granted.error, text('授权失败', 'Failed to allow source text'));
    }
    this.busy = false;
    m.redraw();
  }

  view({attrs}: m.Vnode<ContentDisclosureReviewAttrs>): m.Children {
    const list = (values: readonly string[], empty: string) => values.length > 0 ? values.join(', ') : empty;
    const disclosure = this.disclosure;
    return m('div', {style: {...STYLES.context, marginTop: '10px', marginBottom: 0}, role: 'group',
      'aria-label': text('允许发送正文', 'Allow source text')}, [
      m('div', {style: STYLES.name}, text(
        `允许把 ${this.displayName} 的源码正文发送给 AI 服务`,
        `Allow source text from ${this.displayName} to be sent to the AI service`,
      )),
      this.refreshed && disclosure
        ? m('div', {style: STYLES.error}, text('范围已更新，请重新确认。', 'The scope was updated; confirm again.'))
        : null,
      disclosure ? [
        m('div', {style: {...STYLES.meta, marginTop: '8px'}}, text(
          `包含范围：${list(disclosure.includePrefixes, '全部受支持源码')}`,
          `Included scope: ${list(disclosure.includePrefixes, 'all supported source')}`,
        )),
        m('div', {style: STYLES.meta}, text(
          `排除规则：${list(disclosure.excludeGlobs, '无')}`,
          `Exclusions: ${list(disclosure.excludeGlobs, 'none')}`,
        )),
        m('div', {style: STYLES.meta}, text(
          `语言：${list(disclosure.extensions, '无')}`,
          `Languages: ${list(disclosure.extensions, 'none')}`,
        )),
        m('div', {style: {...STYLES.subtitle, marginTop: '8px'}}, sourceAnalysisDisclosure()),
      ] : m('div', {style: STYLES.error}, text(
        '后端没有给出可确认的授权范围，暂时不能允许发送正文。',
        'The backend gave no scope to confirm, so source text cannot be allowed now.',
      )),
      this.error ? m('div', {style: STYLES.error, role: 'alert'}, this.error) : null,
      m('div', {style: STYLES.actions}, [
        m('button', {
          type: 'button',
          style: {...STYLES.button, ...STYLES.primary},
          disabled: attrs.readOnly || this.busy || !disclosure,
          'aria-busy': this.busy ? 'true' : 'false',
          onclick: () => this.confirm(attrs),
        }, this.busy ? text('授权中…', 'Allowing…') : text('确认允许', 'Allow')),
        m('button', {
          type: 'button',
          style: STYLES.button,
          disabled: this.busy,
          onclick: () => attrs.onCancel(),
        }, text('取消', 'Cancel')),
      ]),
    ]);
  }
}
