// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {BackendProxyService} from './ai_service';
import {SettingsModal} from './settings_modal';
import {SqlResultTable, UserInteraction} from './sql_result_table';
import {ChartVisualizer} from './chart_visualizer';
import {NavigationBookmarkBar, NavigationBookmark} from './navigation_bookmark_bar';
import {SceneNavigationBar} from './scene_navigation_bar';
import {
  getActivityHintFromBufferTxTrackName,
  getMaxPinsForPattern,
  needsActiveDisambiguation,
} from './auto_pin_utils';
import {Engine} from '../../trace_processor/engine';
import {LONG, NUM_NULL, STR_NULL} from '../../trace_processor/query_result';
import {Trace} from '../../public/trace';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AppImpl} from '../../core/app_impl';
import {getBackendUploader} from '../../core/backend_uploader';
import {
  getBackendUploadState,
  subscribeBackendUploadState,
  type BackendUploadSnapshot,
} from '../../core/backend_upload_state';
import {TraceSource} from '../../core/trace_source';
import {Time} from '../../base/time';
// Note: generated types are used by SSE event handlers module
// import {FullAnalysis, ExpandableSections, isFrameDetailData} from './generated';

// Refactored modules - centralized types and utilities
import {
  Message,
  SqlQueryResult,
  AIPanelState,
  PinnedResult,
  AISettings,
  AISession,
  ServerStatus,
  createStreamingFlowState,
  createStreamingAnswerState,
  createStoryPanelState,
  InterventionState,
  StreamingFlowState,
  DEFAULT_SETTINGS,
  PENDING_BACKEND_TRACE_KEY,
  PRESET_QUESTIONS,
  COMPARISON_PRESET_QUESTIONS,
  SelectionContext,
  SelectionTrackInfo,
  SliceCardInfo,
  AreaCardInfo,
  TraceDataset,
} from './types';
// Agent-Driven Architecture v2.0 - Intervention Panel
import {InterventionPanel, DEFAULT_INTERVENTION_STATE} from './intervention_panel';
import {
  decodeBase64Unicode,
  formatMessage,
} from './data_formatter';
import {sessionManager} from './session_manager';
import {mermaidRenderer} from './mermaid_renderer';
import {buildAssistantApiV1Url} from './assistant_api_v1';
import {
  clearComparisonState,
} from './comparison_state_manager';
import {
  handleSSEEvent as handleSSEEventExternal,
  SSEHandlerContext,
} from './sse_event_handlers';
import {STEP_TO_OVERLAY, createOverlayTrack} from './track_overlay';
import {
  subscribeClearChat,
  subscribeOpenSettings,
} from './assistant_command_bus';
// Scene reconstruction logic lives in story_controller.ts; shared constants in scene_constants.ts.
import {SCENE_DISPLAY_NAMES} from './scene_constants';
import {StoryController, StoryControllerContext} from './story_controller';
// AI Everywhere: cross-component shared state + timeline notes
import {updateAISharedState, resetAISharedState, getAISharedState} from './ai_shared_state';
import {addBookmarkNotes, clearAIFindingNotes} from './ai_timeline_notes';
import {
  TransientState,
  consumeTransientState,
  registerTransientSaver,
  switchFloatingMode,
  unregisterTransientSaver,
} from './ai_transient_state';

const DEBUG_AI_PANEL = false;

// Metric card palette keyed by status. Extracted from a triple-ternary that
// repeated the four intent mappings three times (bg / fg / icon name). The
// `info` entry doubles as the default for unknown status values.
const METRIC_STATUS_STYLES: Record<string, {bg: string; fg: string; icon: string}> = {
  good: {
    bg: 'var(--chat-metric-bg-good)',
    fg: 'var(--chat-success)',
    icon: 'check_circle',
  },
  warning: {
    bg: 'var(--chat-metric-bg-warning)',
    fg: 'var(--chat-warning)',
    icon: 'warning',
  },
  critical: {
    bg: 'var(--chat-metric-bg-critical)',
    fg: 'var(--chat-error)',
    icon: 'error',
  },
  info: {
    bg: 'var(--chat-metric-bg-info)',
    fg: 'var(--pf-color-accent)',
    icon: 'analytics',
  },
};

function metricStatusStyle(status: string | undefined): {bg: string; fg: string; icon: string} {
  return (status ? METRIC_STATUS_STYLES[status] : undefined) ?? METRIC_STATUS_STYLES.info;
}

export interface AIPanelAttrs {
  engine: Engine;
  trace: Trace;
}

// Re-export types for backward compatibility with external consumers
export {Message, SqlQueryResult, AISettings, AISession, PinnedResult, ServerStatus} from './types';

// Inline style objects cannot resolve CSS custom properties for dark mode;
// all visual tokens live in styles.scss so the --chat-* cascade handles theming.

