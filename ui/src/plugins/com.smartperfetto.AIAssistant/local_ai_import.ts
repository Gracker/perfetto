// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Import a gateway already configured in Claude Code or Codex. The dialog says
 * which files will be read before any scan runs. A key never reaches this
 * page: the backend holds it and asks for the final confirmation natively.
 */

import m from 'mithril';

import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import {apiUrl, buildHeaders, providerRequestFailure} from './provider_types';
import {errorMessage, MANAGEMENT_STYLES as STYLES} from './management_ui';
import {uiText as text} from './ui_language';

type Tool = 'claude_code' | 'codex';

interface SourcePath {
  tool: Tool;
  path: string;
  status?: 'found' | 'not_found' | 'unreadable';
}

export interface LocalAiImportCapability {
  available: boolean;
  sources?: SourcePath[];
}

interface Candidate {
  candidateId: string;
  tool: Tool;
  endpoint?: string;
  primaryModel?: string;
  hasKey: boolean;
  status: 'ready' | 'needs_model' | 'needs_key' | 'proxy_managed' | 'unsupported';
  reason?: 'api_key_helper' | 'env_key' | 'invalid_endpoint' | 'cloud_provider';
  existingProviderId?: string;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  if (!res.ok) throw await providerRequestFailure(res, text('操作失败', 'The operation failed'));
  return await res.json() as Record<string, unknown>;
}

export async function loadLocalAiImportCapability(backendUrl: string, apiKey?: string): Promise<LocalAiImportCapability> {
  const res = await smartPerfettoFetch(apiUrl(backendUrl, '/local-import/capability'), {headers: buildHeaders(apiKey)});
  return await readJson(res) as unknown as LocalAiImportCapability;
}

const toolName = (tool: Tool): string => tool === 'claude_code' ? 'Claude Code' : 'Codex';

function statusText(candidate: Candidate): string | undefined {
  switch (candidate.status) {
    case 'proxy_managed':
      return text('由 CC Switch 本地代理转发，配置里没有真实密钥，无法导入', 'Routed through the CC Switch local proxy; the file holds no real key');
    case 'needs_key':
      return candidate.reason === 'api_key_helper'
        ? text('密钥由 apiKeyHelper 脚本生成，SmartPerfetto 不执行它，请手动添加', 'The key comes from an apiKeyHelper script, which is not run; add the provider manually')
        : candidate.reason === 'env_key'
          ? text('密钥来自环境变量，不会读取，请手动添加', 'The key comes from an environment variable, which is not read; add the provider manually')
          : text('配置里没有密钥，请手动添加', 'The file holds no key; add the provider manually');
    case 'unsupported':
      return candidate.reason === 'invalid_endpoint'
        ? text('端点不安全或带有账号信息，无法导入', 'The endpoint is insecure or carries credentials')
        : text('云厂商认证请手动添加', 'Add cloud provider authentication manually');
    default:
      return undefined;
  }
}

interface LocalAiImportDialogAttrs {
  backendUrl: string;
  apiKey?: string;
  sources: SourcePath[];
  onImported(providerId: string): void;
  onClose(): void;
}

export class LocalAiImportDialog implements m.ClassComponent<LocalAiImportDialogAttrs> {
  private phase: 'consent' | 'scanning' | 'results' = 'consent';
  private sources: SourcePath[] = [];
  private candidates: Candidate[] = [];
  private models = new Map<string, string>();
  private importingId: string | null = null;
  private notice: string | null = null;
  private error: string | null = null;

  private async scan(attrs: LocalAiImportDialogAttrs): Promise<void> {
    this.phase = 'scanning';
    this.error = null;
    m.redraw();
    try {
      const body = await readJson(await smartPerfettoFetch(apiUrl(attrs.backendUrl, '/local-import/scan'), {
        method: 'POST', headers: buildHeaders(attrs.apiKey),
      }));
      this.sources = body.sources as SourcePath[];
      this.candidates = body.candidates as Candidate[];
      this.phase = 'results';
    } catch (error) {
      this.error = errorMessage(error, text('操作失败', 'The operation failed'));
      this.phase = 'consent';
    }
    m.redraw();
  }

  private async importCandidate(attrs: LocalAiImportDialogAttrs, candidate: Candidate): Promise<void> {
    const model = this.models.get(candidate.candidateId)?.trim();
    this.importingId = candidate.candidateId;
    this.notice = text('请在系统弹窗中确认…', 'Confirm in the system dialog…');
    this.error = null;
    m.redraw();
    try {
      const body = await readJson(await smartPerfettoFetch(apiUrl(attrs.backendUrl, '/local-import/import'), {
        method: 'POST',
        headers: buildHeaders(attrs.apiKey),
        body: JSON.stringify({candidateId: candidate.candidateId, ...(model ? {models: {primary: model, light: model}} : {})}),
      }));
      this.notice = body.imported === true ? null : text('已取消导入。', 'Import cancelled.');
      if (body.imported === true) attrs.onImported((body.provider as {id: string}).id);
    } catch (error) {
      this.notice = null;
      this.error = errorMessage(error, text('操作失败', 'The operation failed'));
    } finally {
      this.importingId = null;
      m.redraw();
    }
  }

