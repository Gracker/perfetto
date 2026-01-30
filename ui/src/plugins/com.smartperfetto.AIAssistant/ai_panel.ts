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
// Mermaid is loaded as external via <script> tag to avoid Rollup code-splitting.
// The script is copied to dist/assets/ by build.js and loaded lazily when needed.
import {assetSrc} from '../../base/assets';
import {AIService, OllamaService, OpenAIService, BackendProxyService} from './ai_service';
import {SettingsModal} from './settings_modal';
import {SqlResultTable} from './sql_result_table';
import {ChartVisualizer} from './chart_visualizer';
import {NavigationBookmarkBar, NavigationBookmark} from './navigation_bookmark_bar';
import {Engine} from '../../trace_processor/engine';
import {Trace} from '../../public/trace';
import {HttpRpcEngine} from '../../trace_processor/http_rpc_engine';
import {AppImpl} from '../../core/app_impl';
import {getBackendUploader} from '../../core/backend_uploader';
import {TraceSource} from '../../core/trace_source';
import {Time} from '../../base/time';
import {
  FullAnalysis,
  ExpandableSections,
  isFrameDetailData,
  // DataEnvelope types (v2.0)
  DataEnvelope,
  DataPayload,
  isDataEnvelope,
  envelopeToSqlQueryResult,
} from './generated';

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
  // Chart data for visualization (display.format: 'chart')
  chartData?: {
    type: 'pie' | 'bar' | 'histogram';
    title?: string;
    data: Array<{ label: string; value: number; percentage?: number; color?: string }>;
  };
  // Metric card data (display.format: 'metric')
  metricData?: {
    title: string;
    value: string | number;
    unit?: string;
    status?: 'good' | 'warning' | 'critical';
    delta?: string;  // e.g., "+5%" or "-10ms"
  };
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
  sectionTitle?: string;  // For skill_section messages - shows title in table header
  stepId?: string;        // Skill step identifier (from DataEnvelope.meta.stepId)
  layer?: string;         // Display layer (overview/list/detail/deep)
  // Output structure optimization: grouping and collapse support
  group?: string;         // Group identifier for interval grouping
  collapsible?: boolean;  // Whether this table can be collapsed
  defaultCollapsed?: boolean;  // Whether this table starts collapsed
  maxVisibleRows?: number;  // Max rows to show before "show more"
  // 可展开行数据（用于 iterator 类型的结果）
  expandableData?: Array<{
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }>;
  // 汇总报告 (legacy format)
  summary?: {
    title: string;
    content: string;
  };
  // 汇总报告 (v2.0 DataPayload format - from SummaryContent)
  summaryReport?: {
    title: string;
    content: string;
    keyMetrics?: Array<{
      name: string;
      value: string;
      status?: 'good' | 'warning' | 'critical';
    }>;
  };
  // 元数据：从列表中提取的固定值（如 layer_name, process_name）
  // 这些值在所有行中相同，显示在标题区域
  metadata?: Record<string, any>;
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
  agentSessionId: string | null;  // Agent 多轮对话 Session ID
  displayedSkillProgress: Set<string>;  // 已显示的 skill 进度 (skillId:step)，用于去重
  completionHandled: boolean;  // 是否已处理分析完成事件（防止 conclusion + analysis_completed 重复处理）
  // SSE Connection State (Phase 2: Reconnection Logic)
  sseConnectionState: 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
  sseRetryCount: number;  // Current retry attempt count
  sseMaxRetries: number;  // Maximum retry attempts (default: 5)
  sseLastEventTime: number | null;  // Last received event timestamp
  // Error Aggregation (Phase 3: Error Summary Display)
  collectedErrors: Array<{
    skillId: string;
    stepId?: string;
    error: string;
    timestamp: number;
  }>;
  // Output structure optimization: track collapsed table states
  collapsedTables: Set<string>;  // Message IDs of currently collapsed tables
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

// Preset questions for quick analysis
// Teaching buttons first (visual priority), then analysis buttons
const PRESET_QUESTIONS: Array<{label: string; question: string; icon: string; isTeaching?: boolean}> = [
  // Teaching mode - helps users understand rendering pipelines
  {label: '🎓 出图教学', question: '/teaching-pipeline', icon: 'school', isTeaching: true},
  // Analysis mode - actual performance analysis
  {label: '滑动', question: '分析滑动性能', icon: 'swipe'},
  {label: '启动', question: '分析启动性能', icon: 'rocket_launch'},
  {label: '跳转', question: '分析跳转性能', icon: 'open_in_new'},
];

