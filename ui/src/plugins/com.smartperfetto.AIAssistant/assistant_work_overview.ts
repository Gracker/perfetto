// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import m from 'mithril';
import type {AssistantWorkCatalogResponse, AssistantWorkItem} from './generated/data_contract.types';
import type {ConversationClientConfig} from './conversation_client';
import {readAssistantWork, readAssistantWorkDetail, downloadAssistantWorkReport,
  type AssistantWorkDetail} from './assistant_work_client';
import {assistantWorkPhaseText, renderAssistantWorkDetails} from './assistant_work';
import {formatMessage} from './data_formatter';
import {uiText} from './ui_language';

interface Attrs {
  config: ConversationClientConfig;
  canRead: boolean;
  authorityKey: string;
  /** Checks the captured owner and sources synchronously, without waiting for redraw. */
  isCurrent(): boolean;
  canContinue: boolean;
  onContinue(sessionId: string, signal: AbortSignal): Promise<void>;
}
function markdown(text: string): m.Vnode {
  const render = ({dom}: m.VnodeDOM) => {dom.innerHTML = formatMessage(text);};
  return m('div.ai-work-detail-body', {oncreate: render, onupdate: render});
}
function label(item: AssistantWorkItem): string {
  return item.surface === 'conversation' ? uiText('对话', 'Conversation') : uiText('Trace 分析', 'Trace analysis');
}

/** A read-only directory and detail surface, independent of the active conversation stream. */
export class AssistantWorkOverview implements m.ClassComponent<Attrs> {
  private expanded = false;
  private filter: AssistantWorkCatalogResponse['filter'] = 'needs_input';
  private items: AssistantWorkItem[] = [];
  private nextCursor?: string;
  private loaded = false;
  private listController?: AbortController;
  private detailController?: AbortController;
  private listError = '';
  private detailError = '';
  private selected?: AssistantWorkItem;
  private detail?: AssistantWorkDetail;
  private continuing = false;
  private removed = false;
  private authorityKey = '';

  oninit({attrs}: m.Vnode<Attrs>): void {this.authorityKey = attrs.authorityKey;}
  onbeforeupdate({attrs}: m.Vnode<Attrs>): void {
    if (this.authorityKey === attrs.authorityKey) return;
    this.authorityKey = attrs.authorityKey;
    this.listController?.abort(); this.listController = undefined;
    this.close(); this.items = []; this.loaded = false; this.nextCursor = undefined;
    this.expanded = false; this.listError = '';
  }

  onremove(): void {
    this.removed = true;
    this.listController?.abort(); this.detailController?.abort();
  }

  private async load(attrs: Attrs, more = false): Promise<void> {
    if (!attrs.canRead || !attrs.isCurrent()) return;
    this.listController?.abort();
    const controller = new AbortController(); this.listController = controller;
    const filter = this.filter;
    this.listError = '';
    try {
      const page = await readAssistantWork(attrs.config, filter, controller.signal, more ? this.nextCursor : undefined);
      if (this.removed || !attrs.isCurrent() || controller.signal.aborted || this.listController !== controller || this.filter !== filter) return;
      const items = more ? [...this.items, ...page.items] : page.items;
      this.items = [...new Map(items.map(item => [item.work.sessionId, item])).values()];
      this.nextCursor = page.nextCursor; this.loaded = true;
    } catch (error) {
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted && this.listController === controller) {
        this.listError = uiText('无法读取工作概览：', 'Could not read work overview: ') +
          (error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.listController === controller) this.listController = undefined;
      if (!this.removed) m.redraw();
    }
  }

  private async open(attrs: Attrs, item: AssistantWorkItem): Promise<void> {
    if (!attrs.isCurrent()) return;
    this.detailController?.abort();
    const controller = new AbortController(); this.detailController = controller;
    this.selected = item; this.detail = undefined; this.detailError = '';
    try {
      const detail = await readAssistantWorkDetail(attrs.config, item, controller.signal);
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted && this.detailController === controller) this.detail = detail;
    } catch (error) {
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted && this.detailController === controller) {
        this.detailError = uiText('无法读取详情：', 'Could not read details: ') +
          (error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (this.detailController === controller) this.detailController = undefined;
      if (!this.removed) m.redraw();
    }
  }

  private close(): void {
    this.detailController?.abort(); this.detailController = undefined;
    this.selected = undefined; this.detail = undefined; this.detailError = '';
  }

