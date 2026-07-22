// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  buildSmartPerfettoContextHeaders,
  buildSmartPerfettoWorkspaceApiUrl,
} from '../../core/smartperfetto_request_context';
import {uiText} from './ui_language';

export type ProviderType =
  | 'anthropic'
  | 'bedrock'
  | 'vertex'
  | 'deepseek'
  | 'glm'
  | 'qwen'
  | 'qwen_coding'
  | 'kimi_code'
  | 'kimi'
  | 'doubao'
  | 'minimax'
  | 'xiaomi'
  | 'tencent_token_plan'
  | 'tencent_coding_plan'
  | 'hunyuan'
  | 'qianfan'
  | 'stepfun'
  | 'siliconflow'
  | 'huawei'
  | 'openai'
  | 'ollama'
  | 'custom';
export type ProviderCategory = 'official' | 'proxy' | 'local' | 'custom';
export type AgentRuntimeKind =
  | 'claude-agent-sdk'
  | 'openai-agents-sdk'
  | 'pi-agent-core'
  | 'opencode'
  | 'qoder-agent-sdk';
export type ServerRuntimeKind =
  | AgentRuntimeKind
  | 'experimental-pi-agent-core'
  | 'experimental-opencode';
export type OpenAIProtocol = 'responses' | 'chat_completions';

export type HealthStatus = 'passed' | 'failed' | 'untested';

export interface ProviderModels {
  primary: string;
  light: string;
  subAgent?: string;
}

export interface ProviderConnection {
  apiKey?: string;
  baseUrl?: string;
  claudeBaseUrl?: string;
  claudeApiKey?: string;
  claudeAuthToken?: string;
  openaiBaseUrl?: string;
  openaiApiKey?: string;
  piAgentCoreModulePath?: string;
  piAgentCoreModelJson?: string;
  piAgentCoreSystemPrompt?: string;
  openCodeSdkModulePath?: string;
  openCodeModelJson?: string;
  openCodeSystemPrompt?: string;
  qoderAccessToken?: string;
  qoderCliPath?: string;
  qoderModel?: string;
  qoderSystemPrompt?: string;
  agentRuntime?: AgentRuntimeKind;
  openaiProtocol?: OpenAIProtocol;
  awsRegion?: string;
  awsBearerToken?: string;
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  awsSessionToken?: string;
  awsProfile?: string;
  gcpProjectId?: string;
  gcpRegion?: string;
  useBedrock?: boolean;
}

export interface ProviderTuning {
  maxTurns?: number;
  effort?: string;
  maxBudgetUsd?: number;
  fullPerTurnMs?: number;
  quickPerTurnMs?: number;
  verifierTimeoutMs?: number;
  classifierTimeoutMs?: number;
  enableSubAgents?: boolean;
  enableVerification?: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  category: ProviderCategory;
  type: ProviderType;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning?: ProviderTuning;
  custom?: {envOverrides?: Record<string, string>};
}

export interface ProviderTemplate {
  type: ProviderType;
  displayName: string;
  requiredFields: string[];
  defaultModels: ProviderModels;
  availableModels: Array<{id: string; name: string; tier: string}>;
  defaultConnection?: Partial<ProviderConnection>;
}

export interface ProviderPanelAttrs {
  backendUrl: string;
  apiKey?: string;
  aiEnabled?: boolean;
  aiDisabledReason?: string;
  onClose?: () => void;
  onProviderSelectionChange?: () => void;
}

export interface ProviderQuickSwitcherAttrs {
  backendUrl: string;
  apiKey?: string;
  compact?: boolean;
  disabled?: boolean;
  onActivate?: () => void;
}

export const TYPE_ICONS: Record<ProviderType, string> = {
  anthropic: '\u{1F916}',
  bedrock: '☁️',
  vertex: '\u{1F537}',
  deepseek: '\u{1F40B}',
  glm: '智',
  qwen: '通',
  qwen_coding: '码',
  kimi_code: 'K',
  kimi: '月',
  doubao: '豆',
  minimax: 'M',
  xiaomi: '米',
  tencent_token_plan: '腾',
  tencent_coding_plan: '编',
  hunyuan: '混',
  qianfan: '千',
  stepfun: '阶',
  siliconflow: '硅',
  huawei: '华',
  openai: '⚡',
  ollama: '\u{1F999}',
  custom: '\u{1F527}',
};

