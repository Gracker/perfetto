// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import markdownit from 'markdown-it';
import {copyToClipboard} from '../../base/clipboard';
import {getLocalTraceAssetSource} from '../../core/trace_asset_source';
import {captureSelection, locateReference, type ChatSelection, type Focus} from './selection';
import type {Conversation, Message} from './conversation';
import './panel.scss';

export const t = (zh: string, en: string) => navigator.language.toLowerCase().startsWith('zh') ? zh : en;
export const title = () => t('Perfetto 对话', 'Perfetto Chat');
const md = markdownit({html: false, linkify: false});
md.validateLink = (url) => /^https?:\/\//i.test(url);
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index]!.content);
md.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
  tokens[index]!.attrSet('target', '_blank');
  tokens[index]!.attrSet('rel', 'noopener noreferrer');
  return renderer.renderToken(tokens, index, options);
};

function failure(code = ''): string {
  switch (code) {
    case 'MODEL_NOT_CONFIGURED': return t('请在服务端配置模型地址、名称和密钥。', 'Configure the model URL, name and API key on the backend.');
    case 'MODEL_RATE_LIMITED': return t('模型服务限流或额度不足，请稍后重试。', 'The model service is rate- or quota-limited. Try again later.');
    case 'MODEL_AUTH_FAILED': return t('模型服务拒绝了当前凭据，请检查服务端配置。', 'The model service rejected the backend credentials.');
    case 'FEATURE_UNAVAILABLE': return t('当前部署未启用此实验。', 'This experiment is disabled for the current deployment.');
    case 'SKILL_RUNTIME_UNAVAILABLE': return t('标准 Perfetto Skills 执行环境不可用。普通对话仍可使用。', 'The standard Perfetto Skills runtime is unavailable. Text chat is available.');
    case 'TRACE_UPLOAD_UNCONFIRMED':
    case 'TRACE_UNAVAILABLE': return t('无法确认这个 Trace 的后端文件。请重试附加或重新打开文件。', 'The backend file could not be confirmed. Retry attachment or reopen the trace.');
    case 'TRACE_TOO_LARGE': return t('Trace 超出实验支持的文件大小。', 'The trace exceeds the experiment’s file size limit.');
    case 'TRACE_SOURCE_UNSUPPORTED': return t('当前来源无法附加，请打开一个可分享和下载的本地单文件。', 'Open a shareable, downloadable local trace file to attach it.');
    case 'INVALID_SELECTION': return t('选区超出 Trace 范围，请重新选择。', 'The focus is outside the trace bounds. Select another range.');
    case 'CAPACITY_EXCEEDED':
    case 'TURN_ALREADY_ACTIVE': return t('当前有任务在处理，请稍后重试。', 'A task is still running. Try again when it finishes.');
    case 'SESSION_CONFIGURATION_CHANGED':
    case 'SESSION_UNAVAILABLE': return t('会话已失效，请新建对话。', 'This session expired. Start a new chat.');
    case 'CONNECTION_FAILED':
    case 'CONNECTION_INTERRUPTED': return t('连接中断，请重试。', 'The connection was interrupted. Try again.');
    case 'TURN_TIMED_OUT': return t('回答超时。', 'The reply timed out.');
    default: return t('未能完成回答，请重试。', 'The reply could not be completed. Try again.');
  }
}

function focusLabel(selection?: ChatSelection) {
  switch (selection?.kind) {
    case 'area': return t('选中区间', 'Selected range');
    case 'event': return t('选中事件', 'Selected event');
    case 'visible_window': return t('当前可视范围', 'Visible range');
    case 'whole_trace': return t('整份 Trace', 'Whole trace');
    default: return '';
  }
}

function toolLabel(tool?: string) {
  if (tool === 'read_perfetto_resource') return t('正在读取 Perfetto Skills', 'Reading Perfetto Skills');
  if (tool) return t('正在查询 Trace', 'Querying trace');
  return t('正在回复', 'Generating reply');
}

export class ChatPanel implements m.ClassComponent<{conversation: Conversation}> {
  private follow = true;
  private copied?: string;
  private copyFailed = false;

  private syncScroll(element: Element): void {
    if (this.follow) element.scrollTop = element.scrollHeight;
  }

  private message(conversation: Conversation, item: Message) {
    return m('article.pf-perfetto-chat__round', {key: item.id}, [
      m('.pf-perfetto-chat__question', item.text),
      item.selection && m('small', focusLabel(item.selection)),
      item.answer && m('.pf-perfetto-chat__answer', m.trust(md.render(item.answer))),
      item.status === 'running' && m('.pf-perfetto-chat__status', {role: 'status'}, toolLabel(item.tool)),
      item.status === 'stopped' && m('.pf-perfetto-chat__status', t('已停止', 'Stopped')),
      item.status === 'failed' && m('.pf-perfetto-chat__status', failure(item.code)),
      m('.pf-perfetto-chat__actions', [
        item.answer && item.status !== 'running' && m('button[type=button]', {
          onclick: async () => {
            try {
              await copyToClipboard(item.answer);
              this.copied = item.id;
              this.copyFailed = false;
            } catch {
              this.copyFailed = true;
            }
            m.redraw();
          },
        }, this.copied === item.id ? t('已复制', 'Copied') : t('复制', 'Copy')),
        ...item.references.map(ref => m('button[type=button]', {
          title: ref.label,
          onclick: () => {
            if (conversation.trace && conversation.traceId) locateReference(conversation.trace, conversation.traceId, ref);
          },
        }, t('在时间线查看', 'View on timeline'), ' · ', ref.label)),
      ]),
    ]);
  }

