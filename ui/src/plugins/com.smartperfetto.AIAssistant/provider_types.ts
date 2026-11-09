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
/** Pi is the only runtime a provider runs on; the other labels are recorded provenance. */
export type ServerRuntimeKind =
  | 'pi-agent-core'
  | 'claude-agent-sdk'
  | 'openai-agents-sdk'
  | 'opencode'
  | 'qoder-agent-sdk'
  | 'experimental-pi-agent-core'
  | 'experimental-opencode';
/** The endpoint Pi Agent Core calls for a provider with more than one. */
export type ProviderApiSurface = 'claude' | 'openai';
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
  /** Pi, or a retired label on a record the backend could not convert. */
  agentRuntime?: ServerRuntimeKind;
  apiSurface?: ProviderApiSurface;
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
  classifierTimeoutMs?: number;
  enableSubAgents?: boolean;
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
  /** The surface the backend resolves for this record, also when none is recorded. */
  effectiveApiSurface?: ProviderApiSurface;
}

/** The record's connection with its effective surface filled in, so the form shows what really runs. */
export function connectionWithEffectiveSurface(provider: ProviderConfig): ProviderConnection {
  return !provider.connection.apiSurface && provider.effectiveApiSurface && providerHasApiSurfaceChoice(provider.type)
    ? {...provider.connection, apiSurface: provider.effectiveApiSurface}
    : provider.connection;
}

export interface ProviderModelOption {
  id: string;
  name: string;
  tier: string;
}

export interface ProviderTemplate {
  type: ProviderType;
  displayName: string;
  requiredFields: string[];
  defaultModels: ProviderModels;
  availableModels: ProviderModelOption[];
  defaultConnection?: Partial<ProviderConnection>;
  /** The endpoints Pi's builtin model catalog serves for this type. */
  piCatalogRouteSurfaces?: string[];
  /** The endpoint this type calls when a record names none. */
  defaultApiSurface?: string;
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

export function isDualSurfaceProviderType(type: ProviderType): boolean {
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

const PROVIDER_STORE_UNREADABLE_CODE = 'provider_store_unreadable';

/**
 * True when the backend reports that providers.json exists but cannot be read:
 * the list is empty because of the file, not because nothing is configured,
 * and every change is refused until the file is repaired.
 */
export function providerStoreUnreadable(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const {code, store} = body as {code?: unknown; store?: {status?: unknown}};
  return (
    code === PROVIDER_STORE_UNREADABLE_CODE || store?.status === 'unreadable'
  );
}

export function providerStoreUnreadableMessage(): string {
  return uiText(
    'providers.json 无法读取，已暂停所有提供商修改；跟随当前提供商的分析也会被拒绝，不会改用系统默认配置（.env）。请修复或移走该文件后刷新。',
    'providers.json could not be read, so provider changes are paused and analyses that follow the active provider are refused rather than run on the system default (.env). Repair or move the file, then refresh.',
  );
}

/** A failed provider request, carrying the backend's reason when it gave one. */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly storeUnreadable: boolean,
  ) {
    super(message);
  }
}

export async function providerRequestFailure(
  res: Response,
  fallback: string,
): Promise<ProviderRequestError> {
  const body: unknown = await res.json().catch(() => undefined);
  if (providerStoreUnreadable(body)) {
    return new ProviderRequestError(providerStoreUnreadableMessage(), true);
  }
  const error = (body as {error?: unknown} | undefined)?.error;
  return new ProviderRequestError(
    typeof error === 'string' && error.length > 0 ? error : fallback,
    false,
  );
}

/** Dual-surface providers and custom ones: both endpoints are available to choose from. */
export function providerHasApiSurfaceChoice(type: ProviderType): boolean {
  return type === 'custom' || isDualSurfaceProviderType(type);
}

type ProviderSurfaceTemplate = Pick<
  ProviderTemplate,
  'piCatalogRouteSurfaces' | 'defaultApiSurface'
>;

function asApiSurface(value?: string): ProviderApiSurface | undefined {
  return value === 'claude' || value === 'openai' ? value : undefined;
}

