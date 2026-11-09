// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import {assistantWorkPhaseText, renderAssistantWorkDetails} from './assistant_work';
import {AssistantWorkOverview} from './assistant_work_overview';
import type {ConversationContextRequest, ConversationStatusResponse} from './generated/data_contract.types';
import type {App} from '../../public/app';
import {BackendUploader} from '../../core/backend_uploader';
import {getSmartPerfettoRequestContext} from '../../core/smartperfetto_request_context';
import {buildWorkspaceTraceViewerHash} from '../../core/workspace_trace_launch';
import {isSmartPerfettoOidcMode} from '../../core/smartperfetto_auth';

import {
  analysisAuthorizationKey,
  analysisContextRequiresFullMode,
  loadAnalysisContext,
} from './analysis_context';
import {formatMessage} from './data_formatter';
import {resolveChatInputKeyAction} from './chat_input';
import {
  ConversationClientError,
  conversationSourceSelectionMatches,
  getConversationStatus,
  getConversation,
  appendConversationContext,
  cancelConversationRun,
  conversationContextRestartNotice,
  streamConversationRun,
  type ConversationFullHandoff,
  type ConversationOutcome,
  type ConversationRunReceipt,
} from './conversation_client';
import {
  appendConversationMessage,
  clearConversationStore,
  clearConversationRuntimeIdentities,
  conversationMessageContent,
  conversationStoreFromSnapshot,
  conversationAuthorityKey,
  conversationMessageId,
  conversationRecoveryNotice,
  conversationOutcomeTurn,
  conversationRestoreErrorMessage,
  ConversationRestoreInvalidatedError,
  invalidateConversationRestore,
  restoreConversationStore,
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
  type PageAuthorityToken,
} from './page_auth_lifecycle';
import type {AnalysisContextSelection} from './types';
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
      (dom as HTMLElement).innerHTML = formatMessage(conversationMessageContent(message));
    },
    onupdate: ({dom}) => {
      (dom as HTMLElement).innerHTML = formatMessage(conversationMessageContent(message));
    },
  });
}

