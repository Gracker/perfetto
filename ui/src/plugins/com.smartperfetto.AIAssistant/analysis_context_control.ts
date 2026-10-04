// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The per-turn analysis context control in the input bar: a chip that names
 * what the next question will use, and a popover with two independent parts,
 * source (off / locate only / send text) and knowledge bases, plus source
 * depth and where the selected material goes. It reads the shared catalog
 * (`analysis_catalog.ts`); registration, consent and indexing stay in
 * Settings, which "Manage…" opens.
 */

import m from 'mithril';

import {analysisCatalog, type CatalogIdentity} from './analysis_catalog';
import {
  analysisContextWithSourceMode,
  normalizeAnalysisContext,
  sourceDepthLabel,
  submittedAnalysisContext,
} from './analysis_context';
import {
  codebaseUnavailableReasonText,
  codebaseUsableInMode,
  knowledgeBaseRetired,
  knowledgeBaseRetiredText,
  knowledgeBaseSelectable,
  type CodebaseSummary,
  type KnowledgeBaseSummary,
} from './codebase_api';
import {uiText as text} from './ui_language';
import type {
  AnalysisContextSelection,
  CodeAwareAnalysisMode,
  RequestedSourceDepth,
  SubmittedAnalysisContext,
} from './types';

export interface AnalysisContextControlAttrs extends CatalogIdentity {
  selection: AnalysisContextSelection;
  /** A run is active: the context of this session cannot change. */
  disabled: boolean;
  /** The active provider's display name, when known. */
  providerName?: string;
  onChange(selection: AnalysisContextSelection): void;
  onManage(): void;
}

/** "Turn everything off" turns source off and clears knowledge, which the source mode does not cover. */
export function analysisContextAllOff(selection: AnalysisContextSelection): AnalysisContextSelection {
  return normalizeAnalysisContext({...normalizeAnalysisContext(selection), codeAwareMode: 'off', knowledgeSourceIds: []});
}

/** What the chip (and a submitted question's label) says: source, knowledge, depth. */
export function analysisContextSummary(context: SubmittedAnalysisContext | undefined): string {
  if (!context) return text('上下文：关闭', 'Context: off');
  const parts: string[] = [];
  if (context.codebaseLabels.length > 0) {
    const names = context.codebaseLabels.length > 2
      ? text(`${context.codebaseLabels.length} 个源码库`, `${context.codebaseLabels.length} codebases`)
      : context.codebaseLabels.join(', ');
    parts.push(context.codeAwareMode === 'provider_send'
      ? text(`源码 ${names}（正文）`, `Source ${names} (text)`)
      : text(`源码 ${names}（定位）`, `Source ${names} (locate)`));
    if (context.sourceDepth !== 'auto') parts.push(sourceDepthLabel(context.sourceDepth));
  }
  if (context.knowledgeSourceCount > 0) {
    parts.push(text(`知识库 ${context.knowledgeSourceCount}`, `${context.knowledgeSourceCount} knowledge base(s)`));
  }
  return parts.join(' · ');
}

/**
 * Where the effective selection goes, one line per kind of material. Locating
 * sends source positions, not text; source text and knowledge text are named
 * separately, so turning source off never reads as turning knowledge off.
 */
export function analysisContextDestinationLines(
  selection: AnalysisContextSelection,
  providerName: string | undefined,
): string[] {
  const normalized = normalizeAnalysisContext(selection);
  const name = providerName?.trim();
  // In Chinese a configured (often Latin) name follows a space; the Chinese fallback phrase does not.
  // Every Chinese line ends the name with full-width punctuation, which takes no space.
  const zhProvider = name ? ` ${name}` : '当前配置的 AI 服务';
  const enProvider = name || 'the configured AI service';
  const lines: string[] = [];
  const sourceSelected = normalized.codeAwareMode !== 'off' && normalized.codebaseIds.length > 0;
  if (sourceSelected && normalized.codeAwareMode === 'metadata_only') {
    lines.push(text(
      `源码只发送位置（文件、符号、行号）给${zhProvider}，不发送正文。`,
      `Only source positions (files, symbols, lines) go to ${enProvider}; no source text.`,
    ));
  }
  if (sourceSelected && normalized.codeAwareMode === 'provider_send') {
    lines.push(text(`相关源码正文片段会发送给${zhProvider}。`, `Relevant source text passages are sent to ${enProvider}.`));
  }
  if (normalized.knowledgeSourceIds.length > 0) {
    lines.push(text(`命中的知识库正文片段会发送给${zhProvider}。`, `Matching knowledge passages are sent to ${enProvider}.`));
  }
  if (lines.length === 0) {
    lines.push(text('本轮不使用源码或知识库。', 'This turn uses no source or knowledge.'));
  }
  return lines;
}

export class AnalysisContextControl implements m.ClassComponent<AnalysisContextControlAttrs> {
  private open = false;
  /** Attached only while the popover is open: it closes on an outside click or Esc, as the mode menu does. */
  private outsideClick: ((event: Event) => void) | null = null;
  private escapeKey: ((event: KeyboardEvent) => void) | null = null;
  private trigger: HTMLElement | null = null;

