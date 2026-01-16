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
import {AIService, OllamaService, OpenAIService, BackendProxyService} from './ai_service';
import {SettingsModal} from './settings_modal';
import {SqlResultTable} from './sql_result_table';
import {NavigationBookmarkBar, NavigationBookmark} from './navigation_bookmark_bar';
import {Engine} from '../../trace_processor/engine';
import {Trace} from '../../public/trace';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AppImpl} from '../../core/app_impl';
import {getBackendUploader} from '../../core/backend_uploader';
import {TraceSource} from '../../core/trace_source';

export interface AIPanelAttrs {
  engine: Engine;
  trace: Trace;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sqlResult?: SqlQueryResult;
  query?: string;
  reportUrl?: string;  // HTML 报告链接
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  sectionTitle?: string;  // For skill_section messages - shows title in table header
  // 可展开行数据（用于 iterator 类型的结果）
  expandableData?: Array<{
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }>;
  // 汇总报告
  summary?: {
    title: string;
    content: string;
  };
}

interface AIPanelState {
  messages: Message[];
  input: string;
  isLoading: boolean;
  showSettings: boolean;
  aiService: AIService | null;
  settings: AISettings;
  commandHistory: string[];
  historyIndex: number;
  lastQuery: string;
  pinnedResults: PinnedResult[];
  backendTraceId: string | null;
  // isUploading removed - auto-upload now happens in load_trace.ts
  bookmarks: NavigationBookmark[];  // 新增：导航书签
  currentTraceFingerprint: string | null;  // 当前 Trace 指纹，用于检测 Trace 变化
  currentSessionId: string | null;  // 当前 Session ID
  isRetryingBackend: boolean;  // 正在重试连接后端
  retryError: string | null;  // 重试连接的错误信息
}

interface PinnedResult {
  id: string;
  query: string;
  columns: string[];
  rows: any[][];
  timestamp: number;
}

export interface AISettings {
  provider: 'ollama' | 'openai' | 'deepseek';
  ollamaUrl: string;
  ollamaModel: string;
  openaiUrl: string;
  openaiModel: string;
  openaiApiKey: string;
  deepseekModel: string;
  deepseekApiKey: string;
  backendUrl: string;
  maxHistory: number;
}

const DEFAULT_SETTINGS: AISettings = {
  provider: 'deepseek',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.4',
  openaiUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiApiKey: '',
  deepseekModel: 'deepseek-chat',
  deepseekApiKey: '',  // Set your API key in settings
  backendUrl: 'http://localhost:3000',
  maxHistory: 10,
};

// Storage key for settings
const SETTINGS_KEY = 'smartperfetto-ai-settings';
const HISTORY_KEY = 'smartperfetto-ai-history';
const SESSIONS_KEY = 'smartperfetto-ai-sessions';
// Temporary storage for backendTraceId during trace reload
const PENDING_BACKEND_TRACE_KEY = 'smartperfetto-pending-backend-trace';

// Session 数据结构
export interface AISession {
  sessionId: string;
  traceFingerprint: string;
  traceName: string;              // 显示名（如文件名）
  backendTraceId?: string;        // 后端 session ID
  createdAt: number;
  lastActiveAt: number;
  messages: Message[];
  summary?: string;               // AI 生成的对话摘要
  pinnedResults?: PinnedResult[]; // 固定的查询结果
  bookmarks?: NavigationBookmark[]; // 导航书签
}