function renderThreadMessage(message: StoredConversationMessage): m.Vnode {
  return m(
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
  );
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
  private store: StoredConversation = {backendUrl: this.settings.backendUrl, messages: [], updatedAt: Date.now()};
  private restorePromise?: Promise<void>;
  private restoreOrdinal = 0;
  private restoreContextKey = '';
  private readonly startQueue = new ConversationStartQueue(
    () => this.store.sessionId,
    (sessionId) => {
      this.store = {...this.store, sessionId, conversationId: sessionId};
      saveConversationStore(this.store);
    },
    undefined,
    () => this.ensureConversationRestored(),
  );
  private input = '';
  /** Only an explicit, reauthorized work-item open may retain an attached Trace on send. */
  private explicitContinuationSessionId?: string;
  private isComposing = false;
  private activeReceipt?: ConversationRunReceipt;
  private activeController?: AbortController;
  private requestOrdinal = 0;
  private error = '';
  private controlController?: AbortController;
  private controlOrdinal = 0;
  private controlStatus?: ConversationStatusResponse;
  private controlReadAt = 0;
  private controlNotice = '';
  private controlError = '';
  private sessionControlBinding?: {sessionId: string; sourceKey: string};
  private contextAttempt?: {sessionId: string; sourceKey: string; request: ConversationContextRequest};

  oncreate(): void {
    this.authLifecycle.mount();
    void this.ensureConversationRestored().catch(() => undefined);
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
    this.resetControls();
    ++this.restoreOrdinal;
    invalidateConversationRestore(this.settings.backendUrl);
    ++this.requestOrdinal;
    const active = this.activeReceipt;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    if (active) {
      void cancelConversationRun({
        backendUrl: this.settings.backendUrl,
        apiKey: this.settings.backendApiKey,
      }, active.sessionId, active.runId).catch(() => undefined);
    }
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
    const workAuthority = this.authLifecycle.capture();
    const workSourceKey = analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl,
      workAuthority?.context ?? getSmartPerfettoRequestContext()));
    const workRestoreOrdinal = this.restoreOrdinal;
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
          m('p', this.store.traceId ? uiText('此对话已附加 Trace。', 'This conversation has an attached trace.') : uiText(
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
      m(AssistantWorkOverview, {
        config: {backendUrl: this.settings.backendUrl, apiKey: this.settings.backendApiKey},
        canRead: Boolean(workAuthority),
        canContinue: this.canContinueWork(),
        authorityKey: `${conversationAuthorityKey(this.settings.backendUrl)}:${workSourceKey}:${workRestoreOrdinal}`,
        isCurrent: () => Boolean(workAuthority && this.authLifecycle.isCurrent(workAuthority) &&
          workRestoreOrdinal === this.restoreOrdinal && workSourceKey === analysisAuthorizationKey(
            loadAnalysisContext(this.settings.backendUrl, workAuthority.context))),
        onContinue: (sessionId: string, signal: AbortSignal) => this.continueWorkConversation(sessionId, signal),
      }),
      m('section.ai-conversation-page-thread',
        this.store.messages.length > 0
          ? [
              ...this.store.messages.map((message) => renderThreadMessage(message)),
            ]
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
      this.store.sessionId ? m('section.ai-conversation-controls', [
        m('button', {disabled: Boolean(this.controlController), onclick: () => void this.control('status')},
          uiText('查看进度', 'Check progress')),
        this.controlStatus ? m('span', {role: 'status'}, [
          assistantWorkPhaseText(this.controlStatus.work.phase),
          this.controlStatus.work.startedAt !== undefined ? uiText(
            ` · 已用时 ${Math.max(0, Math.floor(((this.controlStatus.work.completedAt ?? this.controlReadAt) - this.controlStatus.work.startedAt) / 1000))} 秒（本次查询）`,
            ` · ${Math.max(0, Math.floor(((this.controlStatus.work.completedAt ?? this.controlReadAt) - this.controlStatus.work.startedAt) / 1000))} s elapsed (at check)`) : '',
          this.controlStatus.context.availability === 'available' && this.controlStatus.context.pendingCount > 0
            ? uiText(` · ${this.controlStatus.context.pendingCount} 条补充待下一轮使用`,
              ` · ${this.controlStatus.context.pendingCount} note(s) queued for the next turn`) : '',
        ]) : null,
        this.controlStatus ? renderAssistantWorkDetails(this.controlStatus.work) : null,
        this.controlController ? m('span', {role: 'status'}, uiText('正在处理…', 'Working…')) : null,
      ]) : null,
      this.controlNotice ? m('div.ai-conversation-control-notice', {role: 'status'}, this.controlNotice) : null,
      this.controlError ? m('div.ai-conversation-page-error', {role: 'alert'}, this.controlError) : null,
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
        this.store.sessionId ? m('button.ai-conversation-page-supplement', {
          disabled: !this.input.trim() || Boolean(this.controlController),
          title: uiText('保留当前运行，在你的下一轮提问中使用；后端重启后需重新提交。',
            'Keep the current run. Use this note with your next question; resubmit after a backend restart.'),
          onclick: () => void this.control('context'),
        }, uiText('补充到下一轮', 'Add for next turn')) : null,
        m('button.ai-conversation-page-send', {
          disabled: !this.input.trim(),
          onclick: () => void this.send(),
        }, this.activeReceipt
          ? uiText('修正方向', 'Steer')
          : uiText('发送', 'Send')),
      ]),
    ]);
  }

  private resetControls(): void {
    ++this.controlOrdinal;
    if (this.controlController) {
      this.controlController.abort();
      this.authLifecycle.releaseAbortController(this.controlController);
    }
    this.controlController = undefined;
    this.controlStatus = undefined;
    this.contextAttempt = undefined;
    this.controlNotice = '';
    this.controlError = '';
  }

  private async control(action: 'status' | 'context'): Promise<void> {
    const sessionId = this.store.sessionId;
    const authority = this.authLifecycle.capture();
    const text = this.input;
    if (!sessionId || !authority || this.controlController || (action === 'context' && !text.trim())) return;
    const ordinal = ++this.controlOrdinal;
    const requestOrdinal = this.requestOrdinal;
    const restoreOrdinal = this.restoreOrdinal;
    const contextKey = analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    const matchesSessionContext = this.sessionControlBinding?.sessionId === sessionId &&
      this.sessionControlBinding.sourceKey === contextKey;
    if (action === 'context' && !matchesSessionContext) {
      this.controlError = uiText('当前来源选择尚未绑定到此对话。请先使用当前选择发送一轮问题，再补充说明；输入已保留。',
        'The current source selection is not bound to this conversation. Send a question with this selection before adding notes; your input is preserved.');
      m.redraw(); return;
    }
    const controller = this.authLifecycle.createAbortController(authority);
    this.controlController = controller;
    this.controlError = '';
    const current = () => !controller.signal.aborted && ordinal === this.controlOrdinal &&
      requestOrdinal === this.requestOrdinal && restoreOrdinal === this.restoreOrdinal &&
      sessionId === this.store.sessionId && this.authLifecycle.isCurrent(authority) &&
      contextKey === analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    const config = {backendUrl: this.settings.backendUrl, apiKey: this.settings.backendApiKey};
    m.redraw();
    try {
      if (action === 'status') {
        const status = await getConversationStatus(config, sessionId, controller.signal);
        if (current()) {
          if (!matchesSessionContext) this.controlNotice = uiText('这是已有对话的状态；其来源可能与当前选择不同。',
            'This is the existing conversation; its sources may differ from the current selection.');
          const previousContext = this.controlStatus?.context;
          const epoch = this.contextAttempt?.request.expectedQueueEpoch ??
            (previousContext?.availability === 'available' ? previousContext.queueEpoch : undefined);
          if (epoch && (status.context.availability !== 'available' || epoch !== status.context.queueEpoch)) {
            this.contextAttempt = undefined;
            this.controlNotice = uiText('先前暂存的补充已不可用，请重新提交；这不表示它们已经被读取。',
              'Previously queued notes are unavailable. Submit them again; this does not mean they were read.');
          }
          this.controlStatus = status;
          this.controlReadAt = Date.now();
        }
        return;
      }
      let attempt = this.contextAttempt;
      if (!attempt || attempt.sessionId !== sessionId || attempt.sourceKey !== contextKey || attempt.request.text !== text) {
        const status = await getConversationStatus(config, sessionId, controller.signal);
        if (!current()) return;
        this.controlStatus = status;
        this.controlReadAt = Date.now();
        if (status.context.availability !== 'available' || !status.work.runId) {
          throw new Error(uiText('暂存补充不可用，请打开对话后重新提交。', 'Pending notes are unavailable. Open the conversation and submit again.'));
        }
        attempt = {sessionId, sourceKey: contextKey, request: {text, expectedQueueEpoch: status.context.queueEpoch,
          expectedRunId: status.work.runId, idempotencyKey: messageId('context')}};
        this.contextAttempt = attempt;
      }
      const response = await appendConversationContext(config, sessionId, attempt.request, controller.signal);
      if (!current()) return;
      if (this.controlStatus) this.controlStatus = {...this.controlStatus, context: response.context};
      if (this.input === text) this.input = '';
      this.contextAttempt = undefined;
      this.controlNotice = response.receipt.status === 'consumed'
        ? uiText('这条补充已用于后续轮次，未重复提交。', 'This note was already included in a later turn; it was not added again.')
        : uiText('补充已暂存，当前运行不变；将在你下次提问时使用，尚未读取。后端重启后需重新提交。',
          'Note queued; the current run continues. It will be read with your next question. Resubmit after a backend restart.');
    } catch (error) {
      if (current()) {
        if (error instanceof ConversationClientError && ['CONVERSATION_CONTEXT_EXPIRED', 'CONVERSATION_CONTEXT_RUN_CHANGED',
          'CONVERSATION_CONTEXT_UNAVAILABLE'].includes(error.code ?? '')) this.contextAttempt = undefined;
        this.controlError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.authLifecycle.releaseAbortController(controller);
      if (this.controlController === controller) this.controlController = undefined;
      m.redraw();
    }
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

  private canContinueWork(): boolean {
    return !this.activeReceipt && !this.activeController && !this.controlController && !this.contextAttempt;
  }

  private async continueWorkConversation(sessionId: string, signal: AbortSignal): Promise<void> {
    const authority = this.authLifecycle.capture();
    if (!authority || !this.canContinueWork()) throw new Error(uiText(
      '请先完成当前分析或未决请求；输入已保留。', 'Finish the current analysis or pending request first; your input is preserved.'));
    const ordinal = this.requestOrdinal;
    const restoreOrdinal = this.restoreOrdinal;
    const currentSessionId = this.store.sessionId;
    const selection = loadAnalysisContext(this.settings.backendUrl, authority.context);
    const sourceKey = analysisAuthorizationKey(selection);
    // An explicit open reauthorizes details; it does not reuse the directory's metadata as a grant.
    const snapshot = await getConversation({backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey}, sessionId, signal);
    if (signal.aborted || !this.authLifecycle.isCurrent(authority) || ordinal !== this.requestOrdinal ||
      restoreOrdinal !== this.restoreOrdinal || currentSessionId !== this.store.sessionId || !this.canContinueWork() ||
      sourceKey !== analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context))) {
      throw new ConversationRestoreInvalidatedError();
    }
    if (!snapshot.sourceSelection || !conversationSourceSelectionMatches(snapshot.sourceSelection, selection)) {
      throw new Error(uiText('此对话的来源与当前选择不同。请先选择对应来源，或显式新建对话；输入已保留。',
        'This conversation uses different sources. Select its sources or explicitly start a new conversation; your input is preserved.'));
    }
    const next = conversationStoreFromSnapshot(this.settings.backendUrl, snapshot);
    ++this.restoreOrdinal;
    invalidateConversationRestore(this.settings.backendUrl);
    this.startQueue.reset({persist: false});
    this.resetControls();
    this.store = next;
    this.explicitContinuationSessionId = next.sessionId;
    this.restoreContextKey = sourceKey;
    this.restorePromise = Promise.resolve();
    this.sessionControlBinding = {sessionId, sourceKey};
    saveConversationStore(next);
    this.error = conversationRecoveryNotice(next.recoveryStatus, next.historyUnavailableMessages);
    if (next.activeRunId) void this.resumeConversationRun(next, authority);
    m.redraw();
  }

  private async startNewConversation(): Promise<void> {
    this.explicitContinuationSessionId = undefined;
    this.sessionControlBinding = undefined;
    this.resetControls();
    const authority = this.authLifecycle.capture();
    if (!authority) return;
    const active = this.activeReceipt;
    ++this.requestOrdinal;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    ++this.restoreOrdinal;
    this.restorePromise = undefined;
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
    const restoreOrdinal = this.restoreOrdinal;
    try {
      await this.ensureConversationRestored();
    } catch {
      return; // Preserve the query and the explicit recovery notice; never fork.
    }
    if (restoreOrdinal !== this.restoreOrdinal || !this.authLifecycle.isCurrent(authority)) return;
    this.resetControls();
    const controller = this.authLifecycle.createAbortController(authority);
    this.activeController?.abort();
    this.activeController = controller;
    if (this.store.traceId && this.explicitContinuationSessionId !== this.store.sessionId) {
      this.startQueue.reset();
      this.store = {...this.store, sessionId: undefined, conversationId: undefined, traceId: undefined};
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
        ...(this.explicitContinuationSessionId === this.store.sessionId && this.store.traceId ? {traceId: this.store.traceId} : {}),
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
      this.sessionControlBinding = {sessionId: receipt.sessionId, sourceKey: analysisAuthorizationKey(analysisContext)};
      if (receipt.context?.consumedContextIds.length) this.controlNotice = uiText(
        `本轮包含 ${receipt.context.consumedContextIds.length} 条补充说明。`,
        `This turn includes ${receipt.context.consumedContextIds.length} supplemental note(s).`,
      );
      if (receipt.restartedAfterContextChange) {
        this.store = appendConversationMessage(this.settings.backendUrl, {
          id: messageId('assistant'),
          role: 'assistant',
          content: conversationContextRestartNotice(),
          timestamp: Date.now(),
        }, receipt.sessionId);
      }
      m.redraw();
      await this.consumeConversationRun(receipt, controller, ordinal, authority, analysisContext);
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
      if (ordinal === this.requestOrdinal && this.activeController === controller) {
        this.activeController = undefined;
        this.activeReceipt = undefined;
      }
      m.redraw();
    }
  }

  private async consumeConversationRun(
    receipt: ConversationRunReceipt,
    controller: AbortController,
    ordinal: number,
    authority: PageAuthorityToken,
    analysisContext: AnalysisContextSelection,
    restored = false,
  ): Promise<void> {
    const restoreOrdinal = this.restoreOrdinal;
    const contextKey = analysisAuthorizationKey(analysisContext);
    const isCurrentStream = () => !controller.signal.aborted &&
      this.activeController === controller && this.activeReceipt === receipt &&
      ordinal === this.requestOrdinal && restoreOrdinal === this.restoreOrdinal &&
      this.authLifecycle.isCurrent(authority) && contextKey ===
        analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    let committed = false;
    // One deterministic id per run, shared by the committed outcome and the restored history.
    const runMessageId = conversationMessageId(receipt.sessionId, receipt.runId, 'assistant');
    const commitOutcome = (outcome: ConversationOutcome) => {
      if (
        committed ||
        !isCurrentStream() ||
        outcome.kind === 'cancelled'
      ) return;
      committed = true;
      this.store = appendConversationMessage(this.settings.backendUrl, {
        id: runMessageId,
        role: 'assistant',
        content: outcome.message,
        timestamp: Date.now(),
        evidence: outcome.evidence,
        privateContent: restored || analysisContextRequiresFullMode(analysisContext),
        turn: conversationOutcomeTurn(outcome, receipt.runId),
        recoveryStatus: outcome.recoveryStatus,
        outcomeKind: outcome.kind,
        ...(outcome.kind === 'recommend_full' ? {fullHandoff: outcome.handoff} : {}),
      }, receipt.sessionId);
      m.redraw();
    };
    const outcome = await streamConversationRun({
      backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey,
    }, receipt, {
      signal: controller.signal,
      onOutcome: commitOutcome,
    });
    if (
      !isCurrentStream() ||
      outcome.kind === 'cancelled'
    ) return;
    commitOutcome(outcome);
  }

  private async resumeConversationRun(store: StoredConversation, authority: PageAuthorityToken): Promise<void> {
    if (!store.sessionId || !store.activeRunId || !this.authLifecycle.isCurrent(authority)) return;
    const receipt: ConversationRunReceipt = {
      sessionId: store.sessionId, runId: store.activeRunId,
      isNewSession: false, traceContextAttached: Boolean(store.traceId),
    };
    const ordinal = this.requestOrdinal;
    const controller = this.authLifecycle.createAbortController(authority);
    this.activeController?.abort();
    this.activeController = controller;
    this.activeReceipt = receipt;
    const ownsStream = () => ordinal === this.requestOrdinal &&
      this.activeController === controller && this.activeReceipt === receipt;
    try {
      await this.consumeConversationRun(receipt, controller, ordinal, authority,
        loadAnalysisContext(this.settings.backendUrl, authority.context), true);
    } catch (error) {
      if (!controller.signal.aborted && ownsStream() && this.authLifecycle.isCurrent(authority)) {
        this.error = conversationRestoreErrorMessage(error);
      }
    } finally {
      this.authLifecycle.releaseAbortController(controller);
      if (ownsStream()) {
        this.activeController = undefined;
        this.activeReceipt = undefined;
      }
      m.redraw();
    }
  }

  private ensureConversationRestored(): Promise<void> {
    const authority = this.authLifecycle.capture();
    if (!authority) return Promise.reject(new ConversationRestoreInvalidatedError());
    const contextKey = analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    if (this.restorePromise && this.restoreContextKey !== contextKey) {
      this.explicitContinuationSessionId = undefined;
      ++this.restoreOrdinal;
      this.activeController?.abort();
      this.activeController = undefined;
      this.activeReceipt = undefined;
      invalidateConversationRestore(this.settings.backendUrl);
      this.restorePromise = undefined;
      this.store = {backendUrl: this.settings.backendUrl, messages: [], updatedAt: Date.now()};
    }
    if (this.restorePromise) return this.restorePromise;
    this.restoreContextKey = contextKey;
    const ordinal = this.restoreOrdinal;
    const isCurrent = () => ordinal === this.restoreOrdinal &&
      this.authLifecycle.isCurrent(authority) && contextKey ===
        analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    const promise = restoreConversationStore({
      backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey,
    }, isCurrent).then((store) => {
      if (!isCurrent()) throw new ConversationRestoreInvalidatedError();
      this.store = store;
      this.sessionControlBinding = store.sessionId && store.sourceSelection &&
        conversationSourceSelectionMatches(store.sourceSelection, loadAnalysisContext(this.settings.backendUrl, authority.context))
        ? {sessionId: store.sessionId, sourceKey: contextKey} : undefined;
      if (store.activeRunId) void this.resumeConversationRun(store, authority);
      this.error = conversationRecoveryNotice(store.recoveryStatus, store.historyUnavailableMessages);
      m.redraw();
    }).catch((error: unknown) => {
      if (ordinal === this.restoreOrdinal && error instanceof ConversationRestoreInvalidatedError && this.restorePromise === promise) {
        this.restorePromise = undefined;
      }
      if (ordinal === this.restoreOrdinal && !(error instanceof ConversationRestoreInvalidatedError)) {
        this.store = {backendUrl: this.settings.backendUrl, messages: [], updatedAt: Date.now()};
        this.error = conversationRestoreErrorMessage(error);
        m.redraw();
      }
      throw error;
    });
    this.restorePromise = promise;
    return promise;
  }

  private handleAuthTransition(transition: PageAuthTransition): void {
    if (!transition.authorityChanged) return;
    this.explicitContinuationSessionId = undefined;
    this.sessionControlBinding = undefined;
    this.resetControls();
    ++this.restoreOrdinal;
    this.restorePromise = undefined;
    ++this.requestOrdinal;
    this.activeController?.abort();
    this.activeController = undefined;
    this.activeReceipt = undefined;
    this.startQueue.reset({persist: false});
    clearConversationRuntimeIdentities();
    if (transition.current.kind === 'ready') {
      this.store = {backendUrl: this.settings.backendUrl, messages: [], updatedAt: Date.now()};
      this.error = '';
      void this.ensureConversationRestored().catch(() => undefined);
    } else {
      this.store = {backendUrl: this.settings.backendUrl, messages: [], updatedAt: Date.now()};
    }
    m.redraw();
  }
}
