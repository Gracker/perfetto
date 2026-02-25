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
import {OllamaService, OpenAIService, BackendProxyService} from './ai_service';
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
import {Trace} from '../../public/trace';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AppImpl} from '../../core/app_impl';
import {getBackendUploader} from '../../core/backend_uploader';
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
  createStreamingFlowState,
  createStreamingAnswerState,
  InterventionState,
  DEFAULT_SETTINGS,
  PENDING_BACKEND_TRACE_KEY,
  PRESET_QUESTIONS,
} from './types';
// Agent-Driven Architecture v2.0 - Intervention Panel
import {InterventionPanel, DEFAULT_INTERVENTION_STATE} from './intervention_panel';
import {
  encodeBase64Unicode,
  decodeBase64Unicode,
  formatMessage,
} from './data_formatter';
import {sessionManager} from './session_manager';
import {mermaidRenderer} from './mermaid_renderer';
import {
  handleSSEEvent as handleSSEEventExternal,
  SSEHandlerContext,
} from './sse_event_handlers';
// Scene reconstruction module available for future integration
// import {SceneReconstructionHandler, SceneHandlerContext} from './scene_reconstruction';

export interface AIPanelAttrs {
  engine: Engine;
  trace: Trace;
}

type AppBackendUploadState = {
  backendTraceId?: string;
  backendUploadPromise?: Promise<void>;
  backendUploadState?: 'idle' | 'uploading' | 'ready' | 'failed';
  backendUploadError?: string;
};

// Re-export types for backward compatibility with external consumers
export {Message, SqlQueryResult, AISettings, AISession, PinnedResult} from './types';

// All styles are now in styles.scss using CSS classes
// Removed inline STYLES, THEME, ANIMATIONS objects for better maintainability

export class AIPanel implements m.ClassComponent<AIPanelAttrs> {
  private engine?: Engine;
  private trace?: Trace;
  private state: AIPanelState = {
    messages: [],
    input: '',
    isLoading: false,
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
    displayedSkillProgress: new Set(),  // 已显示的 skill 进度
    completionHandled: false,  // 分析完成事件是否已处理
    // SSE Connection State Initialization
    sseConnectionState: 'disconnected',
    sseRetryCount: 0,
    sseMaxRetries: 5,
    sseLastEventTime: null,
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
  };

  private onClearChat?: () => void;
  private onOpenSettings?: () => void;
  private onBackendUploadComplete?: (e: Event) => void;
  private onBackendUploadFailed?: (e: Event) => void;
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;
  // SSE Connection Management
  private sseAbortController: AbortController | null = null;

  private getAppBackendUploadState(): AppBackendUploadState {
    return AppImpl.instance as unknown as AppBackendUploadState;
  }