  private async continue(attrs: Attrs): Promise<void> {
    if (!attrs.isCurrent() || !attrs.canContinue || this.continuing || this.detail?.kind !== 'conversation') return;
    const selected = this.selected;
    if (!selected) return;
    this.continuing = true; this.detailError = '';
    const controller = new AbortController(); this.detailController = controller;
    try {
      await attrs.onContinue(selected.work.sessionId, controller.signal);
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted && this.selected === selected) this.close();
    } catch (error) {
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted && this.selected === selected) {
        this.detailError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (this.detailController === controller) this.detailController = undefined;
      this.continuing = false; if (!this.removed) m.redraw();
    }
  }

  private async download(attrs: Attrs, url: string): Promise<void> {
    if (!attrs.isCurrent() || this.detailController) return;
    const controller = new AbortController(); this.detailController = controller; this.detailError = '';
    try {await downloadAssistantWorkReport(attrs.config, url, controller.signal,
      () => !this.removed && this.detailController === controller && attrs.isCurrent());}
    catch (error) {
      if (!this.removed && attrs.isCurrent() && !controller.signal.aborted) this.detailError = uiText('报告不可用：', 'Report unavailable: ') +
        (error instanceof Error ? error.message : String(error));
    } finally {
      if (this.detailController === controller) this.detailController = undefined;
      if (!this.removed) m.redraw();
    }
  }

  view({attrs}: m.Vnode<Attrs>): m.Children {
    const detail = this.detail;
    const reportUrl = this.selected?.reportId ? `/api/reports/${encodeURIComponent(this.selected.reportId)}`
      : detail?.kind === 'analysis' ? detail.reportUrl : undefined;
    return m('section.ai-work-overview', [
      m('button', {'data-work-overview-toggle': '', disabled: !attrs.canRead, 'aria-expanded': this.expanded,
        onclick: () => {
          this.expanded = !this.expanded;
          if (this.expanded && !this.loaded) void this.load(attrs);
        }}, uiText('工作概览', 'Work overview')),
      this.expanded ? [
        m('div.ai-work-toolbar', [
          ...(['needs_input', 'recent'] as const).map(filter => m('button', {
            'data-work-filter': filter, 'aria-pressed': this.filter === filter,
            onclick: () => {
              if (this.filter === filter) return;
              this.filter = filter; this.items = []; this.loaded = false; this.nextCursor = undefined;
              void this.load(attrs);
            }}, filter === 'needs_input' ? uiText('需要输入', 'Needs input') : uiText('最近工作', 'Recent work'))),
          m('button', {disabled: Boolean(this.listController), onclick: () => void this.load(attrs)}, uiText('刷新', 'Refresh')),
        ]),
        this.listController ? m('p', {role: 'status'}, uiText('正在读取…', 'Loading…')) : null,
        this.listError ? m('p.ai-work-error', {role: 'alert'}, this.listError) : null,
        this.loaded && !this.items.length && !this.listError ? m('p', this.nextCursor
          ? uiText('本页状态已变化，可继续查看更多。', 'States on this page changed. Continue to see more.')
          : this.filter === 'needs_input' ? uiText('当前没有需要补充或选择的工作。', 'No work currently needs input.')
            : uiText('还没有可查看的工作记录。', 'No work records yet.')) : null,
        m('ul.ai-work-list', this.items.map(item => m('li.ai-work-item', {key: item.work.sessionId}, [
          m('div', [m('strong', label(item)),
            m('span.ai-work-phase', assistantWorkPhaseText(item.work.phase)),
            item.work.startedAt !== undefined ? m('time', new Date(item.work.startedAt).toLocaleString()) : null,
            item.metadata === 'unavailable' ? m('span.ai-work-error', item.metadataReason === 'latest_run_ambiguous'
              ? uiText('无法确定最近一轮，可查看会话历史', 'Latest run is uncertain; session history is available')
              : uiText('部分记录不可用', 'Some metadata is unavailable')) : null,
          ]),
          m('button', {'data-work-open': item.work.sessionId, onclick: () => void this.open(attrs, item)},
            item.metadataReason === 'latest_run_ambiguous' ? uiText('查看会话历史', 'View session history')
              : item.surface === 'conversation' ? uiText('查看对话', 'View conversation')
              : item.result ? uiText('查看结果', 'View result') : uiText('查看会话历史', 'View session history')),
        ]))),
        this.nextCursor ? m('button', {disabled: Boolean(this.listController), onclick: () => void this.load(attrs, true)},
          uiText('查看更多', 'Show more')) : null,
      ] : null,
      this.selected ? m('aside.ai-work-drawer', {'aria-label': uiText('工作详情', 'Work details')}, [
        m('header', [m('h2', label(this.selected)),
          m('button', {'data-work-close': '', onclick: () => this.close()}, uiText('关闭', 'Close'))]),
        m('p', assistantWorkPhaseText(this.selected.work.phase)),
        detail?.kind === 'analysis' ? m('p.ai-work-detail-scope', detail.exactRun
          ? uiText('对应所选运行的结果', 'Result for the selected run')
          : uiText('会话历史，可能与所选运行不同', 'Session history; it may differ from the selected run')) : null,
        this.detailController ? m('p', {role: 'status'}, uiText('正在读取…', 'Loading…')) : null,
        this.detailError ? m('p.ai-work-error', {role: 'alert'}, this.detailError) : null,
        detail?.kind === 'conversation' ? [
          detail.conversation.traceContext.kind === 'attached'
            ? m('p', uiText('此对话已附加 Trace', 'This conversation has an attached trace')) : null,
          detail.conversation.history.map((message, index) => m('article.ai-work-detail-message', {key: index}, [
            m('strong', message.role === 'user' ? uiText('你', 'You') : 'AI'),
            markdown(message.content),
            message.turn?.partial ? m('p', uiText('本轮未完整交付，请保留未完成项。', 'This turn is incomplete; retain its open questions.')) : null,
          ])),
          m('button', {'data-work-continue': '', disabled: !attrs.canContinue || this.continuing,
            title: !attrs.canContinue ? uiText('请先完成当前分析或未决请求；查看详情不会停止它。',
              'Finish the current analysis or pending request first; viewing details does not stop it.') : undefined,
            onclick: () => void this.continue(attrs)}, uiText('继续此对话', 'Continue this conversation')),
        ] : detail?.kind === 'analysis' ? [
          detail.body ? markdown(detail.body) : m('p', uiText('没有可读取的结论正文。', 'No conclusion body is available.')),
          m('details.ai-work-result-record', [m('summary', uiText('完整结果与核验记录', 'Full result and verification record')),
            m('pre', JSON.stringify(detail.record, null, 2))]),
        ] : null,
        reportUrl ? m('button', {disabled: Boolean(this.detailController), onclick: () => void this.download(attrs, reportUrl)},
          uiText('下载原始报告', 'Download original report')) : null,
        renderAssistantWorkDetails(this.selected.work),
      ]) : null,
    ]);
  }
}