/** Detect system dark mode preference. Updates reactively when user toggles OS theme. */
function detectDarkMode(): boolean {
  return typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

export class AIPanel implements m.ClassComponent<AIPanelAttrs> {
  private engine?: Engine;
  private trace?: Trace;
  private isDarkMode = detectDarkMode();
  private darkModeListener?: () => void;
  private state: AIPanelState = {
    messages: [],
    input: '',
    isLoading: false,
    loadingPhase: '',
    showSettings: false,
    aiService: null,
    settings: {...DEFAULT_SETTINGS},
    commandHistory: [],
    historyIndex: -1,
    lastQuery: '',
    pinnedResults: [],
    backendTraceId: null,
    bookmarks: [],  // 初始化为空数组
    currentTraceFingerprint: null,  // 当前 Trace 指纹
    currentSessionId: null,  // 当前 Session ID
    isRetryingBackend: false,  // 正在重试连接后端
    retryError: null,  // 重试连接的错误信息
    agentSessionId: null,  // Agent 多轮对话 Session ID
    agentRunId: null,
    agentRequestId: null,
    agentRunSequence: 0,
    displayedSkillProgress: new Set(),  // 已显示的 skill 进度
    completionHandled: false,  // 分析完成事件是否已处理
    // SSE Connection State Initialization
    sseConnectionState: 'disconnected',
    sseRetryCount: 0,
    sseMaxRetries: 5,
    sseLastEventTime: null,
    sseLastEventId: null,
    // Error Aggregation Initialization
    collectedErrors: [],
    // Output structure optimization
    collapsedTables: new Set(),
    // Scene Navigation Bar
    detectedScenes: [],
    scenesLoading: false,
    scenesError: null,
    // Agent-Driven Architecture v2.0 - Intervention State
    interventionState: {...DEFAULT_INTERVENTION_STATE},
    // Progressive streaming transcript state
    streamingFlow: createStreamingFlowState(),
    // Incremental final answer stream state
    streamingAnswer: createStreamingAnswerState(),
    // Comparison mode state
    referenceTraceId: null,
    referenceTraceName: null,
    isReferenceActive: false,
    showTracePicker: false,
    comparisonTraceLoading: false,
    // Story Panel (Chat ↔ Story view switch)
    currentView: 'chat',
    storyState: createStoryPanelState(),
    // Analysis mode (persisted in localStorage under 'ai-analysis-mode'; default 'auto')
    analysisMode: (() => {
      try {
        const stored = localStorage.getItem('ai-analysis-mode');
        if (stored === 'fast' || stored === 'full' || stored === 'auto') return stored;
      } catch { /* ignore — private browsing or storage quota */ }
      return 'auto';
    })(),
    // Slice Selected card
    sliceCardInfo: null,
    areaCardInfo: null,
    sliceCardPrevSelId: '',
    sliceCardDismissed: false,
    pendingTraceContext: null,
  };

  private unsubscribeClearChat?: () => void;
  private unsubscribeOpenSettings?: () => void;
  private unsubscribeBackendUpload?: () => void;
  private lastBackendUploadState: BackendUploadSnapshot = getBackendUploadState();
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;
  private scrollThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  private availableTraces: Array<{id: string; originalName?: string; uploadedAt?: string; size?: number}> = [];
  // Debounced session save (P1-8): coalesce rapid addMessage() calls
  private saveSessionTimer: ReturnType<typeof setTimeout> | null = null;
  private beforeUnloadHandler: (() => void) | null = null;
  // SSE Connection Management
  private sseAbortController: AbortController | null = null;
  // Paragraph-level progressive reveal: tracks how many children have been animated per message
  private revealedBlockCounts = new Map<string, number>();
  // Transient state saver — bound closure registered in oncreate, cleared in onremove.
  // Captures input draft, collapsed tables, and active SSE analysis when the
  // user switches between tab and floating window mode.
  private transientSaverRef: (() => TransientState) | null = null;

  // Delegate to mermaidRenderer module
  private async renderMermaidInElement(container: HTMLElement): Promise<void> {
    await mermaidRenderer.renderMermaidInElement(container);
  }

  /**
   * Apply paragraph-level progressive reveal animation to message content.
   * Only animates block-level children that haven't been revealed yet,
   * enabling incremental streaming: already-revealed blocks appear instantly
   * while new blocks fade in with a staggered delay.
   */
  private applyBlockReveal(dom: HTMLElement, msgId: string): void {
    const children = Array.from(dom.children) as HTMLElement[];
    const alreadyRevealed = this.revealedBlockCounts.get(msgId) ?? 0;

    for (let i = alreadyRevealed; i < children.length; i++) {
      const child = children[i];
      child.classList.add('ai-reveal-block');
      child.style.animationDelay = `${(i - alreadyRevealed) * 60}ms`;
    }

    this.revealedBlockCounts.set(msgId, children.length);
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}

    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textarea);
      return ok;
    } catch {
      return false;
    }
  }

  private trackFullPathToString(trackNode: any): string {
    const fullPath = trackNode?.fullPath as string[] | undefined;
    return Array.isArray(fullPath) ? fullPath.join(' > ') : '';
  }

  private shouldIgnoreAutoPinTrackName(trackName: string): boolean {
    // Avoid noisy or misleading pins in teaching mode.
    if (/^VSYNC-appsf$/i.test(trackName)) return true;
    if (/^AChoreographer/i.test(trackName)) return true;
    return false;
  }

  // oninit is called before view(), so AI service is initialized before first render
  oninit(vnode: m.Vnode<AIPanelAttrs>) {
    this.engine = vnode.attrs.engine;
    this.trace = vnode.attrs.trace;

    // Load settings from localStorage
    this.loadSettings();

    // Initialize AI service - must happen before first render
    this.initAIService();

    // 检测 Trace 变化并加载对应的历史
    this.handleTraceChange();
  }

  /**
   * 生成 Trace 指纹，用于识别唯一的 Trace
   * 基于 traceInfo 的 start/end 和 traceTitle
   */
  private getTraceFingerprint(): string | null {
    if (!this.trace) return null;
    const info = this.trace.traceInfo;
    // 使用 start + end + title 生成指纹
    return `${info.start}_${info.end}_${info.traceTitle || 'untitled'}`;
  }

  /**
   * 检测 Trace 变化，如果变化则重置状态
   */
  private handleTraceChange(): void {
    const newFingerprint = this.getTraceFingerprint();
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    const backendUploadState = getBackendUploadState();

    // Auto-RPC: Try to get backendTraceId from shared backend upload state.
    const appBackendTraceId = backendUploadState.traceId;
    const appBackendUploadState = backendUploadState.state;
    const appBackendUploadError = backendUploadState.error;

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Trace fingerprint check:', {
      new: newFingerprint,
      current: this.state.currentTraceFingerprint,
      backendTraceId: this.state.backendTraceId,
      appBackendTraceId,
      appBackendUploadState,
      appBackendUploadError,
      engineMode: this.engine?.mode,
      engineInRpcMode,
    });

    // If upload already completed, reuse the backend trace id.
    if (appBackendTraceId && !this.state.backendTraceId) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Using backendTraceId from auto-upload:', appBackendTraceId);
      this.state.backendTraceId = appBackendTraceId;
      // Don't call detectScenesQuick() here — defer to after welcome message below
    }

    // 如果指纹没变且已经有 session，不需要重新加载
    if (newFingerprint && newFingerprint === this.state.currentTraceFingerprint && this.state.currentSessionId) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Same trace, keeping current session');
      // 如果在 RPC 模式但没有 backendTraceId，尝试自动注册
      if (engineInRpcMode && !this.state.backendTraceId) {
        this.autoRegisterWithBackend();
      }
      return;
    }

    // 更新当前指纹
    this.state.currentTraceFingerprint = newFingerprint;

    if (!newFingerprint) {
      // 没有 trace，重置状态
      this.resetStateForNewTrace();
      return;
    }

    // 尝试迁移旧格式数据
    this.migrateOldHistoryToSession();

    // Auto-restore a recent session (<30 min old with messages) for this trace,
    // otherwise create a new session.
    const recentSessions = sessionManager.getSessionsForTrace(newFingerprint);
    const THIRTY_MINUTES = 30 * 60 * 1000;
    const now = Date.now();
    const restorable = recentSessions
      .filter(s => s.messages.length > 0 && (now - (s.lastActiveAt || s.createdAt)) < THIRTY_MINUTES)
      .sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));

    if (restorable.length > 0) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Auto-restoring recent session:', restorable[0].sessionId);
      // Preserve backendTraceId from upload state — loadSession may clear it
      const savedBackendTraceId = this.state.backendTraceId;
      this.loadSession(restorable[0].sessionId);
      if (savedBackendTraceId && !this.state.backendTraceId) {
        this.state.backendTraceId = savedBackendTraceId;
        this.saveCurrentSession();
      }
      if (this.state.backendTraceId) {
        // Scene navigation bar now populates only after explicit /scene command.
        // detectScenesQuick() quality is too low for navigation (0ms entries, inaccurate types).
      } else if (appBackendUploadState === 'uploading') {
        // Background upload still in progress — listen for completion
        // Without this, restored sessions get stuck in disconnected state
        this.listenForBackendUpload();
      } else if (engineInRpcMode) {
        // In RPC mode but no backendTraceId — try to register
        this.autoRegisterWithBackend();
      }
      m.redraw();
      return;
    }

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Creating new session for trace');
    this.createNewSession();

    // 显示欢迎消息 — handle three states:
    // 1. backendTraceId already available (upload completed before panel init)
    // 2. Upload still in progress (show connecting message, listen for completion)
    // 3. Manual RPC mode (trace_processor_shell -D)
    // 4. No backend at all
    if (this.state.backendTraceId) {
      // Backend already available — show welcome (scene detection deferred to /scene command)
      this.addRpcModeWelcomeMessage();
    } else if (appBackendUploadState === 'uploading') {
      // Background upload in progress — show connecting state, listen for completion
      this.addBackendConnectingMessage();
      this.listenForBackendUpload();
    } else if (appBackendUploadState === 'failed') {
      // Background upload failed — show unavailable state immediately
      this.addBackendUnavailableMessage(appBackendUploadError);
    } else if (engineInRpcMode) {
      // Manual RPC mode (trace_processor_shell -D) — try to register
      this.autoRegisterWithBackend();
    } else {
      // No backend connection at all
      this.addBackendUnavailableMessage(appBackendUploadError);
    }
  }

  /**
   * 当已经在 HTTP RPC 模式时，自动向后端注册当前 trace
   * 这样后端可以执行 SQL 查询
   */
  private async autoRegisterWithBackend(): Promise<void> {
    const rpcPort = HttpRpcEngine.rpcPort;
    if (DEBUG_AI_PANEL) console.log('[AIPanel] Auto-registering with backend, RPC port:', rpcPort);

    // First, check if there's a pending backendTraceId from a recent upload
    const pendingTraceId = this.recoverPendingBackendTrace(parseInt(rpcPort, 10));
    if (pendingTraceId) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Recovered pending backend traceId:', pendingTraceId);
      this.state.backendTraceId = pendingTraceId;

      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `✅ **已进入 RPC 模式**\n\nTrace 已成功上传并通过 HTTP RPC (端口 ${rpcPort}) 加载。\nAI 助手已就绪，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
        timestamp: Date.now(),
      });

      this.saveCurrentSession();
      m.redraw();
      return;
    }

    try {
      // 调用后端 API 注册当前 RPC 连接
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/traces/register-rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          port: parseInt(rpcPort, 10),
          traceName: this.trace?.traceInfo?.traceTitle || 'External RPC Trace',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.traceId) {
          this.state.backendTraceId = data.traceId;
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Auto-registered with backend, traceId:', data.traceId);

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `✅ **已连接到 RPC 模式**\n\n检测到当前 Trace 已通过 HTTP RPC (端口 ${rpcPort}) 加载。\nAI 助手现在可以分析这份 Trace 数据了。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
            timestamp: Date.now(),
          });

          this.saveCurrentSession();

          m.redraw();
          return;
        }
      }

      // 注册失败时，显示基本欢迎消息
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Auto-registration failed, showing welcome message');
      this.addRpcModeWelcomeMessage();
    } catch (error) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Auto-registration error:', error);
      this.addRpcModeWelcomeMessage();
    }
  }

  /**
   * 手动重试连接后端 - 用于从 cache 加载的 Trace
   * 当后端启动后，用户可以点击"重试连接"按钮来上传 Trace 并切换到 RPC 模式
   */
  private async retryBackendConnection(): Promise<void> {
    if (!this.trace || this.state.isRetryingBackend) {
      return;
    }

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Manually retrying backend connection...');
    this.state.isRetryingBackend = true;
    this.state.retryError = null;
    m.redraw();

    try {
      const uploader = getBackendUploader(this.state.settings.backendUrl);

      // 首先检查后端是否可用
      const backendAvailable = await uploader.checkAvailable();
      if (!backendAvailable) {
        throw new Error('AI 后端服务未启动。请先运行 `cd backend && npm run dev` 启动后端服务。');
      }

      // 获取当前 Trace 的 source
      const traceInfo = this.trace.traceInfo as unknown as {source: TraceSource};
      const traceSource = traceInfo.source;
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Retrying with trace source type:', traceSource.type);

      // 尝试上传 Trace
      const uploadResult = await uploader.upload(traceSource);

      if (!uploadResult.success || !uploadResult.port) {
        throw new Error(uploadResult.error || '上传 Trace 失败');
      }

      if (DEBUG_AI_PANEL) console.log('[AIPanel] Upload successful, port:', uploadResult.port);

      // 上传成功，需要重新加载 Trace 以使用新的 RPC 端口
      // 显示提示信息
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '🔄 正在切换到 RPC 模式...',
        timestamp: Date.now(),
      });

      // 设置 RPC 端口并重新加载 Trace
      HttpRpcEngine.rpcPort = String(uploadResult.port);

      // 存储 traceId 用于后续注册
      if (uploadResult.traceId) {
        this.state.backendTraceId = uploadResult.traceId;
        // 存储到 localStorage 以便在 reload 后恢复
        try {
          localStorage.setItem(
            PENDING_BACKEND_TRACE_KEY,
            JSON.stringify({
              traceId: uploadResult.traceId,
              port: uploadResult.port,
              timestamp: Date.now(),
            }),
          );
        } catch (e) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Failed to store pending trace:', e);
        }
      }

      // 使用 AppImpl 重新打开 Trace（会使用新的 RPC 端口）
      if (traceSource.type === 'FILE') {
        AppImpl.instance.openTraceFromFile(traceSource.file);
      } else if (traceSource.type === 'URL') {
        AppImpl.instance.openTraceFromUrl(traceSource.url);
      } else if (traceSource.type === 'ARRAY_BUFFER') {
        AppImpl.instance.openTraceFromBuffer({
          buffer: traceSource.buffer,
          title: this.trace.traceInfo.traceTitle,
          fileName: traceSource.fileName,
          url: traceSource.url,
        });
      } else {
        throw new Error(`Cannot reopen trace source type ${traceSource.type} in RPC mode`);
      }

      // 重置重试状态
      this.state.isRetryingBackend = false;
      m.redraw();

    } catch (error: unknown) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('[AIPanel] Retry backend connection failed:', errorMsg);
      this.state.retryError = errorMsg;
      this.state.isRetryingBackend = false;
      m.redraw();
    }
  }

  /**
   * 从临时存储中恢复 pending backendTraceId
   * 用于在 trace reload 后恢复上传时设置的 traceId
   */
  private recoverPendingBackendTrace(currentPort: number): string | null {
    try {
      const stored = localStorage.getItem(PENDING_BACKEND_TRACE_KEY);
      if (!stored) return null;

      const data = JSON.parse(stored);

      // Check if the stored data matches current port and is recent (within 60 seconds)
      if (data.port === currentPort && (Date.now() - data.timestamp) < 60000) {
        // Clear the pending data after recovery
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Recovered and cleared pending backend trace');
        return data.traceId;
      }

      // If too old or port mismatch, clear it
      if ((Date.now() - data.timestamp) > 60000) {
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Cleared stale pending backend trace');
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * RPC 模式欢迎消息（无需上传）
   */
  private addRpcModeWelcomeMessage(): void {
    const rpcPort = HttpRpcEngine.rpcPort;
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `✅ **AI 助手已就绪**\n\nTrace 已通过 HTTP RPC (端口 ${rpcPort}) 加载。\n前后端共享同一个 trace_processor，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * 后端不可用时的提示消息
   */
  private addBackendUnavailableMessage(errorDetail?: string): void {
    const errorSection = errorDetail
      ? `\n\n**错误详情：**\n- ${errorDetail}`
      : '';
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `⚠️ **AI 后端未连接**\n\n无法连接到 AI 分析后端 (${this.state.settings.backendUrl})。\n\n**可能的原因：**\n- 后端服务未启动\n- 网络连接问题${errorSection}\n\n**解决方法：**\n1. 确保后端服务正在运行：\n   \`\`\`bash\n   cd backend && npm run dev\n   \`\`\`\n2. 重新打开 Trace 文件\n\nTrace 已加载到 WASM 引擎，但 AI 分析功能不可用。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * 后端正在连接中的提示消息（非阻塞上传进行中）
   */
  private addBackendConnectingMessage(): void {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `⏳ **正在连接 AI 后端...**\n\nTrace 已加载到 WASM 引擎，AI 分析后端正在后台准备中。\n连接成功后将自动启用 AI 分析功能。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /**
   * 监听后台上传完成事件
   * 上传完成/失败后更新状态
   */
  private listenForBackendUpload(): void {
    if (this.unsubscribeBackendUpload) {
      this.unsubscribeBackendUpload();
      this.unsubscribeBackendUpload = undefined;
    }

    const handleSnapshot = (snapshot: BackendUploadSnapshot): void => {
      const previous = this.lastBackendUploadState;
      this.lastBackendUploadState = snapshot;

      if (snapshot.state === 'ready' && snapshot.traceId) {
        const isNewReadyState =
          previous.state !== 'ready' || previous.traceId !== snapshot.traceId;
        if (!isNewReadyState) return;

        this.state.backendTraceId = snapshot.traceId;
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Backend upload complete, traceId:', snapshot.traceId);
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `✅ **AI 后端已连接**\n\nAI 分析后端已就绪，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
          timestamp: Date.now(),
        });
        this.saveCurrentSession();
        m.redraw();

        if (this.unsubscribeBackendUpload) {
          this.unsubscribeBackendUpload();
          this.unsubscribeBackendUpload = undefined;
        }
        return;
      }

      if (snapshot.state === 'failed') {
        const isNewFailedState =
          previous.state !== 'failed' || previous.error !== snapshot.error;
        if (!isNewFailedState) return;

        console.warn('[AIPanel] Backend upload failed:', snapshot.error ?? 'unknown error');
        this.addBackendUnavailableMessage(snapshot.error);
        if (this.unsubscribeBackendUpload) {
          this.unsubscribeBackendUpload();
          this.unsubscribeBackendUpload = undefined;
        }
      }
    };

    const current = getBackendUploadState();
    this.lastBackendUploadState = current;
    if (current.state === 'ready' || current.state === 'failed') {
      handleSnapshot(current);
      return;
    }

    this.unsubscribeBackendUpload = subscribeBackendUploadState(handleSnapshot);
  }

  /**
   * 重置状态，准备迎接新 Trace
   */
  private resetStateForNewTrace(): void {
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.state.backendTraceId = null;
    this.state.pinnedResults = [];
    this.state.bookmarks = [];
    this.state.lastQuery = '';
    this.state.currentSessionId = null;
    this.state.agentSessionId = null;  // Reset Agent session for multi-turn dialogue
    this.clearAgentObservability();
    this.resetInterventionState();

    // 如果有有效的 trace 指纹，创建新 session
    if (this.state.currentTraceFingerprint) {
      this.createNewSession();
    }

    // 保存到旧的 history 存储（向后兼容）
    this.saveHistory();
    // 显示欢迎消息（进入 RPC 模式界面）
    this.addWelcomeMessage();
  }

  oncreate(_vnode: m.VnodeDOM<AIPanelAttrs>) {
    // Subscribe to assistant command bus.
    this.unsubscribeClearChat = subscribeClearChat(() => {
      void this.clearChat();
    });
    this.unsubscribeOpenSettings = subscribeOpenSettings(() => {
      this.openSettings();
    });

    // Listen for OS dark mode changes
    const mql = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (mql) {
      this.darkModeListener = () => {
        this.isDarkMode = mql.matches;
        m.redraw();
      };
      mql.addEventListener('change', this.darkModeListener);
    }

    // Flush pending session save on page unload
    this.beforeUnloadHandler = () => this.flushSessionSave();
    window.addEventListener('beforeunload', this.beforeUnloadHandler);

    // Register transient state saver. The saver encapsulates the full
    // handoff protocol so both Pop Out and Dock Back get identical treatment
    // (Codex HIGH 1: symmetric handoff):
    //   1. Cancel SSE — stops event processing so the snapshot is stable
    //      and the next instance can replay cleanly from lastEventId.
    //   2. Save session — persists messages + bookmarks + agent session IDs
    //      so the new AIPanel's auto-restore brings the conversation back.
    //   3. Capture in-memory state — fields that don't live in sessions
    //      (input draft, collapsed tables, streaming state, dedup sets).
    this.transientSaverRef = () => {
      this.cancelSSEConnection();
      this.saveCurrentSession();
      if (this.saveSessionTimer) {
        clearTimeout(this.saveSessionTimer);
        this.saveSessionTimer = null;
      }
      return this.snapshotTransientState();
    };
    registerTransientSaver(this.transientSaverRef);

    // Consume any transient state left over from a mode switch — restores
    // input draft, collapsed tables, and any in-flight SSE analysis.
    this.restoreTransientState(consumeTransientState());

    // Focus input (requires DOM)
    setTimeout(() => {
      const textarea = document.getElementById('ai-input') as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);
    // Animation keyframes are now defined in styles.scss
  }

  onremove() {
    // Unregister transient saver first so any in-flight switchFloatingMode()
    // that hasn't captured yet won't try to call into a torn-down instance.
    if (this.transientSaverRef) {
      unregisterTransientSaver(this.transientSaverRef);
      this.transientSaverRef = null;
    }
    this.cancelSSEConnection();
    this.resetInterventionState();
    // Clear any pending conversation flush timer — otherwise its delayed
    // callback fires on the torn-down instance (Codex MEDIUM 2).
    if (this.state.streamingFlow.conversationFlushTimer !== undefined) {
      clearTimeout(this.state.streamingFlow.conversationFlushTimer);
      this.state.streamingFlow.conversationFlushTimer = undefined;
    }
    // Clear pending debounced session save timer. The saver (for mode
    // switches) already does this, but onremove from trace unload needs
    // the same treatment to avoid stale callbacks.
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
      this.saveSessionTimer = null;
    }
    // Clear throttled scroll-to-bottom timer to prevent firing on
    // torn-down instance after mode switch or trace unload.
    if (this.scrollThrottleTimer) {
      clearTimeout(this.scrollThrottleTimer);
      this.scrollThrottleTimer = null;
    }
    if (this.unsubscribeClearChat) {
      this.unsubscribeClearChat();
      this.unsubscribeClearChat = undefined;
    }
    if (this.unsubscribeOpenSettings) {
      this.unsubscribeOpenSettings();
      this.unsubscribeOpenSettings = undefined;
    }
    // Clean up dark mode listener
    if (this.darkModeListener) {
      window.matchMedia?.('(prefers-color-scheme: dark)')
        ?.removeEventListener('change', this.darkModeListener);
      this.darkModeListener = undefined;
    }
    if (this.unsubscribeBackendUpload) {
      this.unsubscribeBackendUpload();
      this.unsubscribeBackendUpload = undefined;
    }
    // Flush pending session save and remove beforeunload listener
    this.flushSessionSave();
    if (this.beforeUnloadHandler) {
      window.removeEventListener('beforeunload', this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }

  view(vnode: m.Vnode<AIPanelAttrs>) {
    // Detect selection changes and update slice card state.
    this.updateSliceCard();

    // AI Everywhere: consume pending selection analysis (one-shot, Codex #4).
    // Read + clear atomically to prevent re-trigger on the next redraw.
    const pending = getAISharedState().pendingSelectionAnalysis;
    if (pending && !this.state.isLoading) {
      updateAISharedState({pendingSelectionAnalysis: null});
      const durMs = ((pending.endNs - pending.startNs) / 1e6).toFixed(1);
      this.state.input = `分析用户选中区间的性能（${durMs}ms），包括关键线程的 CPU 调度、大小核分布和频率、主要耗时 Slice 诊断`;
      // Defer to avoid triggering async work inside view()
      setTimeout(() => this.sendMessage(), 0);
    }

    const providerLabel = this.serverStatus.connected
      ? (this.serverStatus.runtime === 'agentv3' ? 'Claude Agent' : 'Legacy Agent')
      : 'Backend';
    const isConnected = this.serverStatus.connected;
    // Check backend availability: engine in HTTP_RPC mode, OR backend upload completed/in-progress
    // With non-blocking upload, WASM engine is used for UI while backend runs separately
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    const hasBackendTrace = !!this.state.backendTraceId;
    const backendUploadState = getBackendUploadState();
    const hasUploadInProgress = backendUploadState.state === 'uploading';
    const isInRpcMode = engineInRpcMode || hasBackendTrace || hasUploadInProgress;

    // 获取当前 trace 的所有 sessions（只在 RPC 模式下有意义）
    const sessions = isInRpcMode ? this.getCurrentTraceSessions() : [];
    const currentIndex = sessions.findIndex(s => s.sessionId === this.state.currentSessionId);

    return m(
      'div.ai-panel',
      { 'data-theme': this.isDarkMode ? 'dark' : 'light' },
      [
        // Settings Modal
        this.state.showSettings
          ? m(SettingsModal, {
              settings: this.state.settings,
              onClose: () => this.closeSettings(),
              onSave: (newSettings: AISettings) => this.saveSettings(newSettings),
              onCheckStatus: (url: string, key: string) => this.checkServerStatus(url, key),
              initialStatus: this.serverStatus.connected ? this.serverStatus : undefined,
            })
          : null,

        // Header - compact
        m('div.ai-header', [
          m('div.ai-header-left', [
            m('i.pf-icon.ai-header-icon', 'auto_awesome'),
            m('span.ai-header-title', 'AI Assistant'),
            m('span.ai-status-dot', {
              class: isConnected ? 'connected' : 'disconnected',
            }),
            m('span.ai-status-text', providerLabel),
            // SSE streaming status (visible during analysis)
            this.state.sseConnectionState !== 'disconnected'
              ? m('span.ai-status-dot', {
                  class: `sse-${this.state.sseConnectionState}`,
                  title: {
                    connecting: 'Connecting to analysis stream...',
                    connected: 'Streaming analysis results',
                    reconnecting: `Reconnecting (${this.state.sseRetryCount}/${this.state.sseMaxRetries})...`,
                  }[this.state.sseConnectionState] || '',
                })
              : null,
            this.state.sseConnectionState !== 'disconnected'
              ? m('span.ai-status-text', {
                  connecting: 'Connecting...',
                  connected: 'Streaming',
                  reconnecting: `Retry ${this.state.sseRetryCount}/${this.state.sseMaxRetries}`,
                }[this.state.sseConnectionState] || '')
              : null,
            // Backend trace status
            isInRpcMode
              ? m('span.ai-status-dot.backend', {
                  title: `Trace uploaded: ${this.state.backendTraceId}`,
                })
              : null,
            isInRpcMode
              ? m('span.ai-status-text.backend', 'RPC')
              : null,
            // Preset question buttons - only show when connected to backend
            isInRpcMode && !this.state.isLoading
              ? m('div.ai-preset-questions', [
                  ...(this.state.referenceTraceId ? COMPARISON_PRESET_QUESTIONS : PRESET_QUESTIONS).map(preset =>
                    m(`button.ai-preset-btn${preset.isTeaching ? '.ai-teaching-btn' : ''}`, {
                      onclick: () => this.sendPresetQuestion(preset.question),
                      title: preset.isTeaching ? '检测当前 Trace 的渲染管线类型，自动 Pin 关键泳道' : preset.question,
                      disabled: this.state.isLoading,
                    }, [
                      m('i.pf-icon', preset.icon),
                      preset.label,
                    ])
                  ),
                  // "Analyze Selection" button — only visible when user has an active selection
                  this.hasActiveSelection()
                    ? m('button.ai-preset-btn.ai-selection-btn', {
                        onclick: () => this.analyzeCurrentSelection(),
                        title: this.getSelectionButtonTitle(),
                        disabled: this.state.isLoading,
                      }, [
                        m('i.pf-icon', 'my_location'),
                        '选区分析',
                      ])
                    : null,
                ])
              : null,
          ]),
          m('div.ai-header-right', [
            // Comparison mode button — only visible when backend trace is available
            isInRpcMode && hasBackendTrace
              ? m('button.ai-icon-btn', {
                  onclick: () => {
                    this.state.showTracePicker = true;
                    this.fetchAvailableTraces();
                    m.redraw();
                  },
                  title: this.state.referenceTraceId
                    ? `对比模式: ${this.state.referenceTraceName || 'Reference Trace'}`
                    : '对比...',
                  class: this.state.referenceTraceId ? 'active' : '',
                }, m('i.pf-icon', 'compare_arrows'))
              : null,
            // Connection status indicator (read-only, no upload button in auto-RPC mode)
            m('span.ai-icon-btn', {
              title: isInRpcMode
                ? 'Connected to AI backend'
                : 'AI backend not connected',
              style: 'cursor: default;',
            }, m('i.pf-icon', isInRpcMode ? 'cloud_done' : 'cloud_off')),
            m('button.ai-icon-btn', {
              onclick: () => this.clearChat(),
              title: 'New Chat',
            }, m('i.pf-icon', 'add_comment')),
            m('button.ai-icon-btn', {
              onclick: () => this.popOutToFloatingWindow(),
              title: '弹出为浮动窗口（可拖动、可调整大小、跨标签页保持可见）',
            }, m('i.pf-icon', 'open_in_new')),
            m('button.ai-icon-btn', {
              onclick: () => this.openSettings(),
              title: 'Settings',
            }, m('i.pf-icon', 'settings')),
          ]),
        ]),

        // Comparison mode indicator bar
        this.state.referenceTraceId
          ? m('div.ai-comparison-bar', [
              m('div.ai-comparison-info', [
                m('span.ai-comparison-label', [
                  m('i.pf-icon', {style: 'font-size: 14px; margin-right: 4px;'}, 'compare_arrows'),
                  `对比: ${this.state.referenceTraceName || '参考 Trace'}`,
                ]),
              ]),
              m('div.ai-comparison-actions', [
                m('button.ai-comparison-switch', {
                  onclick: () => this.switchComparisonTrace(),
                  title: '在新标签页中打开参考 Trace 进行视觉验证',
                }, '验证'),
                m('button.ai-comparison-close', {
                  onclick: () => this.exitComparisonMode(),
                  title: '退出对比模式',
                }, '\u00D7'),
              ]),
            ])
          : null,

        // Trace picker modal
        this.state.showTracePicker
          ? this.renderTracePicker()
          : null,

        // View switch toolbar — Chat ↔ Story tabs
        m('div.ai-view-tabs', {
          style: 'display: flex; gap: 4px; padding: 8px 16px; border-bottom: 1px solid var(--chat-border); background: var(--chat-bg-secondary);',
        }, [
          m('button.ai-view-tab', {
            onclick: () => { this.state.currentView = 'chat'; m.redraw(); },
            title: '聊天视图',
            style: `padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer;
                    background: ${this.state.currentView === 'chat' ? 'var(--chat-solid-primary)' : 'transparent'};
                    color: ${this.state.currentView === 'chat' ? 'var(--chat-user-text)' : 'var(--chat-text)'};
                    font-weight: ${this.state.currentView === 'chat' ? '600' : '400'};`,
          }, '💬 Chat'),
          m('button.ai-view-tab', {
            onclick: () => { this.state.currentView = 'story'; m.redraw(); },
            title: '场景还原视图',
            style: `padding: 6px 14px; border: none; border-radius: 6px; cursor: pointer;
                    background: ${this.state.currentView === 'story' ? 'var(--chat-solid-primary)' : 'transparent'};
                    color: ${this.state.currentView === 'story' ? 'var(--chat-user-text)' : 'var(--chat-text)'};
                    font-weight: ${this.state.currentView === 'story' ? '600' : '400'};`,
          }, '🎬 Story'),
        ]),

        // Story view body — visible when currentView === 'story'
        this.state.currentView === 'story' ? this.renderStoryBody() : null,

        // Main content area with optional sidebar (visible when currentView === 'chat')
        m('div.ai-content-wrapper', {
          class: isInRpcMode ? 'with-sidebar' : '',  // 总是显示侧边栏（RPC 模式下）
          style: this.state.currentView === 'story' ? 'display: none;' : '',
        }, [
          // Left: Main content area
          m('div.ai-main-content', [
            // Scene Navigation Bar (场景导航 - 自动检测 Trace 中的操作场景)
            isInRpcMode && this.trace
              ? m(SceneNavigationBar, {
                  scenes: this.state.detectedScenes,
                  trace: this.trace,
                  isLoading: this.state.scenesLoading,
                  onSceneClick: (scene, index) => {
                    if (DEBUG_AI_PANEL) console.log(`[AIPanel] Jumped to scene ${index}: ${scene.type}`);
                    this.analyzeScene(scene);
                  },
                  onRefresh: () => this.detectScenesQuick(),
                })
              : null,

            // Navigation Bookmark Bar (显示AI识别的关键时间点)
            this.state.bookmarks.length > 0 && this.trace
              ? m(NavigationBookmarkBar, {
                  bookmarks: this.state.bookmarks,
                  trace: this.trace,
                  onBookmarkClick: (bookmark, index) => {
                    if (DEBUG_AI_PANEL) console.log(`Jumped to bookmark ${index}: ${bookmark.label}`);
                  },
                })
              : null,

            // Backend Unavailable Dialog - full overlay only when no existing messages
            // When messages exist, an inline banner is shown inside the messages area instead
            (!isInRpcMode && this.state.messages.length === 0)
              ? m('div.ai-rpc-dialog', [
                  this.state.isRetryingBackend
                    ? m('div.ai-rpc-dialog-icon.uploading', m('i.pf-icon', 'cloud_upload'))
                    : m('div.ai-rpc-dialog-icon', m('i.pf-icon', 'cloud_off')),
                  m('h3.ai-rpc-dialog-title',
                    this.state.isRetryingBackend ? '正在连接后端...' : 'AI 后端未连接'
                  ),
                  m('p.ai-rpc-dialog-desc', [
                    'Trace 已加载到 WASM 引擎，但无法连接到 AI 后端。',
                    m('br'),
                    'AI 分析功能需要后端服务支持。',
                  ]),
                  this.state.retryError
                    ? m('p.ai-rpc-dialog-desc', {style: 'color: var(--chat-error);'}, [
                        m('i.pf-icon', 'error'),
                        ' ' + this.state.retryError,
                      ])
                    : null,
                  m('p.ai-rpc-dialog-hint', [
                    '请确保后端服务正在运行：',
                    m('br'),
                    m('code', 'cd backend && npm run dev'),
                    m('br'),
                    m('br'),
                    '然后点击下方按钮重试连接。',
                  ]),
                  this.state.isRetryingBackend
                    ? m('div.ai-upload-progress')
                    : m('div.ai-rpc-dialog-actions', [
                        m('button.ai-rpc-dialog-btn.primary', {
                          onclick: () => this.retryBackendConnection(),
                        }, [
                          m('i.pf-icon', 'refresh'),
                          '重试连接',
                        ]),
                      ]),
                ])
              : null,

            // Messages with auto-scroll - show when connected OR when messages exist
            (isInRpcMode || this.state.messages.length > 0) ? m('div.ai-messages', {
          role: 'log',
          'aria-live': 'polite',
          oncreate: (vnode) => {
            this.messagesContainer = vnode.dom as HTMLElement;
            this.scrollToBottom(true);
          },
          onupdate: () => {
            if (this.state.messages.length !== this.lastMessageCount) {
              this.lastMessageCount = this.state.messages.length;
              this.scrollToBottom();
            } else if (this.state.isLoading) {
              // During streaming, content updates within existing messages
              // (answer_token appending) don't change message count.
              // Throttle to avoid forced reflow on every m.redraw().
              this.throttledScrollToBottom();
            }
          },
        },
          (() => {
            let reportLinkSequence = 0;
            const hasConversationTimeline = this.state.messages.some(
              (msg) => msg.flowTag === 'streaming_flow'
            );
            const filteredMessages = this.state.messages
              .filter((msg) => {
                // Hide progress_note bubbles when conversation timeline is active
                // (same info is already shown in the timeline)
                if (hasConversationTimeline && msg.flowTag === 'progress_note') return false;
                return true;
              });
            // Assign each message a round index based on round_separator boundaries.
            // Within each round, streaming_flow sorts before answer_stream, but
            // this reordering never crosses round boundaries.
            const roundIndexMap = new Map<string, number>();
            let currentRound = 0;
            for (const msg of filteredMessages) {
              if (msg.flowTag === 'round_separator') currentRound++;
              roundIndexMap.set(msg.id, currentRound);
            }
            const sortedMessages = [...filteredMessages]
              .sort((a, b) => {
                const roundA = roundIndexMap.get(a.id) ?? 0;
                const roundB = roundIndexMap.get(b.id) ?? 0;
                if (roundA !== roundB) return roundA - roundB;
                const order = (msg: {flowTag?: string}) => {
                  if (msg.flowTag === 'streaming_flow') return 1;
                  if (msg.flowTag === 'answer_stream') return 2;
                  return 0;
                };
                return order(a) - order(b);
              });
            return sortedMessages.map((msg) => {
              // Round separator — visual divider between conversation rounds
              if (msg.flowTag === 'round_separator') {
                return m('div.ai-round-separator', {key: msg.id}, [
                  m('div.ai-round-separator-line'),
                  m('span.ai-round-separator-label', msg.content),
                  m('div.ai-round-separator-line'),
                ]);
              }

              const reportLinkLabel = msg.reportUrl
                ? `查看详细分析报告 #${++reportLinkSequence} (${new Date(msg.timestamp).toLocaleTimeString('zh-CN', {hour12: false})})`
                : '';
              const isProgressMessage = msg.flowTag === 'streaming_flow' || msg.flowTag === 'progress_note';
              const messageClass = [
                msg.role === 'user' ? 'ai-message-user' : 'ai-message-assistant',
                msg.flowTag ? `ai-message-${msg.flowTag}` : '',
                isProgressMessage ? 'ai-message-progress' : '',
              ].filter(Boolean).join(' ');
              const bubbleClass = [
                msg.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-assistant',
                isProgressMessage ? 'ai-bubble-progress' : '',
              ].filter(Boolean).join(' ');
              const contentClass = isProgressMessage ? 'ai-message-content-progress' : '';

              return m('div.ai-message', {
              key: msg.id,
              class: messageClass,
            }, [
              // Avatar
              m('div.ai-avatar', {
                class: msg.role === 'user' ? 'ai-avatar-user' : 'ai-avatar-assistant',
              }, msg.role === 'user'
                ? 'U'  // User initial
                : m('i.pf-icon', 'auto_awesome')),

              // Message Content
              m('div.ai-bubble', {
                class: bubbleClass,
              }, [
                // Use oncreate/onupdate to directly set innerHTML, bypassing Mithril's
                // reconciliation for m.trust() content. This avoids removeChild errors
                // that occur when multiple SSE events trigger rapid redraws.
                m('div.ai-message-content', {
                  class: contentClass,
                  onclick: (e: MouseEvent) => {
                    const selection = window.getSelection();
                    if (selection && !selection.isCollapsed) {
                      // Don't trigger click actions while user is selecting text to copy.
                      return;
                    }
                    const target = e.target as HTMLElement;
                    const copyBtn = target.closest?.('.ai-mermaid-copy') as HTMLElement | null;
                    if (copyBtn) {
                      const b64 = copyBtn.getAttribute('data-mermaid-b64');
                      if (b64) {
                        try {
                          const code = decodeBase64Unicode(b64);
                          void this.copyTextToClipboard(code);
                        } catch (err) {
                          console.warn('[AIPanel] Failed to copy mermaid code:', err);
                        }
                      }
                      return;
                    }
                    if (target.classList.contains('ai-clickable-timestamp')) {
                      const tsNs = target.getAttribute('data-ts');
                      if (tsNs) {
                        const timestampNs = BigInt(tsNs);
                        const navigation = this.jumpToTimestamp(timestampNs);
                        if (!navigation.ok) {
                          this.addMessage({
                            id: this.generateId(),
                            role: 'assistant',
                            content: `Failed to navigate to timestamp ${timestampNs.toString()}ns: ${navigation.error}`,
                            timestamp: Date.now(),
                          });
                        }
                      }
                    }
                  },
                  oncreate: (vnode: m.VnodeDOM) => {
                    const dom = vnode.dom as HTMLElement;
                    dom.innerHTML = formatMessage(msg.content);
                    void this.renderMermaidInElement(dom);
                    if (msg.role === 'assistant' && !isProgressMessage) {
                      this.applyBlockReveal(dom, msg.id);
                    }
                  },
                  onupdate: (vnode: m.VnodeDOM) => {
                    const newHtml = formatMessage(msg.content);
                    const dom = vnode.dom as HTMLElement;
                    // Only update if content actually changed (optimization)
                    if (dom.innerHTML !== newHtml) {
                      dom.innerHTML = newHtml;
                      void this.renderMermaidInElement(dom);
                      if (msg.role === 'assistant' && !isProgressMessage) {
                        this.applyBlockReveal(dom, msg.id);
                      }
                    }
                  },
                }),

                // HTML Report Link (问题1修复)
                msg.reportUrl ? m('div.ai-report-link', [
                  m('i.pf-icon', 'description'),
                  m('a', {
                    href: msg.reportUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, reportLinkLabel),
                ]) : null,

                // SQL Result
                (() => {
                  const sqlResult = msg.sqlResult;
                  if (!sqlResult) return null;
                  const query = sqlResult.query || msg.query || '';

                  // For skill_section messages with sectionTitle, render compact table only
                  if (sqlResult.sectionTitle) {
                    // Auto-collapse tables marked as defaultCollapsed on first render
                    if (sqlResult.defaultCollapsed && !this.state.collapsedTables.has(msg.id) &&
                        !this.state.collapsedTables.has(`_init_${msg.id}`)) {
                      this.state.collapsedTables.add(msg.id);
                      this.state.collapsedTables.add(`_init_${msg.id}`);  // Mark as initialized
                    }

                    const isCollapsed = sqlResult.collapsible && this.state.collapsedTables.has(msg.id);

                    if (isCollapsed) {
                      // Render collapsed: just a clickable title bar
                      return m('div.ai-collapsed-table', {
                        style: {
                          padding: '8px 12px',
                          background: 'var(--chat-bg-secondary)',
                          border: '1px solid var(--chat-border)',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          opacity: '0.7',
                        },
                        onclick: () => {
                          this.state.collapsedTables.delete(msg.id);
                          m.redraw();
                        },
                      }, [
                        m('i.pf-icon', {style: {fontSize: '14px'}}, 'chevron_right'),
                        m('span', {style: {fontSize: '13px', fontWeight: '500'}},
                          `${sqlResult.sectionTitle} (${sqlResult.rowCount} 条)`),
                      ]);
                    }

                    // Render expanded table with optional collapse toggle
                    return m('div', [
                      sqlResult.collapsible ? m('div.ai-table-collapse-toggle', {
                        style: {
                          padding: '4px 8px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '12px',
                          color: 'var(--chat-text-secondary)',
                        },
                        onclick: () => {
                          this.state.collapsedTables.add(msg.id);
                          m.redraw();
                        },
                      }, [
                        m('i.pf-icon', {style: {fontSize: '12px'}}, 'expand_less'),
                        m('span', '收起'),
                      ]) : null,
                      m(SqlResultTable, {
                        columns: sqlResult.columns,
                        rows: sqlResult.maxVisibleRows
                          ? sqlResult.rows.slice(0, sqlResult.maxVisibleRows)
                          : sqlResult.rows,
                        rowCount: sqlResult.maxVisibleRows
                          ? Math.min(sqlResult.rowCount, sqlResult.maxVisibleRows)
                          : sqlResult.rowCount,
                        query: '',  // No SQL display
                        title: sqlResult.sectionTitle,  // Pass title to table
                        trace: vnode.attrs.trace,
                        onPin: (data) => this.handlePin(data),
                        onInteraction: (interaction) => this.handleInteraction(interaction),  // v2.0 Focus Tracking
                        expandableData: sqlResult.expandableData,
                        summary: sqlResult.summary,
                        metadata: sqlResult.metadata,  // Pass metadata for header display
                      }),
                    ]);
                  }

                  // Regular SQL result with outer header
                  return m('div.ai-sql-card', [
                    m('div.ai-sql-header', [
                      m('div.ai-sql-title', [
                        m('i.pf-icon', 'table_chart'),
                        m('span', `${sqlResult.rowCount.toLocaleString()} rows`),
                      ]),
                      m('div.ai-sql-actions', [
                        m('button.ai-sql-action-btn', {
                          onclick: () => this.copyToClipboard(query),
                          title: 'Copy SQL',
                        }, [
                          m('i.pf-icon', 'content_copy'),
                          m('span', 'Copy'),
                        ]),
                        query
                          ? m('button.ai-sql-action-btn', {
                              onclick: () => this.handlePin({
                                query,
                                columns: sqlResult.columns,
                                rows: sqlResult.rows.slice(0, 100),
                                timestamp: Date.now(),
                              }),
                              title: 'Pin result',
                            }, [
                              m('i.pf-icon', 'push_pin'),
                              m('span', 'Pin'),
                            ])
                          : null,
                      ]),
                    ]),
                    query
                      ? m('div.ai-sql-query', query.trim())
                      : null,
                    m(SqlResultTable, {
                      columns: sqlResult.columns,
                      rows: sqlResult.rows,
                      rowCount: sqlResult.rowCount,
                      query,
                      trace: vnode.attrs.trace,  // 传入 trace 对象以支持时间戳跳转
                      onPin: (data) => this.handlePin(data),
                      onExport: (format) => this.exportResult(sqlResult, format),
                      onInteraction: (interaction) => this.handleInteraction(interaction),  // v2.0 Focus Tracking
                      expandableData: sqlResult.expandableData,
                      summary: sqlResult.summary,
                      metadata: sqlResult.metadata,  // Pass metadata for header display
                    }),
                  ]);
                })(),

                // Chart Data Visualization
                msg.chartData ? m('div.ai-chart-card', {
                  style: {
                    marginTop: '12px',
                    borderRadius: '8px',
                    border: '1px solid var(--chat-border)',
                    overflow: 'hidden',
                  },
                }, [
                  m(ChartVisualizer, {
                    chartData: msg.chartData,
                    width: 400,
                    height: 280,
                  }),
                ]) : null,

                // Metric Card Visualization
                msg.metricData ? m('div.ai-metric-card', {
                  style: {
                    marginTop: '12px',
                    padding: '16px 20px',
                    borderRadius: '8px',
                    border: '1px solid var(--chat-border)',
                    background: 'var(--chat-bg)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                  },
                }, (() => {
                  const metricStyle = metricStatusStyle(msg.metricData.status);
                  return [
                  m('div', {
                    style: {
                      width: '48px',
                      height: '48px',
                      borderRadius: '50%',
                      background: metricStyle.bg,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                  }, [
                    m('i.pf-icon', {
                      style: {
                        fontSize: '24px',
                        color: metricStyle.fg,
                      },
                    }, metricStyle.icon),
                  ]),
                  m('div', { style: { flex: 1 } }, [
                    m('div', {
                      style: {
                        fontSize: '12px',
                        color: 'var(--chat-text-secondary)',
                        marginBottom: '4px',
                      },
                    }, msg.metricData.title),
                    m('div', {
                      style: {
                        fontSize: '28px',
                        fontWeight: '600',
                        color: 'var(--chat-text)',
                        lineHeight: '1.2',
                      },
                    }, [
                      String(msg.metricData.value),
                      msg.metricData.unit ? m('span', {
                        style: {
                          fontSize: '14px',
                          fontWeight: '400',
                          color: 'var(--chat-text-secondary)',
                          marginLeft: '4px',
                        },
                      }, msg.metricData.unit) : null,
                    ]),
                    msg.metricData.delta ? m('div', {
                      style: {
                        fontSize: '12px',
                        color: msg.metricData.delta.startsWith('+') ? 'var(--chat-success)' :
                               msg.metricData.delta.startsWith('-') ? 'var(--chat-error)' : 'var(--chat-text-secondary)',
                        marginTop: '4px',
                      },
                    }, msg.metricData.delta) : null,
                  ]),
                  ];
                })()) : null,
              ]),

              // Feedback buttons — show on non-progress assistant messages
              (msg.role === 'assistant' && !isProgressMessage && msg.content.length > 50)
                ? m('div.ai-feedback-bar', [
                    m('button.ai-feedback-btn', {
                      class: (this.state as any)[`feedback_${msg.id}`] === 'positive' ? 'active' : '',
                      title: '有用',
                      onclick: () => {
                        (this.state as any)[`feedback_${msg.id}`] = 'positive';
                        this.submitFeedback(msg.id, 'positive');
                      },
                    }, m('i.pf-icon', 'thumb_up')),
                    m('button.ai-feedback-btn', {
                      class: (this.state as any)[`feedback_${msg.id}`] === 'negative' ? 'active' : '',
                      title: '不准确',
                      onclick: () => {
                        (this.state as any)[`feedback_${msg.id}`] = 'negative';
                        this.submitFeedback(msg.id, 'negative');
                      },
                    }, m('i.pf-icon', 'thumb_down')),
                  ])
                : null,
            ]);
            });
          })(),

          // Intervention Panel (Agent-Driven Architecture v2.0)
          this.state.interventionState.isActive && this.state.interventionState.intervention
              ? m(InterventionPanel, {
                  state: this.state.interventionState,
                  sessionId: this.state.agentSessionId,
                  backendUrl: this.state.settings.backendUrl,
                  backendApiKey: this.state.settings.backendApiKey,
                  onStateChange: (newState: Partial<InterventionState>) => {
                  this.state.interventionState = {
                    ...this.state.interventionState,
                    ...newState,
                  };
                  m.redraw();
                },
                onComplete: () => {
                  m.redraw();
                },
              })
            : null,

          // Loading Indicator with phase context
          this.state.isLoading
            ? m('div.ai-message.ai-message-assistant', [
                m('div.ai-avatar.ai-avatar-assistant', [
                  m('i.pf-icon', 'auto_awesome'),
                ]),
                m('div.ai-bubble.ai-bubble-assistant', [
                  m('div.ai-typing-indicator', [
                    m('span.ai-typing-dot'),
                    m('span.ai-typing-dot'),
                    m('span.ai-typing-dot'),
                    this.state.loadingPhase
                      ? m('span.ai-typing-phase', this.state.loadingPhase)
                      : null,
                  ]),
                ]),
              ])
            : null,

          // Backend connecting indicator — animated progress during background upload
          (hasUploadInProgress && !hasBackendTrace && !this.state.isLoading)
            ? m('div.ai-connecting-indicator', [
                m('i.pf-icon', 'cloud_upload'),
                m('span', '正在连接 AI 后端...'),
                m('div.ai-upload-progress'),
              ])
            : null,

          // Inline disconnection banner — shown when backend drops mid-conversation
          (!isInRpcMode && this.state.messages.length > 0)
            ? m('div.ai-disconnect-banner', [
                m('i.pf-icon', 'cloud_off'),
                m('span', 'AI 后端连接已断开'),
                this.state.isRetryingBackend
                  ? m('span.ai-disconnect-retrying', '重试中...')
                  : m('button.ai-disconnect-retry-btn', {
                      onclick: () => this.retryBackendConnection(),
                    }, '重试连接'),
              ])
            : null,
        ) : null,

        // Input Area - always show (disabled when disconnected)
            (isInRpcMode || this.state.messages.length > 0) ? m('div.ai-input-area', [
              // Conversation context indicator
              this.state.messages.length > 0 && this.state.agentSessionId
                ? m('div.ai-context-indicator',
                  `第 ${this.state.messages.filter(msg => msg.role === 'user').length} 轮对话 | 会话 ${this.state.agentSessionId.substring(0, 8)}...`)
                : null,
              this.renderSliceCard(),
              this.renderAreaCard(),
              this.renderAnalysisModeChips(),
              m('div.ai-input-wrapper', [
                m('textarea#ai-input.ai-input', {
                  class: this.state.isLoading || !this.state.aiService || !isInRpcMode ? 'disabled' : '',
                  'aria-label': '\u8F93\u5165\u5206\u6790\u95EE\u9898',
                  placeholder: !isInRpcMode ? 'AI 后端未连接...' : 'Ask anything about your trace...',
                  value: this.state.input,
                  oninput: (e: Event) => {
                    this.state.input = (e.target as HTMLTextAreaElement).value;
                    this.state.historyIndex = -1;
                  },
                  onkeydown: (e: KeyboardEvent) => this.handleKeyDown(e),
                  disabled: this.state.isLoading || !this.state.aiService || !isInRpcMode,
                }),
                this.state.isLoading
                  ? m('button.ai-send-btn.ai-stop-btn', {
                      onclick: () => this.cancelAnalysis(),
                      title: 'Stop analysis',
                    }, m('i.pf-icon', 'stop_circle'))
                  : m('button.ai-send-btn', {
                      class: !this.state.aiService || !isInRpcMode ? 'disabled' : '',
                      onclick: () => this.sendMessage(),
                      disabled: !this.state.aiService || !isInRpcMode,
                      title: 'Send (Enter)',
                      'aria-label': '\u53D1\u9001',
                    }, m('i.pf-icon', 'send')),
              ]),
              m('div.ai-input-hint', 'Press Enter to send, Shift+Enter for new line'),
              !this.state.aiService
                ? m('div.ai-warning', [
                    m('i.pf-icon', 'warning'),
                    m('span', 'AI service not configured. Click settings to set up.'),
                  ])
                : null,
            ]) : null,
          ]),  // End of ai-main-content

          // Right: Session History Sidebar (总是显示，RPC 模式下)
          isInRpcMode
            ? this.renderSessionSidebar(sessions, currentIndex)
            : null,
        ]),  // End of ai-content-wrapper
      ]
    );
  }

  /** Render the analysis mode selector chips (fast / full / auto).
   *  Disables 'fast' when a strong context (comparison mode) is active: the lightweight
   *  MCP registration skips comparison tools and buildQuickSystemPrompt does not consume
   *  selectionContext, so fast under these contexts would silently drop critical state. */
  private renderAnalysisModeChips(): m.Vnode {
    const current = this.state.analysisMode;
    const fastDisabled = !!this.state.referenceTraceId;
    const modes = [
      {id: 'fast', label: '⚡ 快速', title: '5 轮内精简答复，适合简单事实查询'},
      {id: 'full', label: '🔍 完整', title: '完整多轮分析流水线'},
      {id: 'auto', label: '🤖 智能', title: '按查询复杂度自动选择'},
    ] as const;
    return m('div.ai-mode-chips',
      modes.map((mode) => {
        const disabled = mode.id === 'fast' && fastDisabled;
        const classes = [
          current === mode.id ? 'active' : '',
          disabled ? 'disabled' : '',
        ].filter(Boolean).join(' ');
        return m('button.ai-mode-chip', {
          class: classes,
          title: disabled ? '对比模式下需完整分析才能利用参考 Trace 上下文' : mode.title,
          disabled,
          onclick: () => this.onAnalysisModeChange(mode.id),
        }, mode.label);
      }),
    );
  }

  /** Switch analysis mode. Changing mode mid-session clears agentSessionId so the backend
   *  starts a fresh SDK session — avoids context mix between the 5-turn quick path and
   *  30-turn full pipeline (see plan §3, "SDK resume strategy"). */
  private onAnalysisModeChange(newMode: 'fast' | 'full' | 'auto'): void {
    if (newMode === this.state.analysisMode) return;
    const hadSession = !!this.state.agentSessionId;
    this.state.analysisMode = newMode;
    try {
      localStorage.setItem('ai-analysis-mode', newMode);
    } catch { /* ignore */ }
    if (hadSession) {
      this.state.agentSessionId = null;
      this.clearAgentObservability();
      const label = {fast: '快速', full: '完整', auto: '智能'}[newMode];
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `已切换到「${label}」模式，将开始新会话。`,
        timestamp: Date.now(),
      });
    }
    m.redraw();
  }

  private submitFeedback(_messageId: string, rating: 'positive' | 'negative'): void {
    if (!this.state.agentSessionId || !this.state.settings.backendUrl) return;
    const url = `${this.state.settings.backendUrl}/api/agent/v1/${this.state.agentSessionId}/feedback`;
    const turnIndex = this.state.messages.filter(msg => msg.role === 'user').length;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rating, turnIndex }),
    }).catch(() => { /* non-blocking */ });
    m.redraw();
  }

  private async copyToClipboard(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore
    }
  }

  private saveSettings(newSettings: AISettings) {
    this.state.settings = newSettings;
    sessionManager.saveSettings(newSettings);
    this.initAIService();
    m.redraw();
  }

  private loadSettings() {
    this.state.settings = sessionManager.loadSettings();
  }

  private normalizeHeaders(headers?: HeadersInit): Record<string, string> {
    if (!headers) return {};
    if (headers instanceof Headers) {
      return Object.fromEntries(headers.entries());
    }
    if (Array.isArray(headers)) {
      return Object.fromEntries(headers);
    }
    return {...headers};
  }

  private buildBackendHeaders(headers?: HeadersInit): Record<string, string> {
    const normalized = this.normalizeHeaders(headers);
    const apiKey = (this.state.settings.backendApiKey || '').trim();
    if (!apiKey) return normalized;

    return {
      ...normalized,
      'x-api-key': apiKey,
      Authorization: normalized.Authorization || `Bearer ${apiKey}`,
    };
  }

  private clearAgentObservability(): void {
    this.state.agentRunId = null;
    this.state.agentRequestId = null;
    this.state.agentRunSequence = 0;
  }

  private applyAgentObservability(payload: any): boolean {
    const candidates: any[] = [];
    if (payload && typeof payload === 'object') {
      candidates.push(payload);
      if (payload.observability && typeof payload.observability === 'object') {
        candidates.push(payload.observability);
      }
      if (payload.data && typeof payload.data === 'object') {
        candidates.push(payload.data);
        if (payload.data.observability && typeof payload.data.observability === 'object') {
          candidates.push(payload.data.observability);
        }
      }
    }

    let changed = false;
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;

      const runId = typeof candidate.runId === 'string' ? candidate.runId.trim() : '';
      if (runId && runId !== this.state.agentRunId) {
        this.state.agentRunId = runId;
        changed = true;
      }

      const requestId = typeof candidate.requestId === 'string' ? candidate.requestId.trim() : '';
      if (requestId && requestId !== this.state.agentRequestId) {
        this.state.agentRequestId = requestId;
        changed = true;
      }

      if (typeof candidate.runSequence === 'number' && Number.isFinite(candidate.runSequence)) {
        const runSequence = Math.max(0, Math.floor(candidate.runSequence));
        if (runSequence !== this.state.agentRunSequence) {
          this.state.agentRunSequence = runSequence;
          changed = true;
        }
      }
    }

    return changed;
  }

  private fetchBackend(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: this.buildBackendHeaders(init.headers),
    });
  }

  private isSseStatusMessage(message: Message | undefined): boolean {
    if (!message || message.role !== 'assistant') return false;
    return message.content.startsWith('🔄') ||
      message.content.startsWith('连接中断') ||
      message.content.startsWith('正在恢复会话') ||
      message.content.startsWith('后端已重启') ||
      message.content.startsWith('后端连接') ||
      message.content.startsWith('**Connection Error:**');
  }

  private upsertSseStatusMessage(content: string): void {
    const lastMsg = this.state.messages[this.state.messages.length - 1];
    if (this.isSseStatusMessage(lastMsg)) {
      lastMsg!.content = content;
      this.saveHistory();
      this.saveCurrentSession();
      this.scrollToBottom(true);
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * 从旧的 HISTORY_KEY 迁移数据到新的 Session 格式
   * 仅在首次加载时调用，用于向后兼容
   * Delegates to sessionManager for the actual migration
   */
  private migrateOldHistoryToSession(): boolean {
    const fingerprint = this.state.currentTraceFingerprint || 'unknown';
    const traceName = this.trace?.traceInfo?.traceTitle || 'Migrated Trace';
    return sessionManager.migrateOldHistoryToSession(fingerprint, traceName);
  }

  private addWelcomeMessage() {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: this.getWelcomeMessage(),
      timestamp: Date.now(),
    });
  }

  private async verifyBackendTrace() {
    if (!this.state.backendTraceId) return;

    try {
      const response = await this.fetchBackend(
        `${this.state.settings.backendUrl}/api/traces/${this.state.backendTraceId}`
      );
      if (!response.ok) {
        if (DEBUG_AI_PANEL) console.log(`[AIPanel] Backend trace ${this.state.backendTraceId} no longer valid, clearing`);
        this.state.backendTraceId = null;
        this.saveHistory();
        m.redraw();
      }
    } catch (error) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Failed to verify backend trace, clearing:', error);
      this.state.backendTraceId = null;
      this.saveHistory();
      m.redraw();
    }
  }

  private saveHistory() {
    sessionManager.saveHistory(
      this.state.messages,
      this.state.backendTraceId,
      this.state.currentTraceFingerprint
    );
  }

  // loadPinnedResults 已移至 Session 中管理

  private savePinnedResults() {
    sessionManager.savePinnedResults(this.state.pinnedResults);
  }

  // ============ Session 管理方法 ============
  // Storage operations delegated to sessionManager module

  /**
   * 获取指定 Trace 的所有 Sessions
   */
  getSessionsForTrace(fingerprint: string): AISession[] {
    return sessionManager.getSessionsForTrace(fingerprint);
  }

  /**
   * 获取当前 Trace 的所有 Sessions
   */
  getCurrentTraceSessions(): AISession[] {
    if (!this.state.currentTraceFingerprint) return [];
    return this.getSessionsForTrace(this.state.currentTraceFingerprint);
  }

  /**
   * 创建新 Session
   */
  private createNewSession(): AISession {
    const fingerprint = this.state.currentTraceFingerprint || 'unknown';
    const traceName = this.trace?.traceInfo?.traceTitle || 'Untitled Trace';

    const session = sessionManager.createSession(fingerprint, traceName);

    // 更新当前 session ID
    this.state.currentSessionId = session.sessionId;

    return session;
  }

  /**
   * 保存当前 Session
   */
  saveCurrentSession(): void {
    if (!this.state.currentSessionId || !this.state.currentTraceFingerprint) {
      return;
    }

    sessionManager.updateSession(
      this.state.currentTraceFingerprint,
      this.state.currentSessionId,
      {
        messages: this.state.messages,
        pinnedResults: this.state.pinnedResults,
        bookmarks: this.state.bookmarks,
        backendTraceId: this.state.backendTraceId || undefined,
        agentSessionId: this.state.agentSessionId || undefined,
        agentRunId: this.state.agentRunId || undefined,
        agentRequestId: this.state.agentRequestId || undefined,
        agentRunSequence: this.state.agentRunSequence || undefined,
      }
    );
  }

  /**
   * Schedule a debounced session save (500ms trailing).
   * Coalesces rapid addMessage() calls during streaming.
   */
  private debouncedSaveSession(): void {
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
    }
    this.saveSessionTimer = setTimeout(() => {
      this.saveSessionTimer = null;
      this.saveCurrentSession();
    }, 500);
  }

  /**
   * Immediately flush any pending debounced session save.
   */
  private flushSessionSave(): void {
    if (this.saveSessionTimer) {
      clearTimeout(this.saveSessionTimer);
      this.saveSessionTimer = null;
      this.saveCurrentSession();
    }
  }

  /**
   * 加载指定 Session
   */
  loadSession(sessionId: string): boolean {
    const session = sessionManager.loadSession(sessionId);
    if (!session) return false;

    this.cancelSSEConnection();
    this.resetInterventionState();

    this.state.currentSessionId = session.sessionId;
    this.state.currentTraceFingerprint = session.traceFingerprint;
    this.state.messages = session.messages;
    this.state.pinnedResults = session.pinnedResults || [];
    this.state.bookmarks = session.bookmarks || [];
    this.state.agentSessionId = session.agentSessionId || null;
    this.state.agentRunId = session.agentRunId || null;
    this.state.agentRequestId = session.agentRequestId || null;
    this.state.agentRunSequence = Number.isFinite(session.agentRunSequence)
      ? Math.max(0, Math.floor(session.agentRunSequence as number))
      : 0;

    // Only restore backendTraceId if we're currently in RPC mode
    // If not in RPC mode, the old backendTraceId is stale and invalid
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    if (engineInRpcMode && session.backendTraceId) {
      this.state.backendTraceId = session.backendTraceId;
      // 验证 backend trace 是否仍然有效
      this.verifyBackendTrace();
    } else {
      // Not in RPC mode or no backendTraceId - clear it
      this.state.backendTraceId = null;
    }

    // If the session's backendTraceId differs from current, agentSessionId belongs to a
    // different trace — clear it to prevent traceId mismatch errors on the next request.
    if (session.backendTraceId && this.state.backendTraceId !== session.backendTraceId) {
      this.state.agentSessionId = null;
    }

    // 恢复命令历史
    this.state.commandHistory = this.state.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content);

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Loaded session:', sessionId, {
      engineInRpcMode,
      backendTraceId: this.state.backendTraceId,
    });
    m.redraw();
    return true;
  }

  /**
   * 获取当前 Session
   */
  getCurrentSession(): AISession | null {
    if (!this.state.currentSessionId || !this.state.currentTraceFingerprint) {
      return null;
    }

    const sessions = this.getSessionsForTrace(this.state.currentTraceFingerprint);
    return sessions.find(s => s.sessionId === this.state.currentSessionId) || null;
  }

  /**
   * 删除指定 Session
   */
  deleteSession(sessionId: string): boolean {
    const deleted = sessionManager.deleteSession(sessionId);
    if (deleted) {
      // 如果删除的是当前 session，重置状态
      if (sessionId === this.state.currentSessionId) {
        this.state.currentSessionId = null;
        this.resetStateForNewTrace();
      }
      // IMPORTANT: Trigger UI update after session deletion
      // This is needed because confirm() dialog breaks Mithril's auto-redraw
      m.redraw();
    }
    return deleted;
  }

  // ============ Session 管理方法结束 ============

  private handlePin(data: {query: string, columns: string[], rows: any[][], timestamp: number}) {
    const pinnedResult: PinnedResult = {
      id: this.generateId(),
      query: data.query,
      columns: data.columns,
      rows: data.rows,
      timestamp: data.timestamp,
    };

    // Add to pinned results (keep max 20)
    this.state.pinnedResults = [pinnedResult, ...this.state.pinnedResults].slice(0, 20);
    this.savePinnedResults();

    // Show notification
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `📌 **Result Pinned!**\n\nYour query result has been saved. Use \`/pins\` to view all pinned results.`,
      timestamp: Date.now(),
    });
  }

  /**
   * Handle user interaction from SqlResultTable (Agent-Driven Architecture v2.0).
   *
   * This sends the interaction to the backend FocusStore for tracking user focus
   * across conversation turns, enabling incremental analysis.
   */
  private handleInteraction(interaction: UserInteraction): void {
    const sessionId = this.state.agentSessionId;
    const backendUrl = this.state.settings.backendUrl;

    // Only send if we have an active session
    if (!sessionId) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] No active session, skipping interaction capture');
      return;
    }

    // Fire and forget - don't block UI for interaction tracking
    this.fetchBackend(buildAssistantApiV1Url(backendUrl, `/${sessionId}/interaction`), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: interaction.type,
        target: interaction.target,
        source: interaction.source,
        timestamp: interaction.timestamp,
        context: interaction.context,
      }),
    }).then((response) => {
      if (!response.ok) {
        console.warn('[AIPanel] Failed to send interaction:', response.status);
      } else {
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Interaction captured:', interaction.type, interaction.target);
      }
    }).catch((error) => {
      console.warn('[AIPanel] Error sending interaction:', error);
    });
  }

  private initAIService() {
    const {backendUrl} = this.state.settings;
    // All AI requests go through the backend (agentv3 architecture).
    // The backend handles provider/model selection via its .env config.
    this.state.aiService = new BackendProxyService(backendUrl, 'default');
    // Refresh server status on init (non-blocking)
    this.refreshServerStatus();
  }

  /** Server status cache — shared by header, settings modal, and welcome message. */
  private serverStatus: ServerStatus = {connected: false};

  /**
   * Check backend server status by calling /health with optional auth headers.
   * Used by SettingsModal to test with potentially unsaved URL/key values.
   */
  private async checkServerStatus(backendUrl: string, apiKey: string): Promise<ServerStatus> {
    try {
      const headers: Record<string, string> = {};
      const trimmedKey = (apiKey || '').trim();
      if (trimmedKey) {
        headers['x-api-key'] = trimmedKey;
        headers['Authorization'] = `Bearer ${trimmedKey}`;
      }
      const response = await fetch(`${backendUrl.replace(/\/+$/, '')}/health`, {headers});
      if (!response.ok) return {connected: false};
      const data = await response.json();
      return {
        connected: true,
        runtime: data.aiEngine?.runtime,
        model: data.aiEngine?.model,
        configured: data.aiEngine?.configured,
        environment: data.environment,
        authRequired: data.aiEngine?.authRequired,
      };
    } catch {
      return {connected: false};
    }
  }

  /**
   * Refresh the cached server status using current saved settings.
   * Non-blocking — called on init and after settings save.
   */
  private refreshServerStatus(): void {
    const {backendUrl, backendApiKey} = this.state.settings;
    this.checkServerStatus(backendUrl, backendApiKey || '').then((status) => {
      this.serverStatus = status;
      m.redraw();
    });
  }

  private getWelcomeMessage(): string {
    return `**Welcome to AI Assistant!** 🤖

I can help you analyze Perfetto traces. Here are some things you can ask:

* "What are the main threads in this trace?"
* "Find all ANRs (Application Not Responding)"
* "Show me the janky frames"
* "Why is my app slow?"

**Commands:**
* \`/sql <query>\` - Execute a SQL query
* \`/goto <timestamp>\` - Jump to a timestamp
* \`/analyze\` - Analyze current selection
* \`/anr\` - Find ANRs
* \`/jank\` - Find janky frames
* \`/slow\` - Analyze slow operations (backend)
* \`/memory\` - Analyze memory usage (backend)
* \`/pins\` - View pinned query results
* \`/clear\` - Clear chat history
* \`/help\` - Show this help

**Backend:** ${this.state.settings.backendUrl}

Click ⚙️ to configure backend connection.`;
  }

  private handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      this.sendMessage();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this.navigateHistory(-1);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      this.navigateHistory(1);
    }
  }

  private navigateHistory(direction: number) {
    const history = this.state.commandHistory;
    if (history.length === 0) return;

    if (this.state.historyIndex === -1 && direction === -1) {
      this.state.historyIndex = history.length - 1;
    } else {
      this.state.historyIndex = Math.max(
        -1,
        Math.min(history.length, this.state.historyIndex + direction)
      );
    }

    if (this.state.historyIndex >= 0) {
      this.state.input = history[this.state.historyIndex];
    } else {
      this.state.input = '';
    }
  }

  private async sendMessage() {
    const input = this.state.input.trim();
    if (DEBUG_AI_PANEL) console.log('[AIPanel] sendMessage called, input:', input, 'isLoading:', this.state.isLoading);

    if (!input || this.state.isLoading) return;

    // Clear skill progress tracking and errors for new analysis session
    this.state.displayedSkillProgress.clear();
    this.state.collectedErrors = [];

    // Add round separator when this is a follow-up round (prior analysis results exist).
    // P2-1: Exclude welcome/system-generated assistant messages — only count as
    // prior results when there has been at least one user message (i.e., an analysis
    // round actually ran, not just a welcome message).
    const hasUserMessages = this.state.messages.some((msg) => msg.role === 'user');
    const hasPriorResults = hasUserMessages && this.state.messages.some(
      (msg) => msg.role === 'assistant' && msg.flowTag !== 'round_separator'
    );
    if (hasPriorResults) {
      const roundNumber = this.state.messages.filter(m => m.role === 'user').length + 1;
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `Round #${roundNumber}`,
        timestamp: Date.now(),
        flowTag: 'round_separator',
      });
    }

    // Add user message
    this.addMessage({
      id: this.generateId(),
      role: 'user',
      content: input,
      timestamp: Date.now(),
    });

    this.state.input = '';
    this.state.commandHistory.push(input);
    this.state.historyIndex = -1;

    // Check if it's a command
    if (input.startsWith('/')) {
      await this.handleCommand(input);
    } else {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Calling handleChatMessage with:', input);
      await this.handleChatMessage(input);
      if (DEBUG_AI_PANEL) console.log('[AIPanel] handleChatMessage completed');
    }
  }

  private resetStreamingFlow() {
    this.state.streamingFlow = createStreamingFlowState();
  }

  private resetStreamingAnswer() {
    this.state.streamingAnswer = createStreamingAnswerState();
  }

  /**
   * Send a preset question - triggered by quick action buttons
   */
  private sendPresetQuestion(question: string) {
    if (this.state.isLoading) return;
    this.state.input = question;
    this.sendMessage();
  }

  /** Check if the user has an active Perfetto selection (area or slice). */
  private hasActiveSelection(): boolean {
    if (!this.trace) return false;
    const kind = this.trace.selection.selection.kind;
    return kind === 'area' || kind === 'track_event';
  }

  /** Build a descriptive tooltip for the selection analysis button. */
  private getSelectionButtonTitle(): string {
    if (!this.trace) return '分析当前选区';
    const sel = this.trace.selection.selection;
    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      if (timeSpan) {
        const durMs = (Number(timeSpan.duration) / 1e6).toFixed(1);
        return `分析选中区间 (${durMs}ms, ${sel.trackUris.length} tracks)`;
      }
      return `分析选中区间 (${sel.trackUris.length} tracks)`;
    }
    if (sel.kind === 'track_event') {
      return '分析选中的 Slice';
    }
    return '分析当前选区';
  }

  /**
   * One-click analysis of the current Perfetto selection.
   * Builds a smart query and sends it through the normal agent flow.
   * The selectionContext is auto-injected by handleChatMessage().
   */
  private analyzeCurrentSelection() {
    if (this.state.isLoading || !this.trace) return;
    const sel = this.trace.selection.selection;

    let query: string;
    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      const durMs = timeSpan ? (Number(timeSpan.duration) / 1e6).toFixed(1) : '?';
      query = `分析用户选中区间的性能（${durMs}ms），包括关键线程的 CPU 调度、大小核分布和频率、主要耗时 Slice 诊断`;
    } else if (sel.kind === 'track_event') {
      query = '分析用户选中的这个 Slice：它是什么、子调用链耗时分解、与历史同类 Slice 对比是否异常、根因分析';
    } else {
      return;
    }

    this.state.input = query;
    this.sendMessage();
  }

  /**
   * Analyze a detected scene - triggered by clicking a scene chip in the navigation bar.
   * Builds a context-rich query from the scene metadata and sends it for analysis.
   */
  private analyzeScene(scene: import('./scene_navigation_bar').DetectedScene) {
    if (this.state.isLoading) return;
    const typeNames: Record<string, string> = {
      cold_start: '冷启动', warm_start: '温启动', hot_start: '热启动',
      scroll: '滑动', inertial_scroll: '惯性滑动', scroll_start: '滑动',
      app_switch: '应用切换', home_screen: '桌面', app_foreground: '应用内',
      navigation: '页面跳转',
      tap: '点击响应', long_press: '长按响应',
      screen_on: '亮屏', screen_unlock: '解锁',
      back_key: '返回键', home_key: 'Home键', recents_key: '最近任务键',
      anr: 'ANR', ime_show: '键盘弹出', ime_hide: '键盘收起',
      window_transition: '窗口转场',
    };
    const typeName = typeNames[scene.type] || scene.type;
    const appHint = scene.appPackage ? ` (${scene.appPackage})` : '';
    const durHint = scene.durationMs > 0 ? `，耗时 ${scene.durationMs.toFixed(0)}ms` : '';
    const query = `分析${typeName}性能${appHint}${durHint}`;
    this.state.input = query;
    this.sendMessage();
  }

  private addMessage(msg: Message) {
    this.state.messages.push(msg);
    this.saveHistory();
    // Debounced session save — coalesces rapid streaming messages
    this.debouncedSaveSession();
    this.scrollToBottom(true);
  }

  /**
   * Create the context object for SSE event handlers.
   * This encapsulates the AIPanel state and methods needed by the handlers.
   */
  private createSSEHandlerContext(): SSEHandlerContext {
    return {
      addMessage: (msg: Message) => this.addMessage(msg),
      updateMessage: (
        messageId: string,
        updates: Partial<Message>,
        options?: {persist?: boolean}
      ) => this.updateMessage(messageId, updates, options),
      generateId: () => this.generateId(),
      getMessages: () => this.state.messages,
      removeLastMessageIf: (predicate: (msg: Message) => boolean) => {
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg && predicate(lastMsg)) {
          this.state.messages.pop();
          this.saveHistory();
          this.saveCurrentSession();
          return true;
        }
        return false;
      },
      setLoading: (loading: boolean) => {
        this.setLoadingState(loading);
      },
      displayedSkillProgress: this.state.displayedSkillProgress,
      collectedErrors: this.state.collectedErrors,
      completionHandled: this.state.completionHandled,
      setCompletionHandled: (handled: boolean) => {
        this.state.completionHandled = handled;
      },
      backendUrl: this.state.settings.backendUrl,
      streamingFlow: this.state.streamingFlow,
      streamingAnswer: this.state.streamingAnswer,
      // Agent-Driven Architecture v2.0 - Intervention support
      setInterventionState: (state: Partial<InterventionState>) => {
        this.state.interventionState = {
          ...this.state.interventionState,
          ...state,
        };
      },
      getInterventionState: () => this.state.interventionState,
      // Track overlay — create timeline tracks when overlay-eligible data arrives
      onOverlayDataReceived: (overlayId, columns, rows) => {
        if (this.trace) {
          createOverlayTrack(this.trace, overlayId, columns, rows).catch(
            (e) =>
              console.error(`[AIPanel] Overlay ${overlayId} failed:`, e),
          );
        }
      },
    };
  }

  /**
   * Handle SSE events from backend - delegates to sse_event_handlers module.
   *
   * Note: State synchronization strategy:
   * - displayedSkillProgress, collectedErrors: Passed by reference, changes reflect automatically
   * - completionHandled: Updated via setCompletionHandled() which directly modifies this.state
   * - No manual sync needed as all state changes go directly to this.state
   */
  private handleSSEEvent(eventType: string, data?: any): void {
    const ctx = this.createSSEHandlerContext();
    const result = handleSSEEventExternal(eventType, data, ctx);

    // Update loading phase from handler result
    if (result.loadingPhase !== undefined) {
      this.state.loadingPhase = result.loadingPhase;
    }

    // Handle terminal events
    if (result.stopLoading) {
      this.setLoadingState(false);
    }

    // Note: completionHandled is updated via setCompletionHandled() directly on this.state
    // Do NOT sync ctx.completionHandled back - it's the original value before handler ran

    // Trigger redraw after handling each event
    m.redraw();
  }

  private async handleCommand(input: string) {
    const parts = input.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    switch (cmd) {
      case '/sql':
        await this.handleSqlCommand(args.join(' '));
        break;
      case '/goto':
        await this.handleGotoCommand(args[0]);
        break;
      case '/analyze':
        await this.handleAnalyzeCommand();
        break;
      case '/anr':
        await this.handleAnrCommand();
        break;
      case '/jank':
        await this.handleJankCommand();
        break;
      case '/export':
        await this.handleExportCommand(args[0]);
        break;
      case '/clear':
        this.clearChat();
        break;
      case '/pins':
        this.handlePinsCommand();
        break;
      case '/help':
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: this.getHelpMessage(),
          timestamp: Date.now(),
        });
        break;
      case '/slow':
        await this.handleSlowCommand();
        break;
      case '/memory':
        await this.handleMemoryCommand();
        break;
      case '/settings':
        this.openSettings();
        break;
      case '/teaching-pipeline':
        await this.handleTeachingPipelineCommand();
        break;
      case '/scene':
        // /scene keyword path also activates the Story tab.
        this.state.currentView = 'story';
        m.redraw();
        await this.handleSceneReconstructCommand();
        break;
      default:
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `Unknown command: ${cmd}. Type \`/help\` for available commands.`,
          timestamp: Date.now(),
        });
    }
  }

  private handlePinsCommand() {
    if (this.state.pinnedResults.length === 0) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**No pinned results yet.**\n\nUse the 📌 Pin button on SQL results to save them here.',
        timestamp: Date.now(),
      });
      return;
    }

    const pinsList = this.state.pinnedResults.map((pin, index) => {
      const date = new Date(pin.timestamp).toLocaleString();
      return `**${index + 1}.** ${pin.query.substring(0, 60)}${pin.query.length > 60 ? '...' : ''}\n   - ${pin.rows.length} rows • ${date}`;
    }).join('\n\n');

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**📌 Pinned Results (${this.state.pinnedResults.length})**\n\n${pinsList}\n\nClick on any result in the chat history to use the Pin button.`,
      timestamp: Date.now(),
    });
  }

  private async handleSqlCommand(query: string) {
    if (!query) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: 'Please provide a SQL query. Example: `/sql SELECT * FROM slice LIMIT 10`',
        timestamp: Date.now(),
      });
      return;
    }

    // Store the query for pinning
    this.state.lastQuery = query;

    this.setLoadingState(true);
    m.redraw();

    try {
      const result = await this.engine?.query(query);
      if (result) {
        // Get column names - columns() returns an array of column names (strings)
        const columns = result.columns();
        const rows: any[][] = [];

        // Use empty spec for dynamic queries, iterate through all rows
        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            // Use it.get() to retrieve values by column name
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `Query returned **${rows.length}** rows.`,
          timestamp: Date.now(),
          sqlResult: {columns, rows, rowCount: rows.length, query},
        });

        // 尝试从查询结果中提取导航书签
        this.extractBookmarksFromQueryResult(query, columns, rows);
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error executing query:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleGotoCommand(ts: string) {
    if (!ts) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: 'Please provide a timestamp. Example: `/goto 1234567890`',
        timestamp: Date.now(),
      });
      return;
    }

    const normalized = ts.trim().replace(/ns$/i, '').trim();
    if (!/^\d+$/.test(normalized)) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `Invalid timestamp: ${ts}`,
        timestamp: Date.now(),
      });
      return;
    }

    const timestampNs = BigInt(normalized);
    const navigation = this.jumpToTimestamp(timestampNs);
    if (!navigation.ok) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `Failed to navigate to timestamp ${timestampNs.toString()}ns: ${navigation.error}`,
        timestamp: Date.now(),
      });
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `Navigated to timestamp ${timestampNs.toString()}ns.`,
      timestamp: Date.now(),
    });
  }

  private async handleAnalyzeCommand() {
    // Check if we have a trace and selection
    if (!this.trace) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**Error:** Trace context not available.',
        timestamp: Date.now(),
      });
      return;
    }

    const selection = this.trace.selection.selection;

    // Check if there's a selection
    if (selection.kind === 'empty') {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**No selection found.** Please click on a slice in the timeline to select it, then use `/analyze`.',
        timestamp: Date.now(),
      });
      return;
    }

    // Handle track_event selection (selected slice)
    if (selection.kind === 'track_event') {
      await this.analyzeSelectedSlice(selection.trackUri, selection.eventId);
      return;
    }

    // Handle area selection
    if (selection.kind === 'area') {
      await this.analyzeAreaSelection(selection);
      return;
    }

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `**Selection type:** ${selection.kind}\n\nAnalysis for this selection type is not yet implemented. Please try selecting a specific slice.`,
      timestamp: Date.now(),
    });
  }

  private async analyzeSelectedSlice(_trackUri: string, eventId: number) {
    this.setLoadingState(true);
    m.redraw();

    try {
      // Query the selected slice details
      const query = `
        SELECT
          s.id,
          s.name,
          s.category,
          s.ts,
          s.dur / 1e6 as dur_ms,
          s.track_id,
          s.depth,
          t.name AS track_name,
          thread.name AS thread_name,
          thread.tid AS tid,
          process.name AS process_name,
          process.pid AS pid
        FROM slice s
        LEFT JOIN track t ON s.track_id = t.id
        LEFT JOIN thread_track tt ON s.track_id = tt.id
        LEFT JOIN thread USING (utid)
        LEFT JOIN process USING (upid)
        WHERE s.id = ${eventId}
        LIMIT 1
      `;

      const result = await this.engine?.query(query);
      if (!result || result.numRows() === 0) {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: '**Error:** Could not find slice details. The slice may have been removed or the track may not be a slice track.',
          timestamp: Date.now(),
        });
        this.setLoadingState(false);
        m.redraw();
        return;
      }

      const columns = result.columns();
      const it = result.iter({});
      it.valid();

      const sliceData: Record<string, any> = {};
      for (const col of columns) {
        sliceData[col] = it.get(col);
      }

      // Format the slice information for AI
      const sliceInfo = `
