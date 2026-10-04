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
  analysisAuthorizationKey,
  analysisContextRequiresFullMode,
  loadAnalysisContext,
} from './analysis_context';
import {formatMessage} from './data_formatter';
import {resolveChatInputKeyAction} from './chat_input';
import {
  cancelConversationRun,
  conversationContextRestartNotice,
  deferred,
  stopReviewAndWait,
  streamConversationRun,
  type Deferred,
  type ConversationFullHandoff,
  type ConversationOutcome,
  type ConversationRunReceipt,
} from './conversation_client';
import {
  appendConversationMessage,
  clearConversationStore,
  clearConversationRuntimeIdentities,
  conversationMessageContent,
  conversationMessageId,
  conversationRecoveryNotice,
  conversationOutcomeTurn,
  conversationRestoreErrorMessage,
  ConversationRestoreInvalidatedError,
  invalidateConversationRestore,
  restoreConversationStore,
  saveConversationStore,
  unfinishedProvisionalAnswerMessage,
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
import {answerVerificationCueText} from './answer_verification';
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

function renderThreadMessage(message: StoredConversationMessage, cue?: 'pending'): m.Vnode {
  return m(
    `article.ai-conversation-page-message.ai-conversation-page-message-${message.role}`,
    {key: message.id},
    [
      m('div.ai-conversation-page-role', message.role === 'user' ? uiText('你', 'You') : 'AI'),
      cue
        ? m('div.ai-answer-verification-cue.ai-answer-verification-pending', {role: 'status'},
          answerVerificationCueText(cue))
        : null,
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
  private isComposing = false;
  private activeReceipt?: ConversationRunReceipt;
  private activeController?: AbortController;
  private requestOrdinal = 0;
  private error = '';
  /** Screen-only answer of the active run while its review runs; stored once, with the verdict. */
  private provisionalAnswer?: {runId: string; message: StoredConversationMessage};
  /** Resolves when the current run's verdict landed or its send/resume request ended. */
  private runSettlement?: Deferred;

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
          ? [
              ...this.store.messages.map((message) => renderThreadMessage(message)),
              this.provisionalAnswer
                ? renderThreadMessage(this.provisionalAnswer.message, 'pending')
                : null,
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
      this.activeReceipt && this.provisionalAnswer?.runId === this.activeReceipt.runId
        ? m('div.ai-conversation-page-running', uiText(
            '结论已生成，正在核验；新消息会先结束核验。',
            'The answer is ready and being verified; a new message ends the verification first.',
          ))
        : this.activeReceipt
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
        }, this.activeReceipt
          ? uiText('修正方向', 'Steer')
          : uiText('发送', 'Send')),
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
    // The previous answer is already on screen: end only its review and let it
    // settle into history with its verdict before this question.
    await this.settleProvisionalRun();
    if (restoreOrdinal !== this.restoreOrdinal || !this.authLifecycle.isCurrent(authority)) return;
    const controller = this.authLifecycle.createAbortController(authority);
    this.activeController?.abort();
    this.activeController = controller;
    if (this.store.traceId) {
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
    const settlement = deferred();
    this.runSettlement = settlement;
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
      settlement.resolve();
      m.redraw();
    }
  }

  private async settleProvisionalRun(): Promise<void> {
    const active = this.activeReceipt;
    if (!active || this.provisionalAnswer?.runId !== active.runId) return;
    await stopReviewAndWait({
      backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey,
    }, active, this.runSettlement?.promise);
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
    // One deterministic id per run, shared by the provisional answer, the
    // committed outcome and the restored history.
    const runMessageId = conversationMessageId(receipt.sessionId, receipt.runId, 'assistant');
    const settlement = this.runSettlement;
    const releaseProvisional = (keepUnfinished: boolean) => {
      const provisional = this.provisionalAnswer;
      if (provisional?.runId !== receipt.runId) return;
      this.provisionalAnswer = undefined;
      // A run that ended without its verdict keeps the text it showed, marked unverified.
      if (keepUnfinished && restoreOrdinal === this.restoreOrdinal && this.authLifecycle.isCurrent(authority)) {
        this.store = appendConversationMessage(this.settings.backendUrl,
          unfinishedProvisionalAnswerMessage({id: runMessageId, runId: receipt.runId,
            content: provisional.message.content, privateContent: provisional.message.privateContent}),
          receipt.sessionId);
      }
      m.redraw();
    };
    const commitOutcome = (outcome: ConversationOutcome) => {
      if (
        committed ||
        !isCurrentStream() ||
        outcome.kind === 'cancelled'
      ) return;
      committed = true;
      releaseProvisional(false);
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
      // The verdict landed: a waiting next question may start now.
      settlement?.resolve();
      m.redraw();
    };
    const outcome = await streamConversationRun({
      backendUrl: this.settings.backendUrl,
      apiKey: this.settings.backendApiKey,
    }, receipt, {
      signal: controller.signal,
      onProvisionalAnswer: ({message}) => {
        if (!isCurrentStream()) return;
        this.provisionalAnswer = {runId: receipt.runId, message: {id: runMessageId, role: 'assistant',
          content: message, timestamp: Date.now(),
          privateContent: restored || analysisContextRequiresFullMode(analysisContext)}};
        m.redraw();
      },
      onOutcome: commitOutcome,
    }).finally(() => releaseProvisional(true));
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
    const settlement = deferred();
    this.runSettlement = settlement;
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
      settlement.resolve();
      m.redraw();
    }
  }

  private ensureConversationRestored(): Promise<void> {
    const authority = this.authLifecycle.capture();
    if (!authority) return Promise.reject(new ConversationRestoreInvalidatedError());
    const contextKey = analysisAuthorizationKey(loadAnalysisContext(this.settings.backendUrl, authority.context));
    if (this.restorePromise && this.restoreContextKey !== contextKey) {
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