  // Delegate to mermaidRenderer module
  private async renderMermaidInElement(container: HTMLElement): Promise<void> {
    await mermaidRenderer.renderMermaidInElement(container);
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
    const appBackendState = this.getAppBackendUploadState();

    // Auto-RPC: Try to get backendTraceId from AppImpl (set by background upload in load_trace.ts)
    const appBackendTraceId = appBackendState.backendTraceId;
    const appBackendUploadState = appBackendState.backendUploadState;
    const appBackendUploadError = appBackendState.backendUploadError;

    console.log('[AIPanel] Trace fingerprint check:', {
      new: newFingerprint,
      current: this.state.currentTraceFingerprint,
      backendTraceId: this.state.backendTraceId,
      appBackendTraceId,
      appBackendUploadState,
      appBackendUploadError,
      engineMode: this.engine?.mode,
      engineInRpcMode,
    });

    // If we have a backendTraceId from AppImpl (upload already completed), use it
    if (appBackendTraceId && !this.state.backendTraceId) {
      console.log('[AIPanel] Using backendTraceId from auto-upload:', appBackendTraceId);
      this.state.backendTraceId = appBackendTraceId;
      // Don't call detectScenesQuick() here — defer to after welcome message below
    }

    // 如果指纹没变且已经有 session，不需要重新加载
    if (newFingerprint && newFingerprint === this.state.currentTraceFingerprint && this.state.currentSessionId) {
      console.log('[AIPanel] Same trace, keeping current session');
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

    // 总是创建新 Session（不自动恢复历史）
    // 用户可以通过侧边栏点击历史 Session 来恢复
    console.log('[AIPanel] Creating new session for trace');
    this.createNewSession();

    // 显示欢迎消息 — handle three states:
    // 1. backendTraceId already available (upload completed before panel init)
    // 2. Upload still in progress (show connecting message, listen for completion)
    // 3. Manual RPC mode (trace_processor_shell -D)
    // 4. No backend at all
    if (this.state.backendTraceId) {
      // Backend already available — show welcome and fire scene detection
      this.addRpcModeWelcomeMessage();
      this.detectScenesQuick();
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
    console.log('[AIPanel] Auto-registering with backend, RPC port:', rpcPort);

    // First, check if there's a pending backendTraceId from a recent upload
    const pendingTraceId = this.recoverPendingBackendTrace(parseInt(rpcPort, 10));
    if (pendingTraceId) {
      console.log('[AIPanel] Recovered pending backend traceId:', pendingTraceId);
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
          console.log('[AIPanel] Auto-registered with backend, traceId:', data.traceId);

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `✅ **已连接到 RPC 模式**\n\n检测到当前 Trace 已通过 HTTP RPC (端口 ${rpcPort}) 加载。\nAI 助手现在可以分析这份 Trace 数据了。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
            timestamp: Date.now(),
          });

          this.saveCurrentSession();

          // Trigger quick scene detection for navigation bar
          this.detectScenesQuick();

          m.redraw();
          return;
        }
      }

      // 注册失败时，显示基本欢迎消息
      console.log('[AIPanel] Auto-registration failed, showing welcome message');
      this.addRpcModeWelcomeMessage();
    } catch (error) {
      console.log('[AIPanel] Auto-registration error:', error);
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

    console.log('[AIPanel] Manually retrying backend connection...');
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
      console.log('[AIPanel] Retrying with trace source type:', traceSource.type);

      // 尝试上传 Trace
      const uploadResult = await uploader.upload(traceSource);

      if (!uploadResult.success || !uploadResult.port) {
        throw new Error(uploadResult.error || '上传 Trace 失败');
      }

      console.log('[AIPanel] Upload successful, port:', uploadResult.port);

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
          console.log('[AIPanel] Failed to store pending trace:', e);
        }
      }

      // 使用 AppImpl 重新打开 Trace（会使用新的 RPC 端口）
      AppImpl.instance.openTraceFromBuffer({
        buffer: (traceSource as any).buffer,
        title: this.trace.traceInfo.traceTitle,
        fileName: (traceSource as any).fileName,
        url: (traceSource as any).url,
      });

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
        console.log('[AIPanel] Recovered and cleared pending backend trace');
        return data.traceId;
      }

      // If too old or port mismatch, clear it
      if ((Date.now() - data.timestamp) > 60000) {
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
        console.log('[AIPanel] Cleared stale pending backend trace');
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
    // Clean up any previous listeners
    if (this.onBackendUploadComplete) {
      window.removeEventListener('perfetto:backend-upload-complete', this.onBackendUploadComplete);
    }
    if (this.onBackendUploadFailed) {
      window.removeEventListener('perfetto:backend-upload-failed', this.onBackendUploadFailed);
    }

    this.onBackendUploadComplete = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.traceId) {
        this.state.backendTraceId = detail.traceId;
        console.log('[AIPanel] Backend upload complete, traceId:', detail.traceId);

        // Update with connected message
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: `✅ **AI 后端已连接**\n\nAI 分析后端已就绪，可以开始分析。\n\n试试问我：\n- 这个 Trace 有什么性能问题？\n- 帮我分析启动耗时\n- 有没有卡顿？`,
          timestamp: Date.now(),
        });

        this.saveCurrentSession();
        this.detectScenesQuick();
        m.redraw();
      }

      // One-shot: remove listeners after first terminal event
      if (this.onBackendUploadComplete) {
        window.removeEventListener('perfetto:backend-upload-complete', this.onBackendUploadComplete);
        this.onBackendUploadComplete = undefined;
      }
      if (this.onBackendUploadFailed) {
        window.removeEventListener('perfetto:backend-upload-failed', this.onBackendUploadFailed);
        this.onBackendUploadFailed = undefined;
      }
    };

    this.onBackendUploadFailed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const errorText = detail?.error ? String(detail.error) : undefined;
      console.warn('[AIPanel] Backend upload failed:', errorText ?? 'unknown error');
      this.addBackendUnavailableMessage(errorText);

      if (this.onBackendUploadComplete) {
        window.removeEventListener('perfetto:backend-upload-complete', this.onBackendUploadComplete);
        this.onBackendUploadComplete = undefined;
      }
      if (this.onBackendUploadFailed) {
        window.removeEventListener('perfetto:backend-upload-failed', this.onBackendUploadFailed);
        this.onBackendUploadFailed = undefined;
      }
    };

    window.addEventListener('perfetto:backend-upload-complete', this.onBackendUploadComplete);
    window.addEventListener('perfetto:backend-upload-failed', this.onBackendUploadFailed);
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
    // Listen for custom events (requires DOM)
    this.onClearChat = () => this.clearChat();
    this.onOpenSettings = () => this.openSettings();
    window.addEventListener('ai-assistant:clear-chat', this.onClearChat);
    window.addEventListener('ai-assistant:open-settings', this.onOpenSettings);

    // Focus input (requires DOM)
    setTimeout(() => {
      const textarea = document.getElementById('ai-input') as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);
    // Animation keyframes are now defined in styles.scss
  }

  onremove() {
    this.cancelSSEConnection();
    this.resetInterventionState();
    if (this.onClearChat) {
      window.removeEventListener('ai-assistant:clear-chat', this.onClearChat);
    }
    if (this.onOpenSettings) {
      window.removeEventListener('ai-assistant:open-settings', this.onOpenSettings);
    }
    if (this.onBackendUploadComplete) {
      window.removeEventListener('perfetto:backend-upload-complete', this.onBackendUploadComplete);
      this.onBackendUploadComplete = undefined;
    }
    if (this.onBackendUploadFailed) {
      window.removeEventListener('perfetto:backend-upload-failed', this.onBackendUploadFailed);
      this.onBackendUploadFailed = undefined;
    }
  }

  view(vnode: m.Vnode<AIPanelAttrs>) {
    const providerLabel = this.state.settings.provider.charAt(0).toUpperCase() + this.state.settings.provider.slice(1);
    const isConnected = this.state.aiService !== null;
    // Check backend availability: engine in HTTP_RPC mode, OR backend upload completed/in-progress
    // With non-blocking upload, WASM engine is used for UI while backend runs separately
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    const hasBackendTrace = !!this.state.backendTraceId;
    const appBackendState = this.getAppBackendUploadState();
    const hasUploadInProgress = appBackendState.backendUploadState === 'uploading';
    const isInRpcMode = engineInRpcMode || hasBackendTrace || hasUploadInProgress;

    // 获取当前 trace 的所有 sessions（只在 RPC 模式下有意义）
    const sessions = isInRpcMode ? this.getCurrentTraceSessions() : [];
    const currentIndex = sessions.findIndex(s => s.sessionId === this.state.currentSessionId);

    return m(
      'div.ai-panel',
      [
        // Settings Modal
        this.state.showSettings
          ? m(SettingsModal, {
              settings: this.state.settings,
              onClose: () => this.closeSettings(),
              onSave: (newSettings: AISettings) => this.saveSettings(newSettings),
              onTest: () => this.testConnection(),
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
              ? m('div.ai-preset-questions',
                  PRESET_QUESTIONS.map(preset =>
                    m(`button.ai-preset-btn${preset.isTeaching ? '.ai-teaching-btn' : ''}`, {
                      onclick: () => this.sendPresetQuestion(preset.question),
                      title: preset.isTeaching ? '检测当前 Trace 的渲染管线类型，自动 Pin 关键泳道' : preset.question,
                      disabled: this.state.isLoading,
                    }, [
                      m('i.pf-icon', preset.icon),
                      preset.label,
                    ])
                  )
                )
              : null,
          ]),
          m('div.ai-header-right', [
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
              onclick: () => this.openSettings(),
              title: 'Settings',
            }, m('i.pf-icon', 'settings')),
          ]),
        ]),

        // Main content area with optional sidebar
        m('div.ai-content-wrapper', {
          class: isInRpcMode ? 'with-sidebar' : '',  // 总是显示侧边栏（RPC 模式下）
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
                    console.log(`[AIPanel] Jumped to scene ${index}: ${scene.type}`);
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
                    console.log(`Jumped to bookmark ${index}: ${bookmark.label}`);
                  },
                })
              : null,

            // Backend Unavailable Dialog - Show when trace is loaded but not in RPC mode
            // In the new auto-RPC architecture, this means the backend was unavailable during trace load
            !isInRpcMode
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
                    'AI 分析��能需要后端服务支持。',
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

            // Messages with auto-scroll - only show when connected to backend
            isInRpcMode ? m('div.ai-messages', {
          oncreate: (vnode) => {
            this.messagesContainer = vnode.dom as HTMLElement;
            this.scrollToBottom();
          },
          onupdate: () => {
            if (this.state.messages.length !== this.lastMessageCount) {
              this.lastMessageCount = this.state.messages.length;
              this.scrollToBottom();
            }
          },
        },
          (() => {
            let reportLinkSequence = 0;
            return this.state.messages.map((msg) => {
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
                        this.jumpToTimestamp(BigInt(tsNs));
                      }
                    }
                  },
                  oncreate: (vnode: m.VnodeDOM) => {
                    const dom = vnode.dom as HTMLElement;
                    dom.innerHTML = formatMessage(msg.content);
                    void this.renderMermaidInElement(dom);
                  },
                  onupdate: (vnode: m.VnodeDOM) => {
                    const newHtml = formatMessage(msg.content);
                    const dom = vnode.dom as HTMLElement;
                    // Only update if content actually changed (optimization)
                    if (dom.innerHTML !== newHtml) {
                      dom.innerHTML = newHtml;
                      void this.renderMermaidInElement(dom);
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
                          background: 'var(--surface)',
                          border: '1px solid var(--border)',
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
                          color: 'var(--text-secondary)',
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
                    border: '1px solid var(--border)',
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
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                  },
                }, [
                  m('div', {
                    style: {
                      width: '48px',
                      height: '48px',
                      borderRadius: '50%',
                      background: msg.metricData.status === 'good' ? '#10b98120' :
                                  msg.metricData.status === 'warning' ? '#f59e0b20' :
                                  msg.metricData.status === 'critical' ? '#ef444420' : '#3b82f620',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    },
                  }, [
                    m('i.pf-icon', {
                      style: {
                        fontSize: '24px',
                        color: msg.metricData.status === 'good' ? '#10b981' :
                               msg.metricData.status === 'warning' ? '#f59e0b' :
                               msg.metricData.status === 'critical' ? '#ef4444' : '#3b82f6',
                      },
                    }, msg.metricData.status === 'good' ? 'check_circle' :
                       msg.metricData.status === 'warning' ? 'warning' :
                       msg.metricData.status === 'critical' ? 'error' : 'analytics'),
                  ]),
                  m('div', { style: { flex: 1 } }, [
                    m('div', {
                      style: {
                        fontSize: '12px',
                        color: 'var(--text-secondary)',
                        marginBottom: '4px',
                      },
                    }, msg.metricData.title),
                    m('div', {
                      style: {
                        fontSize: '28px',
                        fontWeight: '600',
                        color: 'var(--text)',
                        lineHeight: '1.2',
                      },
                    }, [
                      String(msg.metricData.value),
                      msg.metricData.unit ? m('span', {
                        style: {
                          fontSize: '14px',
                          fontWeight: '400',
                          color: 'var(--text-secondary)',
                          marginLeft: '4px',
                        },
                      }, msg.metricData.unit) : null,
                    ]),
                    msg.metricData.delta ? m('div', {
                      style: {
                        fontSize: '12px',
                        color: msg.metricData.delta.startsWith('+') ? '#10b981' :
                               msg.metricData.delta.startsWith('-') ? '#ef4444' : 'var(--text-secondary)',
                        marginTop: '4px',
                      },
                    }, msg.metricData.delta) : null,
                  ]),
                ]) : null,
              ]),
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

          // Loading Indicator
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
                  ]),
                ]),
              ])
            : null,
        ) : null,

        // Input Area - only show when connected to backend
            isInRpcMode ? m('div.ai-input-area', [
              m('div.ai-input-wrapper', [
                m('textarea#ai-input.ai-input', {
                  class: this.state.isLoading || !this.state.aiService ? 'disabled' : '',
                  placeholder: 'Ask anything about your trace...',
                  value: this.state.input,
                  oninput: (e: Event) => {
                    this.state.input = (e.target as HTMLTextAreaElement).value;
                    this.state.historyIndex = -1;
                  },
                  onkeydown: (e: KeyboardEvent) => this.handleKeyDown(e),
                  disabled: this.state.isLoading || !this.state.aiService,
                }),
                m('button.ai-send-btn', {
                  class: this.state.isLoading || !this.state.aiService ? 'disabled' : '',
                  onclick: () => this.sendMessage(),
                  disabled: this.state.isLoading || !this.state.aiService,
                  title: 'Send (Enter)',
                }, m('i.pf-icon', this.state.isLoading ? 'more_horiz' : 'send')),
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

  private fetchBackend(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: this.buildBackendHeaders(init.headers),
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
        console.log(`[AIPanel] Backend trace ${this.state.backendTraceId} no longer valid, clearing`);
        this.state.backendTraceId = null;
        this.saveHistory();
        m.redraw();
      }
    } catch (error) {
      console.log('[AIPanel] Failed to verify backend trace, clearing:', error);
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
      }
    );
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

    // 恢复命令历史
    this.state.commandHistory = this.state.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content);

    console.log('[AIPanel] Loaded session:', sessionId, {
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
      console.log('[AIPanel] No active session, skipping interaction capture');
      return;
    }

    // Fire and forget - don't block UI for interaction tracking
    this.fetchBackend(`${backendUrl}/api/agent/${sessionId}/interaction`, {
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
        console.log('[AIPanel] Interaction captured:', interaction.type, interaction.target);
      }
    }).catch((error) => {
      console.warn('[AIPanel] Error sending interaction:', error);
    });
  }

  private initAIService() {
    const {provider, ollamaUrl, ollamaModel, openaiUrl, openaiModel, openaiApiKey, deepseekModel, backendUrl} =
      this.state.settings;

    if (provider === 'ollama') {
      this.state.aiService = new OllamaService(ollamaUrl, ollamaModel);
    } else if (provider === 'openai') {
      this.state.aiService = new OpenAIService(openaiUrl, openaiModel, openaiApiKey);
    } else {
      // Default to deepseek (backend proxy) for any other provider value
      // This includes 'deepseek' and any unexpected/corrupted values
      this.state.aiService = new BackendProxyService(backendUrl, deepseekModel || 'deepseek-chat');
    }
  }

  private async testConnection(): Promise<boolean> {
    if (this.state.aiService) {
      return this.state.aiService.testConnection();
    }
    return false;
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

**Current AI Provider:** ${this.state.settings.provider.toUpperCase()}

Click ⚙️ to change settings.`;
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
    console.log('[AIPanel] sendMessage called, input:', input, 'isLoading:', this.state.isLoading);

    if (!input || this.state.isLoading) return;

    // Clear skill progress tracking and errors for new analysis session
    this.state.displayedSkillProgress.clear();
    this.state.collectedErrors = [];

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
      console.log('[AIPanel] Calling handleChatMessage with:', input);
      await this.handleChatMessage(input);
      console.log('[AIPanel] handleChatMessage completed');
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

  private addMessage(msg: Message) {
    this.state.messages.push(msg);
    this.saveHistory();
    // 同时保存到 Session
    this.saveCurrentSession();
    this.scrollToBottom();
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
        this.state.isLoading = loading;
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

    // Handle terminal events
    if (result.stopLoading) {
      this.state.isLoading = false;
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

    this.state.isLoading = true;
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

    this.state.isLoading = false;
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

    const timestamp = parseInt(ts, 10);
    if (isNaN(timestamp)) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `Invalid timestamp: ${ts}`,
        timestamp: Date.now(),
      });
      return;
    }

    // Navigate to timestamp
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `Navigated to timestamp ${timestamp}.`,
      timestamp: Date.now(),
    });

    // TODO: Implement actual navigation when API is available
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
    this.state.isLoading = true;
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
        this.state.isLoading = false;
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
          content: `**Selected Slice:**\n\`\`\`\n${sliceInfo}\n\`\`\`\n\nConfigure an AI service in settings (⚙️) to get AI-powered analysis.`,
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

    this.state.isLoading = false;
    m.redraw();
  }

