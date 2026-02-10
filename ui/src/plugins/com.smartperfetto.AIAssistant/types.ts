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

/**
 * Shared type definitions for the AI Assistant plugin.
 *
 * This module centralizes all interface definitions to prevent circular
 * dependencies between the various AI panel modules.
 */

import {NavigationBookmark} from './navigation_bookmark_bar';
import {DetectedScene} from './scene_navigation_bar';

/**
 * A chat message in the AI conversation.
 */
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  sqlResult?: SqlQueryResult;
  query?: string;
  reportUrl?: string;  // HTML report link
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

/**
 * SQL query result data structure.
 */
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
  // Column definitions for schema-driven rendering (v2.0)
  columnDefinitions?: Array<{
    name: string;
    type?: string;
    format?: string;
    clickAction?: string;
    durationColumn?: string;
    unit?: 'ns' | 'us' | 'ms' | 's';
    hidden?: boolean;
  }>;
  // Expandable row data (for iterator type results)
  expandableData?: Array<{
    item: Record<string, any>;
    result: {
      success: boolean;
      sections?: Record<string, any>;
      error?: string;
    };
  }>;
  // Summary report (legacy format)
  summary?: {
    title: string;
    content: string;
  };
  // Summary report (v2.0 DataPayload format - from SummaryContent)
  summaryReport?: {
    title: string;
    content: string;
    keyMetrics?: Array<{
      name: string;
      value: string;
      status?: 'good' | 'warning' | 'critical';
    }>;
  };
  // Metadata: fixed values extracted from the list (e.g., layer_name, process_name)
  // These values are the same across all rows, displayed in the header area
  metadata?: Record<string, any>;
}

/**
 * AI panel internal state.
 */
export interface AIPanelState {
  messages: Message[];
  input: string;
  isLoading: boolean;
  showSettings: boolean;
  aiService: any | null;  // AIService type from ai_service.ts
  settings: AISettings;
  commandHistory: string[];
  historyIndex: number;
  lastQuery: string;
  pinnedResults: PinnedResult[];
  backendTraceId: string | null;
  bookmarks: NavigationBookmark[];  // Navigation bookmarks
  currentTraceFingerprint: string | null;  // Current Trace fingerprint
  currentSessionId: string | null;  // Current Session ID
  isRetryingBackend: boolean;  // Retrying backend connection
  retryError: string | null;  // Retry connection error message
  agentSessionId: string | null;  // Agent multi-turn dialogue Session ID
  displayedSkillProgress: Set<string>;  // Displayed skill progress (skillId:step) for deduplication
  completionHandled: boolean;  // Whether analysis completion event was handled
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
  // Scene Navigation Bar state
  detectedScenes: DetectedScene[];  // Detected scenes from quick detection
  scenesLoading: boolean;  // Loading state for scene detection
  scenesError: string | null;  // Error message from scene detection
  // Intervention state (Agent-Driven Architecture v2.0)
  interventionState: InterventionState;
}

/**
 * A pinned SQL query result.
 */
export interface PinnedResult {
  id: string;
  query: string;
  columns: string[];
  rows: any[][];
  timestamp: number;
}

/**
 * AI service provider settings.
 */
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

/**
 * Session data structure for multi-turn conversations.
 */
export interface AISession {
  sessionId: string;
  traceFingerprint: string;
  traceName: string;              // Display name (e.g., filename)
  backendTraceId?: string;        // Backend session ID
  agentSessionId?: string;        // Backend Agent multi-turn session ID
  createdAt: number;
  lastActiveAt: number;
  messages: Message[];
  summary?: string;               // AI-generated conversation summary
  pinnedResults?: PinnedResult[]; // Pinned query results
  bookmarks?: NavigationBookmark[]; // Navigation bookmarks
}

/**
 * Sessions storage structure indexed by trace fingerprint.
 */
export interface SessionsStorage {
  byTrace: Record<string, AISession[]>;
}

/**
 * Default settings for AI service configuration.
 */
export const DEFAULT_SETTINGS: AISettings = {
  provider: 'deepseek',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.4',
  openaiUrl: 'https://api.openai.com/v1',
  openaiModel: 'gpt-4o',
  openaiApiKey: '',
  deepseekModel: 'deepseek-chat',
  deepseekApiKey: '',
  backendUrl: 'http://localhost:3000',
};

// Storage keys for localStorage
export const SETTINGS_KEY = 'smartperfetto-ai-settings';
export const HISTORY_KEY = 'smartperfetto-ai-history';
export const SESSIONS_KEY = 'smartperfetto-ai-sessions';
export const PENDING_BACKEND_TRACE_KEY = 'smartperfetto-pending-backend-trace';

/**
 * Preset questions for quick analysis buttons.
 */
export interface PresetQuestion {
  label: string;
  question: string;
  icon: string;
  isTeaching?: boolean;
  isScene?: boolean;
}

export const PRESET_QUESTIONS: PresetQuestion[] = [
  // Teaching mode - helps users understand rendering pipelines
  {label: '🎓 出图教学', question: '/teaching-pipeline', icon: 'school', isTeaching: true},
  // Scene reconstruction - understand what happened in the trace
  {label: '🎬 场景还原', question: '/scene', icon: 'movie', isScene: true},
  // Analysis mode - actual performance analysis
  {label: '滑动', question: '分析滑动性能', icon: 'swipe'},
  {label: '启动', question: '分析启动性能', icon: 'rocket_launch'},
  {label: '跳转', question: '分析跳转性能', icon: 'open_in_new'},
];

// =============================================================================
// Agent-Driven Architecture v2.0 - Intervention Types
// =============================================================================

/**
 * Types of intervention triggers from the backend.
 */
export type InterventionType =
  | 'low_confidence'
  | 'ambiguity'
  | 'timeout'
  | 'agent_request'
  | 'circuit_breaker'
  | 'validation_required';

/**
 * User actions for intervention responses.
 */
export type InterventionAction =
  | 'continue'
  | 'focus'
  | 'abort'
  | 'custom'
  | 'select_option';

/**
 * An option presented to the user during intervention.
 */
export interface InterventionOption {
  id: string;
  label: string;
  description: string;
  action: InterventionAction;
  recommended?: boolean;
}

/**
 * Context provided with an intervention request.
 */
export interface InterventionContext {
  confidence: number;
  elapsedTimeMs: number;
  roundsCompleted: number;
  progressSummary: string;
  triggerReason: string;
  findingsCount: number;
}

/**
 * An intervention point requiring user input.
 */
export interface InterventionPoint {
  interventionId: string;
  type: InterventionType;
  options: InterventionOption[];
  context: InterventionContext;
  timeout: number;
}

/**
 * State for intervention panel.
 */
export interface InterventionState {
  /** Whether an intervention is currently active */
  isActive: boolean;
  /** Current intervention data */
  intervention: InterventionPoint | null;
  /** Selected option ID (before confirmation) */
  selectedOptionId: string | null;
  /** Custom input text (for 'custom' action) */
  customInput: string;
  /** Whether a response is being sent */
  isSending: boolean;
  /** Timeout remaining (ms) */
  timeoutRemaining: number | null;
}