Selected Slice Information:
- ID: ${sliceData.id}
- Name: ${sliceData.name}
- Category: ${sliceData.category || 'N/A'}
- Timestamp: ${sliceData.ts} (ns, absolute)
- Duration: ${sliceData.dur_ms?.toFixed(2) || 'N/A'} ms
- Process: ${sliceData.process_name || 'N/A'} (pid=${sliceData.pid ?? 'N/A'})
- Thread: ${sliceData.thread_name || 'N/A'} (tid=${sliceData.tid ?? 'N/A'})
- Track: ${sliceData.track_name || 'N/A'}
- Track ID: ${sliceData.track_id}
- Depth: ${sliceData.depth}
      `.trim();

      // If AI service is configured, ask for analysis
      if (this.state.aiService) {
        const systemPrompt = `You are an Android performance analysis expert.

You will be given ONE slice row from a Perfetto trace (plus any joined context like thread/process/track if available).

Rules:
- Base your analysis ONLY on the provided slice data. Do NOT invent missing context.
- If data is insufficient, explicitly say what is missing and suggest how to obtain it (what tables/joins to query).
- Use nanoseconds (ns) for raw timestamps and milliseconds (ms) for durations in your narrative.

Output MUST follow this exact markdown structure:

## What It Is
## Is It Abnormal?
## Why It Matters
## Next Checks (Perfetto SQL)
- Provide up to 2 SQL queries, each in a \`\`\`sql\`\`\` block, and nothing else.`;

        const userPrompt = `Analyze this slice:\n\n${sliceInfo}`;

        try {
          const response = await this.state.aiService.chat([
            {role: 'system', content: systemPrompt},
            {role: 'user', content: userPrompt}
          ]);

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Slice Analysis:**\n\n${sliceInfo}\n\n---\n\n${response}`,
            timestamp: Date.now(),
          });
        } catch (e: any) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Error calling AI:** ${e.message || e}\n\n**Slice Info:**\n\`\`\`\n${sliceInfo}\n\`\`\``,
            timestamp: Date.now(),
          });
        }
      } else {
        // No AI service configured, just show the slice info
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `**Selected Slice:**\n\`\`\`\n${sliceInfo}\n\`\`\`\n\nCheck backend connection in settings (⚙️) to enable AI-powered analysis.`,
          timestamp: Date.now(),
        });
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error analyzing slice:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async analyzeAreaSelection(selection: import('../../public/selection').AreaSelection) {
    this.setLoadingState(true);
    m.redraw();

    try {
      // Get time span info
      const timeSpan = await this.trace!.selection.getTimeSpanOfSelection();
      const duration = timeSpan ? timeSpan.duration : 0;
      const start = timeSpan?.start || 0;
      const end = timeSpan?.end || 0;

      // Query slices in the selected area
      const query = `
        SELECT
          name,
          category,
          COUNT(*) as count,
          SUM(dur) / 1e6 as total_dur_ms,
          AVG(dur) / 1e6 as avg_dur_ms,
          MIN(dur) / 1e6 as min_dur_ms,
          MAX(dur) / 1e6 as max_dur_ms
        FROM slice
        WHERE ts >= ${start} AND ts + dur <= ${end}
        GROUP BY name, category
        ORDER BY total_dur_ms DESC
        LIMIT 20
      `;

      const result = await this.engine?.query(query);
      if (!result || result.numRows() === 0) {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: '**No slices found** in the selected time range.',
          timestamp: Date.now(),
        });
        this.setLoadingState(false);
        m.redraw();
        return;
      }

      const columns = result.columns();
      const rows: any[][] = [];
      const it = result.iter({});
      while (it.valid()) {
        const row: any[] = [];
        for (const col of columns) {
          row.push(it.get(col));
        }
        rows.push(row);
        it.next();
      }

      const summary = `**Area Selection Analysis:**\n`;
      const timeInfo = `- Time range: ${start} to ${end}\n- Duration: ${(Number(duration) / 1e6).toFixed(2)} ms\n- Tracks: ${selection.trackUris.length}\n`;

      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: summary + timeInfo + `\nFound **${rows.length}** slice types in this selection.`,
        timestamp: Date.now(),
        sqlResult: {columns, rows, rowCount: rows.length},
      });
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error analyzing area:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  /**
   * Capture the current Perfetto UI selection and resolve track metadata.
   * Returns null if nothing is selected.
  /**
   * Query slice metadata for the Slice Selected card.
   * Called when selection changes to a track_event.
   */
  private async querySliceCardInfo(eventId: number): Promise<SliceCardInfo | null> {
    if (!this.engine) return null;
    try {
      const result = await this.engine.query(`
        SELECT s.id, s.name, s.ts, s.dur,
          CAST(s.dur / 1e6 AS REAL) as dur_ms,
          COALESCE(t.name, '') as thread_name,
          COALESCE(p.name, '') as process_name,
          s.depth,
          (SELECT COUNT(*) FROM slice c WHERE c.parent_id = s.id) as child_count
        FROM slice s
        LEFT JOIN thread_track tt ON s.track_id = tt.id
        LEFT JOIN thread t ON tt.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE s.id = ${eventId}
      `);
      const it = result.iter({
        id: NUM_NULL, name: STR_NULL, ts: LONG, dur: LONG, dur_ms: NUM_NULL,
        thread_name: STR_NULL, process_name: STR_NULL, depth: NUM_NULL, child_count: NUM_NULL,
      });
      if (!it.valid()) return null;
      return {
        id: Number(it.id ?? 0),
        name: String(it.name ?? ''),
        ts: Number(it.ts),
        dur: Number(it.dur),
        durMs: Number(it.dur_ms ?? 0),
        threadName: String(it.thread_name ?? ''),
        processName: String(it.process_name ?? ''),
        depth: Number(it.depth ?? 0),
        childCount: Number(it.child_count ?? 0),
      };
    } catch {
      return null;
    }
  }

  /**
   * Query area metadata for the Area Selected card.
   */
  private async queryAreaCardInfo(startNs: number, endNs: number): Promise<AreaCardInfo> {
    const durationMs = (endNs - startNs) / 1e6;
    let sliceCount = 0;
    let trackCount = 0;
    let jankCount = 0;
    const topSlices: Array<{ name: string; durMs: number; count: number }> = [];

    if (!this.engine) return { startNs, endNs, durationMs, sliceCount, trackCount, topSlices, hasJank: false, jankCount };

    try {
      const r = await this.engine.query(`
        SELECT COUNT(*) as cnt, COUNT(DISTINCT s.track_id) as tracks
        FROM slice s
        WHERE s.ts >= ${startNs} AND s.ts + s.dur <= ${endNs} AND s.dur > 0
      `);
      const it = r.iter({ cnt: NUM_NULL, tracks: NUM_NULL });
      if (it.valid()) { sliceCount = Number(it.cnt ?? 0); trackCount = Number(it.tracks ?? 0); }
    } catch { /* ignore */ }

    try {
      const r = await this.engine.query(`
        SELECT s.name, COUNT(*) as cnt, CAST(SUM(s.dur)/1e6 AS REAL) as total_ms
        FROM slice s
        WHERE s.ts >= ${startNs} AND s.ts + s.dur <= ${endNs} AND s.dur > 0
        GROUP BY s.name ORDER BY total_ms DESC LIMIT 5
      `);
      for (const it = r.iter({ name: STR_NULL, cnt: NUM_NULL, total_ms: NUM_NULL }); it.valid(); it.next()) {
        topSlices.push({ name: String(it.name ?? ''), durMs: Number(it.total_ms ?? 0), count: Number(it.cnt ?? 0) });
      }
    } catch { /* ignore */ }

    try {
      const r = await this.engine.query(`
        SELECT COUNT(*) as cnt FROM actual_frame_timeline_slice
        WHERE ts >= ${startNs} AND ts + dur <= ${endNs}
          AND jank_type IS NOT NULL AND jank_type != 'None'
      `);
      const it = r.iter({ cnt: NUM_NULL });
      if (it.valid()) jankCount = Number(it.cnt ?? 0);
    } catch { /* ignore */ }

    return { startNs, endNs, durationMs, sliceCount, trackCount, topSlices, hasJank: jankCount > 0, jankCount };
  }

  /**
   * Detect selection changes (called from view()) and trigger async slice/area info query.
   */
  /**
   * Pre-query trace data for the current selection, mirroring smartperfetto's querySelectionData.
   * Results are sent with the request so the AI doesn't need to spend turns fetching basics.
   */
  private async querySelectionData(): Promise<TraceDataset[]> {
    if (!this.engine || !this.trace) return [];
    const sel = this.trace.selection.selection;
    const datasets: TraceDataset[] = [];

    const runQuery = async (label: string, sql: string, schema: Record<string, any>): Promise<void> => {
      try {
        const result = await this.engine!.query(sql);
        const columns = Object.keys(schema);
        const rows: unknown[][] = [];
        for (const it = result.iter(schema); it.valid(); it.next()) {
          rows.push(columns.map(c => {
            const v = (it as any)[c];
            return typeof v === 'bigint' ? Number(v) : (v ?? null);
          }));
        }
        if (rows.length > 0) datasets.push({ label, columns, rows });
      } catch { /* ignore — table may not exist */ }
    };

    if (sel.kind === 'track_event') {
      const id = sel.eventId;
      const tsNs = Number(sel.ts);
      const durNs = sel.dur !== undefined ? Number(sel.dur) : 0;
      const endNs = tsNs + durNs;

      // 1) Slice details + thread/process
      await runQuery(`slice id=${id}`, `
        SELECT s.id, s.name, s.ts, s.dur, CAST(s.dur/1e6 AS REAL) as dur_ms,
          t.name as thread_name, p.name as process_name, s.depth, t.utid, t.tid
        FROM slice s
        LEFT JOIN thread_track tt ON s.track_id = tt.id
        LEFT JOIN thread t ON tt.utid = t.utid
        LEFT JOIN process p ON t.upid = p.upid
        WHERE s.id = ${id}
      `, { id: NUM_NULL, name: STR_NULL, ts: LONG, dur: LONG, dur_ms: NUM_NULL,
           thread_name: STR_NULL, process_name: STR_NULL, depth: NUM_NULL, utid: NUM_NULL, tid: NUM_NULL });

      // 2) Ancestor chain (up to 10 levels)
      await runQuery(`caller chain of slice ${id}`, `
        WITH RECURSIVE ancestors(id, parent_id, name, dur, depth) AS (
          SELECT id, parent_id, name, dur, depth FROM slice WHERE id = ${id}
          UNION ALL
          SELECT s.id, s.parent_id, s.name, s.dur, s.depth
          FROM slice s JOIN ancestors a ON s.id = a.parent_id LIMIT 10
        )
        SELECT id, name, CAST(dur/1e6 AS REAL) as dur_ms, depth
        FROM ancestors WHERE id != ${id} ORDER BY depth ASC
      `, { id: NUM_NULL, name: STR_NULL, dur_ms: NUM_NULL, depth: NUM_NULL });

      // 3) Direct children (call tree)
      await runQuery(`children of slice ${id}`, `
        SELECT id, name, CAST(dur/1e6 AS REAL) as dur_ms, depth,
          ROUND(dur * 100.0 / NULLIF((SELECT dur FROM slice WHERE id = ${id}), 0), 1) as pct
        FROM slice WHERE parent_id = ${id} ORDER BY dur DESC LIMIT 50
      `, { id: NUM_NULL, name: STR_NULL, dur_ms: NUM_NULL, depth: NUM_NULL, pct: NUM_NULL });

      // 4) Thread state distribution
      if (durNs > 0) {
        await runQuery(`thread state during slice ${id}`, `
          SELECT cpu, state, COUNT(*) AS cnt, CAST(SUM(dur)/1e6 AS REAL) as total_ms,
            CAST(SUM(dur)*100.0/${durNs} AS REAL) as pct
          FROM thread_state
          WHERE utid = (SELECT tt.utid FROM slice s JOIN thread_track tt ON s.track_id=tt.id WHERE s.id=${id})
            AND ts >= ${tsNs} AND ts <= ${endNs}
          GROUP BY cpu, state ORDER BY total_ms DESC
        `, { cpu: NUM_NULL, state: STR_NULL, cnt: NUM_NULL, total_ms: NUM_NULL, pct: NUM_NULL });
      }

    } else if (sel.kind === 'area') {
      const startNs = Number(sel.start);
      const endNs = Number(sel.end);

      // Top slices by total duration
      await runQuery(`top slices in range`, `
        SELECT s.name, COUNT(*) as cnt, CAST(SUM(s.dur)/1e6 AS REAL) as total_ms,
          CAST(AVG(s.dur)/1e6 AS REAL) as avg_ms
        FROM slice s
        WHERE s.ts >= ${startNs} AND s.ts + s.dur <= ${endNs} AND s.dur > 0
        GROUP BY s.name ORDER BY total_ms DESC LIMIT 20
      `, { name: STR_NULL, cnt: NUM_NULL, total_ms: NUM_NULL, avg_ms: NUM_NULL });

      // Thread state summary
      await runQuery(`thread states in range`, `
        SELECT t.name as thread_name, ts.state,
          CAST(SUM(ts.dur)/1e6 AS REAL) as total_ms
        FROM thread_state ts JOIN thread t ON ts.utid = t.utid
        WHERE ts.ts >= ${startNs} AND ts.ts <= ${endNs}
        GROUP BY t.name, ts.state ORDER BY total_ms DESC LIMIT 30
      `, { thread_name: STR_NULL, state: STR_NULL, total_ms: NUM_NULL });
    }

    return datasets;
  }

  private updateSliceCard(): void {
    if (!this.trace) return;
    const sel = this.trace.selection.selection;
    const selKey = sel.kind === 'track_event' ? `te-${sel.eventId}`
      : sel.kind === 'area' ? `area-${Number(sel.start)}-${Number(sel.end)}`
      : 'none';
    if (selKey === this.state.sliceCardPrevSelId) return;
    this.state.sliceCardPrevSelId = selKey;
    this.state.sliceCardDismissed = false;
    this.state.sliceCardInfo = null;
    this.state.areaCardInfo = null;
    if (sel.kind === 'track_event') {
      this.querySliceCardInfo(sel.eventId).then((info) => {
        this.state.sliceCardInfo = info;
        m.redraw();
      });
    } else if (sel.kind === 'area') {
      this.queryAreaCardInfo(Number(sel.start), Number(sel.end)).then((info) => {
        this.state.areaCardInfo = info;
        m.redraw();
      });
    }
  }

  private fmtDurMs(ms: number): string {
    if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
    if (ms >= 1) return `${ms.toFixed(2)}ms`;
    return `${(ms * 1000).toFixed(0)}μs`;
  }

  /**
   * Render the Slice Selected card above the input box.
   */
  private renderSliceCard(): m.Vnode | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'track_event') return null;
    if (this.state.sliceCardDismissed) return null;
    const info = this.state.sliceCardInfo;
    if (!info) return null;

    const dur = this.fmtDurMs(info.durMs);
    const isSlow = info.durMs >= 16;

    const onAction = (query: string) => {
      this.state.sliceCardDismissed = true;
      this.state.input = query;
      // Pre-query trace data before sending — result stored in pendingTraceContext
      this.querySelectionData().then((datasets) => {
        this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
        this.sendMessage();
      });
    };

    return m('div.sp-sel-card', [
      m('div.sp-sel-card-header', [
        m('span.sp-sel-card-title', `⬛ Slice Selected${isSlow ? ' ⚠️' : ''}`),
        m('button.sp-sel-card-dismiss', {
          onclick: () => { this.state.sliceCardDismissed = true; m.redraw(); },
          title: 'Dismiss',
        }, '✕'),
      ]),
      m('div.sp-sel-card-meta', [
        m('span.sp-meta-pill', [m('strong', info.name)]),
        m('span.sp-meta-pill', ['⏱ ', m('strong', dur)]),
        info.threadName ? m('span.sp-meta-pill', ['🧵 ', info.threadName]) : null,
        info.processName ? m('span.sp-meta-pill', ['📦 ', info.processName]) : null,
        info.childCount > 0 ? m('span.sp-meta-pill', ['🌿 ', `${info.childCount} children`]) : null,
        m('span.sp-meta-pill', {
          style: 'cursor:pointer',
          title: 'Jump to timestamp',
          onclick: () => this.trace!.timeline.panIntoView(Time.fromRaw(BigInt(info.ts))),
        }, [`📍 `, `${(info.ts / 1e6).toFixed(1)}ms`]),
      ]),
      m('div.sp-sel-card-actions', [
        m('button.sp-action-btn.sp-action-btn--primary', {
          onclick: () => onAction(`分析这个 Slice：${info.name}（${dur}），找出性能问题和根因`),
          disabled: this.state.isLoading,
        }, '🔍 分析此 Slice'),
        m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`找出 "${info.name}" 耗时 ${dur} 的根本原因，分析调用链和子调用`),
          disabled: this.state.isLoading,
        }, '🔎 找根因'),
        m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`展示 "${info.name}" 的完整调用链，包括父调用和子调用，并找出最耗时的部分`),
          disabled: this.state.isLoading,
        }, '📊 调用链'),
        isSlow ? m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`"${info.name}" 耗时 ${dur} 超过帧预算（16ms），分析为什么会卡顿`),
          disabled: this.state.isLoading,
        }, '🚨 卡顿分析') : null,
      ]),
    ]);
  }

  /**
   * Render the Area Selected card above the input box.
   */
  private renderAreaCard(): m.Vnode | null {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;
    if (sel.kind !== 'area') return null;
    if (this.state.sliceCardDismissed) return null;
    const info = this.state.areaCardInfo;
    if (!info) return null;

    const startMs = (info.startNs / 1e6).toFixed(1);
    const endMs = (info.endNs / 1e6).toFixed(1);
    const dur = this.fmtDurMs(info.durationMs);

    const onAction = (query: string) => {
      this.state.sliceCardDismissed = true;
      this.state.input = query;
      this.querySelectionData().then((datasets) => {
        this.state.pendingTraceContext = datasets.length > 0 ? datasets : null;
        this.sendMessage();
      });
    };

    return m('div.sp-sel-card', [
      m('div.sp-sel-card-header', [
        m('span.sp-sel-card-title', `⬜ 时间范围选中${info.hasJank ? ' ⚠️ Jank' : ''}`),
        m('button.sp-sel-card-dismiss', {
          onclick: () => { this.state.sliceCardDismissed = true; m.redraw(); },
          title: 'Dismiss',
        }, '✕'),
      ]),
      m('div.sp-sel-card-meta', [
        m('span.sp-meta-pill', ['⏱ ', m('strong', dur)]),
        m('span.sp-meta-pill', ['📍 ', `${startMs}ms – ${endMs}ms`]),
        info.sliceCount > 0 ? m('span.sp-meta-pill', ['📋 ', `${info.sliceCount} slices`]) : null,
        info.trackCount > 0 ? m('span.sp-meta-pill', ['🎛 ', `${info.trackCount} tracks`]) : null,
        info.hasJank ? m('span.sp-meta-pill', {
          style: 'background:#fef2f2;border-color:#fca5a5;color:#b91c1c',
        }, ['⚠️ ', `${info.jankCount} jank frames`]) : null,
      ]),
      info.topSlices.length > 0
        ? m('div', { style: 'padding: 0 10px 5px; font-size:11px; color:#6b7280' }, [
            'Top: ',
            info.topSlices.slice(0, 3).map((s, i) =>
              m('span', { style: 'margin-right:6px' }, [
                i > 0 ? '· ' : '',
                m('strong', s.name.length > 30 ? s.name.slice(0, 30) + '…' : s.name),
                ` (${this.fmtDurMs(s.durMs)})`,
              ]),
            ),
          ])
        : null,
      m('div.sp-sel-card-actions', [
        m('button.sp-action-btn.sp-action-btn--primary', {
          onclick: () => onAction(`分析 ${startMs}ms–${endMs}ms 这段时间范围（${dur}），找出性能瓶颈`),
          disabled: this.state.isLoading,
        }, '🔍 分析此时间段'),
        info.hasJank ? m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`分析 ${startMs}ms–${endMs}ms 范围内的 ${info.jankCount} 个 Jank 帧，找出卡顿根因`),
          disabled: this.state.isLoading,
        }, '🚨 找卡顿原因') : null,
        m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`找出 ${startMs}ms–${endMs}ms 时间段内主线程的耗时操作`),
          disabled: this.state.isLoading,
        }, '🧵 主线程分析'),
        m('button.sp-action-btn.sp-action-btn--secondary', {
          onclick: () => onAction(`分析 ${startMs}ms–${endMs}ms 内的 Binder 调用和锁竞争`),
          disabled: this.state.isLoading,
        }, '🔗 Binder/锁'),
      ]),
    ]);
  }

  /**
   * Called on every handleChatMessage() so the backend always gets the latest selection.
   */
  private async captureSelectionContext(): Promise<SelectionContext | null> {
    if (!this.trace) return null;
    const sel = this.trace.selection.selection;

    if (sel.kind === 'area') {
      const timeSpan = this.trace.selection.getTimeSpanOfSelection();
      const startNs = Number(sel.start);
      const endNs = Number(sel.end);
      const durationNs = timeSpan ? Number(timeSpan.duration) : endNs - startNs;

      // Resolve track metadata (thread/process names) from track tags
      const tracks = await this.resolveTrackInfos(sel.tracks);

      return {
        kind: 'area',
        startNs,
        endNs,
        durationNs,
        tracks,
        trackCount: sel.trackUris.length,
      };
    }

    if (sel.kind === 'track_event') {
      // Reuse pre-queried sliceCardInfo if it matches current selection (avoids redundant SQL)
      const cardInfo = this.state.sliceCardInfo?.id === sel.eventId
        ? this.state.sliceCardInfo
        : null;
      const ctx: SelectionContext = {
        kind: 'track_event',
        trackUri: sel.trackUri,
        eventId: sel.eventId,
        ts: Number(sel.ts),
        dur: sel.dur !== undefined ? Number(sel.dur) : undefined,
      };
      if (cardInfo) {
        ctx.name = cardInfo.name;
        ctx.threadName = cardInfo.threadName;
        ctx.processName = cardInfo.processName;
        ctx.depth = cardInfo.depth;
        ctx.childCount = cardInfo.childCount;
      }
      console.log('[AIPanel] captureSelectionContext: track_event captured', ctx);
      return ctx;
    }

    console.log('[AIPanel] captureSelectionContext: no selection (kind=' + sel.kind + '), returning null');
    return null;
  }

  /**
   * Batch-resolve track tags (utid/upid/cpu) into human-readable names via SQL.
   */
  private async resolveTrackInfos(
    tracks: ReadonlyArray<import('../../public/track').Track>,
  ): Promise<SelectionTrackInfo[]> {
    const result: SelectionTrackInfo[] = [];
    const utids = new Set<number>();
    const upids = new Set<number>();

    // Collect utid/upid/cpu from track tags
    for (const t of tracks) {
      const info: SelectionTrackInfo = { uri: t.uri };
      if (t.tags?.cpu !== undefined) info.cpu = t.tags.cpu as number;
      if (t.tags?.type) info.kind = t.tags.type as string;
      if (t.tags?.utid !== undefined) utids.add(t.tags.utid as number);
      if (t.tags?.upid !== undefined) upids.add(t.tags.upid as number);
      result.push(info);
    }

    if (!this.engine || (utids.size === 0 && upids.size === 0)) return result;

    // Batch query thread names
    const threadMap = new Map<number, { name: string; tid: number; upid?: number }>();
    if (utids.size > 0) {
      try {
        const q = `SELECT utid, name, tid, upid FROM thread WHERE utid IN (${[...utids].join(',')})`;
        const res = await this.engine.query(q);
        const it = res.iter({});
        while (it.valid()) {
          threadMap.set(
            Number(it.get('utid')),
            { name: String(it.get('name') ?? ''), tid: Number(it.get('tid')), upid: it.get('upid') != null ? Number(it.get('upid')) : undefined },
          );
          // Also collect upids from thread rows for process name resolution
          if (it.get('upid') != null) upids.add(Number(it.get('upid')));
          it.next();
        }
      } catch { /* non-fatal */ }
    }

    // Batch query process names
    const processMap = new Map<number, { name: string; pid: number }>();
    if (upids.size > 0) {
      try {
        const q = `SELECT upid, name, pid FROM process WHERE upid IN (${[...upids].join(',')})`;
        const res = await this.engine.query(q);
        const it = res.iter({});
        while (it.valid()) {
          processMap.set(
            Number(it.get('upid')),
            { name: String(it.get('name') ?? ''), pid: Number(it.get('pid')) },
          );
          it.next();
        }
      } catch { /* non-fatal */ }
    }

    // Merge resolved names back into result
    for (let i = 0; i < tracks.length; i++) {
      const t = tracks[i];
      const info = result[i];
      const utid = t.tags?.utid as number | undefined;
      const upid = t.tags?.upid as number | undefined;

      if (utid !== undefined) {
        const th = threadMap.get(utid);
        if (th) {
          info.threadName = th.name;
          info.tid = th.tid;
          // Resolve process via thread's upid
          if (th.upid !== undefined) {
            const proc = processMap.get(th.upid);
            if (proc) {
              info.processName = proc.name;
              info.pid = proc.pid;
            }
          }
        }
      }
      if (upid !== undefined && !info.processName) {
        const proc = processMap.get(upid);
        if (proc) {
          info.processName = proc.name;
          info.pid = proc.pid;
        }
      }
    }

    return result;
  }

  private async handleAnrCommand() {
    this.setLoadingState(true);
    m.redraw();

    try {
      const query = `
        SELECT
          id,
          name,
          ts,
          dur / 1e6 as duration_ms,
          EXTRACT_ARG(arg_set_id, 'anr.error_type') as error_type
        FROM slice
        WHERE dur > 5000000000
          AND (category = 'Java' OR name LIKE '%ANR%')
        ORDER BY dur DESC
        LIMIT 20
      `;

      // Store query for pinning
      this.state.lastQuery = query;

      const result = await this.engine?.query(query);
      if (result) {
        const columns = result.columns();
        const rows: any[][] = [];

        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        if (rows.length > 0) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `Found **${rows.length}** potential ANRs in this trace.`,
            timestamp: Date.now(),
            query: query,
            sqlResult: {columns, rows, rowCount: rows.length, query},
          });
        } else {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: '**No ANRs detected** in this trace. Good job!',
            timestamp: Date.now(),
          });
        }
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error detecting ANRs:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleJankCommand() {
    this.setLoadingState(true);
    m.redraw();

    try {
      const query = `
        SELECT
          id,
          name,
          ts,
          dur / 1e6 as duration_ms,
          track_id
        FROM slice
        WHERE category = 'gfx'
          AND dur > 16670000
          AND name LIKE 'Jank%'
        ORDER BY dur DESC
        LIMIT 50
      `;

      // Store query for pinning
      this.state.lastQuery = query;

      const result = await this.engine?.query(query);
      if (result) {
        const columns = result.columns();
        const rows: any[][] = [];

        const it = result.iter({});
        while (it.valid()) {
          const row: any[] = [];
          for (const col of columns) {
            row.push(it.get(col));
          }
          rows.push(row);
          it.next();
        }

        if (rows.length > 0) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `Found **${rows.length}** janky frames in this trace.`,
            timestamp: Date.now(),
            query: query,
            sqlResult: {columns, rows, rowCount: rows.length, query},
          });
        } else {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: '**No jank detected** in this trace. Smooth rendering!',
            timestamp: Date.now(),
          });
        }
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error detecting jank:** ${e.message || e}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  private async handleSlowCommand() {
    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。`/slow` 命令需要后端支持。',
        timestamp: Date.now(),
      });
      return;
    }
    await this.handleChatMessage('分析慢操作（IO/数据库/输入事件）');
  }

  private async handleMemoryCommand() {
    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。`/memory` 命令需要后端支持。',
        timestamp: Date.now(),
      });
      return;
    }
    await this.handleChatMessage('分析内存与 GC/LMK 情况');
  }

  /**
   * Ensure backend has an active Agent session for multi-turn continuity.
   * Attempts to restore from backend persistence after reload/restart.
   */
  private async ensureAgentSessionReady(): Promise<void> {
    if (!this.state.agentSessionId || !this.state.backendTraceId) {
      return;
    }

    const sessionId = this.state.agentSessionId;
    try {
      const response = await this.fetchBackend(buildAssistantApiV1Url(this.state.settings.backendUrl, '/resume'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          traceId: this.state.backendTraceId,
        }),
      });

      if (response.ok) {
        const resumeData = await response.json().catch(() => ({} as any));
        const requestIdFromHeader = response.headers.get('x-request-id') || '';
        if (this.applyAgentObservability({
          ...resumeData,
          requestId: resumeData.requestId || requestIdFromHeader,
        })) {
          this.saveCurrentSession();
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent observability updated from resume response:', {
            runId: this.state.agentRunId,
            requestId: this.state.agentRequestId,
            runSequence: this.state.agentRunSequence,
          });
        }
        return;
      }

      const errorData = await response.json().catch(() => ({} as any));
      const code = String(errorData?.code || '');
      const errorText = String(errorData?.error || '');

      // Non-recoverable continuity failures: clear stale session and continue with a new chain.
      if (
        response.status === 404 ||
        code === 'TRACE_ID_MISMATCH' ||
        errorText.includes('Session not found')
      ) {
        console.warn('[AIPanel] Agent session continuity unavailable, falling back to new session:', {
          sessionId,
          code,
          errorText,
        });
        this.state.agentSessionId = null;
        this.clearAgentObservability();
        this.saveCurrentSession();
        // P1-F1: Notify user that context continuity was lost
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `⚠️ **上下文已重置** — 之前的分析会话已过期或后端已重启，本次将以新会话开始分析。之前的对话上下文不会被继承。`,
          timestamp: Date.now(),
        });
        m.redraw();
        return;
      }

      throw new Error(`resume failed: ${response.status} ${errorText || response.statusText}`);
    } catch (error) {
      console.warn('[AIPanel] Failed to ensure Agent session continuity:', error);
      // Keep current sessionId in state for potential transient backend failures.
    }
  }

  private async tryRecoverMissingSseSession(
    sessionId: string
  ): Promise<'restored' | 'notRecoverable' | 'transientError'> {
    if (!this.state.backendTraceId) {
      return 'notRecoverable';
    }

    try {
      this.upsertSseStatusMessage('正在恢复会话：后端可能刚刚重启，正在重新绑定分析上下文。');
      m.redraw();

      const response = await this.fetchBackend(buildAssistantApiV1Url(this.state.settings.backendUrl, '/resume'), {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          traceId: this.state.backendTraceId,
        }),
      });

      if (response.ok) {
        const resumeData = await response.json().catch(() => ({} as any));
        const requestIdFromHeader = response.headers.get('x-request-id') || '';
        this.state.agentSessionId = sessionId;
        this.state.sseLastEventId = null;
        if (this.applyAgentObservability({
          ...resumeData,
          requestId: resumeData.requestId || requestIdFromHeader,
        })) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent observability updated from SSE resume:', {
            runId: this.state.agentRunId,
            requestId: this.state.agentRequestId,
            runSequence: this.state.agentRunSequence,
          });
        }
        this.upsertSseStatusMessage('后端已重启，已恢复会话，正在重新连接结果流。');
        this.saveCurrentSession();
        m.redraw();
        return 'restored';
      }

      const errorData = await response.json().catch(() => ({} as any));
      const code = String(errorData?.code || '');
      const errorText = String(errorData?.error || '');
      if (
        response.status === 404 ||
        code === 'TRACE_ID_MISMATCH' ||
        code === 'TRACE_NOT_UPLOADED' ||
        errorText.includes('Session not found')
      ) {
        this.state.agentSessionId = null;
        this.state.sseLastEventId = null;
        this.state.sseConnectionState = 'disconnected';
        this.clearAgentObservability();
        this.setLoadingState(false);
        const content = code === 'TRACE_NOT_UPLOADED'
          ? '后端已重启，当前 Trace 需要重新连接。请点击右上角“重试连接”重新上传 Trace 后再分析。'
          : '后端已重启，当前分析会话无法恢复。本次流式分析已停止，请重新发起分析。';
        this.upsertSseStatusMessage(content);
        this.saveCurrentSession();
        m.redraw();
        return 'notRecoverable';
      }

      console.warn('[AIPanel] SSE session recovery returned retryable error:', {
        status: response.status,
        code,
        errorText,
      });
      return 'transientError';
    } catch (error) {
      console.warn('[AIPanel] SSE session recovery failed:', error);
      return 'transientError';
    }
  }

  private async handleChatMessage(message: string) {
    if (DEBUG_AI_PANEL) console.log('[AIPanel] handleChatMessage called with:', message);
    if (DEBUG_AI_PANEL) console.log('[AIPanel] backendTraceId:', this.state.backendTraceId);

    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '⚠️ **Trace 未连接到 AI 后端**\n\n请确认后端服务已启动，然后点击右上角"重试连接"按钮。后端将执行 SQL 查询并提供详细分析。',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    this.state.completionHandled = false;  // Reset completion flag for new analysis
    this.state.displayedSkillProgress.clear();  // Clear progress tracking for new analysis
    this.state.collectedErrors = [];  // Clear error collection for new analysis
    this.resetStreamingFlow();  // Reset progressive transcript for new analysis turn
    this.resetStreamingAnswer();  // Reset incremental answer stream for new analysis turn
    // AI Everywhere: update cross-component state + clear old timeline notes
    updateAISharedState({status: 'analyzing', findings: [], currentPhase: '', issueCount: 0});
    if (this.trace) clearAIFindingNotes(this.trace);
    m.redraw();

    try {
      // Ensure prior multi-turn context is restored when possible.
      await this.ensureAgentSessionReady();

      // Call Agent API (Agent-Driven Orchestrator)
      const apiUrl = buildAssistantApiV1Url(this.state.settings.backendUrl, '/analyze');
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Calling Agent API:', apiUrl, 'with traceId:', this.state.backendTraceId);

      // Build request body, include sessionId for multi-turn dialogue
      const requestBody: Record<string, any> = {
        query: message,
        traceId: this.state.backendTraceId,
        options: {
          maxRounds: 3,  // Reduced to avoid unnecessary iterations
          confidenceThreshold: 0.5,  // Match backend default
          maxNoProgressRounds: 2,
          maxFailureRounds: 2,
          analysisMode: this.state.analysisMode,
        },
      };

      // Comparison mode: include reference trace ID
      if (this.state.referenceTraceId) {
        requestBody.referenceTraceId = this.state.referenceTraceId;
      }

      // Capture current Perfetto selection (area / slice) and include in request
      const selectionContext = await this.captureSelectionContext();
      if (selectionContext) {
        requestBody.selectionContext = selectionContext;
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Injecting selectionContext:', selectionContext);
      }

      // Attach pre-queried trace data (set by quick-action buttons) and consume it
      if (this.state.pendingTraceContext) {
        requestBody.traceContext = this.state.pendingTraceContext;
        this.state.pendingTraceContext = null;
      }

      // Include agentSessionId if available for multi-turn dialogue
      if (this.state.agentSessionId) {
        requestBody.sessionId = this.state.agentSessionId;
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Reusing Agent session for multi-turn dialogue:', this.state.agentSessionId);
      }

      const response = await this.fetchBackend(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'TRACE_NOT_UPLOADED' || errorData.error?.includes('not found')) {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content: '⚠️ **后端未找到该 Trace**\n\nTrace 可能已过期。请点击右上角"重试连接"按钮重新上传。',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          // P1-F6: Also clear stale agentSessionId when trace is gone
          this.state.agentSessionId = null;
          this.clearAgentObservability();
          // Note: Don't return early - let finally block handle cleanup
          throw new Error('TRACE_NOT_FOUND');  // Will be caught and cleanup will run
        }
        throw new Error(`API error: ${response.status} ${errorData.error || response.statusText}`);
      }

      const data = await response.json();
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Analysis failed');
      }

      const requestIdFromHeader = response.headers.get('x-request-id') || '';
      const observabilityUpdated = this.applyAgentObservability({
        ...data,
        requestId: data.requestId || requestIdFromHeader,
      });
      if (observabilityUpdated) {
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent observability updated from analyze response:', {
          runId: this.state.agentRunId,
          requestId: this.state.agentRequestId,
          runSequence: this.state.agentRunSequence,
        });
      }

      // Use SSE for real-time progress updates
      const sessionId = data.sessionId;
      if (sessionId) {
        // Save sessionId for multi-turn dialogue
        // Only save if this is a new session or reusing existing session
        const isNewSession = data.isNewSession !== false;
        if (isNewSession) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Saving new Agent session for multi-turn dialogue:', sessionId);
        } else {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] Continuing existing Agent session:', sessionId);
        }
        this.state.agentSessionId = sessionId;
        this.saveCurrentSession();

        if (DEBUG_AI_PANEL) console.log('[AIPanel] Starting Agent SSE listener for session:', sessionId);
        await this.listenToAgentSSE(sessionId);
      } else {
        if (DEBUG_AI_PANEL) console.log('[AIPanel] No sessionId in response, data:', data);
      }

    } catch (e: any) {
      // Don't show duplicate error message for TRACE_NOT_FOUND (already shown above)
      if (e.message !== 'TRACE_NOT_FOUND') {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `**Error:** ${e.message || 'Failed to start analysis'}`,
          timestamp: Date.now(),
        });
      }
    } finally {
      // Always reset loading state, even on early returns via thrown errors
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Calculate exponential backoff delay for SSE reconnection
   * Base: 1 second, Max: 30 seconds
   */
  private calculateBackoffDelay(retryCount: number): number {
    const baseDelay = 1000; // 1 second
    const maxDelay = 30000; // 30 seconds
    const delay = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
    // Add jitter (±20%) to prevent thundering herd
    const jitter = delay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(delay + jitter);
  }

  /**
   * Cancel any ongoing SSE connection
   */
  private cancelSSEConnection(): void {
    if (this.sseAbortController) {
      this.sseAbortController.abort();
      this.sseAbortController = null;
    }
    this.state.sseConnectionState = 'disconnected';
  }

  /**
   * User-initiated analysis cancellation. Aborts the SSE stream,
   * resets loading state, and adds a cancellation notice to chat.
   */
  private cancelAnalysis(): void {
    this.cancelSSEConnection();
    this.setLoadingState(false);
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    // P1-4: Best-effort notify backend to stop consuming tokens
    if (this.state.agentSessionId) {
      const cancelUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        `/${this.state.agentSessionId}/cancel`,
      );
      this.fetchBackend(cancelUrl, {method: 'POST'}).catch(() => {});
    }
    // P2-10: Mark orphaned streaming-flow messages as cancelled
    for (const msg of this.state.messages) {
      if (msg.flowTag === 'streaming_flow') {
        msg.content = '_分析已取消_';
      }
    }
    // P1-F2: Clear agentSessionId after cancellation to avoid resuming a mid-cancelled session
    this.state.agentSessionId = null;
    this.clearAgentObservability();
    this.saveCurrentSession();
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: '分析已取消。下次分析将以新会话开始。',
      timestamp: Date.now(),
    });
    m.redraw();
  }

  private resetInterventionState(): void {
    this.state.interventionState = {...DEFAULT_INTERVENTION_STATE};
  }

  /**
   * Listen to Agent SSE events from MasterOrchestrator
   * With automatic reconnection and exponential backoff.
   *
   * @param sessionId The agent session ID to stream from.
   * @param resumeFromLastEventId If true, preserve the current
   *   `sseLastEventId` so the backend replays events from that point.
   *   Used by transient state restore after Pop Out / Dock Back.
   */
  private async listenToAgentSSE(
    sessionId: string,
    resumeFromLastEventId: boolean = false,
  ): Promise<void> {
    const baseApiUrl = buildAssistantApiV1Url(this.state.settings.backendUrl, `/${sessionId}/stream`);

    // Cancel any existing connection
    this.cancelSSEConnection();

    // Create new AbortController for this connection
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    // Mark as connecting
    this.state.sseConnectionState = 'connecting';
    this.state.sseRetryCount = 0;
    if (!resumeFromLastEventId) {
      this.state.sseLastEventId = null;  // Reset for fresh connection; preserved across reconnects
    }
    m.redraw();

    // Main connection loop with retry logic
    let attemptedSessionRecovery = false;
    while (this.state.sseRetryCount <= this.state.sseMaxRetries) {
      try {
        // Check if aborted before attempting connection
        if (signal.aborted) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE connection aborted');
          return;
        }

        // F3: Append lastEventId query param on reconnect for event replay
        const apiUrl = this.state.sseLastEventId !== null
          ? `${baseApiUrl}${baseApiUrl.includes('?') ? '&' : '?'}lastEventId=${this.state.sseLastEventId}`
          : baseApiUrl;

        const response = await this.fetchBackend(apiUrl, { signal });
        if (!response.ok) {
          if (response.status === 404 && !attemptedSessionRecovery) {
            attemptedSessionRecovery = true;
            const recovery = await this.tryRecoverMissingSseSession(sessionId);
            if (recovery === 'restored') {
              continue;
            }
            if (recovery === 'notRecoverable') {
              return;
            }
          }

          // P2-2: 4xx errors are not transient (bad request, not found, etc.) — don't retry
          if (response.status >= 400 && response.status < 500) {
            console.error(`[AIPanel] SSE got ${response.status} — not retryable, giving up`);
            this.state.sseConnectionState = 'disconnected';
            this.setLoadingState(false);
            this.upsertSseStatusMessage(`后端连接失败：${response.status} ${response.statusText}`);
            m.redraw();
            return;
          }
          throw new Error(`Agent SSE connection failed: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }

        // Connection successful - update state
        this.state.sseConnectionState = 'connected';
        this.state.sseRetryCount = 0;
        this.state.sseLastEventTime = Date.now();
        if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE connected successfully');
        m.redraw();

        const decoder = new TextDecoder();
        let buffer = '';
        // Persist event type across read chunks to handle large payloads
        // that may span multiple reader.read() calls
        let currentEventType = '';

        // Read loop
        while (true) {
          // Check if aborted
          if (signal.aborted) {
            if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE reader aborted');
            reader.releaseLock();
            return;
          }

          const {done, value} = await reader.read();
          if (done) {
            if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE stream ended normally');
            reader.releaseLock();
            // Stream ended normally (server closed), no need to reconnect
            this.state.sseConnectionState = 'disconnected';
            m.redraw();
            return;
          }

          buffer += decoder.decode(value, {stream: true});
          this.state.sseLastEventTime = Date.now();

          // Process complete SSE messages
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith(':')) continue; // Skip keep-alive comments

            if (line.startsWith('id:')) {
              // F3: Track last event sequence ID for replay on reconnect
              const id = parseInt(line.replace('id:', '').trim(), 10);
              if (!isNaN(id)) {
                this.state.sseLastEventId = id;
              }
            } else if (line.startsWith('event:')) {
              currentEventType = line.replace('event:', '').trim();
            } else if (line.startsWith('data:')) {
              const dataStr = line.replace('data:', '').trim();
              if (dataStr) {
                try {
                  const data = JSON.parse(dataStr);
                  const eventType = currentEventType || data.type;
                  if (!eventType) {
                    console.warn('[AIPanel] SSE event with no type, skipping:', Object.keys(data));
                  } else {
                    const observabilityUpdated = this.applyAgentObservability(data);
                    if (observabilityUpdated) {
                      this.saveCurrentSession();
                      if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent observability updated from SSE:', {
                        eventType,
                        runId: this.state.agentRunId,
                        requestId: this.state.agentRequestId,
                        runSequence: this.state.agentRunSequence,
                      });
                    }
                    if (DEBUG_AI_PANEL) console.log('[AIPanel] Agent SSE event:', eventType);
                    this.handleSSEEvent(eventType, data);

                    // Check for terminal events (no need to reconnect after these)
                    // 'conclusion' from agentv3 is near-terminal (answer done) but
                    // 'analysis_completed' follows with reportUrl after HTML report
                    // generation. Only close on analysis_completed/error/end.
                    if (eventType === 'analysis_completed' || eventType === 'error' || eventType === 'end') {
                      this.flushSessionSave();
                      this.cancelSSEConnection();
                      m.redraw();
                      return;
                    }
                  }
                } catch (e) {
                  console.error('[AIPanel] Failed to parse Agent SSE data:', e, dataStr.substring(0, 200));
                }
              }
              currentEventType = '';
            }
          }
        }
      } catch (e: any) {
        // Check if this was an intentional abort
        if (signal.aborted || e.name === 'AbortError') {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE connection intentionally aborted');
          this.state.sseConnectionState = 'disconnected';
          return;
        }

        console.error('[AIPanel] Agent SSE error (attempt', this.state.sseRetryCount + 1, '):', e);

        // Check if we have retries left
        if (this.state.sseRetryCount >= this.state.sseMaxRetries) {
          // Max retries exceeded - give up
          console.error('[AIPanel] SSE max retries exceeded, giving up');
          this.state.sseConnectionState = 'disconnected';
          this.setLoadingState(false);
          this.upsertSseStatusMessage(
            `后端连接失败：${e.message || 'Agent 后端连接中断'}\n\n已重试 ${this.state.sseMaxRetries} 次，请重新发起分析。`
          );
          m.redraw();
          return;
        }

        // Schedule reconnection with exponential backoff
        this.state.sseRetryCount++;
        this.state.sseConnectionState = 'reconnecting';
        const delay = this.calculateBackoffDelay(this.state.sseRetryCount - 1);
        if (DEBUG_AI_PANEL) console.log(`[AIPanel] SSE reconnecting in ${delay}ms (attempt ${this.state.sseRetryCount}/${this.state.sseMaxRetries})`);

        // Update UI to show reconnecting status
        this.upsertSseStatusMessage(
          `连接中断，正在重连...（第 ${this.state.sseRetryCount}/${this.state.sseMaxRetries} 次）`
        );
        m.redraw();

        // Wait before retrying (unless aborted)
        await new Promise<void>((resolve) => {
          const timeoutId = setTimeout(resolve, delay);
          // If aborted during wait, clear timeout and resolve immediately
          const abortHandler = () => {
            clearTimeout(timeoutId);
            resolve();
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        });

        if (signal.aborted) {
          if (DEBUG_AI_PANEL) console.log('[AIPanel] SSE retry wait aborted');
          return;
        }

        // Check if analysis already completed while disconnected
        if (await this.checkSessionStatus(sessionId, signal)) {
          return;
        }
      }
    }
  }

  /**
   * Check backend session status after SSE reconnect.
   * If analysis already completed/failed during disconnect, finalize the UI.
   * Returns true if the session is terminal (no need to reconnect).
   */
  private async checkSessionStatus(sessionId: string, signal: AbortSignal): Promise<boolean> {
    try {
      const statusUrl = buildAssistantApiV1Url(
        this.state.settings.backendUrl,
        `/${sessionId}/status`,
      );
      const res = await this.fetchBackend(statusUrl, {signal});
      if (!res.ok) return false;
      const body = await res.json();
      const status = body.status || body.state;
      if (status === 'completed' || status === 'failed') {
        if (DEBUG_AI_PANEL) console.log('[AIPanel] Session already', status, '— stopping SSE reconnect');
        this.state.sseConnectionState = 'disconnected';
        this.setLoadingState(false);
        // Remove reconnecting indicator if present
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg?.role === 'assistant' && lastMsg.content.startsWith('\u{1F504}')) {
          this.state.messages.pop();
        }
        if (status === 'failed') {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Analysis failed** while reconnecting. Please try again.`,
            timestamp: Date.now(),
          });
        }
        this.flushSessionSave();
        m.redraw();
        return true;
      }
    } catch {
      // Status check failed — continue with reconnect attempt
    }
    return false;
  }


  /**
   * Handle /teaching-pipeline command
   * Detects the rendering pipeline type and shows educational content
   */
  private async handleTeachingPipelineCommand() {
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '⚠️ **无法执行管线检测**\n\n请先确保 Trace 已上传到后端。',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    m.redraw();

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Teaching pipeline request with traceId:', this.state.backendTraceId);

    try {
      const response = await this.fetchBackend(buildAssistantApiV1Url(this.state.settings.backendUrl, '/teaching/pipeline'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.state.backendTraceId,
        }),
      });

      if (!response.ok) {
        // Try to parse error details from response body
        try {
          const errorData = await response.json();
          console.error('[AIPanel] Teaching pipeline error response:', errorData);
          throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        } catch (parseErr) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Pipeline detection failed');
      }

      // Build teaching content message
      const detection = data.detection;
      const teaching = data.teaching;
      const pinInstructions = data.pinInstructions || [];
      // v3 Smart Pin: Get active rendering processes for intelligent pinning
      const activeRenderingProcesses = data.activeRenderingProcesses || [];

      // Format pipeline type with confidence
      const pipelineType = detection.primary_pipeline.id;
      const confidence = (detection.primary_pipeline.confidence * 100).toFixed(0);

      // Build message content
      let content = `## 🎓 渲染管线教学\n\n`;
      content += `### 检测结果\n`;
      content += `- **管线类型**: \`${pipelineType}\` (置信度: ${confidence}%)\n`;

      // Show subvariants if relevant
      const subvariants = detection.subvariants;
      if (subvariants.buffer_mode !== 'UNKNOWN' && subvariants.buffer_mode !== 'N/A') {
        content += `- **Buffer 模式**: ${subvariants.buffer_mode}\n`;
      }
      if (subvariants.flutter_engine !== 'UNKNOWN' && subvariants.flutter_engine !== 'N/A') {
        content += `- **Flutter 引擎**: ${subvariants.flutter_engine}\n`;
      }
      if (subvariants.webview_mode !== 'UNKNOWN' && subvariants.webview_mode !== 'N/A') {
        content += `- **WebView 模式**: ${subvariants.webview_mode}\n`;
      }
      if (subvariants.game_engine !== 'UNKNOWN' && subvariants.game_engine !== 'N/A') {
        content += `- **游戏引擎**: ${subvariants.game_engine}\n`;
      }

      // Show candidates if there are alternatives
      if (detection.candidates && detection.candidates.length > 1) {
        content += `\n**候选类型**: `;
        content += detection.candidates
          .slice(0, 3)
          .map((c: {id: string; confidence: number}) => `${c.id} (${(c.confidence * 100).toFixed(0)}%)`)
          .join(', ');
        content += `\n`;
      }

      // Show features if detected
      if (detection.features && detection.features.length > 0) {
        content += `\n**伴随特性**: `;
        content += detection.features
          .map((f: {id: string; confidence: number}) => `${f.id}`)
          .join(', ');
        content += `\n`;
      }

      // v3: Show active rendering processes
      if (activeRenderingProcesses.length > 0) {
        content += `\n**活跃渲染进程**: `;
        content += activeRenderingProcesses
          .slice(0, 5) // Show top 5
          .map((p: {processName: string; frameCount: number}) => `${p.processName} (${p.frameCount} 帧)`)
          .join(', ');
        if (activeRenderingProcesses.length > 5) {
          content += ` 等 ${activeRenderingProcesses.length} 个进程`;
        }
        content += `\n`;
      }

      // Teaching content
      content += `\n---\n\n### ${teaching.title}\n\n`;
      content += `${teaching.summary}\n\n`;

      // Thread roles table
      if (teaching.threadRoles && teaching.threadRoles.length > 0) {
        content += `#### 关键线程角色\n\n`;
        content += `| 线程 | 职责 | Trace 标签 |\n`;
        content += `|------|------|------------|\n`;
        for (const role of teaching.threadRoles) {
          content += `| ${role.thread} | ${role.responsibility} | ${role.traceTag || '-'} |\n`;
        }
        content += `\n`;
      }

      // Key slices
      if (teaching.keySlices && teaching.keySlices.length > 0) {
        content += `#### 关键 Slice\n`;
        content += `\`${teaching.keySlices.join('`, `')}\`\n\n`;
      }

      // Mermaid diagrams - render locally in the UI (offline, no external services).
      if (teaching.mermaidBlocks && teaching.mermaidBlocks.length > 0) {
        content += `#### 时序图\n\n`;
        const mermaidCode = teaching.mermaidBlocks[0];
        // Use fenced mermaid block so formatter can safely convert to renderable placeholder.
        content += '```mermaid\n';
        content += `${mermaidCode}\n`;
        content += '```\n\n';
      }

      // Trace requirements warning
      if (detection.trace_requirements_missing && detection.trace_requirements_missing.length > 0) {
        content += `\n⚠️ **采集建议**:\n`;
        for (const hint of detection.trace_requirements_missing) {
          content += `- ${hint}\n`;
        }
      }

      // Add message
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content,
        timestamp: Date.now(),
      });

      // Auto-pin relevant tracks with v3 smart pinning
      if (pinInstructions.length > 0 && this.trace) {
        await this.pinTracksFromInstructions(pinInstructions, activeRenderingProcesses);
      }

    } catch (error: any) {
      console.error('[AIPanel] Teaching pipeline error:', error);
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `❌ **管线检测失败**\n\n${error.message || '未知错误'}`,
        timestamp: Date.now(),
      });
    }

    this.setLoadingState(false);
    m.redraw();
  }

  // Scene reconstruction constants (SCENE_DISPLAY_NAMES / SCENE_PIN_MAPPING /
  // SCENE_THRESHOLDS and rating helpers) live in ./scene_constants.ts.
  // AIPanel consumes them only indirectly through story_controller.ts.

  // =============================================================================
  // Scene Reconstruction (delegates to StoryController)
  // =============================================================================
  // Controller logic lives in ./story_controller.ts; AIPanel keeps only the
  // thin command-dispatch wrapper below.

  private storyController: StoryController | null = null;

  private getOrCreateStoryController(): StoryController {
    if (!this.storyController) {
      const ctx: StoryControllerContext = {
        getBackendTraceId: () => this.state.backendTraceId,
        getBackendUrl: () => this.state.settings.backendUrl,
        getTrace: () => this.trace,
        addMessage: (msg) => this.addMessage(msg),
        updateMessage: (id, updates) => this.updateMessage(id, updates),
        generateId: () => this.generateId(),
        setLoadingState: (loading) => this.setLoadingState(loading),
        fetchBackend: (url, opts) => this.fetchBackend(url, opts),
        pinTracksFromInstructions: (insts, procs) =>
          this.pinTracksFromInstructions(insts, procs),
        setDetectedScenes: (scenes) => {
          this.state.detectedScenes = scenes;
        },
        debug: DEBUG_AI_PANEL,
      };
      this.storyController = new StoryController(ctx);
    }
    return this.storyController;
  }

  /**
   * Trigger a preview check for scene reconstruction. Called when the Story
   * tab opens with a loaded trace, or when the user explicitly asks for
   * /scene. Hits POST /scene-reconstruct/preview which returns in sub-second
   * for small traces (or ~5-10s for GB-scale files while hashing).
   */
  private async handleStoryPreview() {
    const traceId = this.state.backendTraceId;
    if (!traceId) return;
    if (this.state.storyState.status === 'previewing') return; // dedupe

    this.state.storyState.status = 'previewing';
    this.state.storyState.lastError = null;
    this.state.storyState.preview = null;
    this.state.storyState.cachedReport = null;
    m.redraw();

    try {
      const ctrl = this.getOrCreateStoryController();
      const preview = await ctrl.preview(traceId);
      this.state.storyState.preview = preview;

      if (preview.cached) {
        // Cache hit — auto-load the full report for instant display.
        this.state.storyState.status = 'preview_cached';
        m.redraw();
        try {
          const report = await ctrl.loadReport(preview.cached.reportId);
          this.state.storyState.cachedReport = report;
          this.state.storyState.status = 'completed';

          // Rebuild track overlays from the cached envelopes so the
          // timeline looks the same as a fresh run.
          this.replayOverlaysFromReport(report);

          // Sync detected scenes for the navigation bar.
          if (Array.isArray(report.displayedScenes)) {
            this.state.detectedScenes = report.displayedScenes.map((s: any) => ({
              type: s.sceneType,
              startTs: s.startTs,
              endTs: s.endTs,
              durationMs: s.durationMs,
              appPackage: s.processName,
              metadata: s.metadata,
            }));
          }
        } catch (loadErr: any) {
          // Cached report failed to load (expired between preview and load?).
          // Degrade to cold path so the user can still run fresh.
          console.warn('[AIPanel] Cached report load failed, falling back to cold path:', loadErr);
          this.state.storyState.status = 'preview_cold';
        }
      } else {
        this.state.storyState.status = 'preview_cold';
      }
    } catch (err: any) {
      this.state.storyState.status = 'failed';
      this.state.storyState.lastError = err?.message ?? 'Preview failed';
    }
    m.redraw();
  }

  /**
   * User confirmed the cold-path estimate — start the full pipeline.
   * Pass forceRefresh=true to bypass the backend cache (used by "重新分析").
   */
  private async handleStoryConfirm(opts?: {forceRefresh?: boolean}) {
    this.state.storyState.status = 'running';
    this.state.storyState.lastError = null;
    m.redraw();

    try {
      const ctrl = this.getOrCreateStoryController();
      await ctrl.start({forceRefresh: opts?.forceRefresh});
      this.state.storyState.status = 'completed';
    } catch (err: any) {
      this.state.storyState.status = 'failed';
      this.state.storyState.lastError = err?.message ?? 'Scene reconstruction failed';
    }
    m.redraw();
  }

  /**
   * Cancel an in-flight pipeline run.
   */
  private async handleStoryCancel() {
    const analysisId = this.state.storyState.analysisId;
    if (!analysisId) return;
    try {
      await this.fetchBackend(
        buildAssistantApiV1Url(this.state.settings.backendUrl,
          `/scene-reconstruct/${analysisId}/cancel`),
        {method: 'POST'},
      );
    } catch (e) {
      console.warn('[AIPanel] Cancel request failed:', e);
    }
  }

  /**
   * Handle /scene command — delegates to StoryController and mirrors the
   * lifecycle into storyState so the Story view can show running/completed.
   *
   * StoryController.start() catches its own errors and pushes them to the
   * chat message stream, so from this wrapper's perspective the call always
   * resolves. A future iteration can thread a status callback through the
   * controller context if we need richer progress reporting.
   */
  private async handleSceneReconstructCommand() {
    // Switch to Story view and trigger preview (the new PR3 flow).
    // Results will render inline in the Story panel. The Chat also gets
    // a compact notification via StoryController.start() → ctx.addMessage.
    this.state.currentView = 'story';
    void this.handleStoryPreview();
  }

  /**
   * Render the Story Panel body — a state-machine-driven view that walks
   * the user through preview → confirm → pipeline → results, all inline.
   */
  private renderStoryBody(): m.Children {
    const hasTrace = !!this.state.backendTraceId;
    const s = this.state.storyState;

    // Auto-trigger preview when the Story tab opens with a loaded trace.
    if (hasTrace && s.status === 'idle') {
      setTimeout(() => this.handleStoryPreview(), 0);
    }

    return m('div.ai-story-body', [
      m('h2', {style: 'margin: 0 0 8px 0;'}, '🎬 场景还原'),
      m('p', {style: 'color: var(--chat-text-secondary); margin: 0 0 16px 0;'},
        '从 Trace 中自动检测用户操作场景并分析性能问题。'),

      !hasTrace
        ? m('div.ai-story-card.ai-story-card--warn',
            '⚠ 请先把 Trace 上传到后端(打开文件后自动完成)')
        : null,

      s.status === 'previewing'
        ? m('div.ai-story-card.ai-story-card--info',
            '⏳ 正在检查缓存与估算成本...')
        : null,

      s.status === 'preview_cached'
        ? m('div.ai-story-card.ai-story-card--success',
            '✅ 发现历史缓存报告,正在加载...')
        : null,

      // Preview: cold path — show estimate + confirm button.
      s.status === 'preview_cold' && s.preview
        ? m('div.ai-story-card.ai-story-card--cold-preview', [
            m('div.ai-story-cold-preview-title', '预估分析成本'),
            m('div.ai-story-cold-preview-metrics', [
              this.renderEstimateMetric(
                `${s.preview.estimate.expectedScenes}`, '预估场景数'),
              this.renderEstimateMetric(
                `~${s.preview.estimate.etaSec}s`, '预估耗时'),
              this.renderEstimateMetric(
                `$${s.preview.estimate.estimatedUsd}`, '预估费用'),
            ]),
            s.preview.estimate.confidence === 'low'
              ? m('div.ai-story-hint', '* 预估基于启发式公式,实际可能有所偏差')
              : null,
            m('div.ai-story-cold-preview-actions', [
              m('button.ai-story-btn-primary', {
                onclick: () => this.handleStoryConfirm(),
              }, '▶ 开始分析'),
              m('button.ai-story-btn-secondary', {
                onclick: () => {
                  this.state.storyState = createStoryPanelState();
                  m.redraw();
                },
              }, '取消'),
            ]),
          ])
        : null,

      s.status === 'running'
        ? m('div.ai-story-card.ai-story-card--info', [
            m('div', {style: 'margin-bottom: 8px;'}, '🎬 场景还原进行中...'),
            m('div', {style: 'font-size: 13px; color: var(--chat-text-secondary);'},
              '进度消息同步显示在 Chat 视图中。'),
            m('button.ai-story-btn-ghost-danger', {
              onclick: () => this.handleStoryCancel(),
            }, '取消分析'),
          ])
        : null,

      s.status === 'completed' ? this.renderStoryCompleted() : null,

      s.status === 'failed'
        ? m('div.ai-story-card.ai-story-card--error', [
            m('div', `❌ ${s.lastError || '场景还原失败'}`),
            m('button.ai-story-btn-retry', {
              onclick: () => this.handleStoryPreview(),
            }, '重试'),
          ])
        : null,
    ]);
  }

  private renderEstimateMetric(value: string, label: string): m.Children {
    return m('div', [
      m('div.ai-story-estimate-metric-value', value),
      m('div.ai-story-estimate-metric-label', label),
    ]);
  }

  /**
   * Render the completed state — either a cached report inline or a
   * "done, check Chat" banner.
   */
  private renderStoryCompleted(): m.Children {
    const report = this.state.storyState.cachedReport;
    const scenes: any[] = report?.displayedScenes ?? [];

    return m('div', [
      m('div.ai-story-card.ai-story-card--success', [
        report
          ? m('div', [
              m('div', {style: 'font-weight: 600; margin-bottom: 4px;'},
                `✅ 场景还原完成 — ${scenes.length} 个场景`),
              report.summary
                ? m('div', {style: 'margin-top: 8px; font-size: 14px; line-height: 1.6;'},
                    report.summary)
                : null,
              report.cachePolicy === 'disk_7d'
                ? m('div', {style: 'margin-top: 8px; font-size: 12px; color: var(--chat-text-secondary);'},
                    `来自缓存 (${new Date(report.createdAt).toLocaleString()})`)
                : null,
            ])
          : '✅ 场景还原完成。切换到 Chat 视图查看完整结果。',
      ]),

      scenes.length > 0
        ? m('div.ai-story-scenes-table', [
            m('table', [
              m('thead',
                m('tr', ['#', '类型', '时长', '应用/进程', '状态'].map(h => m('th', h))),
              ),
              m('tbody', scenes.map((scene: any, i: number) => {
                const displayName = SCENE_DISPLAY_NAMES[scene.sceneType] ?? scene.sceneType;
                const dur = scene.durationMs >= 1000
                  ? `${(scene.durationMs / 1000).toFixed(2)}s`
                  : `${Math.round(scene.durationMs)}ms`;
                const severity = scene.severity === 'bad' ? '🔴'
                  : scene.severity === 'warning' ? '🟡'
                  : scene.severity === 'good' ? '🟢' : '⚪';
                const stateClass = scene.analysisState === 'completed' ? 'ai-story-scene-state--completed'
                  : scene.analysisState === 'failed' ? 'ai-story-scene-state--failed'
                  : 'ai-story-scene-state--pending';
                return m('tr', {
                  key: scene.id,
                  title: `点击跳转到 ${scene.startTs}`,
                }, [
                  m('td.col-index', `${i + 1}`),
                  m('td.col-type', `${severity} ${displayName}`),
                  m('td.col-duration', dur),
                  m('td.col-process', scene.processName ?? '-'),
                  m('td',
                    m(`span.ai-story-scene-state.${stateClass}`,
                      scene.analysisState ?? 'not_planned')),
                ]);
              })),
            ]),
          ])
        : null,

      m('button.ai-story-btn-ghost-accent', {
        onclick: () => {
          // Do NOT reset to idle — that re-triggers handleStoryPreview()
          // which hits the cache again and shows the same old result.
          this.state.storyState.cachedReport = null;
          this.state.storyState.preview = null;
          this.handleStoryConfirm({forceRefresh: true});
        },
      }, '重新分析'),
    ]);
  }

  /**
   * Replay track overlays from a cached SceneReport's envelopes.
   * Called on cache-hit so the timeline looks the same as a fresh run.
   */
  private replayOverlaysFromReport(report: any): void {
    if (!Array.isArray(report?.cachedDataEnvelopes)) return;
    const trace = this.trace;
    if (!trace) return;

    for (const envelope of report.cachedDataEnvelopes) {
      if (!envelope?.meta?.stepId || !envelope?.data?.columns || !envelope?.data?.rows) continue;
      const overlayId = STEP_TO_OVERLAY.get(envelope.meta.stepId);
      if (overlayId) {
        createOverlayTrack(trace, overlayId, envelope.data.columns, envelope.data.rows)
          .catch((err: Error) => console.warn('[AIPanel] Cached overlay creation failed:', err));
      }
    }
  }


  /**
   * Update an existing message by ID
   */
  private updateMessage(
    messageId: string,
    updates: Partial<Message>,
    options: {persist?: boolean} = {}
  ) {
    const index = this.state.messages.findIndex(m => m.id === messageId);
    if (index !== -1) {
      this.state.messages[index] = {
        ...this.state.messages[index],
        ...updates,
      };
      if (options.persist !== false) {
        this.saveHistory();
        this.saveCurrentSession();
      }
    }
  }

  // =============================================================================
  // Quick Scene Detection (for navigation bar)
  // =============================================================================

  /**
   * Perform quick scene detection for the navigation bar
   * Called automatically when trace loads and manually on refresh
   */
  private async detectScenesQuick() {
    if (!this.state.backendTraceId) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] No backend trace ID, skipping quick scene detection');
      return;
    }

    if (this.state.scenesLoading) {
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Scene detection already in progress');
      return;
    }

    this.state.scenesLoading = true;
    this.state.scenesError = null;
    m.redraw();

    if (DEBUG_AI_PANEL) console.log('[AIPanel] Starting quick scene detection for trace:', this.state.backendTraceId);

    try {
      const response = await this.fetchBackend(buildAssistantApiV1Url(this.state.settings.backendUrl, '/scene-detect-quick'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.state.backendTraceId,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Quick scene detection failed');
      }

      this.state.detectedScenes = data.scenes || [];
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Quick scene detection complete:', this.state.detectedScenes.length, 'scenes');

    } catch (error: any) {
      console.warn('[AIPanel] Quick scene detection failed:', error.message);
      this.state.scenesError = error.message;
      this.state.detectedScenes = [];
    }

    this.state.scenesLoading = false;
    m.redraw();
  }

  /**
   * Pin tracks based on pin instructions from the teaching pipeline API
   * v3 Enhancement: Uses activeRenderingProcesses to only pin RenderThreads from active processes
   * v4 Enhancement: Uses mainThreadOnly to only pin main thread tracks (checks track.chips)
   */
  private async pinTracksFromInstructions(
    instructions: Array<{
      pattern: string;
      matchBy: string;
      priority: number;
      reason: string;
      expand?: boolean;          // Whether to expand the track after pinning
      mainThreadOnly?: boolean;  // Only pin main thread (track.chips includes 'main thread')
      smartPin?: boolean;
      skipPin?: boolean;  // v3.1: Skip RenderThread when no active rendering processes
      activeProcessNames?: string[];
    }>,
    activeRenderingProcesses: Array<{processName: string; frameCount: number}> = []
  ) {
    if (!this.trace) return;

    const workspace = this.trace.currentWorkspace;
    if (!workspace) {
      console.warn('[AIPanel] No workspace available for track pinning');
      return;
    }

    const pinnedCount = {count: 0, skipped: 0};
    const sortedInstructions = [...instructions].sort((a, b) => a.priority - b.priority);

    // Build set of active process names for smart filtering
    const activeProcessNames = new Set(activeRenderingProcesses.map(p => p.processName));
    const activeProcessNamesList = Array.from(activeProcessNames);

    const trackActivityCountCache = new Map<string, number>();

    const isCounterOrSliceTrack = (
      uri: string,
      kind: 'CounterTrack' | 'SliceTrack' | 'ThreadStateTrack',
    ): boolean => {
      const track = this.trace?.tracks.getTrack(uri);
      return Boolean(track?.tags?.kinds?.includes(kind));
    };

    // Check if track is suitable for main thread pinning (SliceTrack or ThreadStateTrack)
    const isMainThreadPinnableTrack = (uri: string): boolean => {
      return isCounterOrSliceTrack(uri, 'SliceTrack') ||
             isCounterOrSliceTrack(uri, 'ThreadStateTrack');
    };

    const getTrackActivityCount = async (trackNode: any): Promise<number> => {
      const uri = trackNode?.uri as string | undefined;
      if (!uri) return 0;
      if (trackActivityCountCache.has(uri)) return trackActivityCountCache.get(uri) ?? 0;

      const track = this.trace?.tracks.getTrack(uri);
      const trackIdsRaw = track?.tags?.trackIds;
      const trackIds =
        Array.isArray(trackIdsRaw)
          ? trackIdsRaw
              .map((v: any) => Number(v))
              .filter((v: number) => Number.isFinite(v))
          : [];
      if (trackIds.length === 0) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      const engine = this.engine;
      if (!engine) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      let table: 'counter' | 'slice' | undefined;
      if (track?.tags?.kinds?.includes('CounterTrack')) table = 'counter';
      if (track?.tags?.kinds?.includes('SliceTrack')) table = table ?? 'slice';
      if (!table) {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }

      const query = `select count(*) as cnt from ${table} where track_id in (${trackIds.join(',')})`;
      try {
        const result = await engine.query(query);
        const it = result.iter({});
        let count = 0;
        if (it.valid()) {
          const raw = it.get('cnt');
          count = typeof raw === 'bigint' ? Number(raw) : Number(raw);
          if (!Number.isFinite(count)) count = 0;
        }
        trackActivityCountCache.set(uri, count);
        return count;
      } catch {
        trackActivityCountCache.set(uri, 0);
        return 0;
      }
    };

    const activityHints = new Set<string>();
    const flatTracks = workspace.flatTracks;
    if (flatTracks && activeProcessNamesList.length > 0) {
      for (const trackNode of flatTracks) {
        const name = trackNode?.name || '';
        if (!/^BufferTX\b/i.test(name)) continue;
        if (!activeProcessNamesList.some((p) => name.includes(p))) continue;
        const hint = getActivityHintFromBufferTxTrackName(name);
        if (hint) activityHints.add(hint);
      }
    }

    // Debug: Log available track names and active processes
    if (flatTracks) {
      const trackNames = flatTracks.slice(0, 50).map(t => t.name);
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Available track names (first 50):', trackNames);
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Active rendering processes:', Array.from(activeProcessNames));
      if (DEBUG_AI_PANEL) console.log('[AIPanel] Active surface hints:', Array.from(activityHints));
    }

    // Try using the PinTracksByRegex command first (Perfetto built-in) - but only for non-smart patterns
    const pinByRegexAvailable = this.trace.commands?.hasCommand?.('dev.perfetto.PinTracksByRegex');

    for (const inst of sortedInstructions) {
      try {
        // v3.1: Skip instructions marked with skipPin (e.g., RenderThread with no active processes)
        if (inst.skipPin) {
          if (DEBUG_AI_PANEL) console.log(`[AIPanel] Skipped by skipPin flag: ${inst.pattern} - ${inst.reason || 'no reason'}`);
          pinnedCount.skipped++;
          continue;
        }

        const regex = new RegExp(inst.pattern);
        const smartProcessNames = inst.activeProcessNames ?? Array.from(activeProcessNames);
        const shouldSmartFilterByProcess = Boolean(inst.smartPin) && smartProcessNames.length > 0;
        const maxPinsForInstruction = getMaxPinsForPattern(inst.pattern);
        const shouldAttemptDisambiguation = needsActiveDisambiguation(inst.pattern);
        let pinnedForInstruction = 0;

        // Use built-in pin-by-regex only when we don't need extra filtering.
        // Smart pinning and mainThreadOnly require manual iteration.
        const canUsePinByRegex =
          pinByRegexAvailable &&
          !shouldSmartFilterByProcess &&
          !inst.mainThreadOnly &&
          !inst.expand &&
          !shouldAttemptDisambiguation &&
          (inst.matchBy === 'name' || inst.matchBy === 'path');

        if (canUsePinByRegex) {
          this.trace.commands.runCommand('dev.perfetto.PinTracksByRegex', inst.pattern, inst.matchBy);
          pinnedCount.count++;
          continue;
        }

        // Manual iteration (supports smart process filtering and mainThreadOnly).
        if (flatTracks) {
          const candidates: any[] = [];
          const hasActiveContext = smartProcessNames.length > 0 || activityHints.size > 0;
          const shouldFilterToActive = hasActiveContext && (shouldSmartFilterByProcess || shouldAttemptDisambiguation);

          for (const trackNode of flatTracks) {
            const matchValue = inst.matchBy === 'uri' ? trackNode.uri : trackNode.name;
            if (!matchValue || !regex.test(matchValue)) continue;
            if (this.shouldIgnoreAutoPinTrackName(trackNode.name || '')) {
              pinnedCount.skipped++;
              continue;
            }

            if (inst.mainThreadOnly) {
              const uri = trackNode.uri as string | undefined;
              if (!uri) {
                pinnedCount.skipped++;
                continue;
              }
              const hasMainThreadChip = trackNode.chips?.includes('main thread') ?? false;
              // Allow both SliceTrack (events) and ThreadStateTrack (CPU scheduling state)
              if (!hasMainThreadChip || !isMainThreadPinnableTrack(uri)) {
                pinnedCount.skipped++;
                continue;
              }
            }

            if (shouldFilterToActive) {
              const trackFullPathStr = this.trackFullPathToString(trackNode as any);
              const matchesProcess = smartProcessNames.some((procName) => trackFullPathStr.includes(procName));
              const matchesActivityHint = matchesProcess
                ? true
                : Array.from(activityHints).some((hint) => trackFullPathStr.includes(hint));

              if (!matchesProcess && !matchesActivityHint) {
                pinnedCount.skipped++;
                continue;
              }
            }

            candidates.push(trackNode);
          }

          // Main thread fallback: thread name is often NOT literally "main" (pid == tid).
          // Pin both SliceTrack (events) and ThreadStateTrack (CPU scheduling state)
          if (candidates.length === 0 && inst.pattern.startsWith('^main')) {
            // Track by proc+kind to allow both SliceTrack and ThreadStateTrack per process
            const pinnedByProcAndKind = new Set<string>();
            for (const trackNode of flatTracks) {
              if (this.shouldIgnoreAutoPinTrackName(trackNode.name || '')) continue;
              const uri = trackNode.uri as string | undefined;
              if (!uri || !isMainThreadPinnableTrack(uri)) continue;

              const hasMainThreadChip = trackNode.chips?.includes('main thread') ?? false;
              if (!hasMainThreadChip) continue;

              // Determine track kind for dedup key
              const track = this.trace.tracks.getTrack(uri);
              const kinds = track?.tags?.kinds ?? [];
              const trackKind = kinds.includes('SliceTrack') ? 'slice' :
                               kinds.includes('ThreadStateTrack') ? 'state' : 'other';

              if (smartProcessNames.length > 0) {
                const pathStr = this.trackFullPathToString(trackNode as any);
                const matchedProc = smartProcessNames.find((p) => pathStr.includes(p));
                if (!matchedProc) continue;
                // Allow one SliceTrack and one ThreadStateTrack per process
                const dedupKey = `${matchedProc}:${trackKind}`;
                if (pinnedByProcAndKind.has(dedupKey)) continue;
                pinnedByProcAndKind.add(dedupKey);
              }

              if (!trackNode.isPinned) {
                trackNode.pin();
                if (inst.expand) trackNode.expand();
                pinnedCount.count++;
                pinnedForInstruction++;
                // If we don't have per-proc filtering, pin at most 2 (slice + state).
                if (smartProcessNames.length === 0 && pinnedForInstruction >= 2) break;
              }
            }
            continue;
          }

          if (candidates.length > 0) {
            let nodesToPin = candidates;

            if (maxPinsForInstruction !== undefined && candidates.length > maxPinsForInstruction) {
              const scored = await Promise.all(
                candidates.map(async (trackNode) => {
                  let score = await getTrackActivityCount(trackNode);
                  const name = trackNode?.name || '';

                  // Prefer tracks tied to the active app surface when possible.
                  if (/^QueuedBuffer\\b/i.test(name) && activityHints.size > 0) {
                    if (Array.from(activityHints).some((h) => name.includes(h))) score += 1_000_000;
                  }
                  if (/^BufferTX\\b/i.test(name) && smartProcessNames.length > 0) {
                    if (smartProcessNames.some((p) => name.includes(p))) score += 1_000_000;
                  }
                  if (/BufferQueue/i.test(name) && activityHints.size > 0) {
                    if (Array.from(activityHints).some((h) => name.includes(h))) score += 1_000_000;
                  }

                  return {trackNode, score};
                })
              );

              scored.sort((a, b) => b.score - a.score);
              nodesToPin = scored.slice(0, maxPinsForInstruction).map((x) => x.trackNode);
            }

            for (const trackNode of nodesToPin) {
              if (trackNode.isPinned) continue;
              trackNode.pin();
              if (inst.expand) trackNode.expand();
              pinnedCount.count++;
              pinnedForInstruction++;
              if (maxPinsForInstruction && pinnedForInstruction >= maxPinsForInstruction) break;
            }
          }
        }
      } catch (e) {
        console.warn(`[AIPanel] Failed to pin tracks with pattern ${inst.pattern}:`, e);
      }
    }

    if (pinnedCount.count > 0 || pinnedCount.skipped > 0) {
      if (DEBUG_AI_PANEL) console.log(`[AIPanel] Pinned ${pinnedCount.count} tracks for teaching (skipped ${pinnedCount.skipped} inactive)`);
    }
  }

  private getHelpMessage(): string {
    return `**AI Assistant Commands:**

| Command | Description |
|---------|-------------|
| \`/sql <query>\` | Execute SQL query |
| \`/goto <ts>\` | Jump to timestamp |
| \`/analyze\` | Analyze current selection |
| \`/anr\` | Find ANRs |
| \`/jank\` | Find janky frames |
| \`/slow\` | Analyze slow operations (backend) |
| \`/memory\` | Analyze memory usage (backend) |
| \`/teaching-pipeline\` | 🎓 教学：检测渲染管线类型 |
| \`/scene\` | 🎬 场景还原：识别 Trace 中的操作场景 |
| \`/export [csv|json]\` | Export session results |
| \`/pins\` | View pinned query results |
| \`/clear\` | Clear chat history |
| \`/help\` | Show this help |
| \`/settings\` | Open settings |

**Tips:**
- Use arrow keys to navigate command history
- Shift+Enter for new line, Enter to send
- Click 📄 CSV or 📋 JSON buttons to export query results
- Click 📌 Pin to save query results for later`;
  }

  /**
   * 渲染 Session 历史侧边栏（分区显示：当前对话 + 历史对话）
   */
  private renderSessionSidebar(sessions: AISession[], _currentIndex: number): m.Children {
    // 找到当前 Session
    const currentSession = sessions.find(s => s.sessionId === this.state.currentSessionId);

    // 历史 Sessions（排除当前，按最后活动时间倒序）
    const historySessions = sessions
      .filter(s => s.sessionId !== this.state.currentSessionId)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // 渲染单个 Session 项
    const renderSessionItem = (session: AISession, isCurrent: boolean) => {
      const messageCount = session.messages.length;
      const lastActive = this.formatRelativeTime(session.lastActiveAt);

      // 获取 session 摘要（取第一条用户消息或自动生成）
      const userMessages = session.messages.filter(m => m.role === 'user');
      const summary = isCurrent
        ? '当前对话'
        : (session.summary || (userMessages.length > 0 ? userMessages[0].content.slice(0, 30) : '新对话'));

      return m('div.ai-session-sidebar-item', {
        class: isCurrent ? 'current' : '',
        onclick: () => {
          if (!isCurrent) {
            this.loadSession(session.sessionId);
          }
        },
        title: isCurrent ? '当前对话' : summary,
      }, [
        m('div.ai-session-sidebar-item-indicator', isCurrent ? '●' : '○'),
        m('div.ai-session-sidebar-item-content', [
          m('div.ai-session-sidebar-item-summary', summary + (!isCurrent && summary.length >= 30 ? '...' : '')),
          m('div.ai-session-sidebar-item-meta', [
            m('span', `${messageCount} 条`),
            m('span', '·'),
            m('span', lastActive),
          ]),
        ]),
        // 删除按钮（只对历史 session 显示）
        !isCurrent
          ? m('button.ai-session-sidebar-item-delete', {
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                if (confirm('确定删除这个对话？')) {
                  this.deleteSession(session.sessionId);
                }
              },
              title: '删除对话',
            }, m('i.pf-icon', 'close'))
          : null,
      ]);
    };

    return m('div.ai-session-sidebar', [
      // 标题栏
      m('div.ai-session-sidebar-header', [
        m('i.pf-icon', 'chat'),
        m('span', '对话'),
      ]),

      // Session 列表
      m('div.ai-session-sidebar-items', [
        // 当前对话（固定在顶部）
        currentSession ? renderSessionItem(currentSession, true) : null,

        // 历史对话分隔线（只在有历史时显示）
        historySessions.length > 0
          ? m('div.ai-session-sidebar-divider', '历史对话')
          : null,

        // 历史对话列表
        historySessions.map(session => renderSessionItem(session, false)),
      ]),

      // 新建对话按钮
      m('button.ai-session-sidebar-new', {
        onclick: () => {
          this.cancelSSEConnection();
          this.resetInterventionState();
          // 保存当前 session 再创建新的
          this.saveCurrentSession();
          this.createNewSession();
          this.state.messages = [];
          this.state.agentSessionId = null;  // Reset Agent session for new conversation
          this.clearAgentObservability();
          if (this.state.backendTraceId || this.engine?.mode === 'HTTP_RPC') {
            this.addRpcModeWelcomeMessage();
          } else {
            this.addBackendUnavailableMessage();
          }
          m.redraw();
        },
        title: '新建对话',
      }, [
        m('i.pf-icon', 'add'),
      ]),
    ]);
  }

  /**
   * 格式化相对时间
   */
  private formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;

    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} 天前`;
    if (hours > 0) return `${hours} 小时前`;
    if (minutes > 0) return `${minutes} 分钟前`;
    return '刚刚';
  }



  /**
   * Jump to a specific timestamp in the Perfetto timeline
   */
  private jumpToTimestamp(timestampNs: bigint): {ok: true} | {ok: false; error: string} {
    if (!this.trace) {
      console.error('[AIPanel] No trace available for navigation');
      return {ok: false, error: 'trace context is not available'};
    }

    const traceStart = this.trace.traceInfo.start as unknown as bigint;
    const traceEnd = this.trace.traceInfo.end as unknown as bigint;
    if (timestampNs < traceStart || timestampNs > traceEnd) {
      return {
        ok: false,
        error: `timestamp is outside trace range [${traceStart.toString()}ns, ${traceEnd.toString()}ns]`,
      };
    }

    try {
      // Create a 10ms window around the timestamp for better visibility
      const windowNs = BigInt(10_000_000); // 10ms
      const startNs = timestampNs - windowNs / BigInt(2);
      const endNs = timestampNs + windowNs / BigInt(2);

      if (DEBUG_AI_PANEL) console.log(`[AIPanel] Jumping to timestamp: ${timestampNs}ns`);

      this.trace.scrollTo({
        time: {
          start: Time.fromRaw(startNs > BigInt(0) ? startNs : BigInt(0)),
          end: Time.fromRaw(endNs),
        },
      });
      return {ok: true};
    } catch (error) {
      console.error('[AIPanel] Failed to jump to timestamp:', error);
      const errorText = error instanceof Error ? error.message : String(error);
      return {ok: false, error: errorText};
    }
  }

  private async clearChat() {
    this.cancelSSEConnection();
    this.setLoadingState(false);
    this.resetInterventionState();

    // Persist current conversation before wiping
    this.flushSessionSave();
    this.saveCurrentSession();

    // Do not delete backend trace resources when clearing chat.
    // Clear-chat resets conversation state only and preserves trace continuity.

    // Clear frontend state
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.state.pinnedResults = [];  // Clear pinned results
    this.state.agentSessionId = null;  // Clear Agent session for multi-turn dialogue
    this.revealedBlockCounts.clear();
    this.state.completionHandled = false;
    this.state.displayedSkillProgress = new Set();
    this.state.collectedErrors = [];
    this.state.collapsedTables = new Set();
    this.clearAgentObservability();
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    this.saveHistory();
    // AI Everywhere: reset cross-component state + clear timeline notes
    resetAISharedState();
    if (this.trace) clearAIFindingNotes(this.trace);

    // Show appropriate welcome message based on mode
    if (this.state.backendTraceId || this.engine?.mode === 'HTTP_RPC') {
      this.addRpcModeWelcomeMessage();
    } else {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: this.getWelcomeMessage(),
        timestamp: Date.now(),
      });
    }
    m.redraw();
  }

  /**
   * Pop out the AI panel into a body-level floating window.
   *
   * The full handoff (cancel SSE, save session, snapshot state) runs
   * inside the transient saver registered in oncreate, so this method
   * is just a one-liner. Dock Back goes through the same saver via
   * switchFloatingMode('tab').
   */
  private popOutToFloatingWindow() {
    switchFloatingMode('floating');
  }

  /**
   * Snapshot per-instance state that's not saved to localStorage sessions,
   * for hand-off during Pop Out / Dock Back. Called by the registered
   * transient saver closure in ai_transient_state.ts.
   *
   * The saver already cancelled SSE before calling this, so the state
   * is stable — no event processing can mutate fields between snapshot
   * and the new instance's restore.
   *
   * For replay idempotency (Codex HIGH 3), we must carry the full
   * streamingFlow/streamingAnswer/displayedSkillProgress state so the
   * new instance's handlers can dedupe replayed events.
   */
  private snapshotTransientState(): TransientState {
    // isLoading tracks active analysis more reliably than sseConnectionState
    // (which may be 'disconnected' briefly between connect retries).
    const isAnalysisActive = this.state.isLoading || !!this.state.agentSessionId;
    return {
      inputDraft: this.state.input,
      collapsedTables: Array.from(this.state.collapsedTables),
      historyIndex: this.state.historyIndex,
      activeAnalysis: isAnalysisActive && this.state.agentSessionId
        ? {
            agentSessionId: this.state.agentSessionId,
            lastEventId: this.state.sseLastEventId,
            agentRunId: this.state.agentRunId,
            agentRequestId: this.state.agentRequestId,
            agentRunSequence: this.state.agentRunSequence,
            loadingPhase: this.state.loadingPhase,
            // Dedup sets + completion flag — shallow clone (old instance
            // is frozen after saver's cancelSSEConnection, won't mutate).
            displayedSkillProgress: Array.from(this.state.displayedSkillProgress),
            completionHandled: this.state.completionHandled,
            collectedErrors: [...this.state.collectedErrors],
            // Streaming UI state — shallow clone of outer object, deep
            // clone of collections that would otherwise be shared refs.
            streamingFlow: this.cloneStreamingFlow(),
            streamingAnswer: {...this.state.streamingAnswer},
          }
        : null,
    };
  }

  /** Shallow-clone StreamingFlowState with deep copies of its collections. */
  private cloneStreamingFlow(): StreamingFlowState {
    const f = this.state.streamingFlow;
    return {
      ...f,
      phases: [...f.phases],
      thoughts: [...f.thoughts],
      tools: [...f.tools],
      outputs: [...f.outputs],
      conversationLines: [...f.conversationLines],
      conversationPendingSteps: {...f.conversationPendingSteps},
      conversationSeenEventIds: new Set(f.conversationSeenEventIds),
      subAgents: f.subAgents.map((s) => ({...s})),
      // Timer must NOT be carried across — it references a window-scoped
      // handle that will expire/fire on the old instance's event loop.
      // New instance will schedule its own timer if needed.
      conversationFlushTimer: undefined,
    };
  }

  /**
   * Restore per-instance state from a transient snapshot. Called on the
   * newly-mounted AIPanel instance after a mode switch. If the snapshot
   * contains an active SSE analysis, reconnect and resume streaming —
   * the backend replays events after the saved lastEventId.
   *
   * For replay idempotency (Codex HIGH 3), we restore the full dedup
   * state (displayedSkillProgress, completionHandled, collectedErrors)
   * and streaming UI state before reconnecting SSE, so replayed events
   * hit the same handler state the old instance had and don't
   * re-trigger already-handled paths.
   */
  private restoreTransientState(snapshot: TransientState | null): void {
    if (!snapshot) return;

    this.state.input = snapshot.inputDraft;
    this.state.collapsedTables = new Set(snapshot.collapsedTables);
    this.state.historyIndex = snapshot.historyIndex;

    if (snapshot.activeAnalysis) {
      const a = snapshot.activeAnalysis;
      // Agent identity + cursor
      this.state.agentSessionId = a.agentSessionId;
      // Null cursor → use 0 so backend replays from the start of the
      // ring buffer (Codex HIGH 2: missing first id: event edge case).
      this.state.sseLastEventId = a.lastEventId ?? 0;
      this.state.agentRunId = a.agentRunId;
      this.state.agentRequestId = a.agentRequestId;
      this.state.agentRunSequence = a.agentRunSequence;
      this.state.loadingPhase = a.loadingPhase;
      // Replay-sensitive handler state (Codex HIGH 3)
      this.state.displayedSkillProgress = new Set(a.displayedSkillProgress);
      this.state.completionHandled = a.completionHandled;
      this.state.collectedErrors = [...a.collectedErrors];
      this.state.streamingFlow = a.streamingFlow;
      this.state.streamingAnswer = a.streamingAnswer;
      // Mark loading + resume SSE. The resumeFromLastEventId flag tells
      // listenToAgentSSE to preserve sseLastEventId so the initial fetch
      // appends ?lastEventId=N. The backend replays any events that
      // arrived during the unmount-remount gap.
      this.setLoadingState(true);
      void this.listenToAgentSSE(a.agentSessionId, /* resumeFromLastEventId */ true);
    }
  }

  private openSettings() {
    this.state.showSettings = true;
    m.redraw();
  }

  private closeSettings() {
    this.state.showSettings = false;
    m.redraw();
  }

  // NOTE: uploadTraceToBackend() method removed - auto-upload now happens in load_trace.ts

  /**
   * Export SQL result to CSV or JSON
   */
  private async exportResult(result: SqlQueryResult, format: 'csv' | 'json'): Promise<void> {
    this.setLoadingState(true);
    m.redraw();

    try {
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/export/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          result: {
            columns: result.columns,
            rows: result.rows,
            rowCount: result.rowCount,
            query: result.query,
          },
          format,
          options: format === 'json' ? { prettyPrint: true } : { includeHeaders: true },
        }),
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      // Get filename from Content-Disposition header or generate one
      const contentDisp = response.headers.get('Content-Disposition') || '';
      const filenameMatch = contentDisp.match(/filename="(.+)"/);
      const filename = filenameMatch ? filenameMatch[1] : `result-${Date.now()}.${format}`;

      // Download file
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `✅ Exported **${result.rowCount}** rows as ${format.toUpperCase()}`,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Export failed:** ${e.message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Export current session
   */
  private async exportCurrentSession(format: 'csv' | 'json' = 'json'): Promise<void> {
    // Collect all SQL results from messages
    const results = this.state.messages
      .filter(msg => msg.sqlResult)
      .map(msg => ({
        name: `Query at ${new Date(msg.timestamp).toLocaleTimeString()}`,
        result: msg.sqlResult!,
      }));

    if (results.length === 0) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '**No SQL results to export.** Run some queries first.',
        timestamp: Date.now(),
      });
      return;
    }

    this.setLoadingState(true);
    m.redraw();

    try {
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/export/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          results,
          format,
          options: format === 'json' ? { prettyPrint: true } : { includeHeaders: true },
        }),
      });

      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }

      const contentDisp = response.headers.get('Content-Disposition') || '';
      const filenameMatch = contentDisp.match(/filename="(.+)"/);
      const filename = filenameMatch ? filenameMatch[1] : `session-${Date.now()}.${format}`;

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `✅ Exported session with **${results.length}** query results as ${format.toUpperCase()}`,
        timestamp: Date.now(),
      });
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Export failed:** ${e.message}`,
        timestamp: Date.now(),
      });
    } finally {
      this.setLoadingState(false);
      m.redraw();
    }
  }

  /**
   * Handle /export command
   */
  private async handleExportCommand(formatArg?: string) {
    const format = formatArg === 'csv' ? 'csv' : 'json';
    await this.exportCurrentSession(format);
  }

  private generateId(): string {
    return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Universal value formatter for displaying any data type in tables.
   * Handles: null, undefined, numbers, bigints, objects, arrays, strings.
   *


  /**
   * Convert backend frame detail data to sections format expected by renderExpandableContent.
   *
   * Backend returns: FrameDetailData { diagnosis_summary, full_analysis: FullAnalysis }






  /**
   * 从SQL查询结果中提取关键时间点作为导航书签
   * 根据查询内容和结果自动识别掉帧、ANR、慢函数等关键点
   */
  private extractBookmarksFromQueryResult(
    query: string,
    columns: string[],
    rows: any[][]
  ): void {
    // 只处理包含时间戳的查询结果
    const tsColumnIndex = columns.findIndex(col =>
      /^ts$|^timestamp$|^start_ts$|_ts$/i.test(col)
    );

    if (tsColumnIndex === -1 || rows.length === 0) {
      return; // 没有时间戳列，不提取书签
    }

    const bookmarks: NavigationBookmark[] = [];
    const queryLower = query.toLowerCase();

    // 根据查询类型确定书签类型
    let bookmarkType: NavigationBookmark['type'] = 'custom';
    let labelPrefix = '关键点';

    if (queryLower.includes('jank') || queryLower.includes('掉帧') || queryLower.includes('frame')) {
      bookmarkType = 'jank';
      labelPrefix = '掉帧';
    } else if (queryLower.includes('anr')) {
      bookmarkType = 'anr';
      labelPrefix = 'ANR';
    } else if (queryLower.includes('slow') || queryLower.includes('慢') || queryLower.includes('dur')) {
      bookmarkType = 'slow_function';
      labelPrefix = '慢函数';
    } else if (queryLower.includes('binder')) {
      bookmarkType = 'binder_slow';
      labelPrefix = 'Binder';
    }

    // 限制书签数量，避免太多
    const maxBookmarks = 20;
    const rowsToProcess = rows.slice(0, maxBookmarks);

    rowsToProcess.forEach((row, index) => {
      const timestamp = row[tsColumnIndex];
      if (typeof timestamp === 'number' && timestamp > 0) {
        // 尝试获取更多上下文信息
        const nameColumnIndex = columns.findIndex(col =>
          /name|slice|function/i.test(col)
        );
        const durColumnIndex = columns.findIndex(col => /^dur$/i.test(col));

        let description = `${labelPrefix} #${index + 1}`;
        if (nameColumnIndex >= 0 && row[nameColumnIndex]) {
          description += ` - ${row[nameColumnIndex]}`;
        }
        if (durColumnIndex >= 0 && row[durColumnIndex]) {
          const durMs = (row[durColumnIndex] as number) / 1000000;
          description += ` (${durMs.toFixed(2)}ms)`;
        }

        bookmarks.push({
          id: `bookmark-${Date.now()}-${index}`,
          timestamp,
          label: `${labelPrefix} #${index + 1}`,
          type: bookmarkType,
          description,
        });
      }
    });

    // 更新书签列表
    if (bookmarks.length > 0) {
      this.state.bookmarks = bookmarks;
      if (DEBUG_AI_PANEL) console.log(`Extracted ${bookmarks.length} bookmarks from query result`);
      // AI Everywhere: also create timeline notes for visual annotation
      if (this.trace) {
        const findings = addBookmarkNotes(this.trace, bookmarks);
        updateAISharedState({findings, issueCount: findings.length});
      }
    }
  }

  /**
   * Centralized loading state setter. Clears loadingPhase on both start and stop
   * to prevent stale phase text from previous analyses.
   */
  private setLoadingState(loading: boolean): void {
    this.state.isLoading = loading;
    this.state.loadingPhase = '';
  }

  /**
   * Auto-scroll to bottom only if the user is already near the bottom.
   * This prevents stealing scroll position during long analyses when
   * the user has scrolled up to review intermediate results.
   * @param force If true, always scroll (e.g., on user-initiated message send).
   */
  private scrollToBottom(force = false): void {
    if (!this.messagesContainer) return;
    const el = this.messagesContainer;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Only auto-scroll if within 150px of bottom or forced
    if (force || distanceFromBottom < 150) {
      el.scrollTop = el.scrollHeight;
    }
  }

  /** Throttled variant for streaming updates — avoids forced reflow on every redraw. */
  private throttledScrollToBottom(): void {
    if (this.scrollThrottleTimer) return;
    this.scrollThrottleTimer = setTimeout(() => {
      this.scrollThrottleTimer = null;
      this.scrollToBottom();
    }, 100);
  }

  // ==========================================================================
  // Comparison Mode
  // ==========================================================================

  /** Fetch available traces from backend for the trace picker. */
  private async fetchAvailableTraces(): Promise<void> {
    this.state.comparisonTraceLoading = true;
    m.redraw();
    try {
      const url = `${this.state.settings.backendUrl.replace(/\/+$/, '')}/api/traces`;
      const response = await this.fetchBackend(url);
      if (response.ok) {
        const data = await response.json();
        this.availableTraces = (data.traces || []).map((t: any) => ({
          id: t.id,
          originalName: t.originalName || t.name,
          uploadedAt: t.uploadedAt,
          size: t.size,
        }));
      }
    } catch (e) {
      console.warn('[AIPanel] Failed to fetch traces:', e);
      this.availableTraces = [];
    } finally {
      this.state.comparisonTraceLoading = false;
      m.redraw();
    }
  }

  /** Render trace picker modal for selecting a reference trace. */
  private renderTracePicker(): m.Vnode {
    return m('div.ai-modal-overlay', {
      onclick: (e: Event) => {
        if ((e.target as HTMLElement).classList.contains('ai-modal-overlay')) {
          this.state.showTracePicker = false;
          m.redraw();
        }
      },
    }, m('div.ai-modal.ai-trace-picker', [
      m('div.ai-modal-header', [
        m('span', '选择对比 Trace'),
        m('button.ai-modal-close', {
          onclick: () => { this.state.showTracePicker = false; m.redraw(); },
        }, '\u00D7'),
      ]),
      m('div.ai-modal-body', [
        this.state.comparisonTraceLoading
          ? m('div.ai-trace-picker-loading', '加载 Trace 列表中...')
          : m('div.ai-trace-picker-list', [
              // Show available traces from backend
              this.availableTraces.length > 0
                ? this.availableTraces
                    .filter(t => t.id !== this.state.backendTraceId) // Exclude current trace
                    .map(t => m('div.ai-trace-picker-item', {
                      key: t.id,
                      onclick: () => this.enterComparisonMode(t.id, t.originalName || t.id),
                      class: this.state.referenceTraceId === t.id ? 'selected' : '',
                    }, [
                      m('div.ai-trace-picker-item-name', t.originalName || t.id),
                      m('div.ai-trace-picker-item-meta', [
                        t.uploadedAt ? new Date(t.uploadedAt).toLocaleString() : '',
                        t.size ? ` · ${(t.size / 1024 / 1024).toFixed(1)}MB` : '',
                      ].filter(Boolean).join('')),
                    ]))
                : m('div.ai-trace-picker-empty',
                    '没有可用的参考 Trace。请先上传另一个 Trace 文件到后端。'),
            ]),
      ]),
      m('div.ai-modal-footer', [
        this.state.referenceTraceId
          ? m('button.ai-btn-secondary', {
              onclick: () => this.exitComparisonMode(),
            }, '退出对比')
          : null,
        m('button.ai-btn-secondary', {
          onclick: () => { this.state.showTracePicker = false; m.redraw(); },
        }, '取消'),
      ]),
    ]));
  }

  /** Enter comparison mode with a reference trace. */
  private async enterComparisonMode(refTraceId: string, refTraceName: string): Promise<void> {
    this.state.referenceTraceId = refTraceId;
    this.state.referenceTraceName = refTraceName;
    this.state.showTracePicker = false;
    this.state.isReferenceActive = false;

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: `**对比模式已激活**\n\n` +
        `- 主 Trace: ${this.trace?.traceInfo?.traceTitle || '当前 Trace'}\n` +
        `- 参考 Trace: ${refTraceName}\n\n` +
        `你可以直接提问，AI 会同时分析两个 Trace 并输出对比结论。\n` +
        `点击 **[切换]** 可在 Perfetto 中查看参考 Trace。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /** Exit comparison mode. */
  private exitComparisonMode(): void {
    this.state.referenceTraceId = null;
    this.state.referenceTraceName = null;
    this.state.isReferenceActive = false;
    this.state.showTracePicker = false;
    this.state.comparisonTraceLoading = false;
    clearComparisonState();

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: '已退出对比模式，回到单 Trace 分析。',
      timestamp: Date.now(),
    });
    m.redraw();
  }

  /** Open the reference trace in a new browser tab for visual verification.
   *  In-tab trace switching is deferred — openTraceFromUrl would re-import
   *  the trace into trace_processor (duplicate data risk) and requires
   *  downloading the full file (slow for large traces). New-tab approach
   *  is zero-risk and keeps the current AI analysis session undisturbed. */
  private switchComparisonTrace(): void {
    if (!this.state.referenceTraceId) return;

    const targetTraceId = this.state.isReferenceActive
      ? this.state.backendTraceId  // Switch back to primary → open primary in new tab
      : this.state.referenceTraceId;  // Switch to reference → open reference in new tab

    if (!targetTraceId) return;

    // Open the trace file download URL — browser/Perfetto will handle it in a new tab
    const fileUrl = `${this.state.settings.backendUrl.replace(/\/+$/, '')}/api/traces/${targetTraceId}/file`;
    window.open(fileUrl, '_blank');

    this.addMessage({
      id: this.generateId(),
      role: 'system',
      content: this.state.isReferenceActive
        ? `已在新标签页中打开主 Trace，可在那里视觉验证 AI 的分析结论。`
        : `已在新标签页中打开参考 Trace: **${this.state.referenceTraceName}**，可在那里视觉验证 AI 的对比结论。\n\n当前标签页的 AI 对话和分析不受影响。`,
      timestamp: Date.now(),
    });
    m.redraw();
  }
}