  onremove(): void {
    this.setOpen(false);
  }

  private setOpen(open: boolean, attrs?: AnalysisContextControlAttrs): void {
    this.open = open;
    if (open && !this.outsideClick) {
      this.outsideClick = (event: Event) => {
        const target = event.target as HTMLElement | null;
        if (!target?.closest?.('[data-analysis-context-control]')) {
          this.setOpen(false);
          m.redraw();
        }
      };
      this.escapeKey = (event: KeyboardEvent) => {
        if (event.key !== 'Escape') return;
        // Focus inside the popover returns to the trigger, which stays in the DOM.
        const focusInside = this.trigger?.parentElement?.contains(document.activeElement) === true;
        this.setOpen(false);
        m.redraw();
        if (focusInside) this.trigger?.focus();
      };
      document.addEventListener('click', this.outsideClick, true);
      document.addEventListener('keydown', this.escapeKey);
    } else if (!open && this.outsideClick) {
      document.removeEventListener('click', this.outsideClick, true);
      document.removeEventListener('keydown', this.escapeKey!);
      this.outsideClick = null;
      this.escapeKey = null;
    }
    // Lists are read on every open: consent and indexes change in Settings.
    if (open && attrs) void analysisCatalog.refresh(attrs);
  }

  private change(attrs: AnalysisContextControlAttrs, next: AnalysisContextSelection): void {
    if (attrs.disabled) return;
    attrs.onChange(normalizeAnalysisContext(next));
  }

  private codebaseStatus(codebase: CodebaseSummary, mode: CodeAwareAnalysisMode): string {
    if (!codebaseUsableInMode(codebase, 'metadata_only')) {
      return codebaseUnavailableReasonText(codebase.unavailableReason);
    }
    if (mode === 'provider_send' && codebase.eligibleForSendToProvider !== true) {
      return text('未允许发送正文，只能用于定位', 'Text not allowed; locate only');
    }
    return codebase.eligibleForSendToProvider === true
      ? text('可读取正文', 'Text allowed')
      : text('可定位', 'Locate');
  }

  private knowledgeStatus(source: KnowledgeBaseSummary, selectable: boolean): string {
    if (selectable) return text('可检索', 'Searchable');
    if (knowledgeBaseRetired(source)) return text('已停用', 'Retired');
    return source.hasActiveIndex
      ? text('未允许发送正文', 'Text not allowed')
      : text('未建索引', 'Not indexed');
  }