function piCatalogRouteSurface(
  template?: ProviderSurfaceTemplate,
): ProviderApiSurface | undefined {
  const surfaces = (template?.piCatalogRouteSurfaces ?? []).flatMap(
    (value) => asApiSurface(value) ?? [],
  );
  const preferred = asApiSurface(template?.defaultApiSurface);
  return preferred && surfaces.includes(preferred) ? preferred : surfaces[0];
}

/**
 * Whether Pi resolves this record from its builtin model catalog: a Pi record
 * of a catalog type that recorded no endpoint. Only the shared key and that
 * endpoint apply then.
 */
export function providerUsesPiCatalogRoute(
  connection: ProviderConnection,
  template?: ProviderSurfaceTemplate,
): boolean {
  return (
    connection.agentRuntime === 'pi-agent-core' &&
    !connection.apiSurface &&
    piCatalogRouteSurface(template) !== undefined
  );
}

/** The endpoint a record calls: its recorded choice, else what its template declares. */
export function providerApiSurface(
  type: ProviderType,
  connection: ProviderConnection,
  template?: ProviderSurfaceTemplate,
): ProviderApiSurface {
  return (
    (providerHasApiSurfaceChoice(type) ? connection.apiSurface : undefined) ??
    (providerUsesPiCatalogRoute(connection, template)
      ? piCatalogRouteSurface(template)
      : undefined) ??
    asApiSurface(template?.defaultApiSurface) ??
    'claude'
  );
}

/** The runtime a record carries: Pi, unless it keeps a retired label. */
export function resolveProviderRuntime(
  provider: ProviderConfig,
): ServerRuntimeKind {
  return provider.connection.agentRuntime ?? 'pi-agent-core';
}

const RETIRED_RUNTIME_LABELS: readonly ServerRuntimeKind[] = [
  'opencode',
  'qoder-agent-sdk',
];
const RETIRED_RUNTIME_CONNECTION_FIELDS = [
  'openCodeSdkModulePath',
  'openCodeModelJson',
  'openCodeSystemPrompt',
  'qoderAccessToken',
  'qoderCliPath',
  'qoderModel',
  'qoderSystemPrompt',
];

/**
 * A record the backend could not convert to Pi: read-time migration removes
 * this state from every record it can map to an endpoint, so what is left
 * still needs the endpoint it never had.
 */
export function providerNeedsPiEndpoint(
  connection: ProviderConnection,
): boolean {
  const fields = connection as Record<string, unknown>;
  return (
    (connection.agentRuntime !== undefined &&
      RETIRED_RUNTIME_LABELS.includes(connection.agentRuntime)) ||
    RETIRED_RUNTIME_CONNECTION_FIELDS.some(
      (field) => fields[field] !== undefined,
    )
  );
}

/** The record as Pi runs it; the next backend read drops the retired fields it stored. */
export function withPiRuntimeRecord(
  connection: ProviderConnection,
): ProviderConnection {
  const piConnection = {...connection, agentRuntime: 'pi-agent-core' as const};
  const fields = piConnection as Record<string, unknown>;
  for (const field of RETIRED_RUNTIME_CONNECTION_FIELDS) delete fields[field];
  return piConnection;
}

/** Labels the runtime a record or session carries; anything unrecognized is Pi. */
export function providerRuntimeLabel(runtime: ServerRuntimeKind): string {
  if (runtime === 'claude-agent-sdk') return 'Claude SDK';
  if (runtime === 'openai-agents-sdk') return 'OpenAI SDK';
  if (runtime === 'experimental-pi-agent-core') {
    return 'Experimental Pi Agent Core';
  }
  if (runtime === 'opencode') return 'OpenCode';
  if (runtime === 'experimental-opencode') return 'Experimental OpenCode';
  if (runtime === 'qoder-agent-sdk') return 'Qoder SDK';
  return 'Pi Agent Core';
}

export function providerRuntimeShortLabel(runtime: ServerRuntimeKind): string {
  if (runtime === 'claude-agent-sdk') return 'CL';
  if (runtime === 'openai-agents-sdk') return 'OA';
  if (runtime === 'opencode' || runtime === 'experimental-opencode') {
    return 'OC';
  }
  if (runtime === 'qoder-agent-sdk') return 'QD';
  return 'PI';
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
