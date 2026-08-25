// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import type {App} from '../../public/app';
import {BackendUploader} from '../../core/backend_uploader';
import {getSmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {buildWorkspaceTraceViewerHash} from '../../core/workspace_trace_launch';
import {isSmartPerfettoOidcMode} from '../../core/smartperfetto_auth';

import {
  analysisContextRequiresFullMode,
  loadAnalysisContext,
} from './analysis_context';
import {formatMessage} from './data_formatter';
import {resolveChatInputKeyAction} from './chat_input';
import {
  cancelConversationRun,
  streamConversationRun,
  type ConversationFullHandoff,
  type ConversationRunReceipt,
} from './conversation_client';
import {
  appendConversationMessage,
  clearConversationStore,
  clearConversationRuntimeIdentities,
  loadConversationStore,
  saveConversationStore,
  type StoredConversation,
  type StoredConversationMessage,
} from './conversation_store';
import {sessionManager} from './session_manager';
import {
  ConversationStartInvalidatedError,
  ConversationStartQueue,
} from './conversation_start_queue';
import {conversationTraceContextResetNotice} from './conversation_context_notice';
import {uiText} from './ui_language';
import {
  PageAuthLifecycle,
  type PageAuthTransition,
} from './page_auth_lifecycle';
import {TracePairWorkspace} from './trace_pair_workspace';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {
  loadPersistedTracePairWorkspace,
  persistTracePairWorkspace,
} from './trace_pair_workspace_persistence';

function messageId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function renderMessageContent(message: StoredConversationMessage): m.Vnode {
  return m('div.ai-conversation-page-message-content', {
    oncreate: ({dom}) => {
      (dom as HTMLElement).innerHTML = formatMessage(message.content);
    },
    onupdate: ({dom}) => {
      (dom as HTMLElement).innerHTML = formatMessage(message.content);
    },
  });
}

export class ConversationPage implements m.ClassComponent<{app: App}> {
  private readonly authLifecycle = new PageAuthLifecycle(
    (transition) => this.handleAuthTransition(transition),
  );
  private readonly settings = sessionManager.loadSettings();
  private readonly traceUploader = new BackendUploader(
    this.settings.backendUrl,
    this.settings.backendApiKey,
  );
  private readonly tracePairWorkspaceController =
    new TracePairWorkspaceController();
  private unsubscribeTracePair?: () => void;
  private store: StoredConversation = loadConversationStore(this.settings.backendUrl);
  private readonly startQueue = new ConversationStartQueue(
    () => this.store.sessionId,
    (sessionId) => {
      this.store = {...this.store, sessionId};
      saveConversationStore(this.store);
    },
  );
  private input = '';
  private isComposing = false;
  private activeReceipt?: ConversationRunReceipt;
  private activeController?: AbortController;
  private requestOrdinal = 0;
  private error = '';

  oncreate(): void {
    this.authLifecycle.mount();
    if (!isSmartPerfettoOidcMode()) {
      this.tracePairWorkspaceController.setUploadHandler(
        async (_pane, file) => {
          const result = await this.traceUploader.upload({type: 'FILE', file});
          if (!result.success || !result.traceId) {
            throw new Error(result.error || uiText(
              'Trace 上传失败',
              'Trace upload failed',
            ));
          }
          return {
            id: result.traceId,
            filename: file.name,
            size: file.size,
            uploadedAt: new Date().toISOString(),
          };
        },
      );
      this.restoreTracePairWorkspace();
      this.unsubscribeTracePair =
        this.tracePairWorkspaceController.subscribe(() => {
          persistTracePairWorkspace(
            this.tracePairWorkspaceController.getState(),
            this.settings.backendUrl,
          );
        });
    }
  }

  onremove(): void {
    ++this.requestOrdinal;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    this.unsubscribeTracePair?.();
    this.unsubscribeTracePair = undefined;
    this.tracePairWorkspaceController.setUploadHandler(undefined);
    const authState = this.authLifecycle.getState();
    if (authState.kind === 'ready' && authState.authority.oidc) {
      this.startQueue.reset({persist: false});
      clearConversationRuntimeIdentities();
    }
    this.authLifecycle.dispose();
  }

  view({attrs}: m.Vnode<{app: App}>): m.Children {
    const pendingHandoff = [...this.store.messages].reverse().find(
      (message) => message.fullHandoff,
    )?.fullHandoff;
    return m('main.ai-conversation-page', [
      m(TracePairWorkspace, {
        controller: this.tracePairWorkspaceController,
        onAssistant: () => this.launchTracePairAnalysis(attrs.app),
      }),
      m('header.ai-conversation-page-header', [
        m('div', [
          m('h1', uiText('AI 对话', 'AI Conversation')),
          m('p', uiText(
            '当前未附加 Trace。可以讨论需求、性能原理、分析方法和已授权源码；Trace 结论会明确标注证据边界。',
            'No trace is attached. Discuss requirements, performance concepts, analysis methods, or authorized source code; trace claims will state their evidence boundary.',
          )),
        ]),
        m('div.ai-conversation-page-header-actions', [
          m('button', {
            'data-open-zero-trace-pair': '',
            'disabled': isSmartPerfettoOidcMode(),
            'onclick': () => this.openTracePairWorkspace(),
            'title': isSmartPerfettoOidcMode()
              ? uiText(
                  'OIDC Viewer 使用页面本地 Trace，不支持后端双窗上传',
                  'OIDC Viewer uses page-local traces and does not support backend dual uploads',
                )
              : uiText('打开空双窗并上传两份 Trace', 'Open empty dual view and upload two traces'),
          }, uiText('双 Trace', 'Dual Trace')),
          m('button', {
            onclick: () => void this.startNewConversation(),
          }, uiText('新对话', 'New conversation')),
        ]),
      ]),
      m('section.ai-conversation-page-thread',
        this.store.messages.length > 0
          ? this.store.messages.map((message) => m(
              `article.ai-conversation-page-message.ai-conversation-page-message-${message.role}`,
              {key: message.id},
              [
                m('div.ai-conversation-page-role', message.role === 'user' ? uiText('你', 'You') : 'AI'),
                renderMessageContent(message),
                message.evidence?.length
                  ? m('details.ai-conversation-sources', [
                      m('summary', uiText(
                        `来源 ${message.evidence.length}`,
                        `${message.evidence.length} source(s)`,
                      )),
                      m('ul', message.evidence.map((item) => m('li', [
                        item.label,
                        item.source ? ` · ${item.source}` : '',
                      ]))),
                    ])
                  : null,
              ],
            ))
          : m('div.ai-conversation-page-empty', [
              m('h2', uiText('从问题开始，不从流程开始', 'Start with the question, not a workflow')),
              m('p', uiText(
                '我会先理解你的目标；信息不够时会停下来问你，而不是自行跑完整分析。',
                'The assistant first understands your goal and pauses for missing information instead of launching a full analysis by itself.',
              )),
            ]),
      ),
      pendingHandoff
        ? this.renderFullHandoff(attrs.app, pendingHandoff)
        : null,
      this.activeReceipt
        ? m('div.ai-conversation-page-running', uiText(
            '正在回答。你可以继续输入来修正方向；新消息会先停止当前运行。',
            'Answering. You can send another message to steer the response; it will stop the current run first.',
          ))
        : null,
      this.error ? m('div.ai-conversation-page-error', this.error) : null,
      m('footer.ai-conversation-page-composer', [
        m('textarea', {
          value: this.input,
          placeholder: uiText(
            '输入问题；Enter 发送，Shift+Enter 换行',
            'Enter a question; Enter sends and Shift+Enter adds a line',
          ),
          oninput: (event: Event) => {
            this.input = (event.target as HTMLTextAreaElement).value;
          },
          oncompositionstart: () => { this.isComposing = true; },
          oncompositionend: () => { this.isComposing = false; },
          onkeydown: (event: KeyboardEvent) => {
            const action = resolveChatInputKeyAction(event, this.isComposing);
            if (action === 'submit') {
              event.preventDefault();
              void this.send();
            }
          },
        }),
        m('button.ai-conversation-page-send', {
          disabled: !this.input.trim(),
          onclick: () => void this.send(),
        }, this.activeReceipt ? uiText('修正方向', 'Steer') : uiText('发送', 'Send')),
      ]),
    ]);
  }

  private tracePairScope() {
    const context = getSmartPerfettoRequestContext();
    return {
      key: [
        context.tenantId,
        context.userId,
        context.workspaceId,
        this.settings.backendUrl.replace(/\/+$/, ''),
        'zero-start',
      ].join(':'),
      backendUrl: this.settings.backendUrl,
    };
  }

  private openTracePairWorkspace(): void {
    if (isSmartPerfettoOidcMode()) return;
    this.tracePairWorkspaceController.open({scope: this.tracePairScope()});
  }

  private restoreTracePairWorkspace(): void {
    const saved = loadPersistedTracePairWorkspace(this.settings.backendUrl);
    if (!saved) return;
    this.tracePairWorkspaceController.open({scope: this.tracePairScope()});
    const catalog = [saved.baseline, saved.comparison].filter(
      (trace): trace is NonNullable<typeof trace> => trace !== undefined,
    );
    this.tracePairWorkspaceController.setCatalog(catalog);
    if (saved.baseline) {
      this.tracePairWorkspaceController.selectTrace({
        pane: 'first',
        traceId: saved.baseline.id,
      });
    }
    if (saved.comparison) {
      this.tracePairWorkspaceController.selectTrace({
        pane: 'second',
        traceId: saved.comparison.id,
      });
    }
    this.tracePairWorkspaceController.setLayout(saved.layout);
    this.tracePairWorkspaceController.setSplitPercent(saved.splitPercent);
    if (!saved.open) this.tracePairWorkspaceController.close();
  }

  private launchTracePairAnalysis(app: App): void {
    const state = this.tracePairWorkspaceController.getState();
    if (!state.currentTrace || !state.referenceTrace) return;
    this.tracePairWorkspaceController.close();
    persistTracePairWorkspace(state, this.settings.backendUrl);
    app.navigate(
      buildWorkspaceTraceViewerHash({
        id: state.currentTrace.id,
        filename: state.currentTrace.filename,
      }),
    );
  }

  private renderFullHandoff(app: App, handoff: ConversationFullHandoff): m.Children {
    return m('aside.ai-conversation-full-handoff', [
      m('div', [
        m('strong', uiText('建议使用完整分析', 'Full analysis recommended')),
        m('span', ` · ${handoff.scope}`),
      ]),
      m('button', {
        onclick: () => app.navigate('#!/viewer'),
        title: uiText(
          '完整分析需要先打开或上传 Trace；交接信息会保留。',
          'Open or upload a trace before full analysis. The handoff will be preserved.',
        ),
      }, uiText('打开 Trace 后继续', 'Open a trace to continue')),
    ]);
  }

  private async startNewConversation(): Promise<void> {
    const authority = this.authLifecycle.capture();
    if (!authority) return;
    const active = this.activeReceipt;
    ++this.requestOrdinal;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    this.startQueue.reset();
    this.store = clearConversationStore(this.settings.backendUrl);
    this.input = '';
    this.error = '';
    m.redraw();
    if (!active || !this.authLifecycle.isCurrent(authority)) return;
    await cancelConversationRun({
      backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey,
    }, active.sessionId, active.runId).catch(() => undefined);
  }

  private async send(): Promise<void> {
    const query = this.input.trim();
    if (!query) return;
    const authority = this.authLifecycle.capture();
    if (!authority) {
      this.error = uiText(
        '登录会话尚未就绪，请重新登录后重试。',
        'Your sign-in session is not ready. Sign in again and retry.',
      );
      return;
    }
    const controller = this.authLifecycle.createAbortController(authority);
    this.activeController?.abort();
    this.activeController = controller;
    if (this.store.traceId) {
      this.startQueue.reset();
      this.store = {...this.store, sessionId: undefined, traceId: undefined};
      saveConversationStore(this.store);
      this.store = appendConversationMessage(this.settings.backendUrl, {
        id: messageId('assistant'),
        role: 'assistant',
        content: conversationTraceContextResetNotice(),
        timestamp: Date.now(),
      });
    }
    const ordinal = ++this.requestOrdinal;
    const analysisContext = loadAnalysisContext(
      this.settings.backendUrl,
      authority.context,
    );
    this.input = '';
    this.error = '';
    this.store = appendConversationMessage(this.settings.backendUrl, {
      id: messageId('user'),
      role: 'user',
      content: query,
      timestamp: Date.now(),
      privateContent: analysisContextRequiresFullMode(analysisContext),
    }, this.store.sessionId);
    m.redraw();
    try {
      const receipt = await this.startQueue.enqueue({
        backendUrl: this.settings.backendUrl,
        apiKey: this.settings.backendApiKey,
      }, {
        query,
        analysisContext,
      });
      if (
        ordinal !== this.requestOrdinal ||
        !this.authLifecycle.isCurrent(authority)
      ) {
        await cancelConversationRun({
          backendUrl: this.settings.backendUrl,
          apiKey: this.settings.backendApiKey,
        }, receipt.sessionId, receipt.runId).catch(() => undefined);
        return;
      }
      this.activeReceipt = receipt;
      m.redraw();
      const outcome = await streamConversationRun({
        backendUrl: this.settings.backendUrl,
        apiKey: this.settings.backendApiKey,
      }, receipt, {signal: controller.signal});
      if (
        ordinal !== this.requestOrdinal ||
        !this.authLifecycle.isCurrent(authority) ||
        outcome.kind === 'cancelled'
      ) return;
      this.store = appendConversationMessage(this.settings.backendUrl, {
        id: messageId('assistant'),
        role: 'assistant',
        content: outcome.message,
        timestamp: Date.now(),
        evidence: outcome.evidence,
        outcomeKind: outcome.kind,
        ...(outcome.kind === 'recommend_full' ? {fullHandoff: outcome.handoff} : {}),
      }, receipt.sessionId);
    } catch (error) {
      if (
        controller.signal.aborted ||
        error instanceof ConversationStartInvalidatedError ||
        !this.authLifecycle.isCurrent(authority)
      ) return;
      if (ordinal === this.requestOrdinal) {
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.authLifecycle.releaseAbortController(controller);
      if (this.activeController === controller) {
        this.activeController = undefined;
      }
      if (ordinal === this.requestOrdinal) this.activeReceipt = undefined;
      m.redraw();
    }
  }

  private handleAuthTransition(transition: PageAuthTransition): void {
    if (!transition.authorityChanged) return;
    ++this.requestOrdinal;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    this.startQueue.reset({persist: false});
    clearConversationRuntimeIdentities();
    if (transition.current.kind === 'ready') {
      this.store = loadConversationStore(this.settings.backendUrl);
      this.error = '';
    } else {
      this.store = {
        ...this.store,
        sessionId: undefined,
        traceId: undefined,
      };
    }
    m.redraw();
  }
}