const DUAL_SURFACE_PROVIDER_TYPES: ProviderType[] = [
  'deepseek',
  'glm',
  'qwen',
  'qwen_coding',
  'kimi_code',
  'kimi',
  'doubao',
  'minimax',
  'xiaomi',
  'tencent_token_plan',
  'tencent_coding_plan',
  'hunyuan',
  'qianfan',
  'stepfun',
  'siliconflow',
  'huawei',
];

function isDualSurfaceProviderType(type: ProviderType): boolean {
  return DUAL_SURFACE_PROVIDER_TYPES.includes(type);
}

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  official: 'Official',
  proxy: 'Proxy',
  local: 'Local',
  custom: 'Custom',
};

export const CONNECTION_FIELD_LABELS: Record<
  string,
  {label: string; type: string; placeholder: string}
> = {
  apiKey: {
    label: 'Provider API Key (shared)',
    type: 'password',
    placeholder: 'sk-...',
  },
  baseUrl: {
    label: 'Base URL',
    type: 'text',
    placeholder: 'https://api.example.com',
  },
  claudeBaseUrl: {
    label: 'Claude-compatible Base URL',
    type: 'text',
    placeholder: 'https://api.example.com/anthropic',
  },
  claudeApiKey: {
    label: 'Claude-compatible API Key',
    type: 'password',
    placeholder: 'sk-...',
  },
  claudeAuthToken: {
    label: 'Claude-compatible Auth Token',
    type: 'password',
    placeholder: 'token without Bearer prefix',
  },
  openaiBaseUrl: {
    label: 'OpenAI-compatible Base URL',
    type: 'text',
    placeholder: 'https://api.example.com/v1',
  },
  openaiApiKey: {
    label: 'OpenAI-compatible API Key',
    type: 'password',
    placeholder: 'sk-...',
  },
  piAgentCoreModulePath: {
    label: 'Pi Agent Core Module Path',
    type: 'text',
    placeholder: '/path/to/@earendil-works/pi-agent-core/dist/index.js',
  },
  piAgentCoreModelJson: {
    label: 'Pi Agent Core Model JSON',
    type: 'text',
    placeholder: '{"id":"...","provider":"..."}',
  },
  piAgentCoreSystemPrompt: {
    label: 'Pi Agent Core System Prompt',
    type: 'text',
    placeholder: 'Optional runtime-level system prompt',
  },
  openCodeSdkModulePath: {
    label: 'OpenCode SDK Module Path',
    type: 'text',
    placeholder: '/path/to/@opencode-ai/sdk/dist/index.js',
  },
  openCodeModelJson: {
    label: 'OpenCode Model JSON',
    type: 'text',
    placeholder: '{"providerID":"smartperfetto","modelID":"..."}',
  },
  openCodeSystemPrompt: {
    label: 'OpenCode System Prompt',
    type: 'text',
    placeholder: 'Optional runtime-level system prompt',
  },
  qoderAccessToken: {
    label: 'Qoder Personal Access Token',
    type: 'password',
    placeholder: 'qpat_...',
  },
  qoderCliPath: {
    label: 'Qoder CLI Path',
    type: 'text',
    placeholder: '/usr/local/bin/qodercli',
  },
  qoderModel: {
    label: 'Qoder Model',
    type: 'text',
    placeholder: 'Optional model override',
  },
  qoderSystemPrompt: {
    label: 'Qoder System Prompt',
    type: 'text',
    placeholder: 'Optional runtime-level system prompt',
  },
  awsRegion: {label: 'AWS Region', type: 'text', placeholder: 'us-east-1'},
  awsBearerToken: {
    label: 'AWS Bearer Token',
    type: 'password',
    placeholder: 'Token...',
  },
  awsAccessKeyId: {
    label: 'AWS Access Key ID',
    type: 'text',
    placeholder: 'AKIA...',
  },
  awsSecretAccessKey: {
    label: 'AWS Secret Access Key',
    type: 'password',
    placeholder: 'Secret...',
  },
  awsSessionToken: {
    label: 'AWS Session Token',
    type: 'password',
    placeholder: 'Session token...',
  },
  awsProfile: {label: 'AWS Profile', type: 'text', placeholder: 'default'},
  gcpProjectId: {
    label: 'GCP Project ID',
    type: 'text',
    placeholder: 'my-project-123',
  },
  gcpRegion: {label: 'GCP Region', type: 'text', placeholder: 'us-central1'},
};