  private renderCandidate(attrs: LocalAiImportDialogAttrs, candidate: Candidate): m.Children {
    const blocked = statusText(candidate);
    const model = this.models.get(candidate.candidateId) ?? '';
    const needsModel = candidate.status === 'needs_model';
    const disabled = this.importingId !== null || Boolean(blocked) || (needsModel && !model.trim());
    return m('div.ai-local-import-candidate', [
      m('div', m('strong', toolName(candidate.tool))),
      m('div', text(`端点：${candidate.endpoint ?? '官方 API'}`, `Endpoint: ${candidate.endpoint ?? 'official API'}`)),
      candidate.primaryModel ? m('div', text(`模型：${candidate.primaryModel}`, `Model: ${candidate.primaryModel}`)) : null,
      m('div', candidate.hasKey ? text('密钥：已配置（不会显示）', 'Key: configured (never shown)') : text('密钥：未配置', 'Key: not configured')),
      candidate.existingProviderId ? m('div.ai-context-control-note', text('已有相同端点和模型的提供商，导入会新增一条。', 'A provider with this endpoint and model exists; importing adds another.')) : null,
      blocked ? m('div.ai-context-control-note', blocked) : null,
      needsModel
        ? m('input', {
            'aria-label': text('模型 ID', 'Model ID'),
            placeholder: text('配置里只有模型别名，请填写网关的模型 ID', 'Only a model alias is configured; enter the gateway model id'),
            value: model,
            oninput: (event: Event) => this.models.set(candidate.candidateId, (event.target as HTMLInputElement).value),
          })
        : null,
      blocked ? null : m('button', {
        type: 'button', style: {...STYLES.button, ...STYLES.primary}, disabled,
        onclick: () => this.importCandidate(attrs, candidate),
      }, this.importingId === candidate.candidateId ? text('等待确认…', 'Waiting…') : text('导入', 'Import')),
    ]);
  }

  private renderConsent(attrs: LocalAiImportDialogAttrs): m.Children {
    return [
      m('p', text('只在你点击“扫描”后读取下面两个文件中的网关地址、模型和密钥：', 'After you click Scan, only the gateway address, model and key are read from these two files:')),
      m('ul', attrs.sources.map(source => m('li', [m('strong', `${toolName(source.tool)}：`), m('code', source.path)]))),
      m('p.ai-context-control-note', text(
        '不会读取 CC Switch 数据库、Keychain、登录令牌（.credentials.json、auth.json）或环境变量，也不会运行 apiKeyHelper。CC Switch 当前启用的供应商已写入上面的文件。',
        'CC Switch databases, Keychain, login tokens (.credentials.json, auth.json) and environment variables are not read, and apiKeyHelper is not run. The provider active in CC Switch is already in these files.',
      )),
      m('p.ai-context-control-note', text(
        '密钥不会显示在页面上。导入时会弹出系统确认框，确认后密钥以明文保存到本机 providers.json（仅当前用户可读）。这是一次性复制，之后修改原工具配置不会同步。',
        'The key is never shown here. A system dialog confirms the import; the key is then saved in plain text to the local providers.json, readable only by you. This is a one-time copy that does not follow later changes.',
      )),
      m('div', {style: STYLES.actions}, [
        m('button', {type: 'button', style: STYLES.button, onclick: () => attrs.onClose()}, text('取消', 'Cancel')),
        m('button', {type: 'button', style: {...STYLES.button, ...STYLES.primary}, disabled: this.phase === 'scanning',
          onclick: () => this.scan(attrs)}, this.phase === 'scanning' ? text('扫描中…', 'Scanning…') : text('扫描', 'Scan')),
      ]),
    ];
  }

  private renderResults(attrs: LocalAiImportDialogAttrs): m.Children {
    return [
      this.candidates.length === 0
        ? m('p', text('没有发现可导入的第三方配置。', 'No importable third-party configuration was found.'))
        : this.candidates.map(candidate => this.renderCandidate(attrs, candidate)),
      this.sources.filter(source => source.status === 'unreadable').map(source =>
        m('p.ai-context-control-note', text(`无法读取 ${source.path}`, `Could not read ${source.path}`))),
      m('div', {style: STYLES.actions},
        m('button', {type: 'button', style: STYLES.button, onclick: () => attrs.onClose()}, text('关闭', 'Close'))),
    ];
  }

  view({attrs}: m.Vnode<LocalAiImportDialogAttrs>): m.Children {
    return m('div.ai-modal-backdrop', {role: 'dialog', 'aria-modal': 'true', 'aria-label': text('从本机 AI 工具导入', 'Import from local AI tools')},
      m('div.ai-modal-card', [
        m('h4', text('从本机 AI 工具导入', 'Import from local AI tools')),
        this.phase === 'results' ? this.renderResults(attrs) : this.renderConsent(attrs),
        this.notice ? m('div.ai-context-control-note', {role: 'status'}, this.notice) : null,
        this.error ? m('div', {style: STYLES.error, role: 'alert'}, this.error) : null,
      ]));
  }
}