// Sessions 存储结构
interface SessionsStorage {
  // 按 trace fingerprint 索引的 sessions
  byTrace: Record<string, AISession[]>;
}

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
  };

  private onClearChat?: () => void;
  private onOpenSettings?: () => void;
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;

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

    // Auto-RPC: Try to get backendTraceId from AppImpl (set by auto-upload in load_trace.ts)
    const appBackendTraceId = (AppImpl.instance as unknown as {backendTraceId?: string}).backendTraceId;

    console.log('[AIPanel] Trace fingerprint check:', {
      new: newFingerprint,
      current: this.state.currentTraceFingerprint,
      backendTraceId: this.state.backendTraceId,
      appBackendTraceId,
      engineMode: this.engine?.mode,
      engineInRpcMode,
    });

    // If we have a backendTraceId from AppImpl, use it
    if (appBackendTraceId && !this.state.backendTraceId) {
      console.log('[AIPanel] Using backendTraceId from auto-upload:', appBackendTraceId);
      this.state.backendTraceId = appBackendTraceId;
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

    // 显示欢迎消息
    if (engineInRpcMode) {
      if (this.state.backendTraceId) {
        // Auto-upload succeeded, show welcome message
        this.addRpcModeWelcomeMessage();
      } else {
        // Try to register with backend
        this.autoRegisterWithBackend();
      }
    } else {
      // Not in RPC mode, show backend unavailable message
      this.addBackendUnavailableMessage();
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
      const response = await fetch(`${this.state.settings.backendUrl}/api/traces/register-rpc`, {
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
  private addBackendUnavailableMessage(): void {
    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: `⚠️ **AI 后端未连接**\n\n无法连接到 AI 分析后端 (${this.state.settings.backendUrl})。\n\n**可能的原因：**\n- 后端服务未启动\n- 网络连接问题\n\n**解决方法：**\n1. 确保后端服务正在运行：\n   \`\`\`bash\n   cd backend && npm run dev\n   \`\`\`\n2. 重新打开 Trace 文件\n\nTrace 已加载到 WASM 引擎，但 AI 分析功能不可用。`,
      timestamp: Date.now(),
    });
    m.redraw();
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
    if (this.onClearChat) {
      window.removeEventListener('ai-assistant:clear-chat', this.onClearChat);
    }
    if (this.onOpenSettings) {
      window.removeEventListener('ai-assistant:open-settings', this.onOpenSettings);
    }
  }

  view(vnode: m.Vnode<AIPanelAttrs>) {
    const providerLabel = this.state.settings.provider.charAt(0).toUpperCase() + this.state.settings.provider.slice(1);
    const isConnected = this.state.aiService !== null;
    // Check RPC mode: engine must be in HTTP_RPC mode
    // backendTraceId alone is not sufficient - it could be stale from an old session
    const engineInRpcMode = this.engine?.mode === 'HTTP_RPC';
    // We're only in RPC mode if the engine is actually using HTTP RPC
    // This prevents showing chat UI when loading a new trace that isn't in RPC mode yet
    const isInRpcMode = engineInRpcMode;

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
          this.state.messages.map((msg) =>
            m('div.ai-message', {
              class: msg.role === 'user' ? 'ai-message-user' : 'ai-message-assistant',
            }, [
              // Avatar
              m('div.ai-avatar', {
                class: msg.role === 'user' ? 'ai-avatar-user' : 'ai-avatar-assistant',
              }, msg.role === 'user'
                ? 'U'  // User initial
                : m('i.pf-icon', 'auto_awesome')),

              // Message Content
              m('div.ai-bubble', {
                class: msg.role === 'user' ? 'ai-bubble-user' : 'ai-bubble-assistant',
              }, [
                m('div.ai-message-content', m.trust(this.formatMessage(msg.content))),

                // HTML Report Link (问题1修复)
                msg.reportUrl ? m('div.ai-report-link', [
                  m('i.pf-icon', 'description'),
                  m('a', {
                    href: msg.reportUrl,
                    target: '_blank',
                    rel: 'noopener noreferrer',
                  }, '查看详细分析报告 (HTML)'),
                ]) : null,

                // SQL Result
                (() => {
                  const sqlResult = msg.sqlResult;
                  if (!sqlResult) return null;
                  const query = sqlResult.query || msg.query || '';

                  // For skill_section messages with sectionTitle, render compact table only
                  if (sqlResult.sectionTitle) {
                    return m(SqlResultTable, {
                      columns: sqlResult.columns,
                      rows: sqlResult.rows,
                      rowCount: sqlResult.rowCount,
                      query: '',  // No SQL display
                      title: sqlResult.sectionTitle,  // Pass title to table
                      trace: vnode.attrs.trace,
                      onPin: (data) => this.handlePin(data),
                      expandableData: sqlResult.expandableData,
                      summary: sqlResult.summary,
                    });
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
                      expandableData: sqlResult.expandableData,
                      summary: sqlResult.summary,
                    }),
                  ]);
                })(),
              ]),
            ])
          ),

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
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(newSettings));
    this.initAIService();
    m.redraw();
  }

  private loadSettings() {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        // Merge stored settings with defaults to handle new properties
        const storedSettings = JSON.parse(stored);
        this.state.settings = {...DEFAULT_SETTINGS, ...storedSettings};
      }
    } catch {
      // Use default settings on error
    }
  }

  /**
   * 从旧的 HISTORY_KEY 迁移数据到新的 Session 格式
   * 仅在首次加载时调用，用于向后兼容
   */
  private migrateOldHistoryToSession(): boolean {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (!stored) return false;

      const parsed = JSON.parse(stored);
      const messages = Array.isArray(parsed) ? parsed : (parsed.messages || []);
      const fingerprint = parsed.traceFingerprint || this.state.currentTraceFingerprint;

      // 如果没有消息或没有指纹，不迁移
      if (messages.length === 0 || !fingerprint) return false;

      // 检查是否已经有这个 trace 的 sessions
      const existingSessions = this.getSessionsForTrace(fingerprint);
      if (existingSessions.length > 0) {
        // 已经有 sessions，不需要迁移
        return false;
      }

      // 创建迁移的 session
      console.log('[AIPanel] Migrating old history to new session format');
      const session: AISession = {
        sessionId: this.generateId(),
        traceFingerprint: fingerprint,
        traceName: this.trace?.traceInfo?.traceTitle || 'Migrated Trace',
        backendTraceId: parsed.backendTraceId,
        createdAt: messages[0]?.timestamp || Date.now(),
        lastActiveAt: messages[messages.length - 1]?.timestamp || Date.now(),
        messages: messages,
      };

      // 保存到新格式
      const storage = this.loadSessionsStorage();
      if (!storage.byTrace[fingerprint]) {
        storage.byTrace[fingerprint] = [];
      }
      storage.byTrace[fingerprint].push(session);
      this.saveSessionsStorage(storage);

      console.log('[AIPanel] Migration complete, session:', session.sessionId);
      return true;
    } catch {
      return false;
    }
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
      const response = await fetch(
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
    try {
      // Save messages, backendTraceId, and trace fingerprint
      const data = {
        messages: this.state.messages,
        backendTraceId: this.state.backendTraceId,
        traceFingerprint: this.state.currentTraceFingerprint,
      };
      localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
    } catch {
      // Ignore errors
    }
  }

  // loadPinnedResults 已移至 Session 中管理

  private savePinnedResults() {
    try {
      localStorage.setItem('smartperfetto-pinned-results', JSON.stringify(this.state.pinnedResults));
    } catch {
      // Ignore errors
    }
  }

  // ============ Session 管理方法 ============

  /**
   * 加载所有 Sessions 存储
   */
  private loadSessionsStorage(): SessionsStorage {
    try {
      const stored = localStorage.getItem(SESSIONS_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // Ignore errors
    }
    return { byTrace: {} };
  }

  /**
   * 保存所有 Sessions 存储
   */
  private saveSessionsStorage(storage: SessionsStorage): void {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(storage));
    } catch {
      // Ignore errors
    }
  }

  /**
   * 获取指定 Trace 的所有 Sessions
   */
  getSessionsForTrace(fingerprint: string): AISession[] {
    const storage = this.loadSessionsStorage();
    return storage.byTrace[fingerprint] || [];
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

    const session: AISession = {
      sessionId: this.generateId(),
      traceFingerprint: fingerprint,
      traceName: traceName,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messages: [],
      pinnedResults: [],
      bookmarks: [],
    };

    // 保存到存储
    const storage = this.loadSessionsStorage();
    if (!storage.byTrace[fingerprint]) {
      storage.byTrace[fingerprint] = [];
    }
    storage.byTrace[fingerprint].push(session);
    this.saveSessionsStorage(storage);

    // 更新当前 session ID
    this.state.currentSessionId = session.sessionId;

    console.log('[AIPanel] Created new session:', session.sessionId);
    return session;
  }

  /**
   * 保存当前 Session
   */
  saveCurrentSession(): void {
    if (!this.state.currentSessionId || !this.state.currentTraceFingerprint) {
      return;
    }

    const storage = this.loadSessionsStorage();
    const sessions = storage.byTrace[this.state.currentTraceFingerprint];
    if (!sessions) return;

    const sessionIndex = sessions.findIndex(s => s.sessionId === this.state.currentSessionId);
    if (sessionIndex === -1) return;

    // 更新 session 数据
    sessions[sessionIndex] = {
      ...sessions[sessionIndex],
      messages: this.state.messages,
      pinnedResults: this.state.pinnedResults,
      bookmarks: this.state.bookmarks,
      backendTraceId: this.state.backendTraceId || undefined,
      lastActiveAt: Date.now(),
    };

    this.saveSessionsStorage(storage);
    console.log('[AIPanel] Saved session:', this.state.currentSessionId);
  }

  /**
   * 加载指定 Session
   */
  loadSession(sessionId: string): boolean {
    const storage = this.loadSessionsStorage();

    // 在所有 traces 中查找 session
    for (const fingerprint in storage.byTrace) {
      const sessions = storage.byTrace[fingerprint];
      const session = sessions.find(s => s.sessionId === sessionId);
      if (session) {
        this.state.currentSessionId = session.sessionId;
        this.state.currentTraceFingerprint = session.traceFingerprint;
        this.state.messages = session.messages;
        this.state.pinnedResults = session.pinnedResults || [];
        this.state.bookmarks = session.bookmarks || [];

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
    }

    return false;
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
    const storage = this.loadSessionsStorage();

    for (const fingerprint in storage.byTrace) {
      const sessions = storage.byTrace[fingerprint];
      const index = sessions.findIndex(s => s.sessionId === sessionId);
      if (index !== -1) {
        sessions.splice(index, 1);
        this.saveSessionsStorage(storage);

        // 如果删除的是当前 session，重置状态
        if (sessionId === this.state.currentSessionId) {
          this.state.currentSessionId = null;
          this.resetStateForNewTrace();
        }

        console.log('[AIPanel] Deleted session:', sessionId);
        return true;
      }
    }

    return false;
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

  private addMessage(msg: Message) {
    this.state.messages.push(msg);
    // Trim to max history
    const maxMsgs = this.state.settings.maxHistory * 2; // user + assistant
    if (this.state.messages.length > maxMsgs) {
      this.state.messages = this.state.messages.slice(-maxMsgs);
    }
    this.saveHistory();
    // 同时保存到 Session
    this.saveCurrentSession();
    this.scrollToBottom();
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
          id,
          name,
          category,
          ts,
          dur / 1e6 as dur_ms,
          track_id,
          depth
        FROM slice
        WHERE id = ${eventId}
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
- Timestamp: ${sliceData.ts} (convert to human-readable time if needed)
- Duration: ${sliceData.dur_ms?.toFixed(2) || 'N/A'} ms
- Track ID: ${sliceData.track_id}
- Depth: ${sliceData.depth}
`.trim();

      // If AI service is configured, ask for analysis
      if (this.state.aiService) {
        const systemPrompt = `You are an Android performance analysis expert. Analyze the given slice from a Perfetto trace and provide insights about:
1. What this slice represents
2. Whether the duration is typical or concerning
3. Possible performance issues if any
4. Suggestions for further investigation

Keep your analysis concise and actionable.`;

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

    this.state.isLoading = true;
    m.redraw();

    try {
      // Call backend slow analysis endpoint
      const apiUrl = `${this.state.settings.backendUrl}/api/trace-analysis/analyze/slow`;
      console.log('[AIPanel] Calling slow analysis API:', apiUrl, 'with traceId:', this.state.backendTraceId);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.state.backendTraceId,
        }),
      });

      console.log('[AIPanel] Slow analysis API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'TRACE_NOT_UPLOADED') {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content: '⚠️ **Trace not found in backend.**\n\nPlease upload the trace again using the 📤 button.',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          return;
        }
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[AIPanel] Slow analysis API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Slow analysis failed');
      }

      // Display results with SQL result table if available
      if (data.data?.result) {
        const result = data.data.result;
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: data.data.summary || `**Slow operations analysis complete.** Found **${result.rowCount}** slow operations.`,
          timestamp: Date.now(),
          sqlResult: {
            columns: result.columns || [],
            rows: result.rows || [],
            rowCount: result.rowCount || 0,
            query: result.query || '',
          },
        });
      } else {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: data.data?.summary || '**Slow operations analysis complete.** No slow operations detected.',
          timestamp: Date.now(),
        });
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error:** ${e.message || 'Failed to analyze slow operations'}`,
        timestamp: Date.now(),
      });
    }

    this.state.isLoading = false;
    m.redraw();
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

    this.state.isLoading = true;
    m.redraw();

    try {
      // Call backend memory analysis endpoint
      const apiUrl = `${this.state.settings.backendUrl}/api/trace-analysis/analyze/memory`;
      console.log('[AIPanel] Calling memory analysis API:', apiUrl, 'with traceId:', this.state.backendTraceId);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.state.backendTraceId,
        }),
      });

      console.log('[AIPanel] Memory analysis API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'TRACE_NOT_UPLOADED') {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content: '⚠️ **Trace not found in backend.**\n\nPlease upload the trace again using the 📤 button.',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          return;
        }
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[AIPanel] Memory analysis API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Memory analysis failed');
      }

      // Display results with SQL result table if available
      if (data.data?.result) {
        const result = data.data.result;
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: data.data.summary || `**Memory analysis complete.** Found **${result.rowCount}** memory allocations.`,
          timestamp: Date.now(),
          sqlResult: {
            columns: result.columns || [],
            rows: result.rows || [],
            rowCount: result.rowCount || 0,
            query: result.query || '',
          },
        });
      } else {
        this.addMessage({
          id: this.generateId(),
          role: 'assistant',
          content: data.data?.summary || '**Memory analysis complete.** No memory data detected.',
          timestamp: Date.now(),
        });
      }
    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error:** ${e.message || 'Failed to analyze memory'}`,
        timestamp: Date.now(),
      });
    }

    this.state.isLoading = false;
    m.redraw();
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
    m.redraw();

    try {
      // Call backend analysis API
      const apiUrl = `${this.state.settings.backendUrl}/api/trace-analysis/analyze`;
      console.log('[AIPanel] Calling API:', apiUrl, 'with traceId:', this.state.backendTraceId);

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: message,
          traceId: this.state.backendTraceId,
          maxIterations: 12,
        }),
      });

      console.log('[AIPanel] API response status:', response.status);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        if (errorData.code === 'TRACE_NOT_UPLOADED') {
          this.addMessage({
            id: this.generateId(),
            role: 'system',
            content: '⚠️ **Trace not found in backend.**\n\nPlease upload the trace again using the 📤 button.',
            timestamp: Date.now(),
          });
          this.state.backendTraceId = null;
          return;
        }
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log('[AIPanel] API response data:', data);

      if (!data.success) {
        throw new Error(data.error || 'Analysis failed');
      }

      // Use SSE for real-time progress updates
      const analysisId = data.analysisId;
      if (analysisId) {
        console.log('[AIPanel] Starting SSE listener for:', analysisId);
        await this.listenToSSE(analysisId);
      } else {
        console.log('[AIPanel] No analysisId in response, data:', data);
      }

    } catch (e: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Error:** ${e.message || 'Failed to start analysis'}`,
        timestamp: Date.now(),
      });
    }

    this.state.isLoading = false;
    m.redraw();
  }

  /**
   * Listen to SSE events from backend for real-time progress updates
   */
  private async listenToSSE(analysisId: string): Promise<void> {
    const apiUrl = `${this.state.settings.backendUrl}/api/trace-analysis/${analysisId}/stream`;

    try {
      const response = await fetch(apiUrl);
      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const {done, value} = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, {stream: true});

        // Process complete SSE messages
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEventType = '';
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          if (line.startsWith(':')) continue; // Skip comments

          if (line.startsWith('event:')) {
            // Extract event type (e.g., "event: progress" -> "progress")
            currentEventType = line.replace('event:', '').trim();
          } else if (line.startsWith('data:')) {
            // Parse data line
            const dataStr = line.replace('data:', '').trim();
            if (dataStr) {
              try {
                const data = JSON.parse(dataStr);
                // Use the event type from the event: line, or fall back to data.type
                const eventType = currentEventType || data.type;
                this.handleSSEEvent(eventType, data);
              } catch (e) {
                console.error('[AIPanel] Failed to parse SSE data:', e, dataStr);
              }
            }
            currentEventType = ''; // Reset for next event
          }
        }
      }
    } catch (e: any) {
      console.error('[AIPanel] SSE error:', e);
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: `**Connection Error:** ${e.message || 'Lost connection to backend'}`,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle SSE events from backend
   */
  private handleSSEEvent(eventType: string, data?: any): void {
    console.log('[AIPanel] SSE event:', eventType, data);

    switch (eventType) {
      case 'connected':
        // Connection established
        break;

      case 'progress':
        // Show progress update (replaces previous progress message)
        if (data?.data?.message) {
          // Remove previous progress message
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `⏳ ${data.data.message}`,
            timestamp: Date.now(),
          });
        }
        break;

      case 'sql_generated':
        // SQL was generated - don't show raw SQL to user
        // The progress event will show the status
        break;

      case 'sql_executed':
        // SQL was executed - show result count
        if (data?.data?.result) {
          const rowCount = data.data.result.rowCount || 0;
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `📊 查询到 **${rowCount}** 条记录`,
            timestamp: Date.now(),
            sqlResult: {
              columns: data.data.result.columns || [],
              rows: data.data.result.rows || [],
              rowCount,
              query: data.data.sql || '',
              expandableData: data.data.result.expandableData,
              summary: data.data.result.summary,
            },
          });
        }
        break;

      case 'step_completed':
        // A step was completed - skip empty content
        if (data?.data?.content && data.data.content !== 'Query returned 0 rows.') {
          // Don't show this, we already showed the result in sql_executed
        }
        break;

      case 'skill_section':
        // Skill section data - display as a table
        if (data?.data) {
          const section = data.data;
          // Remove previous progress message
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }
          // Show progress for this section - use sectionTitle for compact display
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: '',  // No message content, title is in table header
            timestamp: Date.now(),
            sqlResult: section.rowCount > 0 ? {
              columns: section.columns,
              rows: section.rows,
              rowCount: section.rowCount,
              query: '',  // No SQL display
              sectionTitle: `${section.sectionTitle} (${section.sectionIndex}/${section.totalSections})`,
              expandableData: section.expandableData,
              summary: section.summary,
            } : undefined,
          });
        }
        break;

      case 'skill_diagnostics':
        // Skill diagnostics - display as a warning/info message
        if (data?.data?.diagnostics && data.data.diagnostics.length > 0) {
          const diagnostics = data.data.diagnostics;
          const criticalItems = diagnostics.filter((d: any) => d.severity === 'critical');
          const warningItems = diagnostics.filter((d: any) => d.severity === 'warning');
          const infoItems = diagnostics.filter((d: any) => d.severity === 'info');

          let content = '**🔍 诊断结果**\n\n';
          if (criticalItems.length > 0) {
            content += '🔴 **严重问题:**\n';
            criticalItems.forEach((d: any) => {
              content += `- ${d.message}\n`;
              if (d.suggestions && d.suggestions.length > 0) {
                content += `  *建议: ${d.suggestions.join('; ')}*\n`;
              }
            });
            content += '\n';
          }
          if (warningItems.length > 0) {
            content += '🟡 **警告:**\n';
            warningItems.forEach((d: any) => {
              content += `- ${d.message}\n`;
            });
            content += '\n';
          }
          if (infoItems.length > 0) {
            content += '🔵 **提示:**\n';
            infoItems.forEach((d: any) => {
              content += `- ${d.message}\n`;
            });
          }

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: content.trim(),
            timestamp: Date.now(),
          });
        }
        break;

      case 'skill_layered_result':
        // Layered skill result - display L1/L2/L4 data as tables
        // Support both formats:
        // 1. PerfettoAnalysisOrchestrator: { result: { layers, metadata }, summary }
        // 2. MasterOrchestrator/AnalysisWorker: { skillId, skillName, layers, diagnostics }
        const layeredResult = data?.data?.result?.layers || data?.data?.layers;
        if (layeredResult) {
          console.log('[AIPanel] skill_layered_result received:', data.data);
          const layers = layeredResult;
          // Support both metadata locations
          const metadata = data.data.result?.metadata || {
            skillName: data.data.skillName || data.data.skillId,
          };

          // Remove previous progress message
          const lastProgressMsg = this.state.messages[this.state.messages.length - 1];
          if (lastProgressMsg && lastProgressMsg.role === 'assistant' && lastProgressMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          // Process overview layer (L1) - metrics summary
          const overview = layers.overview || layers.L1;
          if (overview && Object.keys(overview).length > 0) {
            // Separate simple values from nested objects
            const simpleMetrics: Record<string, any> = {};
            const nestedObjects: Record<string, any> = {};

            for (const [key, val] of Object.entries(overview)) {
              if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
                nestedObjects[key] = val;
              } else {
                simpleMetrics[key] = val;
              }
            }

            // Display simple metrics as a single-row table
            if (Object.keys(simpleMetrics).length > 0) {
              const columns = Object.keys(simpleMetrics);
              const row = columns.map(col => this.formatDisplayValue(simpleMetrics[col], col));

              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns,
                  rows: [row],
                  rowCount: 1,
                  sectionTitle: `📊 ${metadata.skillName || '分析'} - 概览指标`,
                },
              });
            }

            // Display nested objects as separate tables (e.g., performance_summary, jank_type_stats)
            for (const [key, obj] of Object.entries(nestedObjects)) {
              const objColumns = Object.keys(obj);
              const objRow = objColumns.map(col => this.formatDisplayValue(obj[col], col));

              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns: objColumns,
                  rows: [objRow],
                  rowCount: 1,
                  sectionTitle: `📈 ${this.formatLayerName(key)}`,
                },
              });
            }
          }

          // Process list layer (L2) - array data tables
          const list = layers.list || layers.L2;
          if (list && typeof list === 'object') {
            for (const [key, items] of Object.entries(list)) {
              if (!Array.isArray(items) || items.length === 0) continue;

              const columns = Object.keys(items[0] || {});
              const rows = items.map((item: any) => columns.map(col => {
                return this.formatDisplayValue(item[col], col);
              }));

              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns,
                  rows,
                  rowCount: rows.length,
                  sectionTitle: `📋 ${this.formatLayerName(key)} (${rows.length}条)`,
                },
              });
            }
          }

          // Process deep layer (L4) - detailed frame data
          const deep = layers.deep || layers.L4;
          if (deep && typeof deep === 'object') {
            for (const [key, items] of Object.entries(deep)) {
              if (!Array.isArray(items) || items.length === 0) continue;

              const columns = Object.keys(items[0] || {});
              const rows = items.slice(0, 50).map((item: any) => columns.map(col => {
                return this.formatDisplayValue(item[col], col);
              }));

              const totalCount = items.length;
              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns,
                  rows,
                  rowCount: rows.length,
                  sectionTitle: `🔍 ${this.formatLayerName(key)} (${totalCount > 50 ? `显示前50条/共${totalCount}条` : `${totalCount}条`})`,
                },
              });
            }
          }

          // Show conclusion card if available (Phase 4: Root Cause Classification)
          const conclusion = data.data.result?.conclusion || this.extractConclusionFromOverview(overview);
          if (conclusion && conclusion.category && conclusion.category !== 'UNKNOWN') {
            const categoryEmoji = conclusion.category === 'APP' ? '📱' :
                                  conclusion.category === 'SYSTEM' ? '⚙️' :
                                  conclusion.category === 'MIXED' ? '🔄' : '❓';
            const confidencePercent = Math.round((conclusion.confidence || 0.5) * 100);
            const confidenceBar = '█'.repeat(Math.floor(confidencePercent / 10)) + '░'.repeat(10 - Math.floor(confidencePercent / 10));

            let conclusionContent = `## 🎯 分析结论\n\n`;
            conclusionContent += `**问题分类:** ${categoryEmoji} **${this.translateCategory(conclusion.category)}**\n`;
            conclusionContent += `**问题组件:** \`${this.translateComponent(conclusion.component)}\`\n`;
            conclusionContent += `**置信度:** ${confidenceBar} ${confidencePercent}%\n\n`;
            conclusionContent += `### 📋 根因分析\n${conclusion.summary}\n\n`;

            if (conclusion.suggestion) {
              conclusionContent += `### 💡 优化建议\n${conclusion.suggestion}\n\n`;
            }

            if (conclusion.evidence && Array.isArray(conclusion.evidence) && conclusion.evidence.length > 0) {
              conclusionContent += `### 📊 证据\n`;
              conclusion.evidence.forEach((e: string) => {
                conclusionContent += `- ${e}\n`;
              });
            }

            this.addMessage({
              id: this.generateId(),
              role: 'assistant',
              content: conclusionContent,
              timestamp: Date.now(),
            });
          }

          // Show summary if available
          if (data.data.summary) {
            this.addMessage({
              id: this.generateId(),
              role: 'assistant',
              content: `**📝 分析摘要:** ${data.data.summary}`,
              timestamp: Date.now(),
            });
          }
        }
        break;

      case 'analysis_completed':
        // Analysis is complete - show final answer
        console.log('[AIPanel] analysis_completed - full data:', JSON.stringify(data, null, 2));
        console.log('[AIPanel] answer exists?', !!data?.data?.answer);
        console.log('[AIPanel] answer value:', data?.data?.answer);
        this.state.isLoading = false;
        if (data?.data?.answer) {
          // Remove any remaining progress message
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }
          console.log('[AIPanel] Adding final answer message');
          // 构建消息内容，包含 HTML 报告链接
          let content = data.data.answer;
          const reportUrl = data.data.reportUrl;
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: content,
            timestamp: Date.now(),
            reportUrl: reportUrl ? `${this.state.settings.backendUrl}${reportUrl}` : undefined,
          });
        } else {
          console.warn('[AIPanel] No answer in analysis_completed event!');
        }
        break;

      case 'error':
        // Error occurred
        this.state.isLoading = false;
        if (data?.data?.error) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**错误:** ${data.data.error}`,
            timestamp: Date.now(),
          });
        }
        break;

      case 'end':
        // Stream ended
        this.state.isLoading = false;
        break;
    }

    // Trigger redraw after handling each event
    m.redraw();
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
          // 保存当前 session 再创建新的
          this.saveCurrentSession();
          this.createNewSession();
          this.state.messages = [];
          if (this.engine?.mode === 'HTTP_RPC') {
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

  private formatMessage(content: string): string {
    // Simple markdown-like formatting
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  private async clearChat() {
    // First, cleanup backend resources if a trace was uploaded
    if (this.state.backendTraceId) {
      try {
        const response = await fetch(
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
      const response = await fetch(`${this.state.settings.backendUrl}/api/export/result`, {
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
      const response = await fetch(`${this.state.settings.backendUrl}/api/export/session`, {
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
   * @param val - The value to format
   * @param columnName - Optional column name for context-aware formatting
   * @returns Formatted string representation
   */
  private formatDisplayValue(val: any, columnName?: string): string {
    // Handle null/undefined
    if (val === null || val === undefined) {
      return '';
    }

    // Handle numbers with smart formatting
    if (typeof val === 'number') {
      const col = (columnName || '').toLowerCase();

      // Percentage fields
      if (col.includes('rate') || col.includes('percent')) {
        // If value is already in percentage form (e.g., 6.07), don't multiply
        if (val > 1) {
          return `${val.toFixed(2)}%`;
        }
        return `${(val * 100).toFixed(1)}%`;
      }

      // Duration/time fields in nanoseconds
      if (col.includes('ns') || col.includes('_ns')) {
        if (val > 1_000_000_000) return `${(val / 1_000_000_000).toFixed(2)}s`;
        if (val > 1_000_000) return `${(val / 1_000_000).toFixed(2)}ms`;
        if (val > 1000) return `${(val / 1000).toFixed(2)}µs`;
        return `${val}ns`;
      }

      // Duration/time fields in milliseconds
      if (col.includes('duration') || col.includes('time') || col.includes('ms') || col.includes('_ms')) {
        if (val > 1000) return `${(val / 1000).toFixed(2)}s`;
        return `${val.toFixed(1)}ms`;
      }

      // Large numbers get locale formatting
      if (Math.abs(val) >= 1000) {
        return val.toLocaleString();
      }

      // Small decimals
      if (!Number.isInteger(val)) {
        return val.toFixed(2);
      }

      return String(val);
    }

    // Handle bigint
    if (typeof val === 'bigint') {
      const num = Number(val);
      if (num > 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}s`;
      if (num > 1_000_000) return `${(num / 1_000_000).toFixed(2)}ms`;
      if (num > 1000) return `${(num / 1000).toFixed(2)}µs`;
      return val.toString();
    }

    // Handle arrays
    if (Array.isArray(val)) {
      if (val.length === 0) return '[]';
      // For short arrays, show inline
      if (val.length <= 3) {
        return `[${val.map(v => this.formatDisplayValue(v)).join(', ')}]`;
      }
      return `[${val.length} items]`;
    }

    // Handle objects (nested data)
    if (typeof val === 'object') {
      const keys = Object.keys(val);
      if (keys.length === 0) return '{}';
      // For small objects, try to show key-value pairs
      if (keys.length <= 3) {
        const pairs = keys.map(k => `${k}: ${this.formatDisplayValue(val[k])}`);
        return `{${pairs.join(', ')}}`;
      }
      // For larger objects, use JSON
      try {
        return JSON.stringify(val);
      } catch {
        return `{${keys.length} fields}`;
      }
    }

    // Handle boolean
    if (typeof val === 'boolean') {
      return val ? '✓' : '✗';
    }

    // Default: convert to string
    return String(val);
  }

  /**
   * Format layer data key name to human-readable label
   */
  private formatLayerName(key: string): string {
    // Common layer name mappings
    const nameMap: Record<string, string> = {
      'jank_frames': '卡顿帧',
      'scrolling_sessions': '滑动会话',
      'frame_details': '帧详情',
      'frame_analysis': '帧分析',
      'slow_frames': '慢帧',
      'blocked_frames': '阻塞帧',
      'sessions': '会话',
      'frames': '帧数据',
      'metrics': '指标',
      'overview': '概览',
      'summary': '摘要',
    };

    // Check for exact match
    const lowerKey = key.toLowerCase();
    if (nameMap[lowerKey]) {
      return nameMap[lowerKey];
    }

    // Format snake_case to readable string
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Extract conclusion from overview layer data (Phase 4)
   * Maps the root_cause_classification step output to conclusion format
   */
  private extractConclusionFromOverview(overview: Record<string, any> | undefined): any {
    if (!overview) return null;

    // Check for conclusion data in various locations
    const conclusion = overview.conclusion || overview.root_cause_classification;
    if (conclusion && typeof conclusion === 'object') {
      // Direct conclusion object
      if (conclusion.problem_category || conclusion.category) {
        return {
          category: conclusion.problem_category || conclusion.category,
          component: conclusion.problem_component || conclusion.component,
          confidence: conclusion.confidence || 0.5,
          summary: conclusion.root_cause_summary || conclusion.summary || '',
          evidence: this.parseEvidence(conclusion.evidence),
          suggestion: conclusion.suggestion,
        };
      }
    }

    // Check if conclusion fields are at the top level of overview
    if (overview.problem_category) {
      return {
        category: overview.problem_category,
        component: overview.problem_component,
        confidence: overview.confidence || 0.5,
        summary: overview.root_cause_summary || '',
        evidence: this.parseEvidence(overview.evidence),
        suggestion: overview.suggestion,
      };
    }

    return null;
  }

  /**
   * Parse evidence field which may be JSON string or array
   */
  private parseEvidence(evidence: any): string[] {
    if (!evidence) return [];
    if (Array.isArray(evidence)) return evidence;
    if (typeof evidence === 'string') {
      try {
        const parsed = JSON.parse(evidence);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [evidence];
      }
    }
    return [];
  }

  /**
   * Translate problem category to Chinese (Phase 4)
   */
  private translateCategory(category: string): string {
    const translations: Record<string, string> = {
      'APP': '应用问题',
      'SYSTEM': '系统问题',
      'MIXED': '混合问题',
      'UNKNOWN': '未知',
    };
    return translations[category] || category;
  }

  /**
   * Translate problem component to Chinese (Phase 4)
   */
  private translateComponent(component: string): string {
    const translations: Record<string, string> = {
      'MAIN_THREAD': '主线程',
      'RENDER_THREAD': '渲染线程',
      'SURFACE_FLINGER': 'SurfaceFlinger',
      'BINDER': 'Binder 跨进程调用',
      'CPU_SCHEDULING': 'CPU 调度',
      'CPU_AFFINITY': 'CPU 亲和性',
      'GPU': 'GPU',
      'MEMORY': '内存',
      'IO': 'IO',
      'MAIN_THREAD_BLOCKING': '主线程阻塞',
      'UNKNOWN': '未知',
    };
    return translations[component] || component;
  }

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