const CONNECTION_FIELD_LABEL_ZH: Record<string, string> = {
  apiKey: '提供商 API 密钥（共享）',
  baseUrl: '基础 URL',
  claudeBaseUrl: 'Claude 兼容基础 URL',
  claudeApiKey: 'Claude 兼容 API 密钥',
  claudeAuthToken: 'Claude 兼容认证令牌',
  openaiBaseUrl: 'OpenAI 兼容基础 URL',
  openaiApiKey: 'OpenAI 兼容 API 密钥',
  piAgentCoreModulePath: 'Pi Agent Core 模块路径',
  piAgentCoreModelJson: 'Pi Agent Core 模型 JSON',
  piAgentCoreSystemPrompt: 'Pi Agent Core 系统提示词',
  openCodeSdkModulePath: 'OpenCode SDK 模块路径',
  openCodeModelJson: 'OpenCode 模型 JSON',
  openCodeSystemPrompt: 'OpenCode 系统提示词',
  qoderAccessToken: 'Qoder 个人访问令牌',
  qoderCliPath: 'Qoder CLI 路径',
  qoderModel: 'Qoder 模型',
  qoderSystemPrompt: 'Qoder 系统提示词',
  awsRegion: 'AWS 区域',
  awsBearerToken: 'AWS Bearer 令牌',
  awsAccessKeyId: 'AWS 访问密钥 ID',
  awsSecretAccessKey: 'AWS 私密访问密钥',
  awsSessionToken: 'AWS 会话令牌',
  awsProfile: 'AWS 配置文件',
  gcpProjectId: 'GCP 项目 ID',
  gcpRegion: 'GCP 区域',
};

const CONNECTION_FIELD_PLACEHOLDER_ZH: Record<string, string> = {
  claudeAuthToken: '不包含 Bearer 前缀的令牌',
  piAgentCoreSystemPrompt: '可选的运行时级系统提示词',
  openCodeSystemPrompt: '可选的运行时级系统提示词',
  qoderSystemPrompt: '可选的运行时级系统提示词',
  awsBearerToken: '令牌……',
  awsSecretAccessKey: '私密密钥……',
  awsSessionToken: '会话令牌……',
};

export function connectionFieldMetadata(field: string): {
  label: string;
  type: string;
  placeholder: string;
} {
  const metadata = CONNECTION_FIELD_LABELS[field] || {
    label: field,
    type: 'text',
    placeholder: '',
  };
  return {
    ...metadata,
    label: uiText(
      CONNECTION_FIELD_LABEL_ZH[field] || metadata.label,
      metadata.label,
    ),
    placeholder: uiText(
      CONNECTION_FIELD_PLACEHOLDER_ZH[field] || metadata.placeholder,
      metadata.placeholder,
    ),
  };
}

export function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return buildSmartPerfettoContextHeaders(headers);
}

export function apiUrl(backendUrl: string, path: string): string {
  return buildSmartPerfettoWorkspaceApiUrl(backendUrl, 'providers', path);
}

export function providerHasClaudeSurface(provider: ProviderConfig): boolean {
  const conn = provider.connection;
  if (
    provider.type === 'anthropic' ||
    provider.type === 'bedrock' ||
    provider.type === 'vertex' ||
    isDualSurfaceProviderType(provider.type)
  ) {
    return true;
  }
  return !!(
    conn.claudeBaseUrl ||
    conn.claudeApiKey ||
    conn.claudeAuthToken ||
    (provider.type === 'custom' &&
      conn.agentRuntime !== 'openai-agents-sdk' &&
      conn.agentRuntime !== 'pi-agent-core' &&
      conn.agentRuntime !== 'opencode' &&
      (conn.baseUrl || conn.apiKey))
  );
}

export function providerHasOpenAISurface(provider: ProviderConfig): boolean {
  const conn = provider.connection;
  if (
    provider.type === 'openai' ||
    provider.type === 'ollama' ||
    isDualSurfaceProviderType(provider.type)
  ) {
    return true;
  }
  return !!(
    conn.openaiBaseUrl ||
    conn.openaiApiKey ||
    conn.openaiProtocol ||
    (provider.type === 'custom' &&
      conn.agentRuntime === 'openai-agents-sdk' &&
      (conn.baseUrl || conn.apiKey))
  );
}