  private renderPopover(attrs: AnalysisContextControlAttrs): m.Children {
    const selection = normalizeAnalysisContext(attrs.selection);
    const mode = selection.codeAwareMode;
    const depth = selection.sourceDepth ?? 'auto';
    const sourceSelected = mode !== 'off' && selection.codebaseIds.length > 0;
    const modes: Array<{id: CodeAwareAnalysisMode; label: string}> = [
      {id: 'off', label: text('关闭', 'Off')},
      {id: 'metadata_only', label: text('仅定位', 'Locate only')},
      {id: 'provider_send', label: text('发送正文', 'Send text')},
    ];
    const depths: Array<{id: RequestedSourceDepth; title: string}> = [
      {id: 'auto', title: text('按问题判断要不要读实现', 'Decide from the question whether to read implementations')},
      {id: 'locate', title: text('只找位置，少量读取', 'Find locations, read little')},
      {id: 'mechanism', title: text('读实现，用于解释机制（耗时更长）', 'Read implementations to explain mechanisms (takes longer)')},
    ];
    const radio = (name: string, checked: boolean, disabled: boolean, label: string, onchange: () => void, title?: string) =>
      m('label.ai-context-control-option', {class: disabled ? 'disabled' : '', title}, [
        m('input[type=radio]', {name, checked, disabled, onchange}),
        m('span', label),
      ]);
    const catalog = analysisCatalog.read(attrs);
    const loading = catalog.status === 'loading' || catalog.status === 'empty';
    const knowledge = catalog.knowledgeBases;
    return m('div.ai-mode-menu.ai-context-control-popover', {role: 'dialog', 'aria-label': text('本轮分析上下文', 'Analysis context for this turn')}, [
      attrs.disabled
        ? m('div.ai-context-control-note', text('分析运行中，上下文不能修改。', 'An analysis is running; the context cannot change.'))
        : null,
      catalog.errors.length > 0 ? m('div.ai-context-control-error', catalog.errors.join(' · ')) : null,
      m('div.ai-context-control-section', [
        m('div.ai-context-control-heading', text('源码', 'Source')),
        m('div.ai-context-control-row', modes.map(option => radio(
          'ai-context-source-mode', mode === option.id, attrs.disabled || !catalog.featureEnabled, option.label,
          () => this.change(attrs, analysisContextWithSourceMode(selection, option.id, catalog.codebases)),
        ))),
        !catalog.featureEnabled
          ? m('div.ai-context-control-note', text('后端已关闭源码分析。', 'Source analysis is disabled on the backend.'))
          : catalog.codebases.length === 0 && !loading
            ? m('div.ai-context-control-note', text('还没有源码库，可在“管理…”中添加。', 'No codebases yet; add one under Manage….'))
            : catalog.codebases.map(codebase => {
                const usable = codebaseUsableInMode(codebase, mode);
                return m('label.ai-context-control-item', {class: !usable || mode === 'off' ? 'disabled' : ''}, [
                  m('input[type=checkbox]', {
                    checked: mode !== 'off' && selection.codebaseIds.includes(codebase.codebaseId),
                    disabled: attrs.disabled || mode === 'off' || !usable,
                    onchange: () => {
                      const ids = new Set(selection.codebaseIds);
                      ids.has(codebase.codebaseId) ? ids.delete(codebase.codebaseId) : ids.add(codebase.codebaseId);
                      this.change(attrs, {...selection, codebaseIds: [...ids]});
                    },
                  }),
                  m('span.ai-context-control-name', codebase.displayName),
                  m('span.ai-context-control-status', this.codebaseStatus(codebase, mode)),
                ]);
              }),
      ]),
      m('div.ai-context-control-section', [
        m('div.ai-context-control-heading', text('源码深度', 'Source depth')),
        m('div.ai-context-control-row', depths.map(option => radio(
          'ai-context-source-depth', depth === option.id, attrs.disabled || !sourceSelected, sourceDepthLabel(option.id),
          () => this.change(attrs, {...selection, sourceDepth: option.id}), option.title,
        ))),
      ]),
      m('div.ai-context-control-section', [
        m('div.ai-context-control-heading', text('知识库', 'Knowledge bases')),
        knowledge.length === 0 && !loading
          ? m('div.ai-context-control-note', text('还没有知识库，可在“管理…”中添加。', 'No knowledge bases yet; add one under Manage….'))
          : knowledge.map(source => {
              const selectable = knowledgeBaseSelectable(source);
              const checked = selection.knowledgeSourceIds.includes(source.sourceId);
              return [
                m('label.ai-context-control-item', {class: selectable ? '' : 'disabled'}, [
                  m('input[type=checkbox]', {
                    checked,
                    // An entry that can no longer be used may still be cleared, never chosen.
                    disabled: attrs.disabled || (!selectable && !checked),
                    onchange: () => {
                      const ids = new Set(selection.knowledgeSourceIds);
                      ids.has(source.sourceId) ? ids.delete(source.sourceId) : ids.add(source.sourceId);
                      this.change(attrs, {...selection, knowledgeSourceIds: [...ids]});
                    },
                  }),
                  m('span.ai-context-control-name', source.displayName),
                  m('span.ai-context-control-status', this.knowledgeStatus(source, selectable)),
                ]),
                knowledgeBaseRetired(source) ? m('div.ai-context-control-note', knowledgeBaseRetiredText()) : null,
              ];
            }),
      ]),
      m('div.ai-context-control-section', [
        m('div.ai-context-control-heading', text('数据去向', 'Where it goes')),
        analysisContextDestinationLines(selection, attrs.providerName)
          .map(line => m('div.ai-context-control-note', line)),
      ]),
      m('div.ai-context-control-actions', [
        m('button.ai-context-control-button', {
          type: 'button',
          disabled: attrs.disabled || (mode === 'off' && selection.knowledgeSourceIds.length === 0),
          onclick: () => this.change(attrs, analysisContextAllOff(selection)),
        }, text('全部关闭', 'Turn all off')),
        m('button.ai-context-control-button', {
          type: 'button',
          onclick: () => {
            this.setOpen(false);
            attrs.onManage();
          },
        }, text('管理…', 'Manage…')),
      ]),
    ]);
  }

  view({attrs}: m.Vnode<AnalysisContextControlAttrs>): m.Children {
    const submitted = submittedAnalysisContext(attrs.selection, analysisCatalog.read(attrs).codebases);
    const summary = analysisContextSummary(submitted);
    // The summary may be cut or hidden in a narrow panel (styles.scss), so the
    // label and the title always carry it whole.
    const label = `${text('本轮使用的源码与知识库', 'Source and knowledge used by this turn')}: ${summary}`;
    return m('div.ai-mode-selector.ai-context-control', {'data-analysis-context-control': ''}, [
      m('button.ai-mode-trigger.ai-context-control-trigger', {
        type: 'button',
        // The icon alone still shows whether this turn uses any source or knowledge.
        class: submitted ? 'active' : '',
        title: label,
        'aria-label': label,
        'aria-haspopup': 'dialog',
        'aria-expanded': this.open ? 'true' : 'false',
        oncreate: (vnode: m.VnodeDOM) => {
          this.trigger = vnode.dom as HTMLElement;
        },
        onclick: (event: MouseEvent) => {
          event.preventDefault();
          event.stopPropagation();
          this.setOpen(!this.open, attrs);
        },
      }, [
        m('i.pf-icon', 'source'),
        m('span.ai-context-control-summary', summary),
        m('i.pf-icon.ai-context-control-arrow', 'keyboard_arrow_down'),
      ]),
      this.open ? this.renderPopover(attrs) : null,
    ]);
  }
}