export class AIPanel implements m.ClassComponent<AIPanelAttrs> {
  private engine?: Engine;
  private trace?: Trace;
  private mermaidInitialized = false;
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
  };

  private onClearChat?: () => void;
  private onOpenSettings?: () => void;
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;
  // SSE Connection Management
  private sseAbortController: AbortController | null = null;

  private getMermaid(): any | undefined {
    return (globalThis as any).mermaid;
  }

  private mermaidLoadPromise: Promise<void> | null = null;

  private loadMermaidScript(): Promise<void> {
    if (this.mermaidLoadPromise) return this.mermaidLoadPromise;
    if (this.getMermaid()) return Promise.resolve();

    this.mermaidLoadPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      // Load mermaid from local assets (copied by build.js) to comply with CSP.
      script.src = assetSrc('assets/mermaid.min.js');
      script.async = true;
      script.onload = () => {
        console.log('[AIPanel] Mermaid loaded from local assets');
        resolve();
      };
      script.onerror = () => {
        console.error('[AIPanel] Failed to load Mermaid from local assets');
        this.mermaidLoadPromise = null;
        reject(new Error('Failed to load Mermaid'));
      };
      document.head.appendChild(script);
    });

    return this.mermaidLoadPromise;
  }

  private async ensureMermaidInitialized(): Promise<void> {
    if (this.mermaidInitialized) return;

    // Load mermaid script if not already loaded
    if (!this.getMermaid()) {
      try {
        await this.loadMermaidScript();
      } catch (e) {
        console.warn('[AIPanel] Mermaid not available:', e);
        return;
      }
    }

    const mermaid = this.getMermaid();
    if (!mermaid) {
      console.warn('[AIPanel] Mermaid not available on globalThis after load');
      return;
    }
    // Keep this safe for untrusted markdown: strict sanitization and no autostart.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'default',
    });
    this.mermaidInitialized = true;
  }

  private encodeBase64Unicode(input: string): string {
    // btoa only supports latin1 - convert safely.
    return btoa(unescape(encodeURIComponent(input)));
  }

  private decodeBase64Unicode(base64: string): string {
    return decodeURIComponent(escape(atob(base64)));
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

  private async renderMermaidInElement(container: HTMLElement): Promise<void> {
    const diagramNodes = Array.from(
      container.querySelectorAll<HTMLElement>('.ai-mermaid-diagram[data-mermaid-b64]')
    );
    const sourceNodes = Array.from(
      container.querySelectorAll<HTMLElement>('.ai-mermaid-source[data-mermaid-b64]')
    );

    if (diagramNodes.length === 0 && sourceNodes.length === 0) return;

    await this.ensureMermaidInitialized();
    const mermaid = this.getMermaid();
    if (!mermaid) return;

    // Populate sources first (textContent, no HTML interpretation).
    for (const source of sourceNodes) {
      if (source.dataset.rendered === 'true') continue;
      const b64 = source.dataset.mermaidB64;
      if (!b64) continue;
      try {
        source.textContent = this.decodeBase64Unicode(b64);
        source.dataset.rendered = 'true';
      } catch (e) {
        console.warn('[AIPanel] Failed to decode mermaid source:', e);
      }
    }

    // Render diagrams.
    for (const host of diagramNodes) {
      if (host.dataset.rendered === 'true') continue;
      const b64 = host.dataset.mermaidB64;
      if (!b64) continue;

      let code = '';
      try {
        code = this.decodeBase64Unicode(b64);
      } catch (e) {
        console.warn('[AIPanel] Failed to decode mermaid diagram:', e);
        continue;
      }

      const renderId = `ai-mermaid-${Math.random().toString(36).slice(2)}`;
      host.classList.add('mermaid');
      host.textContent = '';

      try {
        // mermaid.render returns {svg, bindFunctions} in modern versions.
        const result: any = await mermaid.render(renderId, code);
        host.innerHTML = result?.svg || '';
        if (typeof result?.bindFunctions === 'function') {
          result.bindFunctions(host);
        }
        host.dataset.rendered = 'true';
      } catch (e) {
        console.warn('[AIPanel] Mermaid render failed:', e);
        host.innerHTML =
          '<div class="ai-mermaid-error">Mermaid 渲染失败（请展开查看源码）</div>';
        host.dataset.rendered = 'true';
      }
    }
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
    this.state.agentSessionId = null;  // Reset Agent session for multi-turn dialogue

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
                // Use oncreate/onupdate to directly set innerHTML, bypassing Mithril's
                // reconciliation for m.trust() content. This avoids removeChild errors
                // that occur when multiple SSE events trigger rapid redraws.
                m('div.ai-message-content', {
                  onclick: (e: MouseEvent) => {
                    const target = e.target as HTMLElement;
                    const copyBtn = target.closest?.('.ai-mermaid-copy') as HTMLElement | null;
                    if (copyBtn) {
                      const b64 = copyBtn.getAttribute('data-mermaid-b64');
                      if (b64) {
                        try {
                          const code = this.decodeBase64Unicode(b64);
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
                    dom.innerHTML = this.formatMessage(msg.content);
                    void this.renderMermaidInElement(dom);
                  },
                  onupdate: (vnode: m.VnodeDOM) => {
                    const newHtml = this.formatMessage(msg.content);
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
                  }, '查看详细分析报告 (HTML)'),
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
    m.redraw();

    try {
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

      const response = await fetch(apiUrl, {
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
          return;
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

        console.log('[AIPanel] Starting Agent SSE listener for session:', sessionId);
        await this.listenToAgentSSE(sessionId);
      } else {
        console.log('[AIPanel] No sessionId in response, data:', data);
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

        const response = await fetch(apiUrl, { signal });
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
                      this.state.sseConnectionState = 'disconnected';
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
          // Deduplication check - prevent duplicate skill_layered_result display
          const skillId = data.data.skillId || data.data.result?.metadata?.skillId || 'unknown';
          const deduplicationKey = `skill_layered_result:${skillId}`;
          if (this.state.displayedSkillProgress.has(deduplicationKey)) {
            console.log('[AIPanel] Skipping duplicate skill_layered_result:', deduplicationKey);
            break;
          }
          this.state.displayedSkillProgress.add(deduplicationKey);

          console.log('[AIPanel] skill_layered_result received:', data.data);
          console.log('[AIPanel] Deep layer details:', {
            hasDeep: !!layeredResult.deep,
            deepKeys: layeredResult.deep ? Object.keys(layeredResult.deep) : [],
            deepSample: layeredResult.deep ? Object.entries(layeredResult.deep).slice(0, 1).map(
              ([sid, frames]) => ({ sessionId: sid, frameKeys: Object.keys(frames as object) })
            ) : [],
          });
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
            // Helper to check if object is a StepResult format
            const isStepResult = (obj: any): boolean => {
              return obj && typeof obj === 'object' &&
                'data' in obj && Array.isArray(obj.data);
            };

            // Helper to extract data from StepResult or use as-is
            const extractData = (obj: any): any[] | null => {
              if (isStepResult(obj)) {
                return obj.data;
              }
              return null;
            };

            // Helper to get display title from StepResult
            const getDisplayTitle = (key: string, obj: any): string => {
              if (isStepResult(obj) && obj.display?.title) {
                return obj.display.title;
              }
              // Use metadata.skillName as context for the title
              const skillContext = metadata.skillName ? ` (${metadata.skillName})` : '';
              return this.formatLayerName(key) + skillContext;
            };

            // Helper to get display format from StepResult
            const getDisplayFormat = (obj: any): string => {
              return (obj?.display?.format || 'table').toLowerCase();
            };

            // Helper to build chart data from step result
            const buildChartData = (obj: any, title: string): Message['chartData'] | null => {
              const dataArray = extractData(obj);
              if (!dataArray || dataArray.length === 0) return null;

              // Try to infer chart type from data structure
              const firstRow = dataArray[0];
              if (!firstRow || typeof firstRow !== 'object') return null;

              const keys = Object.keys(firstRow);
              // Look for label/value pairs
              const labelKey = keys.find(k => k.toLowerCase().includes('label') || k.toLowerCase().includes('name') || k.toLowerCase().includes('type'));
              const valueKey = keys.find(k => k.toLowerCase().includes('value') || k.toLowerCase().includes('count') || k.toLowerCase().includes('total'));

              if (!labelKey || !valueKey) return null;

              return {
                type: 'bar',  // Default to bar chart
                title: title,
                data: dataArray.map((item: any) => ({
                  label: String(item[labelKey] || 'Unknown'),
                  value: Number(item[valueKey]) || 0,
                })),
              };
            };

            // Helper to build metric data from step result
            const buildMetricData = (obj: any, title: string): Message['metricData'] | null => {
              const dataArray = extractData(obj);
              if (!dataArray || dataArray.length === 0) return null;

              const firstRow = dataArray[0];
              if (!firstRow || typeof firstRow !== 'object') return null;

              const keys = Object.keys(firstRow);
              const valueKey = keys.find(k => k.toLowerCase().includes('value') || k.toLowerCase().includes('total') || k.toLowerCase().includes('avg'));

              if (valueKey) {
                const value = firstRow[valueKey];
                return {
                  title: title,
                  value: typeof value === 'number' ? value.toFixed(2) : String(value),
                  status: firstRow.status || undefined,
                };
              }

              // If single key-value pair, use first entry
              if (keys.length === 1) {
                return {
                  title: title,
                  value: String(firstRow[keys[0]]),
                };
              }

              return null;
            };

            // Process each entry in overview layer
            for (const [key, val] of Object.entries(overview)) {
              if (val === null || val === undefined) continue;

              // Get display format from step config
              const format = getDisplayFormat(val);
              const title = getDisplayTitle(key, val);

              // Route based on display format
              if (format === 'chart') {
                const chartData = buildChartData(val, title);
                if (chartData) {
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    chartData,
                  });
                  continue;
                }
              } else if (format === 'metric') {
                const metricData = buildMetricData(val, title);
                if (metricData) {
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    metricData,
                  });
                  continue;
                }
              }

              // Default: table format
              // Check if it's a StepResult format (has data array)
              const dataArray = extractData(val);
              if (dataArray && dataArray.length > 0) {
                // StepResult format: extract and display the data array
                const firstRow = dataArray[0];
                if (typeof firstRow === 'object' && firstRow !== null) {
                  const columns = Object.keys(firstRow);
                  const rows = dataArray.map((item: any) =>
                    columns.map(col => this.formatDisplayValue(item[col], col))
                  );

                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: '',
                    timestamp: Date.now(),
                    sqlResult: {
                      columns,
                      rows,
                      rowCount: rows.length,
                      sectionTitle: `📊 ${title}`,
                    },
                  });
                }
              } else if (typeof val === 'object' && !Array.isArray(val)) {
                // Nested object: display as single-row table
                const objColumns = Object.keys(val);
                const objRow = objColumns.map(col => this.formatDisplayValue((val as any)[col], col));

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
              } else if (!Array.isArray(val)) {
                // Simple value - collect for combined display (skip for now, handled below)
              }
            }
          }

          // Process list layer (L2) - array data tables
          // Get deep layer data for potential expandable rows
          const deep = layers.deep || layers.L4;
          const list = layers.list || layers.L2;

          // Debug logging for expandable data
          console.log('[AIPanel] Processing L2/deep layers:', {
            hasDeep: !!deep,
            hasList: !!list,
            deepKeys: deep ? Object.keys(deep) : [],
            listKeys: list ? Object.keys(list) : [],
          });
          if (list && typeof list === 'object') {
            // Helper to check if object is a StepResult format
            // Supports BOTH formats:
            // 1. Legacy format: data is an array of row objects [{col1: val1}, ...]
            // 2. New DataPayload format: data is {columns, rows, expandableData, summary}
            const isStepResult = (obj: any): boolean => {
              if (!obj || typeof obj !== 'object' || !('data' in obj)) return false;
              // Legacy format: data is array
              if (Array.isArray(obj.data)) return true;
              // New DataPayload format: data has columns/rows structure
              if (obj.data && typeof obj.data === 'object' &&
                  (Array.isArray(obj.data.columns) || Array.isArray(obj.data.rows))) {
                return true;
              }
              return false;
            };

            // Helper to check if data is in DataPayload format (new format)
            const isDataPayloadFormat = (data: any): boolean => {
              return data && typeof data === 'object' &&
                !Array.isArray(data) &&
                (Array.isArray(data.columns) || Array.isArray(data.rows));
            };

            // Helper to find frame detail in deep layer (legacy fallback)
            // Supports both prefixed (session_1, frame_123) and non-prefixed (1, 123) formats
            let findFrameDetailCallCount = 0;
            const findFrameDetail = (frameId: string | number, sessionId?: string | number): any => {
              findFrameDetailCallCount++;
              if (!deep || typeof deep !== 'object') {
                if (findFrameDetailCallCount <= 5) console.warn('[findFrameDetail] deep is invalid:', deep);
                return null;
              }

              // Generate all possible key variants for matching
              const sessionKeys = sessionId !== undefined
                ? [String(sessionId), `session_${sessionId}`]
                : [];
              const frameKeys = [String(frameId), `frame_${frameId}`];

              // Deep layer structure: { sessionId: { frameId: frameData } }
              for (const [sid, frames] of Object.entries(deep)) {
                // Check if session matches (if sessionId provided)
                if (sessionId !== undefined) {
                  const sessionMatches = sessionKeys.some(sk => sid === sk);
                  if (!sessionMatches) continue;
                }

                if (frames && typeof frames === 'object') {
                  // Try all possible frame key formats
                  for (const fk of frameKeys) {
                    const frameData = (frames as any)[fk];
                    if (frameData) return frameData;
                  }
                  // Debug: log when session matches but frame not found
                  if (findFrameDetailCallCount <= 5) {
                    const availableKeys = Object.keys(frames as object).slice(0, 5);
                    console.log(`[findFrameDetail] Session ${sid} matched but frame not found. Looking for: ${frameKeys.join(', ')}. Available keys sample: ${availableKeys.join(', ')}`);
                  }
                }
              }
              return null;
            };

            for (const [key, value] of Object.entries(list)) {
              // Handle StepResult format: { stepId, data: [...] | DataPayload, display }
              let items: any[] = [];
              let columns: string[] = [];
              let rows: any[][] = [];
              let displayTitle = this.formatLayerName(key);
              let isExpandable = false;
              let metadataColumns: string[] = [];
              let hiddenColumns: string[] = [];
              let preBindedExpandableData: any[] | undefined;  // L4 data pre-bound by backend
              let summaryReport: any | undefined;

              if (isStepResult(value)) {
                const stepData = (value as any).data;
                const displayConfig = (value as any).display;

                if (displayConfig?.title) {
                  displayTitle = displayConfig.title;
                }
                // Check if this list should be expandable (has frame details in deep layer)
                isExpandable = displayConfig?.expandable === true;
                // Get metadata_fields (values to extract to header) - prefer camelCase, fallback to legacy snake_case
                metadataColumns = displayConfig?.metadataFields || displayConfig?.metadata_columns || [];
                // Get hidden_columns (columns to hide from main table) - support legacy/camelCase
                hiddenColumns = displayConfig?.hidden_columns || displayConfig?.hiddenColumns || [];

                // Also extract hidden columns from column definitions (columns with hidden: true)
                if (displayConfig?.columns && Array.isArray(displayConfig.columns)) {
                  const hiddenFromDefs = displayConfig.columns
                    .filter((c: any) => c.hidden === true)
                    .map((c: any) => c.name);
                  hiddenColumns = [...new Set([...hiddenColumns, ...hiddenFromDefs])];
                }

                // Check which data format we have
                if (isDataPayloadFormat(stepData)) {
                  // NEW DataPayload format: {columns, rows, expandableData, summary}
                  console.log('[AIPanel] Processing DataPayload format for', key, {
                    hasColumns: !!stepData.columns,
                    hasRows: !!stepData.rows,
                    hasExpandableData: !!stepData.expandableData,
                    hasSummary: !!stepData.summary,
                  });

                  const allColumns = stepData.columns || [];
                  const allRows = stepData.rows || [];
                  preBindedExpandableData = stepData.expandableData;
                  summaryReport = stepData.summary;

                  // For DataPayload, items is rows converted to objects (for metadata extraction)
                  items = allRows.map((row: any[]) => {
                    const obj: Record<string, any> = {};
                    allColumns.forEach((col: string, i: number) => { obj[col] = row[i]; });
                    return obj;
                  });

                  // Apply column filtering for DataPayload format
                  const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
                  if (columnsToHide.size > 0) {
                    // Get indices of visible columns
                    const visibleIndices: number[] = [];
                    columns = allColumns.filter((col: string, idx: number) => {
                      if (!columnsToHide.has(col)) {
                        visibleIndices.push(idx);
                        return true;
                      }
                      return false;
                    });
                    // Filter rows to only include visible column values
                    rows = allRows.map((row: any[]) =>
                      visibleIndices.map(idx => this.formatDisplayValue(row[idx], allColumns[idx]))
                    );
                    console.log('[AIPanel] Applied column filtering for DataPayload:', {
                      original: allColumns.length,
                      filtered: columns.length,
                      hidden: columnsToHide.size,
                      hiddenList: Array.from(columnsToHide),
                    });
                  } else {
                    columns = allColumns;
                    rows = allRows.map((row: any[]) =>
                      row.map((val, idx) => this.formatDisplayValue(val, allColumns[idx]))
                    );
                  }
                } else {
                  // Legacy format: data is array of row objects
                  items = stepData;
                }
              } else if (Array.isArray(value)) {
                items = value;
              }

              // Skip if no data
              if (items.length === 0 && rows.length === 0) continue;

              // If we don't have columns/rows yet (legacy format), build them from items
              if (columns.length === 0 && items.length > 0) {
                // Get all columns from the first item
                const allColumns = Object.keys(items[0] || {});

                // Extract metadata values from the first item (for columns that are constant across rows)
                const metadata: Record<string, any> = {};
                if (metadataColumns.length > 0) {
                  for (const col of metadataColumns) {
                    if (items[0][col] !== undefined) {
                      metadata[col] = items[0][col];
                    }
                  }
                }

                // Filter columns: remove metadata_columns and hidden_columns from display
                const columnsToHide = new Set([...metadataColumns, ...hiddenColumns]);
                columns = allColumns.filter(col => !columnsToHide.has(col));

                // Build rows with only visible columns
                rows = items.map((item: any) => columns.map(col => {
                  return this.formatDisplayValue(item[col], col);
                }));
              }

              // Build expandable data - prefer pre-bound data from backend
              let expandableData: any[] | undefined;

              if (preBindedExpandableData && preBindedExpandableData.length > 0) {
                // Use pre-bound expandable data from backend (v2.0 DataPayload format)
                console.log('[AIPanel] Using pre-bound expandableData for', key, {
                  count: preBindedExpandableData.length,
                  sampleHasSections: !!preBindedExpandableData[0]?.result?.sections,
                });
                expandableData = preBindedExpandableData;
              } else if (isExpandable && deep) {
                // Fallback: build expandable data by looking up in deep layer (legacy)
                console.log('[AIPanel] Building expandable data via findFrameDetail for', key, {
                  itemCount: items.length,
                  sampleItem: items[0],
                  deepStructure: Object.fromEntries(
                    Object.entries(deep).slice(0, 2).map(([k, v]) => [k, Object.keys(v as object)])
                  ),
                });

                // IMPORTANT: Don't use .filter(Boolean) - we need to preserve array indices
                // so that expandableData[rowIndex] matches the correct row
                expandableData = items.map((item: any, idx: number) => {
                  const frameId = item.frame_id || item.frameId || item.id;
                  const sessionId = item.session_id || item.sessionId;
                  const frameDetail = findFrameDetail(frameId, sessionId);

                  // Log all frames to help diagnose expand issues
                  if (idx < 10 || !frameDetail) {
                    console.log(`[AIPanel] Frame ${idx}: frameId=${frameId}, sessionId=${sessionId}, found=${!!frameDetail}`);
                    if (frameDetail) {
                      console.log(`[AIPanel] Frame ${idx} detail:`, {
                        hasData: !!frameDetail.data,
                        dataType: typeof frameDetail.data,
                        dataKeys: frameDetail.data ? Object.keys(frameDetail.data) : [],
                      });
                    }
                  }

                  if (frameDetail) {
                    // Convert backend format to frontend sections format
                    const sections = this.convertToExpandableSections(frameDetail.data);

                    if (idx < 3) {
                      console.log(`[AIPanel] Frame ${idx} sections:`, Object.keys(sections));
                    }

                    return {
                      item: frameDetail.item || item,
                      result: {
                        success: true,
                        sections,
                      },
                    };
                  }
                  // Return null but DON'T filter - preserve index alignment with rows
                  return null;
                });

                const expandableItemCount = expandableData?.filter(Boolean).length || 0;
                const failedIndices = expandableData?.map((d, i) => d ? null : i).filter(i => i !== null) || [];
                console.log('[AIPanel] Expandable data built:', expandableData?.length || 0, 'slots,', expandableItemCount, 'with data');
                if (failedIndices.length > 0 && failedIndices.length <= 10) {
                  console.warn('[AIPanel] Failed to find deep data for frames at indices:', failedIndices);
                } else if (failedIndices.length > 10) {
                  console.warn('[AIPanel] Failed to find deep data for', failedIndices.length, 'frames. First 10:', failedIndices.slice(0, 10));
                }
              }

              // Extract metadata for header display
              const metadata: Record<string, any> = {};
              if (metadataColumns.length > 0 && items.length > 0) {
                for (const col of metadataColumns) {
                  if (items[0][col] !== undefined) {
                    metadata[col] = items[0][col];
                  }
                }
              }

              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns,
                  rows,
                  rowCount: rows.length,
                  sectionTitle: `📋 ${displayTitle} (${rows.length}条)`,
                  // Include expandableData if at least one item has data (use filter to count non-null items)
                  expandableData: expandableData && expandableData.filter(Boolean).length > 0 ? expandableData : undefined,
                  // Include metadata for header display (extracted fixed values like layer_name, process_name)
                  metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
                  // Include summary report if available (from DataPayload)
                  summaryReport: summaryReport,
                },
              });
            }
          }

          // Process deep layer (L4) - detailed frame data
          // Skip L4 display if data is already embedded in L2 expandable rows
          // The deep layer data is used for expandable content in list tables
          // NOTE: We no longer display L4 as standalone tables since it's
          // now embedded as expandable data in the frame list (L2 layer)

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

          // Show summary if available - try to parse as table if it looks like key-value pairs
          if (data.data.summary) {
            const summaryTableData = this.parseSummaryToTable(data.data.summary);
            if (summaryTableData) {
              // Display as table
              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns: summaryTableData.columns,
                  rows: summaryTableData.rows,
                  rowCount: summaryTableData.rows.length,
                  sectionTitle: '📝 分析摘要',
                },
              });
            } else {
              // Fallback to text display
              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: `**📝 分析摘要:** ${data.data.summary}`,
                timestamp: Date.now(),
              });
            }
          }
        }
        break;

      case 'analysis_completed':
        // Analysis is complete - show final answer (authoritative completion event)
        // Supports both legacy 'answer' field and agent-driven 'conclusion' field
        console.log('[AIPanel] analysis_completed received, architecture:', data?.architecture);
        this.state.isLoading = false;

        // Guard against duplicate handling
        if (this.state.completionHandled) {
          console.log('[AIPanel] Completion already handled, skipping');
          break;
        }

        // Support both 'answer' (legacy) and 'conclusion' (agent-driven)
        const answerContent = data?.data?.answer || data?.data?.conclusion;

        if (answerContent) {
          // Mark completion as handled BEFORE modifying messages to prevent race conditions
          this.state.completionHandled = true;

          // Remove any remaining progress message
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }
          console.log('[AIPanel] Adding final answer message');

          // Build content with agent-driven metadata if available
          let content = answerContent;

          // For agent-driven results, add hypothesis summary if available
          const isAgentDriven = data?.architecture === 'v2-agent-driven' || data?.architecture === 'agent-driven';
          if (isAgentDriven && data?.data?.hypotheses) {
            const hypotheses = data.data.hypotheses;
            const confirmed = hypotheses.filter((h: any) => h.status === 'confirmed');
            const confidence = data.data.confidence || 0;

            if (confirmed.length > 0 || confidence > 0) {
              content += `\n\n---\n**分析元数据**\n`;
              content += `- 置信度: ${(confidence * 100).toFixed(0)}%\n`;
              content += `- 分析轮次: ${data.data.rounds || 1}\n`;
              if (confirmed.length > 0) {
                content += `- 确认假设: ${confirmed.map((h: any) => h.description).join(', ')}\n`;
              }
            }
          }

          const reportUrl = data.data.reportUrl;
          if (!reportUrl && data.data.reportError) {
            console.warn('[AIPanel] HTML report generation failed:', data.data.reportError);
          }

          // Check if conclusion was already shown by skill_layered_result handler
          const hasConclusionAlready = this.state.messages.some(
            m => m.role === 'assistant' && m.content.includes('🎯 分析结论')
          );

          if (!hasConclusionAlready) {
            // Append conclusion at the end of the conversation (after all data tables)
            this.addMessage({
              id: this.generateId(),
              role: 'assistant',
              content: content,
              timestamp: Date.now(),
              reportUrl: reportUrl ? `${this.state.settings.backendUrl}${reportUrl}` : undefined,
            });
          } else if (reportUrl) {
            // Conclusion already shown, but attach reportUrl to existing conclusion message
            const conclusionMsg = this.state.messages.find(
              m => m.role === 'assistant' && m.content.includes('🎯 分析结论')
            );
            if (conclusionMsg) {
              conclusionMsg.reportUrl = `${this.state.settings.backendUrl}${reportUrl}`;
              this.saveHistory();
              this.saveCurrentSession();
            }
          }

          // Show error summary if there were any non-fatal errors during analysis
          if (this.state.collectedErrors.length > 0) {
            this.showErrorSummary();
          }
        } else {
          console.warn('[AIPanel] No answer/conclusion in analysis_completed event!');
          // Still show error summary even if no answer
          if (this.state.collectedErrors.length > 0) {
            this.showErrorSummary();
          }
        }
        break;

      case 'thought':
        // Agent thinking process (Planner or Evaluator)
        // Skip detailed thought messages to reduce noise - only show a brief progress indicator
        // The actual results are shown via skill_data and analysis_completed events
        console.log(`[AIPanel] Skipping thought display:`, data?.data?.agent);
        break;

      case 'worker_thought':
        // Worker skill execution progress
        // Skip all worker_thought messages to reduce noise - the skill_data/skill_layered_result
        // already provides the actual data in a more useful format (tables)
        console.log(`[AIPanel] Skipping worker_thought display (data shown via skill_data):`, data?.data?.step);
        break;

      case 'data':
        // v2.0 DataEnvelope format - unified data event
        // Handle both single envelope and array of envelopes
        if (data) {
          console.log('[AIPanel] v2.0 data event received:', data.id, data.envelope);

          const envelopes: DataEnvelope[] = Array.isArray(data.envelope)
            ? data.envelope
            : [data.envelope];

          for (const envelope of envelopes) {
            if (!isDataEnvelope(envelope)) {
              console.warn('[AIPanel] Invalid DataEnvelope:', envelope);
              continue;
            }

            // Generate deduplication key
            // Use meta.source so repeated executions (e.g. per-session deep dives) can be displayed independently.
            const deduplicationKey = envelope.meta.source ||
              `${envelope.meta.skillId || 'unknown'}:${envelope.meta.stepId || 'unknown'}`;

            // Check for duplicates
            if (this.state.displayedSkillProgress.has(deduplicationKey)) {
              console.log('[AIPanel] Skipping duplicate data envelope:', deduplicationKey);
              continue;
            }
            this.state.displayedSkillProgress.add(deduplicationKey);

            // Remove previous progress message
            const lastMsg = this.state.messages[this.state.messages.length - 1];
            if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
              this.state.messages.pop();
            }

            // Render based on display.format
            const format = envelope.display.format || 'table';
            const payload = envelope.data as DataPayload;
            const title = envelope.display.title;

            switch (format) {
              case 'text':
                // Render text content as markdown
                if (payload.text) {
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: `**${title}**\n\n${payload.text}`,
                    timestamp: Date.now(),
                  });
                }
                break;

              case 'summary':
                // Render summary card with optional metrics
                if (payload.summary) {
                  let summaryContent = `## 📊 ${payload.summary.title || title}\n\n`;
                  summaryContent += payload.summary.content + '\n';

                  // Add metrics if available
                  if (payload.summary.metrics && payload.summary.metrics.length > 0) {
                    summaryContent += '\n### 关键指标\n\n';
                    for (const metric of payload.summary.metrics) {
                      const icon = metric.severity === 'critical' ? '🔴' :
                                   metric.severity === 'warning' ? '🟡' : '🟢';
                      const unit = metric.unit || '';
                      summaryContent += `${icon} **${metric.label}:** ${metric.value}${unit}\n`;
                    }
                  }

                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: summaryContent,
                    timestamp: Date.now(),
                  });
                }
                break;

              case 'metric':
                // Render as metric card (similar to summary but more compact)
                if (payload.summary && payload.summary.metrics) {
                  let metricContent = `### 📈 ${title}\n\n`;
                  for (const metric of payload.summary.metrics) {
                    const icon = metric.severity === 'critical' ? '🔴' :
                                 metric.severity === 'warning' ? '🟡' : '🟢';
                    const unit = metric.unit || '';
                    metricContent += `| ${icon} ${metric.label} | **${metric.value}${unit}** |\n`;
                  }
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: metricContent,
                    timestamp: Date.now(),
                  });
                }
                break;

              case 'chart':
                // Chart format - placeholder for now, show chart config info
                if (payload.chart) {
                  const chartConfig = payload.chart;
                  let chartContent = `### 📉 ${title}\n\n`;
                  chartContent += `**图表类型:** ${chartConfig.type}\n\n`;
                  chartContent += `*[图表渲染暂未实现，数据已记录]*\n`;
                  // TODO: Integrate with chart visualization library
                  console.log('[AIPanel] Chart data received:', chartConfig);
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: chartContent,
                    timestamp: Date.now(),
                  });
                }
                break;

              case 'timeline':
                // Timeline format - placeholder for now
                let timelineContent = `### ⏱️ ${title}\n\n`;
                timelineContent += `*[时间线渲染暂未实现]*\n`;
                // TODO: Integrate with Perfetto timeline visualization
                this.addMessage({
                  id: this.generateId(),
                  role: 'assistant',
                  content: timelineContent,
                  timestamp: Date.now(),
                });
                break;

              case 'table':
              default:
                // Default: render as table using existing SqlQueryResult logic
                const rawResult = envelopeToSqlQueryResult(envelope);

                // Filter hidden columns from column definitions (v2.0)
                // This mirrors the logic in skill_layered_result handling
                let filteredColumns = rawResult.columns;
                let filteredRows = rawResult.rows;
                let filteredColumnDefs = rawResult.columnDefinitions;

                if (rawResult.columnDefinitions && Array.isArray(rawResult.columnDefinitions)) {
                  // Extract hidden columns and metadata fields
                  const hiddenFromDefs = rawResult.columnDefinitions
                    .filter((c: any) => c.hidden === true)
                    .map((c: any) => c.name);
                  const metadataFields = envelope.display.metadataFields || [];
                  const columnsToHide = new Set([...hiddenFromDefs, ...metadataFields]);

                  if (columnsToHide.size > 0 && rawResult.columns.length > 0) {
                    // Get indices of visible columns
                    const visibleIndices: number[] = [];
                    filteredColumns = rawResult.columns.filter((col: string, idx: number) => {
                      if (!columnsToHide.has(col)) {
                        visibleIndices.push(idx);
                        return true;
                      }
                      return false;
                    });

                    // Filter rows to only include visible column values
                    filteredRows = rawResult.rows.map((row: any[]) =>
                      visibleIndices.map(idx => row[idx])
                    );

                    // Filter column definitions to only include visible columns
                    filteredColumnDefs = rawResult.columnDefinitions.filter(
                      (def: any) => !columnsToHide.has(def.name)
                    );

                    console.log('[AIPanel] DataEnvelope column filtering applied:', {
                      original: rawResult.columns.length,
                      filtered: filteredColumns.length,
                      hidden: columnsToHide.size,
                      hiddenList: Array.from(columnsToHide),
                    });
                  }
                }

                const sqlResult = {
                  ...rawResult,
                  columns: filteredColumns,
                  rows: filteredRows,
                  rowCount: filteredRows.length,
                  columnDefinitions: filteredColumnDefs,
                };

                // Only add message if there are actual data rows (skip empty tables)
                if (sqlResult.rowCount > 0) {
                  this.addMessage({
                    id: this.generateId(),
                    role: 'assistant',
                    content: '',  // Title is in the table header
                    timestamp: Date.now(),
                    sqlResult: {
                      ...sqlResult,
                      sectionTitle: title,
                      // Pass grouping/collapse metadata from DataEnvelope
                      group: envelope.display.group,
                      collapsible: envelope.display.collapsible,
                      defaultCollapsed: envelope.display.defaultCollapsed,
                      maxVisibleRows: envelope.display.maxVisibleRows,
                    },
                  });
                }
                break;
            }
          }
          m.redraw();
        }
        break;

      case 'skill_data':
        // ⚠️ DEPRECATED: skill_data format is deprecated, use skill_layered_result instead
        // This handler provides backward compatibility but will be removed in v3.0
        console.warn('[AIPanel] ⚠️ DEPRECATED: skill_data event received. ' +
          'Backend should emit skill_layered_result instead. ' +
          'skill_data support will be removed in v3.0');

        if (data?.data) {
          console.log('[AIPanel] Converting legacy skill_data to skill_layered_result:', data.data);

          // Transform to skill_layered_result format
          const transformedData = {
            data: {
              skillId: data.data.skillId,
              skillName: data.data.skillName,
              layers: data.data.layers,
              diagnostics: data.data.diagnostics,
            },
          };

          // Delegate to skill_layered_result handler
          this.handleSSEEvent('skill_layered_result', transformedData);
        }
        break;

      case 'finding':
        // Analysis finding - skip display to reduce noise
        // The actual data is already shown in skill_data tables (L2 layer)
        // Findings are also included in the final analysis_completed answer
        console.log(`[AIPanel] Skipping finding display (data shown in tables):`, data?.data?.stage);
        break;

      case 'finding_DISABLED':
        // DISABLED: Original finding display code kept for reference
        // Analysis finding with clickable timestamps
        if (data?.data) {
          const { stage, findings } = data.data;

          if (!findings || findings.length === 0) break;

          // Build finding message with clickable timestamps
          let content = `## 🔍 发现 (${stage || '分析'})\n\n`;

          // Collect findings that have table data for separate rendering
          const findingsWithTables: any[] = [];

          for (const finding of findings) {
            const severityEmoji: Record<string, string> = {
              critical: '🔴',
              high: '🟠',
              warning: '🟡',
              medium: '🟡',
              info: '🔵',
              low: '🟢',
            };
            const emoji = severityEmoji[finding.severity] || '⚪';

            content += `### ${emoji} ${finding.title}\n`;

            // Check if this finding has structured table data
            if (finding.details?.tableData && Array.isArray(finding.details.tableData)) {
              // Don't include the raw description, we'll show a table instead
              content += `_(详见下方表格)_\n\n`;
              findingsWithTables.push({
                title: finding.details.tableTitle || finding.title,
                data: finding.details.tableData,
                emoji,
              });
            } else {
              content += `${finding.description}\n\n`;
            }

            // Add clickable timestamps
            if (finding.timestampsNs && finding.timestampsNs.length > 0) {
              content += `**时间点** (点击跳转):\n`;
              finding.timestampsNs.slice(0, 5).forEach((ts: number) => {
                const label = this.formatTimestampForDisplay(ts);
                content += `- @ts[${ts}|${label}]\n`;
              });
              if (finding.timestampsNs.length > 5) {
                content += `- _...还有 ${finding.timestampsNs.length - 5} 个时间点_\n`;
              }
              content += '\n';
            }

            // Add recommendations
            if (finding.recommendations && finding.recommendations.length > 0) {
              content += `**优化建议**:\n`;
              finding.recommendations.forEach((rec: any) => {
                content += `- ${rec.text || rec}\n`;
              });
              content += '\n';
            }
          }

          // First add the text message
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content,
            timestamp: Date.now(),
          });

          // Then add table messages for findings with structured data
          for (const tableInfo of findingsWithTables) {
            const firstRow = tableInfo.data[0];
            if (firstRow && typeof firstRow === 'object') {
              const columns = Object.keys(firstRow).filter(k => !k.startsWith('_'));
              const rows = tableInfo.data.map((item: any) =>
                columns.map(col => this.formatDisplayValue(item[col], col))
              );

              this.addMessage({
                id: this.generateId(),
                role: 'assistant',
                content: '',
                timestamp: Date.now(),
                sqlResult: {
                  columns,
                  rows,
                  rowCount: rows.length,
                  sectionTitle: `${tableInfo.emoji} ${tableInfo.title}`,
                },
              });
            }
          }
        }
        break;

      // =========================================================================
      // Agent-Driven Architecture Events (Phase 5)
      // =========================================================================

      case 'hypothesis_generated':
        // Initial hypotheses created by AI
        if (data?.data?.hypotheses && Array.isArray(data.data.hypotheses)) {
          const hypotheses = data.data.hypotheses;
          // Remove previous progress message
          const lastMsgHypo = this.state.messages[this.state.messages.length - 1];
          if (lastMsgHypo && lastMsgHypo.role === 'assistant' && lastMsgHypo.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          // Fix: 减少不必要的换行，避免产生大量 <br> 导致空白过大
          let content = `### 🧪 生成了 ${hypotheses.length} 个分析假设\n`;
          for (let i = 0; i < hypotheses.length; i++) {
            const h = hypotheses[i];
            content += `${i + 1}. ${h}\n`;
          }
          content += '\n_AI 将验证这些假设..._';

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content,
            timestamp: Date.now(),
          });
        }
        break;

      case 'round_start':
        // Analysis round started
        if (data?.data) {
          const round = data.data.round || 1;
          const maxRounds = data.data.maxRounds || 5;
          const message = data.data.message || `分析轮次 ${round}`;

          // Remove previous progress message
          const lastMsgRound = this.state.messages[this.state.messages.length - 1];
          if (lastMsgRound && lastMsgRound.role === 'assistant' && lastMsgRound.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `⏳ 🔄 ${message} (${round}/${maxRounds})`,
            timestamp: Date.now(),
          });
        }
        break;

      case 'agent_task_dispatched':
        // Tasks sent to domain agents
        if (data?.data) {
          const taskCount = data.data.taskCount || 0;
          const agents = data.data.agents || [];
          const message = data.data.message || `派发 ${taskCount} 个任务`;

          // Remove previous progress message
          const lastMsgTask = this.state.messages[this.state.messages.length - 1];
          if (lastMsgTask && lastMsgTask.role === 'assistant' && lastMsgTask.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          let content = `⏳ 🤖 ${message}`;
          if (agents.length > 0) {
            content += `\n\n派发给: ${agents.map((a: string) => `\`${a}\``).join(', ')}`;
          }

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content,
            timestamp: Date.now(),
          });
        }
        break;

      case 'agent_dialogue':
        // Agent communication event (task dispatch or inter-agent query)
        // These are tracked internally but not always shown to reduce noise
        console.log('[AIPanel] Agent dialogue event:', data?.data);
        break;

      case 'agent_response':
        // Agent completed task
        if (data?.data) {
          const agentId = data.data.agentId || 'unknown';
          console.log(`[AIPanel] Agent ${agentId} completed task`);
          // Don't add message for every agent response - wait for synthesis
        }
        break;

      case 'synthesis_complete':
        // Feedback synthesis complete
        if (data?.data) {
          const confirmedFindings = data.data.confirmedFindings || 0;
          const updatedHypotheses = data.data.updatedHypotheses || 0;
          const message = data.data.message || '综合分析结果';

          // Remove previous progress message
          const lastMsgSynth = this.state.messages[this.state.messages.length - 1];
          if (lastMsgSynth && lastMsgSynth.role === 'assistant' && lastMsgSynth.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `⏳ 📝 ${message}\n\n确认 ${confirmedFindings} 个发现，更新 ${updatedHypotheses} 个假设`,
            timestamp: Date.now(),
          });
        }
        break;

      case 'strategy_decision':
        // Next iteration strategy decided
        if (data?.data) {
          const strategy = data.data.strategy || 'continue';
          const confidence = data.data.confidence || 0;
          const message = data.data.message || `策略: ${strategy}`;

          // Remove previous progress message
          const lastMsgStrat = this.state.messages[this.state.messages.length - 1];
          if (lastMsgStrat && lastMsgStrat.role === 'assistant' && lastMsgStrat.content.startsWith('⏳')) {
            this.state.messages.pop();
          }

          const strategyEmoji = strategy === 'conclude' ? '✅' :
                               strategy === 'deep_dive' ? '🔍' :
                               strategy === 'pivot' ? '↩️' : '➡️';

          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `⏳ ${strategyEmoji} ${message} (置信度: ${(confidence * 100).toFixed(0)}%)`,
            timestamp: Date.now(),
          });
        }
        break;

      // =========================================================================
      // End Agent-Driven Events
      // =========================================================================

      case 'conclusion':
        // Final conclusion from analysis (first event in completion sequence)
        // Note: analysis_completed event follows with more info (reportUrl), so we skip adding message here
        // and let analysis_completed handle the final message display
        console.log('[AIPanel] CONCLUSION event received - skipping message add (waiting for analysis_completed)');
        // Don't set isLoading = false yet, wait for analysis_completed
        break;

      case 'error':
        // Fatal error occurred - stop loading and show error
        this.state.isLoading = false;
        if (data?.data?.error) {
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: `**错误:** ${data.data.error}`,
            timestamp: Date.now(),
          });
        }
        // Show collected errors summary if any
        if (this.state.collectedErrors.length > 0) {
          this.showErrorSummary();
        }
        break;

      case 'skill_error':
        // Non-fatal skill execution error - collect for summary
        // These errors don't stop the analysis, but should be shown at the end
        if (data) {
          const errorInfo = {
            skillId: data.skillId || 'unknown',
            stepId: data.data?.stepId,
            error: data.data?.error || 'Unknown error',
            timestamp: Date.now(),
          };
          console.log('[AIPanel] Skill error collected:', errorInfo);
          this.state.collectedErrors.push(errorInfo);
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

  /**
   * Show a summary of all collected errors from the analysis
   * Called after analysis_completed or error events
   */
  private showErrorSummary(): void {
    if (this.state.collectedErrors.length === 0) {
      return;
    }

    // Group errors by skillId
    const errorsBySkill = new Map<string, Array<{ stepId?: string; error: string }>>();
    for (const err of this.state.collectedErrors) {
      if (!errorsBySkill.has(err.skillId)) {
        errorsBySkill.set(err.skillId, []);
      }
      errorsBySkill.get(err.skillId)!.push({ stepId: err.stepId, error: err.error });
    }

    let summaryContent = `### ⚠️ 分析过程中遇到 ${this.state.collectedErrors.length} 个错误\n\n`;

    // Group and format errors
    for (const [skillId, errors] of errorsBySkill) {
      summaryContent += `**Skill: ${skillId}**\n`;
      for (const err of errors) {
        const stepInfo = err.stepId ? ` (step: ${err.stepId})` : '';
        summaryContent += `- ${err.error}${stepInfo}\n`;
      }
      summaryContent += '\n';
    }

    summaryContent += `\n*这些错误不影响其他分析结果的展示，但可能导致部分数据缺失。*`;

    this.addMessage({
      id: this.generateId(),
      role: 'assistant',
      content: summaryContent,
      timestamp: Date.now(),
    });

    // Clear collected errors after showing summary
    this.state.collectedErrors = [];
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
      const response = await fetch(`${this.state.settings.backendUrl}/api/agent/teaching/pipeline`, {
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
        const b64 = this.encodeBase64Unicode(mermaidCode);

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
        this.pinTracksFromInstructions(pinInstructions, activeRenderingProcesses);
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

  /**
   * Pin tracks based on pin instructions from the teaching pipeline API
   * v3 Enhancement: Uses activeRenderingProcesses to only pin RenderThreads from active processes
   * v4 Enhancement: Uses mainThreadOnly to only pin main thread tracks (checks track.chips)
   */
  private pinTracksFromInstructions(
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

    // Debug: Log available track names and active processes
    const flatTracks = workspace.flatTracks;
    if (flatTracks) {
      const trackNames = flatTracks.slice(0, 50).map(t => t.name);
      console.log('[AIPanel] Available track names (first 50):', trackNames);
      console.log('[AIPanel] Active rendering processes:', Array.from(activeProcessNames));
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
        const maxPinsForInstruction = /surfaceflinger/i.test(inst.pattern) ? 1 : undefined;
        let pinnedForInstruction = 0;

        // Use built-in pin-by-regex only when we don't need extra filtering.
        // Smart pinning and mainThreadOnly require manual iteration.
        const canUsePinByRegex = pinByRegexAvailable && !shouldSmartFilterByProcess && !inst.mainThreadOnly;

        if (canUsePinByRegex) {
          this.trace.commands.runCommand('dev.perfetto.PinTracksByRegex', inst.pattern, inst.matchBy);
          pinnedCount.count++;
          continue;
        }

        // Manual iteration (supports smart process filtering and mainThreadOnly).
        if (flatTracks) {
          for (const trackNode of flatTracks) {
            const matchValue = inst.matchBy === 'uri' ? trackNode.uri : trackNode.name;
            if (!matchValue || !regex.test(matchValue)) continue;
            if (this.shouldIgnoreAutoPinTrackName(trackNode.name || '')) {
              pinnedCount.skipped++;
              continue;
            }

            if (inst.mainThreadOnly) {
              const track = trackNode.uri ? this.trace.tracks.getTrack(trackNode.uri) : undefined;
              const chips = track?.chips;
              const hasMainThreadChip = chips?.includes('main thread') ?? false;
              if (!hasMainThreadChip) {
                pinnedCount.skipped++;
                continue;
              }
            }

            if (shouldSmartFilterByProcess) {
              const trackFullPathStr = this.trackFullPathToString(trackNode as any);
              let isActiveProcess = false;
              for (const procName of smartProcessNames) {
                if (trackFullPathStr.includes(procName)) {
                  isActiveProcess = true;
                  break;
                }
              }
              if (!isActiveProcess) {
                pinnedCount.skipped++;
                continue;
              }
            }

            if (!trackNode.isPinned) {
              trackNode.pin();
              pinnedCount.count++;
              pinnedForInstruction++;
              if (maxPinsForInstruction && pinnedForInstruction >= maxPinsForInstruction) {
                break;
              }
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
          this.state.agentSessionId = null;  // Reset Agent session for new conversation
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
    // Process clickable timestamps: @ts[timestampNs|label]
    // Convert to clickable span elements with data attributes
    let processedContent = content.replace(
      /@ts\[(\d+)\|([^\]]+)\]/g,
      '<span class="ai-clickable-timestamp" data-ts="$1" title="点击跳转到此时间点">$2</span>'
    );

    // Process Markdown tables BEFORE other formatting
    // Match table blocks: header row, separator row, and data rows
    processedContent = processedContent.replace(
      /(\|[^\n]+\|\n\|[-:| ]+\|\n(?:\|[^\n]+\|\n?)+)/g,
      (tableBlock) => {
        const lines = tableBlock.trim().split('\n');
        if (lines.length < 2) return tableBlock;

        // Parse header
        const headerCells = lines[0]
          .split('|')
          .filter((cell) => cell.trim() !== '')
          .map((cell) => `<th>${cell.trim()}</th>`)
          .join('');

        // Skip separator line (line 1), parse data rows
        const dataRows = lines
          .slice(2)
          .map((line) => {
            const cells = line
              .split('|')
              .filter((cell) => cell.trim() !== '')
              .map((cell) => `<td>${cell.trim()}</td>`)
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');

        return `<table class="ai-md-table"><thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>`;
      }
    );

    // Markdown-like formatting with extended support
    processedContent = processedContent
      .replace(/^## (.*?)$/gm, '<h2>$1</h2>')
      .replace(/^### (.*?)$/gm, '<h3>$1</h3>')
      // Image markdown: ![alt](url) - must be before link processing
      .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" class="ai-markdown-image" />')
      // Link markdown: [text](url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/^> (.*?)$/gm, '<blockquote>$1</blockquote>')
      // Unordered list items
      .replace(/^- (.*?)$/gm, '<li class="ul-item">$1</li>')
      // Ordered list items (1. 2. 3. etc.)
      .replace(/^\d+\. (.*?)$/gm, '<li class="ol-item">$1</li>')
      .replace(/\n/g, '<br>');

    // Wrap consecutive unordered <li> elements in <ul>
    processedContent = processedContent.replace(
      /(<li class="ul-item">.*?<\/li>(?:<br>)?)+/g,
      (match) => '<ul>' + match.replace(/<br>/g, '').replace(/ class="ul-item"/g, '') + '</ul>'
    );

    // Wrap consecutive ordered <li> elements in <ol>
    processedContent = processedContent.replace(
      /(<li class="ol-item">.*?<\/li>(?:<br>)?)+/g,
      (match) => '<ol>' + match.replace(/<br>/g, '').replace(/ class="ol-item"/g, '') + '</ol>'
    );

    // Fix: 合并连续的 <br> 标签，避免过多空白
    // 将 3 个或以上连续的 <br> 合并为 2 个
    processedContent = processedContent.replace(/(<br>){3,}/g, '<br><br>');

    return processedContent;
  }

  /**
   * Format timestamp for display (nanoseconds to human-readable)
   */
  private formatTimestampForDisplay(timestampNs: number): string {
    if (timestampNs >= 1_000_000_000) {
      return (timestampNs / 1_000_000_000).toFixed(3) + 's';
    }
    if (timestampNs >= 1_000_000) {
      return (timestampNs / 1_000_000).toFixed(2) + 'ms';
    }
    if (timestampNs >= 1_000) {
      return (timestampNs / 1_000).toFixed(2) + 'us';
    }
    return timestampNs + 'ns';
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
    this.state.agentSessionId = null;  // Clear Agent session for multi-turn dialogue
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
   * Parse a summary string like "key1: value1, key2: value2" into table data
   * Returns null if the string doesn't match the expected pattern
   */
  private parseSummaryToTable(summary: string): { columns: string[], rows: string[][] } | null {
    if (!summary || typeof summary !== 'string') {
      return null;
    }

    // Try to parse formats like:
    // "key1: value1, key2: value2, key3: value3"
    // "key1: value1 | key2: value2 | key3: value3"

    // First, split by common delimiters
    const parts = summary.split(/[,|]/).map(p => p.trim()).filter(p => p);

    if (parts.length < 2) {
      // Not enough key-value pairs to make a table worthwhile
      return null;
    }

    const keyValuePairs: { key: string; value: string }[] = [];

    for (const part of parts) {
      // Match "key: value" pattern
      const match = part.match(/^([^:]+):\s*(.+)$/);
      if (match) {
        keyValuePairs.push({
          key: match[1].trim(),
          value: match[2].trim(),
        });
      }
    }

    // Need at least 2 valid key-value pairs for a table
    if (keyValuePairs.length < 2) {
      return null;
    }

    // Create a single-row table with columns as keys
    const columns = keyValuePairs.map(kv => kv.key);
    const rows = [keyValuePairs.map(kv => this.formatDisplayValue(kv.value, kv.key))];

    return { columns, rows };
  }

  /**
   * Convert backend frame detail data to sections format expected by renderExpandableContent.
   *
   * Backend returns: FrameDetailData { diagnosis_summary, full_analysis: FullAnalysis }
   * Frontend expects: ExpandableSections { [sectionId]: { title, data: unknown[] } }
   *
   * @see generated/frame_analysis.types.ts for type definitions
   */
  private convertToExpandableSections(data: unknown): ExpandableSections {
    // Type guard: validate input format
    console.log('[convertToExpandableSections] Input data:', {
      type: typeof data,
      isNull: data === null,
      isUndefined: data === undefined,
      keys: data && typeof data === 'object' ? Object.keys(data) : [],
    });

    if (!isFrameDetailData(data)) {
      console.warn('[convertToExpandableSections] Invalid data format - failing isFrameDetailData check:', data);
      return {};
    }

    const sections: ExpandableSections = {};

    // Title mapping for each analysis type (matches FullAnalysis keys)
    const titleMap: Record<keyof FullAnalysis, string> = {
      'quadrants': '四象限分析',
      'binder_calls': 'Binder 调用',
      'cpu_frequency': 'CPU 频率',
      'main_thread_slices': '主线程耗时操作',
      'render_thread_slices': 'RenderThread 耗时操作',
      'cpu_freq_timeline': 'CPU 频率时间线',
      'lock_contentions': '锁竞争',
    };

    // Handle diagnosis_summary as a special section
    if (data.diagnosis_summary) {
      sections['diagnosis'] = {
        title: '🎯 根因诊断',
        data: [{ diagnosis: data.diagnosis_summary }],
      };
    }

    // Handle full_analysis object with typed access
    const analysis = data.full_analysis;
    if (analysis) {
      // Process quadrants - convert nested object to display array
      if (analysis.quadrants) {
        const quadrantData: Array<{ thread: string; quadrant: string; percentage: number }> = [];
        const { main_thread, render_thread } = analysis.quadrants;

        // Convert main_thread quadrants
        for (const [qKey, qValue] of Object.entries(main_thread)) {
          if (qValue > 0) {
            quadrantData.push({
              thread: '主线程',
              quadrant: qKey.toUpperCase(),
              percentage: qValue,
            });
          }
        }

        // Convert render_thread quadrants
        for (const [qKey, qValue] of Object.entries(render_thread)) {
          if (qValue > 0) {
            quadrantData.push({
              thread: 'RenderThread',
              quadrant: qKey.toUpperCase(),
              percentage: qValue,
            });
          }
        }

        if (quadrantData.length > 0) {
          sections['quadrants'] = { title: titleMap['quadrants'], data: quadrantData };
        }
      }

      // Process cpu_frequency - convert object to display array
      if (analysis.cpu_frequency) {
        const freqData: Array<{ core_type: string; avg_freq_mhz: number }> = [];
        const { big_avg_mhz, little_avg_mhz } = analysis.cpu_frequency;

        if (big_avg_mhz > 0) {
          freqData.push({ core_type: '大核', avg_freq_mhz: big_avg_mhz });
        }
        if (little_avg_mhz > 0) {
          freqData.push({ core_type: '小核', avg_freq_mhz: little_avg_mhz });
        }

        if (freqData.length > 0) {
          sections['cpu_frequency'] = { title: titleMap['cpu_frequency'], data: freqData };
        }
      }

      // Process array fields directly
      const arrayFields: Array<keyof FullAnalysis> = [
        'binder_calls',
        'main_thread_slices',
        'render_thread_slices',
        'cpu_freq_timeline',
        'lock_contentions',
      ];

      for (const field of arrayFields) {
        const value = analysis[field];
        if (Array.isArray(value) && value.length > 0) {
          sections[field] = { title: titleMap[field], data: value };
        }
      }
    }

    return sections;
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