export function providerHasPiAgentCoreSurface(
  provider: ProviderConfig,
): boolean {
  const conn = provider.connection;
  return (
    provider.type === 'custom' &&
    !!(
      conn.agentRuntime === 'pi-agent-core' ||
      conn.piAgentCoreModelJson ||
      conn.piAgentCoreModulePath
    )
  );
}

export function providerHasOpenCodeSurface(provider: ProviderConfig): boolean {
  const conn = provider.connection;
  return (
    provider.type === 'custom' &&
    !!(
      conn.agentRuntime === 'opencode' ||
      conn.openCodeModelJson ||
      conn.openCodeSdkModulePath ||
      conn.openaiBaseUrl ||
      conn.baseUrl
    )
  );
}

export function providerHasQoderSurface(provider: ProviderConfig): boolean {
  const conn = provider.connection;
  return (
    provider.type === 'custom' &&
    !!(
      conn.agentRuntime === 'qoder-agent-sdk' ||
      conn.qoderAccessToken ||
      conn.qoderCliPath
    )
  );
}

export function resolveProviderRuntime(
  provider?: ProviderConfig,
): AgentRuntimeKind {
  const runtime = provider?.connection.agentRuntime;
  if (
    runtime === 'openai-agents-sdk' ||
    runtime === 'claude-agent-sdk' ||
    runtime === 'pi-agent-core' ||
    runtime === 'opencode' ||
    runtime === 'qoder-agent-sdk'
  ) {
    return runtime;
  }
  if (!provider) return 'claude-agent-sdk';
  if (provider.type === 'openai' || provider.type === 'ollama') {
    return 'openai-agents-sdk';
  }
  if (
    provider.type === 'custom' &&
    providerHasOpenAISurface(provider) &&
    !providerHasClaudeSurface(provider)
  ) {
    return 'openai-agents-sdk';
  }
  return 'claude-agent-sdk';
}

export function providerSupportsRuntime(
  provider: ProviderConfig,
  runtime: AgentRuntimeKind,
): boolean {
  if (runtime === 'openai-agents-sdk') {
    return providerHasOpenAISurface(provider);
  }
  if (runtime === 'pi-agent-core') {
    return providerHasPiAgentCoreSurface(provider);
  }
  if (runtime === 'opencode') return providerHasOpenCodeSurface(provider);
  if (runtime === 'qoder-agent-sdk')
    return providerHasQoderSurface(provider);
  return providerHasClaudeSurface(provider);
}

export function providerRuntimeLabel(runtime: ServerRuntimeKind): string {
  if (runtime === 'openai-agents-sdk') return 'OpenAI SDK';
  if (runtime === 'pi-agent-core') return 'Pi Agent Core';
  if (runtime === 'experimental-pi-agent-core') {
    return 'Experimental Pi Agent Core';
  }
  if (runtime === 'opencode') return 'OpenCode';
  if (runtime === 'experimental-opencode') return 'Experimental OpenCode';
  if (runtime === 'qoder-agent-sdk') return 'Qoder SDK';
  return 'Claude SDK';
}

export function providerRuntimeShortLabel(runtime: ServerRuntimeKind): string {
  if (runtime === 'openai-agents-sdk') return 'OA';
  if (runtime === 'pi-agent-core' || runtime === 'experimental-pi-agent-core') {
    return 'PI';
  }
  if (runtime === 'opencode' || runtime === 'experimental-opencode') {
    return 'OC';
  }
  if (runtime === 'qoder-agent-sdk') {
    return 'QD';
  }
  return 'CL';
}

export type BedrockAuthMethod = 'bearer' | 'accessKey' | 'profile';

export interface FormState {
  name: string;
  type: ProviderType;
  models: ProviderModels;
  connection: ProviderConnection;
  tuning: ProviderTuning;
  showTuning: boolean;
  useBedrock: boolean;
  bedrockAuthMethod: BedrockAuthMethod;
}

export function createEmptyForm(): FormState {
  return {
    name: '',
    type: 'anthropic',
    models: {primary: '', light: ''},
    connection: {},
    tuning: {},
    showTuning: false,
    useBedrock: true,
    bedrockAuthMethod: 'accessKey',
  };
}