  private async analyzeAreaSelection(selection: import('../../public/selection').AreaSelection) {
    this.state.isLoading = true;
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
        this.state.isLoading = false;
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

    this.state.isLoading = false;
    m.redraw();
  }

  private async handleAnrCommand() {
    this.state.isLoading = true;
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

    this.state.isLoading = false;
    m.redraw();
  }

  private async handleJankCommand() {
    this.state.isLoading = true;
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

    this.state.isLoading = false;
    m.redraw();
  }

  private async handleSlowCommand() {
    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '⚠️ **Trace not uploaded to backend.**\n\nClick the 📤 button to upload this trace to the backend first. The `/slow` command requires backend analysis.',
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
        content: '⚠️ **Trace not uploaded to backend.**\n\nClick the 📤 button to upload this trace to the backend first. The `/memory` command requires backend analysis.',
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
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/agent/resume`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          sessionId,
          traceId: this.state.backendTraceId,
        }),
      });

      if (response.ok) {
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
        this.saveCurrentSession();
        return;
      }

      throw new Error(`resume failed: ${response.status} ${errorText || response.statusText}`);
    } catch (error) {
      console.warn('[AIPanel] Failed to ensure Agent session continuity:', error);
      // Keep current sessionId in state for potential transient backend failures.
    }
  }

  private async handleChatMessage(message: string) {
    console.log('[AIPanel] handleChatMessage called with:', message);
    console.log('[AIPanel] backendTraceId:', this.state.backendTraceId);

    // Check if trace is uploaded to backend
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: '⚠️ **Trace not uploaded to backend.**\n\nClick the 📤 button to upload this trace to the backend first. The backend will execute SQL queries and provide detailed analysis.',
        timestamp: Date.now(),
      });
      return;
    }

    this.state.isLoading = true;
    this.state.completionHandled = false;  // Reset completion flag for new analysis
    this.state.displayedSkillProgress.clear();  // Clear progress tracking for new analysis
    this.state.collectedErrors = [];  // Clear error collection for new analysis
    this.resetStreamingFlow();  // Reset progressive transcript for new analysis turn
    this.resetStreamingAnswer();  // Reset incremental answer stream for new analysis turn
    m.redraw();

    try {
      // Ensure prior multi-turn context is restored when possible.
      await this.ensureAgentSessionReady();

      // Call Agent API (Agent-Driven Orchestrator)
      const apiUrl = `${this.state.settings.backendUrl}/api/agent/analyze`;
      console.log('[AIPanel] Calling Agent API:', apiUrl, 'with traceId:', this.state.backendTraceId);

      // Build request body, include sessionId for multi-turn dialogue
      const requestBody: Record<string, any> = {
        query: message,
        traceId: this.state.backendTraceId,
        options: {
          maxRounds: 3,  // Reduced to avoid unnecessary iterations
          confidenceThreshold: 0.5,  // Match backend default
          maxNoProgressRounds: 2,
          maxFailureRounds: 2,
        },
      };

      // Include agentSessionId if available for multi-turn dialogue
      if (this.state.agentSessionId) {
        requestBody.sessionId = this.state.agentSessionId;
        console.log('[AIPanel] Reusing Agent session for multi-turn dialogue:', this.state.agentSessionId);
      }

      const response = await this.fetchBackend(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      });

      console.log('[AIPanel] Agent API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'TRACE_NOT_UPLOADED' || errorData.error?.includes('not found')) {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content: '⚠️ **Trace not found in backend.**\n\nPlease upload the trace again using the 📤 button.',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          // Note: Don't return early - let finally block handle cleanup
          throw new Error('TRACE_NOT_FOUND');  // Will be caught and cleanup will run
        }
        throw new Error(`API error: ${response.status} ${errorData.error || response.statusText}`);
      }

      const data = await response.json();
      console.log('[AIPanel] Agent API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Analysis failed');
      }

      // Use SSE for real-time progress updates
      const sessionId = data.sessionId;
      if (sessionId) {
        // Save sessionId for multi-turn dialogue
        // Only save if this is a new session or reusing existing session
        const isNewSession = data.isNewSession !== false;
        if (isNewSession) {
          console.log('[AIPanel] Saving new Agent session for multi-turn dialogue:', sessionId);
        } else {
          console.log('[AIPanel] Continuing existing Agent session:', sessionId);
        }
        this.state.agentSessionId = sessionId;
        this.saveCurrentSession();

        console.log('[AIPanel] Starting Agent SSE listener for session:', sessionId);
        await this.listenToAgentSSE(sessionId);
      } else {
        console.log('[AIPanel] No sessionId in response, data:', data);
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
      this.state.isLoading = false;
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

  private resetInterventionState(): void {
    this.state.interventionState = {...DEFAULT_INTERVENTION_STATE};
  }

  /**
   * Listen to Agent SSE events from MasterOrchestrator
   * With automatic reconnection and exponential backoff
   */
  private async listenToAgentSSE(sessionId: string): Promise<void> {
    const apiUrl = `${this.state.settings.backendUrl}/api/agent/${sessionId}/stream`;

    // Cancel any existing connection
    this.cancelSSEConnection();

    // Create new AbortController for this connection
    this.sseAbortController = new AbortController();
    const signal = this.sseAbortController.signal;

    // Mark as connecting
    this.state.sseConnectionState = 'connecting';
    this.state.sseRetryCount = 0;
    m.redraw();

    // Main connection loop with retry logic
    while (this.state.sseRetryCount <= this.state.sseMaxRetries) {
      try {
        // Check if aborted before attempting connection
        if (signal.aborted) {
          console.log('[AIPanel] SSE connection aborted');
          return;
        }

        const response = await this.fetchBackend(apiUrl, { signal });
        if (!response.ok) {
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
        console.log('[AIPanel] SSE connected successfully');
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
            console.log('[AIPanel] SSE reader aborted');
            reader.releaseLock();
            return;
          }

          const {done, value} = await reader.read();
          if (done) {
            console.log('[AIPanel] SSE stream ended normally');
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

            if (line.startsWith('event:')) {
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
                    console.log('[AIPanel] Agent SSE event:', eventType);
                    this.handleSSEEvent(eventType, data);

                    // Check for terminal events (no need to reconnect after these)
                    if (eventType === 'analysis_completed' || eventType === 'error') {
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
          console.log('[AIPanel] SSE connection intentionally aborted');
          this.state.sseConnectionState = 'disconnected';
          return;
        }

        console.error('[AIPanel] Agent SSE error (attempt', this.state.sseRetryCount + 1, '):', e);

        // Check if we have retries left
        if (this.state.sseRetryCount >= this.state.sseMaxRetries) {
          // Max retries exceeded - give up
          console.error('[AIPanel] SSE max retries exceeded, giving up');
          this.state.sseConnectionState = 'disconnected';
          this.state.isLoading = false;
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**Connection Error:** ${e.message || 'Lost connection to Agent backend'}\n\nFailed to reconnect after ${this.state.sseMaxRetries} attempts. Please try again.`,
            timestamp: Date.now(),
          });
          m.redraw();
          return;
        }

        // Schedule reconnection with exponential backoff
        this.state.sseRetryCount++;
        this.state.sseConnectionState = 'reconnecting';
        const delay = this.calculateBackoffDelay(this.state.sseRetryCount - 1);
        console.log(`[AIPanel] SSE reconnecting in ${delay}ms (attempt ${this.state.sseRetryCount}/${this.state.sseMaxRetries})`);

        // Update UI to show reconnecting status
        // Find and update any existing reconnecting message, or add new one
        const lastMsg = this.state.messages[this.state.messages.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('🔄')) {
          lastMsg.content = `🔄 Connection lost. Reconnecting... (attempt ${this.state.sseRetryCount}/${this.state.sseMaxRetries})`;
        } else {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `🔄 Connection lost. Reconnecting... (attempt ${this.state.sseRetryCount}/${this.state.sseMaxRetries})`,
            timestamp: Date.now(),
          });
        }
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
          console.log('[AIPanel] SSE retry wait aborted');
          return;
        }
      }
    }
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

    this.state.isLoading = true;
    m.redraw();

    console.log('[AIPanel] Teaching pipeline request with traceId:', this.state.backendTraceId);

    try {
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/agent/teaching/pipeline`, {
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
        const b64 = encodeBase64Unicode(mermaidCode);

        // Diagram placeholder - rendered on the client by mermaid.js
        content += `<div class="ai-mermaid-block">`;
        content += `<div class="ai-mermaid-diagram" data-mermaid-b64="${b64}"></div>`;
        content += `<details class="ai-mermaid-details">`;
        content += `<summary>📝 查看 Mermaid 源码</summary>`;
        content += `<div class="ai-mermaid-actions">`;
        content += `<button class="ai-mermaid-copy" data-mermaid-b64="${b64}" type="button">复制代码</button>`;
        content += `</div>`;
        content += `<pre class="ai-mermaid-source" data-mermaid-b64="${b64}"></pre>`;
        content += `</details>`;
        content += `</div>\n\n`;
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

    this.state.isLoading = false;
    m.redraw();
  }

  // =============================================================================
  // Scene Reconstruction Types and Mappings
  // =============================================================================

  /**
   * Scene category type matching backend's SceneCategory
   */
  private static readonly SCENE_DISPLAY_NAMES: Record<string, string> = {
    'cold_start': '冷启动',
    'warm_start': '温启动',
    'hot_start': '热启动',
    'scroll_start': '滑动启动',
    'scroll': '滑动浏览',
    'inertial_scroll': '惯性滑动',
    'navigation': '页面跳转',
    'app_switch': '应用切换',
    'screen_on': '屏幕点亮',
    'screen_off': '屏幕熄灭',
    'screen_sleep': '屏幕休眠',
    'screen_unlock': '解锁屏幕',
    'notification': '通知操作',
    'split_screen': '分屏操作',
    'tap': '点击',
    'long_press': '长按',
    'idle': '空闲',
  };

  /**
   * Scene-to-pin mapping for auto-pinning relevant tracks based on scene type
   */
  private static readonly SCENE_PIN_MAPPING: Record<string, Array<{
    pattern: string;
    matchBy: string;
    priority: number;
    reason: string;
    expand?: boolean;
    mainThreadOnly?: boolean;
    smartPin?: boolean;
  }>> = {
    'scroll_start': [
      { pattern: '^RenderThread$', matchBy: 'name', priority: 1, reason: '渲染线程', smartPin: true },
      { pattern: '^main$', matchBy: 'name', priority: 2, reason: '主线程', smartPin: true, mainThreadOnly: true },
    ],
    'scroll': [
      { pattern: '^RenderThread$', matchBy: 'name', priority: 1, reason: '渲染线程', smartPin: true },
      { pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器' },
      { pattern: '^BufferTX', matchBy: 'name', priority: 3, reason: '缓冲区', smartPin: true },
    ],
    'inertial_scroll': [
      { pattern: '^RenderThread$', matchBy: 'name', priority: 1, reason: '渲染线程', smartPin: true },
      { pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器' },
      { pattern: '^BufferTX', matchBy: 'name', priority: 3, reason: '缓冲区', smartPin: true },
    ],
    'cold_start': [
      { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
      { pattern: 'ActivityManager', matchBy: 'name', priority: 2, reason: '活动管理' },
      { pattern: 'Zygote', matchBy: 'name', priority: 3, reason: '进程创建' },
    ],
    'warm_start': [
      { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
      { pattern: 'ActivityManager', matchBy: 'name', priority: 2, reason: '活动管理' },
    ],
    'hot_start': [
      { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
    ],
    'tap': [
      { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
      { pattern: '^RenderThread$', matchBy: 'name', priority: 2, reason: '渲染响应', smartPin: true },
    ],
    'navigation': [
      { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
      { pattern: '^RenderThread$', matchBy: 'name', priority: 2, reason: '渲染线程', smartPin: true },
    ],
    'app_switch': [
      { pattern: 'ActivityManager', matchBy: 'name', priority: 1, reason: '活动管理' },
      { pattern: 'WindowManager', matchBy: 'name', priority: 2, reason: '窗口管理' },
    ],
  };

  /**
   * Performance rating thresholds for scenes
   */
  private static readonly SCENE_THRESHOLDS: Record<string, { good: number; acceptable: number }> = {
    'cold_start': { good: 500, acceptable: 1000 },
    'warm_start': { good: 300, acceptable: 600 },
    'hot_start': { good: 100, acceptable: 200 },
    'scroll_fps': { good: 55, acceptable: 45 },
    'inertial_scroll': { good: 500, acceptable: 1000 },
    'tap': { good: 100, acceptable: 200 },
    'navigation': { good: 300, acceptable: 500 },
  };

  /**
   * Get performance rating emoji based on scene type and duration
   */
  private getScenePerformanceRating(sceneType: string, durationMs: number, metadata?: Record<string, any>): string {
    // For scroll, check FPS instead of duration
    if ((sceneType === 'scroll' || sceneType === 'inertial_scroll') && metadata?.averageFps !== undefined) {
      const fps = metadata.averageFps;
      const thresholds = AIPanel.SCENE_THRESHOLDS['scroll_fps'];
      if (fps >= thresholds.good) return '🟢';
      if (fps >= thresholds.acceptable) return '🟡';
      return '🔴';
    }

    // For other scenes, check duration
    const thresholds = AIPanel.SCENE_THRESHOLDS[sceneType];
    if (!thresholds) return '⚪'; // Unknown scene type

    if (durationMs <= thresholds.good) return '🟢';
    if (durationMs <= thresholds.acceptable) return '🟡';
    return '🔴';
  }

  private getSceneResponseStatusLabel(sceneType: string, durationMs: number, metadata?: Record<string, any>): string {
    const rating = this.getScenePerformanceRating(sceneType, durationMs, metadata);
    if (rating === '🟢') return '🟢 流畅';
    if (rating === '🟡') return '🟡 轻微波动';
    if (rating === '🔴') return '🔴 明显波动';
    return '⚪ 未知';
  }

  // =============================================================================
  // Scene Reconstruction Command Handler
  // =============================================================================

  /**
   * Handle /scene command
   * Replays user operations and device responses from the trace.
   */
  private async handleSceneReconstructCommand() {
    if (!this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: '⚠️ **无法执行场景还原**\n\n请先确保 Trace 已上传到后端。',
        timestamp: Date.now(),
      });
      return;
    }

    this.state.isLoading = true;
    m.redraw();

    // Add initial progress message
    const progressMessageId = this.generateId();
    this.addMessage({
      id: progressMessageId,
      role: 'assistant',
      content: '🎬 **场景还原中...**\n\n正在回放 Trace 中的用户操作与设备响应...',
      timestamp: Date.now(),
    });

    console.log('[AIPanel] Scene reconstruction request with traceId:', this.state.backendTraceId);

    try {
      // Start scene reconstruction
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/agent/scene-reconstruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.state.backendTraceId,
          options: {
            deepAnalysis: false,
            generateTracks: true,
          },
        }),
      });

      if (!response.ok) {
        try {
          const errorData = await response.json();
          console.error('[AIPanel] Scene reconstruction error response:', errorData);
          throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        } catch (parseErr) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data = await response.json();
      if (!data.success || !data.analysisId) {
        throw new Error(data.error || 'Failed to start scene reconstruction');
      }

      const analysisId = data.analysisId;
      console.log('[AIPanel] Scene reconstruction started with analysisId:', analysisId);

      // Connect to SSE for real-time updates
      await this.connectToSceneSSE(analysisId, progressMessageId);

    } catch (error: any) {
      console.error('[AIPanel] Scene reconstruction error:', error);
      // Update the progress message with error
      this.updateMessage(progressMessageId, {
        content: `❌ **场景还原失败**\n\n${error.message || '未知错误'}`,
      });
    }

    this.state.isLoading = false;
    m.redraw();
  }

  /**
   * Connect to SSE endpoint for scene reconstruction updates
   */
  private async connectToSceneSSE(analysisId: string, progressMessageId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const sceneSseUrl = new URL(
        `${this.state.settings.backendUrl}/api/agent/scene-reconstruct/${analysisId}/stream`
      );
      const apiKey = (this.state.settings.backendApiKey || '').trim();
      if (apiKey) {
        sceneSseUrl.searchParams.set('api_key', apiKey);
      }
      const eventSource = new EventSource(sceneSseUrl.toString());

      let scenes: any[] = [];
      let trackEvents: any[] = [];
      let narrative = '';
      let findings: any[] = [];

      const unwrapEventData = (raw: any): any => {
        if (!raw || typeof raw !== 'object') return {};
        // Agent-driven backend wraps payload as: { type, data, timestamp }.
        if (raw.data && typeof raw.data === 'object') return raw.data;
        return raw;
      };

      const applyScenePayload = (payload: any) => {
        if (!payload || typeof payload !== 'object') return;
        if (Array.isArray(payload.scenes)) scenes = payload.scenes;
        if (Array.isArray(payload.trackEvents)) trackEvents = payload.trackEvents;
        if (Array.isArray(payload.tracks) && trackEvents.length === 0) trackEvents = payload.tracks;
        if (typeof payload.narrative === 'string' && payload.narrative) narrative = payload.narrative;
        if (typeof payload.conclusion === 'string' && payload.conclusion && !narrative) narrative = payload.conclusion;
        if (Array.isArray(payload.findings)) findings = payload.findings;
      };

      eventSource.onopen = () => {
        console.log('[AIPanel] Scene SSE connected');
      };

      eventSource.onerror = (error) => {
        console.error('[AIPanel] Scene SSE error:', error);
        eventSource.close();
        reject(new Error('SSE connection failed'));
      };

      // Handle different event types
      eventSource.addEventListener('connected', () => {
        console.log('[AIPanel] Scene SSE: connected event received');
      });

      eventSource.addEventListener('progress', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          const phase = data.phase || raw.phase;
          if (!phase) return;
          console.log('[AIPanel] Scene progress:', phase, data);
          this.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n${phase}...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[AIPanel] Failed to parse progress event:', e);
        }
      });

      // Backward compatibility with legacy scene SSE.
      eventSource.addEventListener('phase_start', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[AIPanel] Scene phase start:', data);
          this.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n${data.phase || '正在分析'}...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[AIPanel] Failed to parse phase_start event:', e);
        }
      });

      eventSource.addEventListener('scene_detected', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Scene detected:', data);
          if (data.scene) {
            scenes.push(data.scene);
          }
          this.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n已检测到 ${scenes.length} 个场景...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[AIPanel] Failed to parse scene_detected event:', e);
        }
      });

      eventSource.addEventListener('finding', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Scene finding:', data);
          if (data.finding) {
            findings.push(data.finding);
          }
        } catch (e) {
          console.warn('[AIPanel] Failed to parse finding event:', e);
        }
      });

      eventSource.addEventListener('track_events', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Track events:', data);
          if (Array.isArray(data.events)) {
            trackEvents = data.events;
          } else if (Array.isArray(data.trackEvents)) {
            trackEvents = data.trackEvents;
          }
        } catch (e) {
          console.warn('[AIPanel] Failed to parse track_events:', e);
        }
      });

      eventSource.addEventListener('track_data', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Track data:', data);
          if (Array.isArray(data.scenes)) scenes = data.scenes;
          if (Array.isArray(data.tracks)) trackEvents = data.tracks;
          if (Array.isArray(data.trackEvents)) trackEvents = data.trackEvents;
        } catch (e) {
          console.warn('[AIPanel] Failed to parse track_data event:', e);
        }
      });

      eventSource.addEventListener('result', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Scene result:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[AIPanel] Failed to parse result event:', e);
        }
      });

      eventSource.addEventListener('analysis_completed', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Analysis completed:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[AIPanel] Failed to parse analysis_completed event:', e);
        }
      });

      eventSource.addEventListener('scene_reconstruction_completed', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[AIPanel] Scene reconstruction completed:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[AIPanel] Failed to parse scene_reconstruction_completed event:', e);
        }
      });

      eventSource.addEventListener('end', () => {
        console.log('[AIPanel] Scene SSE: end event received');
        eventSource.close();

        // Render the final result
        this.renderSceneReconstructionResult(progressMessageId, scenes, trackEvents, narrative, findings);

        // Auto-pin tracks based on detected scenes
        this.autoPinTracksForScenes(scenes);

        resolve();
      });

      eventSource.addEventListener('error', (event) => {
        try {
          const data = JSON.parse((event as any).data || '{}');
          console.error('[AIPanel] Scene SSE error event:', data);
          eventSource.close();
          reject(new Error(data.error || 'Scene reconstruction failed'));
        } catch (e) {
          // Not a data event, might be connection error
          eventSource.close();
          reject(new Error('Scene reconstruction connection failed'));
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (eventSource.readyState !== EventSource.CLOSED) {
          console.warn('[AIPanel] Scene SSE timeout');
          eventSource.close();
          reject(new Error('Scene reconstruction timeout'));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Render the scene reconstruction result
   */
  private renderSceneReconstructionResult(
    messageId: string,
    scenes: any[],
    _trackEvents: any[],
    narrative: string,
    _findings: any[]
  ) {
    if (scenes.length === 0) {
      this.updateMessage(messageId, {
        content: '🎬 **场景还原完成**\n\n未检测到明显的用户操作场景。',
      });
      m.redraw();
      return;
    }

    // Build scene cards content
    let content = '## 🎬 场景还原结果\n\n';

    // Scene summary
    content += `共还原 **${scenes.length}** 个操作场景（仅回放，不含根因诊断）：\n\n`;

    // Scene timeline as a table
    content += '| 序号 | 类型 | 开始时间 | 时长 | 应用/活动 | 响应状态 |\n';
    content += '|------|------|----------|------|-----------|-----------|\n';

    scenes.forEach((scene, index) => {
      const displayName = AIPanel.SCENE_DISPLAY_NAMES[scene.type] || scene.type;
      const durationStr = scene.durationMs >= 1000
        ? `${(scene.durationMs / 1000).toFixed(2)}s`
        : `${scene.durationMs.toFixed(0)}ms`;
      const responseStatus = this.getSceneResponseStatusLabel(scene.type, scene.durationMs, scene.metadata);
      const appInfo = scene.appPackage
        ? (scene.activityName ? `${scene.appPackage}/${scene.activityName}` : scene.appPackage)
        : '-';

      // Make start timestamp clickable for navigation
      const startTsNs = scene.startTs;
      content += `| ${index + 1} | ${displayName} | `;
      content += `<span class="clickable-ts" data-ts="${startTsNs}">${this.formatSceneTimestamp(startTsNs)}</span> | `;
      content += `${durationStr} | ${appInfo.length > 30 ? appInfo.substring(0, 30) + '...' : appInfo} | ${responseStatus} |\n`;
    });

    // Add narrative if available
    if (narrative) {
      content += `\n---\n\n### 📝 操作回放摘要\n\n${narrative}\n`;
    }

    // Add navigation tips
    content += `\n---\n\n💡 **提示**: 点击时间戳可跳转到对应位置，相关泳道已自动 Pin 到顶部。`;

    this.updateMessage(messageId, { content });
    m.redraw();
  }

  /**
   * Auto-pin tracks based on detected scene types
   */
  private async autoPinTracksForScenes(scenes: any[]) {
    if (!this.trace || scenes.length === 0) return;

    // Collect unique scene types
    const sceneTypes = new Set(scenes.map(s => s.type));

    // Collect pin instructions for all detected scene types
    const allInstructions: Array<{
      pattern: string;
      matchBy: string;
      priority: number;
      reason: string;
      expand?: boolean;
      mainThreadOnly?: boolean;
      smartPin?: boolean;
    }> = [];

    sceneTypes.forEach(sceneType => {
      const instructions = AIPanel.SCENE_PIN_MAPPING[sceneType];
      if (instructions) {
        instructions.forEach(inst => {
          // Avoid duplicates
          if (!allInstructions.some(i => i.pattern === inst.pattern)) {
            allInstructions.push(inst);
          }
        });
      }
    });

    if (allInstructions.length === 0) return;

    // Get active processes from scenes
    const activeProcesses = scenes
      .filter(s => s.appPackage)
      .map(s => ({ processName: s.appPackage, frameCount: 1 }));

    console.log('[AIPanel] Auto-pinning tracks for scenes:', sceneTypes, 'with', allInstructions.length, 'instructions');

    // Use existing pinTracksFromInstructions method
    await this.pinTracksFromInstructions(allInstructions, activeProcesses);
  }

  /**
   * Format scene timestamp for display (ns string to human readable)
   * Handles BigInt string timestamps from scene reconstruction
   */
  private formatSceneTimestamp(tsNs: string): string {
    try {
      const ns = BigInt(tsNs);
      const ms = Number(ns / BigInt(1000000));
      const seconds = ms / 1000;
      if (seconds < 60) {
        return `${seconds.toFixed(3)}s`;
      }
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
    } catch {
      return tsNs;
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
      console.log('[AIPanel] No backend trace ID, skipping quick scene detection');
      return;
    }

    if (this.state.scenesLoading) {
      console.log('[AIPanel] Scene detection already in progress');
      return;
    }

    this.state.scenesLoading = true;
    this.state.scenesError = null;
    m.redraw();

    console.log('[AIPanel] Starting quick scene detection for trace:', this.state.backendTraceId);

    try {
      const response = await this.fetchBackend(`${this.state.settings.backendUrl}/api/agent/scene-detect-quick`, {
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
      console.log('[AIPanel] Quick scene detection complete:', this.state.detectedScenes.length, 'scenes');

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
      console.log('[AIPanel] Available track names (first 50):', trackNames);
      console.log('[AIPanel] Active rendering processes:', Array.from(activeProcessNames));
      console.log('[AIPanel] Active surface hints:', Array.from(activityHints));
    }

    // Try using the PinTracksByRegex command first (Perfetto built-in) - but only for non-smart patterns
    const pinByRegexAvailable = this.trace.commands?.hasCommand?.('dev.perfetto.PinTracksByRegex');

    for (const inst of sortedInstructions) {
      try {
        // v3.1: Skip instructions marked with skipPin (e.g., RenderThread with no active processes)
        if (inst.skipPin) {
          console.log(`[AIPanel] Skipped by skipPin flag: ${inst.pattern} - ${inst.reason || 'no reason'}`);
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
              const track = this.trace.tracks.getTrack(uri);
              const hasMainThreadChip = track?.chips?.includes('main thread') ?? false;
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

              const track = this.trace.tracks.getTrack(uri);
              const hasMainThreadChip = track?.chips?.includes('main thread') ?? false;
              if (!hasMainThreadChip) continue;

              // Determine track kind for dedup key
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
      console.log(`[AIPanel] Pinned ${pinnedCount.count} tracks for teaching (skipped ${pinnedCount.skipped} inactive)`);
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
  private jumpToTimestamp(timestampNs: bigint): void {
    if (!this.trace) {
      console.error('[AIPanel] No trace available for navigation');
      return;
    }

    try {
      // Create a 10ms window around the timestamp for better visibility
      const windowNs = BigInt(10_000_000); // 10ms
      const startNs = timestampNs - windowNs / BigInt(2);
      const endNs = timestampNs + windowNs / BigInt(2);

      console.log(`[AIPanel] Jumping to timestamp: ${timestampNs}ns`);

      this.trace.scrollTo({
        time: {
          start: Time.fromRaw(startNs > BigInt(0) ? startNs : BigInt(0)),
          end: Time.fromRaw(endNs),
        },
      });
    } catch (error) {
      console.error('[AIPanel] Failed to jump to timestamp:', error);
    }
  }

  private async clearChat() {
    this.cancelSSEConnection();
    this.resetInterventionState();

    // First, cleanup backend resources if a trace was uploaded
    if (this.state.backendTraceId) {
      try {
        const response = await this.fetchBackend(
          `${this.state.settings.backendUrl}/api/traces/${this.state.backendTraceId}`,
          { method: 'DELETE' }
        );
        if (response.ok) {
          console.log(`[AIPanel] Backend trace ${this.state.backendTraceId} deleted`);
        }
      } catch (error) {
        console.error('[AIPanel] Failed to cleanup backend trace:', error);
      }
    }

    // Clear frontend state
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.state.backendTraceId = null;  // Clear backend trace ID
    this.state.pinnedResults = [];  // Clear pinned results
    this.state.agentSessionId = null;  // Clear Agent session for multi-turn dialogue
    this.resetStreamingFlow();
    this.resetStreamingAnswer();
    this.saveHistory();

    // Show welcome message
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: this.getWelcomeMessage(),
      timestamp: Date.now(),
    });
    m.redraw();
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
    this.state.isLoading = true;
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
      this.state.isLoading = false;
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

    this.state.isLoading = true;
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
      this.state.isLoading = false;
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
      console.log(`Extracted ${bookmarks.length} bookmarks from query result`);
    }
  }

  private scrollToBottom(): void {
    if (this.messagesContainer) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }
}
