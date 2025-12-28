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
import {Engine} from '../../trace_processor/engine';
import {Trace} from '../../public/trace';

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
}

export interface SqlQueryResult {
  columns: string[];
  rows: any[][];
  rowCount: number;
  query?: string;
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
  isUploading: boolean;
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

// Theme colors
const THEME = {
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryLight: 'rgba(99, 102, 241, 0.1)',
  success: '#10b981',
  warning: '#f59e0b',
  error: '#ef4444',
  surface: '#1e1e2e',
  surfaceLight: '#2a2a3e',
  border: '#3a3a4e',
  text: '#e0e0e0',
  textSecondary: '#a0a0b0',
  textMuted: '#707080',
};

// Animation keyframes
const ANIMATIONS = {
  fadeIn: 'ai-fade-in 0.2s ease-out',
  slideIn: 'ai-slide-in 0.3s ease-out',
  slideUp: 'ai-slide-up 0.3s ease-out',
  pulse: 'ai-pulse 2s infinite',
};

// Inline styles - completely redesigned
const STYLES = {
  panel: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    overflow: 'hidden' as const,
    backgroundColor: 'var(--background)',
    color: 'var(--text)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, sans-serif',
  },

  // Header - compact
  header: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '8px 12px',
    minHeight: '36px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--background2)',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '8px',
  },
  headerIcon: {
    fontSize: '16px',
  },
  titleText: {
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--text)',
    margin: '0',
  },
  statusDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: THEME.success,
    display: 'inline-block',
  },
  statusText: {
    fontSize: '11px',
    color: 'var(--text-secondary)',
  },
  headerRight: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '2px',
  },
  iconBtn: {
    width: '28px',
    height: '28px',
    borderRadius: '6px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: '14px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    transition: 'all 0.15s ease',
  },

  // Messages area
  messages: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },

  // Message containers
  messageUser: {
    alignSelf: 'flex-end' as const,
    display: 'flex',
    gap: '12px',
    flexDirection: 'row-reverse' as const,
    maxWidth: '75%',
    animation: ANIMATIONS.slideIn,
  },
  messageAssistant: {
    alignSelf: 'flex-start' as const,
    display: 'flex',
    gap: '12px',
    maxWidth: '85%',
    animation: ANIMATIONS.slideIn,
  },

  // Avatar
  avatar: {
    width: '28px',
    height: '28px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    fontSize: '14px',
    flexShrink: 0,
  },
  avatarUser: {
    background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
  },
  avatarAssistant: {
    background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
  },

  // Message content
  messageContentUser: {
    padding: '10px 14px',
    background: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
    color: '#ffffff',
    borderRadius: '14px 14px 4px 14px',
    wordWrap: 'break-word' as const,
    fontSize: '13px',
    lineHeight: '1.4',
  },
  messageContentAssistant: {
    padding: '10px 14px',
    backgroundColor: 'var(--background2)',
    border: '1px solid var(--border)',
    borderRadius: '14px 14px 14px 4px',
    wordWrap: 'break-word' as const,
    fontSize: '13px',
    lineHeight: '1.4',
  },

  // Message meta
  messageMeta: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '8px',
    marginTop: '8px',
    paddingTop: '8px',
    borderTop: '1px solid rgba(255, 255, 255, 0.1)',
  },
  messageMetaText: {
    fontSize: '12px',
    color: 'var(--text-secondary)',
  },
  messageActionBtn: {
    padding: '4px 10px',
    borderRadius: '6px',
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center' as const,
    gap: '4px',
    transition: 'all 0.2s ease',
  },

  // Typing indicator
  loading: {
    display: 'flex',
    gap: '6px',
    padding: '12px 16px',
  },
  typing: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: 'var(--primary)',
    animation: 'ai-typing 1.4s infinite ease-in-out',
    boxShadow: '0 0 8px rgba(99, 102, 241, 0.5)',
  },

  // Input area
  inputArea: {
    padding: '10px 12px',
    borderTop: '1px solid var(--border)',
    background: 'var(--background2)',
  },
  inputWrapper: {
    display: 'flex',
    gap: '8px',
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    minHeight: '38px',
    maxHeight: '100px',
    padding: '10px 14px',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    backgroundColor: 'var(--background)',
    color: 'var(--text)',
    fontFamily: 'inherit',
    fontSize: '13px',
    lineHeight: '1.4',
    resize: 'none' as const,
    transition: 'all 0.15s ease',
  },
  inputFocus: {
    borderColor: 'var(--primary)',
  },
  sendBtn: {
    width: '38px',
    height: '38px',
    borderRadius: '14px',
    border: 'none',
    backgroundColor: 'linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%)',
    color: '#ffffff',
    fontSize: '18px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    transition: 'all 0.2s ease',
    boxShadow: '0 4px 14px rgba(99, 102, 241, 0.3)',
  },
  sendBtnDisabled: {
    opacity: '0.5',
    cursor: 'not-allowed',
  },

  // Warning
  warning: {
    padding: '12px 16px',
    background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.15) 0%, rgba(239, 68, 68, 0.1) 100%)',
    border: '1px solid rgba(245, 158, 11, 0.3)',
    borderRadius: '10px',
    fontSize: '13px',
    color: THEME.warning,
    display: 'flex',
    alignItems: 'center' as const,
    gap: '8px',
  },

  // SQL result card
  sqlResultCard: {
    marginTop: '16px',
    borderRadius: '12px',
    border: '1px solid var(--border)',
    overflow: 'hidden',
    background: 'var(--background2)',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.08)',
  },
  sqlResultHeader: {
    display: 'flex',
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '14px 18px',
    background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(139, 92, 246, 0.04) 100%)',
    borderBottom: '1px solid var(--border)',
  },
  sqlResultTitle: {
    display: 'flex',
    alignItems: 'center' as const,
    gap: '8px',
    fontSize: '13px',
    fontWeight: '600',
    color: 'var(--text)',
  },
  sqlResultActions: {
    display: 'flex',
    gap: '6px',
  },
  sqlResultActionBtn: {
    padding: '6px 12px',
    borderRadius: '6px',
    background: 'transparent',
    border: '1px solid var(--border)',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center' as const,
    gap: '4px',
    transition: 'all 0.2s ease',
  },
  sqlResultQuery: {
    padding: '12px 18px',
    background: 'rgba(0, 0, 0, 0.2)',
    borderBottom: '1px solid var(--border)',
    fontFamily: 'monospace',
    fontSize: '12px',
    color: '#a5b4fc',
    overflowX: 'auto' as const,
    whiteSpace: 'pre-wrap' as const,
  },
};

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
    isUploading: false,
  };

  private onClearChat?: () => void;
  private onOpenSettings?: () => void;
  private messagesContainer: HTMLElement | null = null;
  private lastMessageCount = 0;

  oncreate(vnode: m.VnodeDOM<AIPanelAttrs>) {
    this.engine = vnode.attrs.engine;
    this.trace = vnode.attrs.trace;

    // Load settings from localStorage
    this.loadSettings();

    // Load chat history from localStorage
    this.loadHistory();

    // Load pinned results from localStorage
    this.loadPinnedResults();

    // Initialize AI service
    this.initAIService();

    // Listen for custom events
    this.onClearChat = () => this.clearChat();
    this.onOpenSettings = () => this.openSettings();
    window.addEventListener('ai-assistant:clear-chat', this.onClearChat);
    window.addEventListener('ai-assistant:open-settings', this.onOpenSettings);

    // Add welcome message if no history
    if (this.state.messages.length === 0) {
      this.addMessage({
        id: this.generateId(),
        role: 'assistant',
        content: this.getWelcomeMessage(),
        timestamp: Date.now(),
      });
    }

    // Focus input
    setTimeout(() => {
      const textarea = document.getElementById('ai-input') as HTMLTextAreaElement;
      if (textarea) textarea.focus();
    }, 100);

    // Add animation keyframes
    if (!document.getElementById('ai-animations')) {
      const style = document.createElement('style');
      style.id = 'ai-animations';
      style.textContent = `
        @keyframes ai-typing {
          0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
          40% { transform: scale(1); opacity: 1; }
        }
      `;
      document.head.appendChild(style);
    }
  }

  onremove() {
    if (this.onClearChat) {
      window.removeEventListener('ai-assistant:clear-chat', this.onClearChat);
    }
    if (this.onOpenSettings) {
      window.removeEventListener('ai-assistant:open-settings', this.onOpenSettings);
    }
  }

  view() {
    const providerLabel = this.state.settings.provider.charAt(0).toUpperCase() + this.state.settings.provider.slice(1);
    const isConnected = this.state.aiService !== null;

    return m(
      'div',
      {style: STYLES.panel},
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
        m('div', {style: STYLES.header}, [
          m('div', {style: STYLES.headerLeft}, [
            m('span', {style: STYLES.headerIcon}, '🤖'),
            m('span', {style: STYLES.titleText}, 'AI'),
            m('span', {style: {...STYLES.statusDot, background: isConnected ? THEME.success : THEME.warning}}),
            m('span', {style: STYLES.statusText}, providerLabel),
            // Backend trace status
            this.state.backendTraceId
              ? m('span', {
                  style: {...STYLES.statusDot, background: THEME.success, marginLeft: '8px'},
                  title: `Trace uploaded to backend: ${this.state.backendTraceId}`,
                }, '●')
              : null,
            this.state.backendTraceId
              ? m('span', {style: {...STYLES.statusText, fontSize: '10px', color: THEME.success}}, 'Backend')
              : null,
          ]),
          m('div', {style: STYLES.headerRight}, [
            // Upload to backend button
            m('button', {
              style: {
                ...STYLES.iconBtn,
                opacity: this.state.isUploading ? 0.5 : 1,
                cursor: this.state.isUploading ? 'wait' : 'pointer',
              },
              onclick: () => this.uploadTraceToBackend(),
              title: this.state.backendTraceId
                ? 'Trace uploaded to backend ✓'
                : 'Upload trace to backend for AI analysis',
              disabled: this.state.isUploading,
            }, this.state.isUploading ? '⏳' : (this.state.backendTraceId ? '☁️' : '📤')),
            m('button', {
              style: STYLES.iconBtn,
              onclick: () => this.clearChat(),
              title: 'New Chat',
            }, '✕'),
            m('button', {
              style: STYLES.iconBtn,
              onclick: () => this.openSettings(),
              title: 'Settings',
            }, '⚙'),
          ]),
        ]),

        // Messages with auto-scroll
        m('div', {
          style: STYLES.messages,
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
            m('div', {
              style: msg.role === 'user' ? STYLES.messageUser : STYLES.messageAssistant,
            }, [
              // Avatar
              m('div', {
                style: {...STYLES.avatar, ...(msg.role === 'user' ? STYLES.avatarUser : STYLES.avatarAssistant)},
              }, msg.role === 'user' ? '👤' : '🤖'),

              // Message Content
              m('div', {
                style: msg.role === 'user' ? STYLES.messageContentUser : STYLES.messageContentAssistant,
              }, [
                m('div', {style: {lineHeight: '1.6'}}, m.trust(this.formatMessage(msg.content))),

                // SQL Result
                (() => {
                  const sqlResult = msg.sqlResult;
                  if (!sqlResult) return null;
                  const query = sqlResult.query || msg.query || '';
                  return m('div', {style: STYLES.sqlResultCard}, [
                    m('div', {style: STYLES.sqlResultHeader}, [
                      m('div', {style: STYLES.sqlResultTitle}, [
                        m('span', '📊'),
                        m('span', `${sqlResult.rowCount.toLocaleString()} rows`),
                      ]),
                      m('div', {style: STYLES.sqlResultActions}, [
                        m('button', {
                          style: STYLES.sqlResultActionBtn,
                          onclick: () => this.copyToClipboard(query),
                        }, '📋 Copy'),
                        query
                          ? m('button', {
                              style: STYLES.sqlResultActionBtn,
                              onclick: () => this.handlePin({
                                query,
                                columns: sqlResult.columns,
                                rows: sqlResult.rows.slice(0, 100),
                                timestamp: Date.now(),
                              }),
                            }, '📌 Pin')
                          : null,
                      ]),
                    ]),
                    query
                      ? m('div', {style: STYLES.sqlResultQuery}, query.trim())
                      : null,
                    m(SqlResultTable, {
                      columns: sqlResult.columns,
                      rows: sqlResult.rows,
                      rowCount: sqlResult.rowCount,
                      query,
                      onPin: (data) => this.handlePin(data),
                      onExport: (format) => this.exportResult(sqlResult, format),
                    }),
                  ]);
                })(),
              ]),
            ])
          ),

          // Loading Indicator
          this.state.isLoading
            ? m('div', {style: STYLES.messageAssistant}, [
                m('div', {style: {...STYLES.avatar, ...STYLES.avatarAssistant}}, '🤖'),
                m('div', {style: {...STYLES.messageContentAssistant, padding: '16px 20px'}}, [
                  m('div', {style: STYLES.loading}, [
                    m('span', {style: STYLES.typing}),
                    m('span', {style: {...STYLES.typing, animationDelay: '0.16s'}}),
                    m('span', {style: {...STYLES.typing, animationDelay: '0.32s'}}),
                  ]),
                ]),
              ])
            : null,
        ),

        // Input Area
        m('div', {style: STYLES.inputArea}, [
          m('div', {style: STYLES.inputWrapper}, [
            m('textarea#ai-input', {
              style: {...STYLES.input, ...(this.state.isLoading || !this.state.aiService ? {opacity: 0.6} : {})},
              placeholder: 'Ask anything about your trace... (Shift+Enter for new line)',
              value: this.state.input,
              oninput: (e: Event) => {
                this.state.input = (e.target as HTMLTextAreaElement).value;
                this.state.historyIndex = -1;
              },
              onkeydown: (e: KeyboardEvent) => this.handleKeyDown(e),
              disabled: this.state.isLoading || !this.state.aiService,
            }),
            m('button', {
              style: {...STYLES.sendBtn, ...(this.state.isLoading || !this.state.aiService ? STYLES.sendBtnDisabled : {})},
              onclick: () => this.sendMessage(),
              disabled: this.state.isLoading || !this.state.aiService,
            }, this.state.isLoading ? '⋯' : '➤'),
          ]),
          !this.state.aiService
            ? m('div', {style: STYLES.warning}, [
                m('span', '⚠️'),
                m('span', 'AI service not configured. Click ⚙️ to set up.'),
              ])
            : null,
        ]),
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

  private loadHistory() {
    try {
      const stored = localStorage.getItem(HISTORY_KEY);
      if (stored) {
        this.state.messages = JSON.parse(stored);
        // Restore command history
        this.state.commandHistory = this.state.messages
          .filter((m) => m.role === 'user')
          .map((m) => m.content);
      }
    } catch {
      // Ignore errors
    }
  }

  private saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.state.messages));
    } catch {
      // Ignore errors
    }
  }

  private loadPinnedResults() {
    try {
      const stored = localStorage.getItem('smartperfetto-pinned-results');
      if (stored) {
        this.state.pinnedResults = JSON.parse(stored);
      }
    } catch {
      // Ignore errors
    }
  }

  private savePinnedResults() {
    try {
      localStorage.setItem('smartperfetto-pinned-results', JSON.stringify(this.state.pinnedResults));
    } catch {
      // Ignore errors
    }
  }

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
    } else if (provider === 'deepseek') {
      // Use backend proxy to avoid CORS issues
      this.state.aiService = new BackendProxyService(backendUrl, deepseekModel);
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

      case 'analysis_completed':
        // Analysis is complete - show final answer
        this.state.isLoading = false;
        if (data?.data?.answer) {
          // Remove any remaining progress message
          const lastMsg = this.state.messages[this.state.messages.length - 1];
          if (lastMsg && lastMsg.role === 'assistant' && lastMsg.content.startsWith('⏳')) {
            this.state.messages.pop();
          }
          this.addMessage({
            id: this.generateId(),
            role: 'assistant',
            content: data.data.answer,
            timestamp: Date.now(),
          });
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

  private formatMessage(content: string): string {
    // Simple markdown-like formatting
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/\n/g, '<br>');
  }

  private clearChat() {
    this.state.messages = [];
    this.state.commandHistory = [];
    this.state.historyIndex = -1;
    this.saveHistory();
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

  /**
   * Upload the current trace to the backend for AI analysis
   * This enables the backend to execute SQL queries on the trace
   */
  private async uploadTraceToBackend(): Promise<void> {
    if (this.state.backendTraceId) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `✅ Trace already uploaded to backend (${this.state.backendTraceId}). AI can now analyze the trace with full SQL capabilities.`,
        timestamp: Date.now(),
      });
      return;
    }

    if (this.state.isUploading) return;

    this.state.isUploading = true;
    m.redraw();

    try {
      // Get the current trace file directly from Perfetto UI
      if (!this.trace) {
        throw new Error('No trace loaded. Please open a trace file first.');
      }

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `⏳ Getting current trace file...`,
        timestamp: Date.now(),
      });

      const traceBlob = await this.trace.getTraceFile();
      const traceFile = new File([traceBlob], `trace_${Date.now()}.pftrace`, { type: 'application/octet-stream' });

      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `⏳ Uploading trace to backend (${(traceFile.size / 1024 / 1024).toFixed(2)} MB)...`,
        timestamp: Date.now(),
      });

      const formData = new FormData();
      formData.append('file', traceFile);

      const response = await fetch(`${this.state.settings.backendUrl}/api/traces/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Upload failed: ${response.statusText}`);
      }

      const data = await response.json();
      if (data.success && data.trace?.id) {
        this.state.backendTraceId = data.trace.id;
        this.addMessage({
          id: this.generateId(),
          role: 'system',
          content: `✅ **Trace uploaded to backend successfully!**\n\nSize: ${(traceFile.size / 1024 / 1024).toFixed(2)} MB\nBackend ID: ${data.trace.id}\n\nYou can now ask AI questions about this trace. The backend will execute SQL queries and provide detailed analysis.`,
          timestamp: Date.now(),
        });
      } else {
        throw new Error(data.error || 'Upload failed');
      }
    } catch (error: any) {
      this.addMessage({
        id: this.generateId(),
        role: 'system',
        content: `❌ **Failed to upload trace:** ${error.message}\n\nMake sure the backend is running at ${this.state.settings.backendUrl}`,
        timestamp: Date.now(),
      });
    } finally {
      this.state.isUploading = false;
      m.redraw();
    }
  }

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

  private scrollToBottom(): void {
    if (this.messagesContainer) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }
}
