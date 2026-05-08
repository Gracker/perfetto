// SPDX-License-Identifier: AGPL-3.0-or-later

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
export type AgentRuntimeKind = 'claude-agent-sdk' | 'openai-agents-sdk';
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
  onClose?: () => void;
}

export interface ProviderQuickSwitcherAttrs {
  backendUrl: string;
  apiKey?: string;
  compact?: boolean;
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
  apiKey: {label: 'API Key', type: 'password', placeholder: 'sk-...'},
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
  claudeApiKey: {label: 'Claude API Key', type: 'password', placeholder: 'sk-...'},
  claudeAuthToken: {
    label: 'Claude Auth Token',
    type: 'password',
    placeholder: 'Bearer token...',
  },
  openaiBaseUrl: {
    label: 'OpenAI-compatible Base URL',
    type: 'text',
    placeholder: 'https://api.example.com/v1',
  },
  openaiApiKey: {label: 'OpenAI API Key', type: 'password', placeholder: 'sk-...'},
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

export function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

export function apiUrl(backendUrl: string, path: string): string {
  const base = backendUrl.replace(/\/+$/, '');
  return `${base}/api/v1/providers${path}`;
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
    (provider.type === 'custom' && conn.agentRuntime !== 'openai-agents-sdk' && (conn.baseUrl || conn.apiKey))
  );
}

export function providerHasOpenAISurface(provider: ProviderConfig): boolean {
  const conn = provider.connection;
  if (provider.type === 'openai' || provider.type === 'ollama' || isDualSurfaceProviderType(provider.type)) {
    return true;
  }
  return !!(
    conn.openaiBaseUrl ||
    conn.openaiApiKey ||
    conn.openaiProtocol ||
    (provider.type === 'custom' && conn.agentRuntime === 'openai-agents-sdk' && (conn.baseUrl || conn.apiKey))
  );
}

export function resolveProviderRuntime(provider?: ProviderConfig): AgentRuntimeKind {
  const runtime = provider?.connection.agentRuntime;
  if (runtime === 'openai-agents-sdk' || runtime === 'claude-agent-sdk') {
    return runtime;
  }
  if (!provider) return 'claude-agent-sdk';
  if (provider.type === 'openai' || provider.type === 'ollama') {
    return 'openai-agents-sdk';
  }
  if (provider.type === 'custom' && providerHasOpenAISurface(provider) && !providerHasClaudeSurface(provider)) {
    return 'openai-agents-sdk';
  }
  return 'claude-agent-sdk';
}

export function providerSupportsRuntime(
  provider: ProviderConfig,
  runtime: AgentRuntimeKind,
): boolean {
  return runtime === 'openai-agents-sdk'
    ? providerHasOpenAISurface(provider)
    : providerHasClaudeSurface(provider);
}

export function providerRuntimeLabel(runtime: AgentRuntimeKind): string {
  return runtime === 'openai-agents-sdk' ? 'OpenAI SDK' : 'Claude SDK';
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