  view({attrs: {conversation: c}}: m.Vnode<{conversation: Conversation}>) {
    c.checkScope();
    const caps = c.capabilities;
    const trace = c.trace;
    const currentlyAttached = trace && c.traceId;
    const active = c.messages.at(-1)?.status === 'running';
    const usableSource = trace && getLocalTraceAssetSource(trace.traceInfo);
    return m('section.pf-perfetto-chat', {'aria-label': title()}, [
      m('header.pf-perfetto-chat__header', [
        m('.pf-perfetto-chat__heading', [
          m('h2', title()),
          caps?.profile && m('small', {title: caps.profile.origin}, caps.profile.model),
        ]),
        caps?.chat && m('button[type=button]', {onclick: () => c.reset(true)}, t('新对话', 'New chat')),
      ]),
      m('.pf-perfetto-chat__messages', {
        oncreate: (vnode: m.VnodeDOM) => this.syncScroll(vnode.dom),
        onupdate: (vnode: m.VnodeDOM) => this.syncScroll(vnode.dom),
        onscroll: (event: Event) => {
          const node = event.currentTarget as HTMLElement;
          this.follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        },
      }, [
        caps?.enabled && !caps.chat && m('p', failure('MODEL_NOT_CONFIGURED')),
        caps && !caps.enabled && m('p', failure('FEATURE_UNAVAILABLE')),
        !caps && !c.error && m('p', t('正在检查对话服务', 'Checking chat availability')),
        caps?.chat && !c.messages.length && m('p', trace
          ? t('问一个 Perfetto 问题，或附加当前 Trace 后分析选区。', 'Ask a Perfetto question or attach the trace to analyze a selection.')
          : t('问一个关于 Perfetto 或标准 Skills 的问题。', 'Ask a question about Perfetto or its standard Skills.')),
        m('div', c.messages.map(item => this.message(c, item))),
      ]),
      caps?.chat && m('.pf-perfetto-chat__composer', [
        trace && !currentlyAttached && m('.pf-perfetto-chat__actions', [
          m('button[type=button]', {
            disabled: c.pending || !caps.trace || !usableSource,
            title: !usableSource ? failure('TRACE_SOURCE_UNSUPPORTED') :
              !caps.trace ? failure('SKILL_RUNTIME_UNAVAILABLE') : trace.traceInfo.traceTitle,
            onclick: () => { c.consenting = true; },
          }, t('附加当前 Trace', 'Attach current trace')),
          !usableSource && m('small', failure('TRACE_SOURCE_UNSUPPORTED')),
          usableSource && !caps.trace && m('small', failure('SKILL_RUNTIME_UNAVAILABLE')),
        ]),
        c.consenting && trace && caps.profile && m('.pf-perfetto-chat__consent', [
          m('strong', trace.traceInfo.traceTitle),
          m('p', t('Trace 文件留在本机。查询结果和本轮选区可能发送给此模型服务。',
            'The trace file stays on this device. Query results and selection context may be sent to this model service.')),
          m('code', caps.profile.origin),
          m('.pf-perfetto-chat__actions', [
            m('button[type=button]', {disabled: c.pending, onclick: () => void c.attach()},
              c.pending ? t('正在准备 Trace', 'Preparing trace') : t('确认附加', 'Confirm attachment')),
            m('button[type=button]', {onclick: () => c.cancelAttachment()}, t('取消', 'Cancel')),
          ]),
        ]),
        currentlyAttached && trace && c.traceId && m('.pf-perfetto-chat__attachment', [
          m('strong', {title: trace.traceInfo.traceTitle}, trace.traceInfo.traceTitle),
          m('button[type=button]', {onclick: () => c.reset()}, t('移除 Trace', 'Remove trace')),
          m('label', [
            t('本轮关注范围', 'Next question focus'),
            m('select', {
              value: c.focus,
              onchange: (event: Event) => { c.focus = (event.currentTarget as HTMLSelectElement).value as Focus; },
            }, [
              m('option[value=selection]', t('跟随当前选区', 'Follow selection')),
              m('option[value=whole_trace]', t('整份 Trace', 'Whole trace')),
              m('option[value=visible_window]', t('当前可视范围', 'Visible range')),
            ]),
          ]),
          c.focus === 'selection' && m('small', focusLabel(captureSelection(trace, c.traceId, c.focus))),
        ]),
        m('form', {onsubmit: (event: Event) => { event.preventDefault(); void c.send(); }}, [
          m('textarea', {
            'aria-label': t('问题', 'Question'),
            placeholder: t('输入问题', 'Ask a question'),
            value: c.draft,
            maxlength: 4000,
            rows: 2,
            oninput: (event: InputEvent) => { c.draft = (event.currentTarget as HTMLTextAreaElement).value; },
            onkeydown: (event: KeyboardEvent) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
                event.preventDefault();
                void c.send();
              }
            },
          }),
          active ? m('button[type=button]', {
            disabled: c.stopping,
            onclick: () => void c.stop(),
          }, c.stopping ? t('正在停止', 'Stopping') : t('停止', 'Stop'))
            : m('button[type=submit]', {disabled: c.pending || !c.draft.trim()}, t('发送', 'Send')),
        ]),
      ]),
      (c.error || this.copyFailed) && m('.pf-perfetto-chat__status', {role: 'alert'},
        c.error ? failure(c.error) : t('复制失败。', 'Copy failed.')),
    ]);
  }
}
