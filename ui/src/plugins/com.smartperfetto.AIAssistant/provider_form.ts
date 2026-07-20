// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {
  type ProviderType,
  type ProviderTuning,
  type ProviderConfig,
  type ProviderTemplate,
  type FormState,
  type BedrockAuthMethod,
  type AgentRuntimeKind,
  type OpenAIProtocol,
  connectionFieldMetadata,
  buildHeaders,
  apiUrl,
  createEmptyForm,
} from './provider_types';
import {renderProviderIcon} from './provider_icons';
import {getTokens, STYLES as getStyles} from './provider_styles';
import {uiText as text} from './ui_language';

export interface ProviderFormAttrs {
  backendUrl: string;
  apiKey?: string;
  editingProvider?: ProviderConfig;
  cloneSource?: ProviderConfig;
  templates: ProviderTemplate[];
  onSaved: () => void;
  onCancel: () => void;
}

type AccordionSection = 'name' | 'connection' | 'models' | 'tuning';

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

const CONNECTION_FIELD_HINTS: Record<string, [string, string]> = {
  apiKey: [
    '通常只需要此凭据。除非设置了下方的可选覆盖项，预设提供商会将它用于所选 SDK 运行时。',
    'Usually this is the only credential you need. Preset providers reuse it for the selected SDK runtime unless an optional override below is set.',
  ],
  claudeApiKey: [
    '用于 Claude SDK 路径，并以 x-api-key 发送。需要复用共享提供商密钥时请留空。',
    'Used by the Claude SDK path and sent as x-api-key. Leave empty when the shared provider key should be reused.',
  ],
  claudeAuthToken: [
    '仅用于在 Claude SDK 路径上要求 Authorization: Bearer <token> 的提供商。请勿包含 Bearer 前缀。',
    'Only needed for providers that require Authorization: Bearer <token> on the Claude SDK path. Do not include the Bearer prefix.',
  ],
  claudeBaseUrl: [
    '提供商模板已预填。仅当提供商控制台给出不同的 Claude/Anthropic 兼容 URL 时修改。',
    'Prefilled by the provider template. Change only when your provider console shows a different Claude/Anthropic-compatible URL.',
  ],
  openaiApiKey: [
    '用于 OpenAI SDK 路径。需要复用共享提供商密钥时请留空。',
    'Used by the OpenAI SDK path. Leave empty when the shared provider key should be reused.',
  ],
  openaiBaseUrl: [
    '提供商模板已预填。OpenAI 兼容网关通常使用以 /v1 结尾的 URL。',
    'Prefilled by the provider template. OpenAI-compatible gateways usually use a URL ending in /v1.',
  ],
  piAgentCoreModulePath: [
    '可选的显式模块路径。留空时从后端包加载 @earendil-works/pi-agent-core。',
    'Optional explicit module path. Leave empty to load @earendil-works/pi-agent-core from the backend package.',
  ],
  piAgentCoreModelJson: [
    'Pi Agent Core 必填。请粘贴 Pi 运行时要求的模型 JSON 对象；此字段按敏感信息处理。',
    'Required for Pi Agent Core. Paste the model JSON object expected by the Pi runtime. This field is treated as sensitive.',
  ],
  piAgentCoreSystemPrompt: [
    'Pi Agent Core 的可选运行时系统提示词。SmartPerfetto 分析契约仍来自后端 Strategy。',
    'Optional runtime-level system prompt for Pi Agent Core. SmartPerfetto analysis contracts still come from backend strategies.',
  ],
  openCodeSdkModulePath: [
    '可选的显式模块路径。留空时从后端包加载 @opencode-ai/sdk。',
    'Optional explicit module path. Leave empty to load @opencode-ai/sdk from the backend package.',
  ],
  openCodeModelJson: [
    '可选的 OpenCode 模型/提供商 JSON。省略时使用该提供商的 OpenAI 兼容字段和主模型。',
    'Optional OpenCode model/provider JSON. If omitted, OpenCode uses the OpenAI-compatible fields and primary model from this provider.',
  ],
  openCodeSystemPrompt: [
    'OpenCode 的可选运行时系统提示词。SmartPerfetto 分析契约仍来自后端 Strategy。',
    'Optional runtime-level system prompt for OpenCode. SmartPerfetto analysis contracts still come from backend strategies.',
  ],
};

function connectionFieldHint(field: string): string | undefined {
  const hint = CONNECTION_FIELD_HINTS[field];
  return hint ? text(hint[0], hint[1]) : undefined;
}

const CONNECTION_FIELD_QUALIFIERS: Record<string, string> = {
  baseUrl: 'Optional',
  claudeAuthToken: 'Optional',
  claudeBaseUrl: 'Preset',
  openaiBaseUrl: 'Preset',
  piAgentCoreModulePath: 'Optional',
  piAgentCoreSystemPrompt: 'Optional',
  openCodeSdkModulePath: 'Optional',
  openCodeModelJson: 'Optional',
  openCodeSystemPrompt: 'Optional',
  awsRegion: 'Preset',
  awsSessionToken: 'Optional',
  awsProfile: 'Optional',
  gcpRegion: 'Preset',
};

function connectionFieldQualifier(field: string): string | undefined {
  const qualifier = CONNECTION_FIELD_QUALIFIERS[field];
  if (qualifier === 'Optional') return text('可选', 'Optional');
  if (qualifier === 'Preset') return text('预设', 'Preset');
  return qualifier;
}

export class ProviderForm implements m.ClassComponent<ProviderFormAttrs> {
  private form: FormState = createEmptyForm();
  private expandedSection: AccordionSection = 'name';
  private error: string | null = null;
  private saving = false;
  private isEdit = false;
  private editingId: string | null = null;

  oninit(vnode: m.Vnode<ProviderFormAttrs>) {
    const {editingProvider, cloneSource, templates} = vnode.attrs;
    if (editingProvider) {
      this.isEdit = true;
      this.editingId = editingProvider.id;
      this.form = {
        name: editingProvider.name,
        type: editingProvider.type,
        models: {...editingProvider.models},
        connection: this.normalizeConnectionForForm(
          editingProvider.type,
          editingProvider.connection,
        ),
        tuning: editingProvider.tuning ? {...editingProvider.tuning} : {},
        showTuning:
          !!editingProvider.tuning &&
          Object.keys(editingProvider.tuning).length > 0,
        useBedrock: editingProvider.connection.useBedrock !== false,
        bedrockAuthMethod: this.inferAuthMethod(editingProvider.connection),
      };
    } else if (cloneSource) {
      const src = cloneSource;
      this.isEdit = false;
      this.editingId = null;
      this.form = {
        name: text(`${src.name}（副本）`, `${src.name} (Copy)`),
        type: src.type,
        models: {...src.models},
        connection: this.normalizeConnectionForForm(src.type, src.connection),
        tuning: src.tuning ? {...src.tuning} : {},
        showTuning: !!src.tuning && Object.keys(src.tuning).length > 0,
        useBedrock: src.connection.useBedrock !== false,
        bedrockAuthMethod: this.inferAuthMethod(src.connection),
      };
    } else {
      this.isEdit = false;
      this.editingId = null;
      this.form = createEmptyForm();
      const firstTemplate = templates[0];
      if (firstTemplate) {
        this.form.type = firstTemplate.type;
        this.form.models = {...firstTemplate.defaultModels};
        this.form.connection = {...(firstTemplate.defaultConnection || {})};
      }
    }
    this.expandedSection = 'name';
  }

  private onTypeChange(type: ProviderType, templates: ProviderTemplate[]) {
    this.form.type = type;
    const template = templates.find((t) => t.type === type);
    if (template) {
      this.form.models = {...template.defaultModels};
      this.form.connection = {...(template.defaultConnection || {})};
    }
    if (type === 'bedrock') {
      this.form.useBedrock = true;
      this.form.bedrockAuthMethod = 'accessKey';
    }
    this.expandedSection = 'name';
  }

  private inferAuthMethod(conn: {
    awsBearerToken?: string;
    awsProfile?: string;
  }): BedrockAuthMethod {
    if (conn.awsBearerToken) return 'bearer';
    if (conn.awsProfile) return 'profile';
    return 'accessKey';
  }

  private normalizeConnectionForForm(
    type: ProviderType,
    connection: FormState['connection'],
  ): FormState['connection'] {
    const conn = {...connection};
    if (type === 'anthropic') {
      conn.claudeApiKey ??= conn.apiKey;
      conn.claudeBaseUrl ??= conn.baseUrl;
    } else if (type === 'openai' || type === 'ollama') {
      conn.openaiApiKey ??= conn.apiKey;
      conn.openaiBaseUrl ??= conn.baseUrl;
      conn.agentRuntime ??= 'openai-agents-sdk';
      conn.openaiProtocol ??=
        type === 'openai' ? 'responses' : 'chat_completions';
    } else if (isDualSurfaceProviderType(type)) {
      conn.claudeBaseUrl ??= conn.baseUrl;
      conn.openaiProtocol ??= 'chat_completions';
      conn.agentRuntime ??= 'claude-agent-sdk';
    } else if (type === 'custom') {
      if (conn.agentRuntime === 'pi-agent-core') {
        // Pi Agent Core uses explicit Pi fields; do not infer Claude/OpenAI
        // connection fields from the legacy shared key.
      } else if (conn.agentRuntime === 'qoder-agent-sdk') {
        // Qoder uses explicit qoderAccessToken/qoderCliPath; do not infer
        // Claude/OpenAI connection fields from the legacy shared key.
      } else if (conn.agentRuntime === 'opencode') {
        conn.openaiApiKey ??= conn.apiKey;
        conn.openaiBaseUrl ??= conn.baseUrl;
        conn.openaiProtocol ??= 'chat_completions';
      } else if (
        conn.agentRuntime === 'openai-agents-sdk' ||
        conn.openaiProtocol
      ) {
        conn.openaiApiKey ??= conn.apiKey;
        conn.openaiBaseUrl ??= conn.baseUrl;
        conn.openaiProtocol ??= 'chat_completions';
      } else {
        conn.claudeApiKey ??= conn.apiKey;
        conn.claudeBaseUrl ??= conn.baseUrl;
      }
    }
    return conn;
  }

  private toggleSection(section: AccordionSection) {
    if (this.isEdit) {
      this.expandedSection = section;
    } else {
      this.expandedSection =
        this.expandedSection === section ? ('' as AccordionSection) : section;
    }
  }

  private isSectionComplete(
    section: AccordionSection,
    template?: ProviderTemplate,
  ): boolean {
    switch (section) {
      case 'name':
        return this.form.name.trim().length > 0;
      case 'connection': {
        if (!template) return false;
        const conn = this.form.connection;
        if (this.form.type === 'anthropic') {
          return !!(conn.claudeApiKey || conn.claudeAuthToken || conn.apiKey);
        }
        if (isDualSurfaceProviderType(this.form.type)) {
          return !!(
            conn.apiKey ||
            conn.claudeApiKey ||
            conn.claudeAuthToken ||
            conn.openaiApiKey
          );
        }
        if (this.form.type === 'openai') {
          return !!(conn.openaiApiKey || conn.apiKey);
        }
        if (this.form.type === 'ollama') {
          return !!(conn.openaiBaseUrl || conn.baseUrl);
        }
        if (this.form.type === 'custom') {
          if (this.currentRuntime() === 'openai-agents-sdk') {
            return !!(conn.openaiBaseUrl || conn.baseUrl);
          }
          if (this.currentRuntime() === 'pi-agent-core') {
            return !!conn.piAgentCoreModelJson;
          }
          if (this.currentRuntime() === 'opencode') {
            return !!(
              conn.openCodeModelJson ||
              conn.openaiBaseUrl ||
              conn.baseUrl
            );
          }
          if (this.currentRuntime() === 'qoder-agent-sdk') {
            return !!(conn.qoderAccessToken || conn.qoderCliPath);
          }
          return !!(conn.claudeBaseUrl || conn.baseUrl);
        }
        const requiredFields = (template.requiredFields || []).map((f) =>
          f.replace(/^connection\./, ''),
        );
        return requiredFields.every((f) => {
          const val = (this.form.connection as Record<string, string>)[f];
          return val && val.trim().length > 0;
        });
      }
      case 'models':
        return !!(
          this.form.models.primary?.trim() && this.form.models.light?.trim()
        );
      case 'tuning':
        return true;
    }
  }

  private async saveProvider(attrs: ProviderFormAttrs) {
    const {templates, backendUrl, apiKey, onSaved} = attrs;
    const template = templates.find((tmpl) => tmpl.type === this.form.type);
    const connection = {...this.form.connection};
    if (this.form.type === 'bedrock') {
      connection.useBedrock = this.form.useBedrock;
    }
    const body: Record<string, unknown> = {
      name: this.form.name,
      category: this.form.type === 'custom' ? 'custom' : 'official',
      type: this.form.type,
      models: {
        primary:
          this.form.models.primary || template?.defaultModels.primary || '',
        light: this.form.models.light || template?.defaultModels.light || '',
        ...(this.form.models.subAgent
          ? {subAgent: this.form.models.subAgent}
          : {}),
      },
      connection,
    };

    if (this.form.showTuning && Object.keys(this.form.tuning).length > 0) {
      body.tuning = this.form.tuning;
    }

    this.saving = true;
    this.error = null;
    m.redraw();

    try {
      let res: Response;
      if (this.isEdit && this.editingId) {
        res = await fetch(apiUrl(backendUrl, `/${this.editingId}`), {
          method: 'PATCH',
          headers: buildHeaders(apiKey),
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch(apiUrl(backendUrl, ''), {
          method: 'POST',
          headers: buildHeaders(apiKey),
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          (errData as {error?: string}).error ||
            text(`保存失败：${res.status}`, `Save failed: ${res.status}`),
        );
      }

      onSaved();
    } catch (e: unknown) {
      this.error =
        e instanceof Error ? e.message : text('保存失败', 'Save failed');
      m.redraw();
    } finally {
      this.saving = false;
      m.redraw();
    }
  }

  view(vnode: m.Vnode<ProviderFormAttrs>): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const {templates, onCancel} = vnode.attrs;
    const template = templates.find((tmpl) => tmpl.type === this.form.type);

    return m(
      'div',
      {
        style: {
          ...s.container,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column' as const,
        },
      },
      [
        this.error
          ? m('div', {style: s.errorBanner}, [
              m('span', '⚠️'),
              m('span', this.error),
            ])
          : null,

        m('div', {style: s.header}, [
          m('div', [
            m(
              'h3',
              {style: s.title},
              this.isEdit
                ? text('编辑提供商', 'Edit Provider')
                : text('添加提供商', 'Add Provider'),
            ),
            m(
              'p',
              {style: s.subtitle},
              this.isEdit
                ? text(
                    '修改提供商凭据、运行时和模型。',
                    'Modify provider credentials, runtime, and models',
                  )
                : text(
                    '提供商模板会预填运行时 URL 和模型；通常只需填写 API 密钥。',
                    'Provider templates prefill runtime URLs and models. Usually only the API key is required.',
                  ),
            ),
          ]),
          m(
            'button',
            {
              style: {...s.btn, ...s.btnSecondary},
              onclick: () => onCancel(),
            },
            text('← 返回', '← Back'),
          ),
        ]),

        m(
          'div',
          {style: {flex: 1, overflowY: 'auto' as const, paddingBottom: '8px'}},
          [
            this.renderTypeGrid(t, s, templates),
            m(
              'div',
              {style: {marginTop: '16px'}},
              this.renderAccordion(t, s, template, vnode.attrs),
            ),
          ],
        ),

        m(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              gap: '10px',
              padding: '12px 20px',
              borderTop: `1px solid ${t.border}`,
              backgroundColor: t.bg,
              flexShrink: 0,
            },
          },
          [
            m(
              'button',
              {
                style: {...s.btn, ...s.btnSecondary},
                onclick: () => onCancel(),
              },
              text('关闭', 'Close'),
            ),
            m(
              'button',
              {
                style: {
                  ...s.btn,
                  ...s.btnPrimary,
                  ...(!this.form.name || this.saving ? s.btnDisabled : {}),
                },
                disabled: !this.form.name || this.saving,
                onclick: () => this.saveProvider(vnode.attrs),
              },
              this.saving
                ? text('保存中……', 'Saving...')
                : this.isEdit
                  ? text('保存修改', 'Save Changes')
                  : text('创建提供商', 'Create Provider'),
            ),
          ],
        ),
      ],
    );
  }

  private renderTypeGrid(
    _t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
    templates: ProviderTemplate[],
  ): m.Children {
    return m(
      'div',
      {style: s.typeGrid},
      templates.map((tmpl) => {
        const isSelected = this.form.type === tmpl.type;
        const isDisabled = this.isEdit;
        const cardStyle = {
          ...s.typeCard,
          ...(isSelected ? s.typeCardSelected : {}),
          ...(isDisabled ? s.typeCardDisabled : {}),
        };
        return m(
          'div',
          {
            key: tmpl.type,
            style: cardStyle,
            onclick: isDisabled
              ? undefined
              : () => {
                  this.onTypeChange(tmpl.type, templates);
                  m.redraw();
                },
          },
          [
            m(
              'div',
              {style: s.typeCardIcon},
              renderProviderIcon(tmpl.type, 24),
            ),
            m('div', {style: s.typeCardLabel}, tmpl.displayName),
          ],
        );
      }),
    );
  }

  private renderAccordion(
    t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
    template: ProviderTemplate | undefined,
    attrs: ProviderFormAttrs,
  ): m.Children {
    const sections: Array<{key: AccordionSection; title: string}> = [
      {key: 'name', title: text('名称与身份', 'Name & Identity')},
      {key: 'connection', title: text('连接', 'Connection')},
      {key: 'models', title: text('模型', 'Models')},
      {key: 'tuning', title: text('高级调优', 'Advanced Tuning')},
    ];

    return m('div', [
      ...sections.map(({key, title}) => {
        const isOpen = this.isEdit ? true : this.expandedSection === key;
        const isComplete = this.isSectionComplete(key, template);

        return m('div', {key, style: s.accordionSection}, [
          m(
            'div',
            {
              style: s.accordionHeader,
              onclick: () => {
                this.toggleSection(key);
                m.redraw();
              },
            },
            [
              m('div', {style: s.accordionHeaderLeft}, [
                m('div', {
                  style: {
                    ...s.accordionDot,
                    ...(isComplete
                      ? s.accordionDotComplete
                      : s.accordionDotPending),
                  },
                }),
                m('span', {style: s.accordionTitle}, title),
              ]),
              m(
                'span',
                {
                  style: {
                    ...s.accordionChevron,
                    transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                  },
                },
                '▼',
              ),
            ],
          ),

          isOpen
            ? m(
                'div',
                {style: s.accordionBody},
                this.renderSectionContent(key, t, s, template, attrs),
              )
            : null,
        ]);
      }),
    ]);
  }

  private renderSectionContent(
    section: AccordionSection,
    _t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
    template: ProviderTemplate | undefined,
    _attrs: ProviderFormAttrs,
  ): m.Children {
    switch (section) {
      case 'name':
        return this.renderNameSection(s, template);
      case 'connection':
        return this.renderConnectionSection(s, template);
      case 'models':
        return this.renderModelsSection(s, template);
      case 'tuning':
        return this.renderTuningSection(_t, s);
    }
  }

  private renderNameSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(s, text('显示名称', 'Display Name')),
      m('input[type=text]', {
        style: s.formInput,
        value: this.form.name,
        oninput: (e: Event) => {
          this.form.name = (e.target as HTMLInputElement).value;
        },
        placeholder: text(
          `我的${template?.displayName || '提供商'}`,
          `My ${template?.displayName || 'Provider'}`,
        ),
      }),
      m(
        'div',
        {style: s.formHint},
        text(
          '使用便于在切换器中识别的名称；它不会影响提供商凭据或模型 ID。',
          'Use a name you can recognize in the switcher. It does not affect provider credentials or model IDs.',
        ),
      ),
    ]);
  }

  private renderFieldLabel(
    s: ReturnType<typeof getStyles>,
    label: string,
    qualifier?: string,
  ): m.Children {
    const t = getTokens();
    return m('label', {style: s.formLabel}, [
      label,
      qualifier
        ? m(
            'span',
            {
              style: {
                marginLeft: '6px',
                padding: '1px 5px',
                borderRadius: '4px',
                border: `1px solid ${t.border}`,
                color: t.textMuted,
                fontSize: '10px',
                fontWeight: 500,
              },
            },
            qualifier,
          )
        : null,
    ]);
  }

  private renderConnectionSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    if (!template) {
      return m(
        'div',
        {style: s.formField},
        m(
          'span',
          {style: s.formHint},
          text('请先选择提供商类型。', 'Select a provider type first.'),
        ),
      );
    }

    if (this.form.type === 'bedrock') {
      return this.renderBedrockConnection(s);
    }

    if (this.form.type === 'custom') {
      return this.renderCustomConnection(s);
    }

    if (
      this.supportsClaudeSurface(this.form.type) &&
      this.supportsOpenAISurface(this.form.type)
    ) {
      return this.renderDualSdkConnection(s);
    }

    if (this.supportsClaudeSurface(this.form.type)) {
      return this.renderClaudeConnectionFields(s, {includeApiKey: true});
    }

    if (this.supportsOpenAISurface(this.form.type)) {
      return this.renderOpenAIConnectionFields(s, {includeApiKey: true});
    }

    const requiredFields = (template.requiredFields || []).map((f) =>
      f.replace(/^connection\./, ''),
    );

    if (requiredFields.length === 0) {
      return m(
        'div',
        {style: s.formField},
        m(
          'span',
          {style: s.formHint},
          text('无需填写连接字段。', 'No connection fields required.'),
        ),
      );
    }

    return m(
      'div',
      {},
      requiredFields.map((field) => {
        const meta = connectionFieldMetadata(field);
        return m('div', {key: field, style: s.formField}, [
          this.renderFieldLabel(s, meta.label, connectionFieldQualifier(field)),
          m(`input[type=${meta.type}]`, {
            style: s.formInput,
            value:
              (this.form.connection as Record<string, string>)[field] || '',
            oninput: (e: Event) => {
              (this.form.connection as Record<string, string>)[field] = (
                e.target as HTMLInputElement
              ).value;
            },
            placeholder: meta.placeholder,
          }),
          connectionFieldHint(field)
            ? m('div', {style: s.formHint}, connectionFieldHint(field))
            : null,
        ]);
      }),
    );
  }

  private supportsClaudeSurface(type: ProviderType): boolean {
    return (
      type === 'anthropic' ||
      isDualSurfaceProviderType(type) ||
      type === 'custom'
    );
  }

  private supportsOpenAISurface(type: ProviderType): boolean {
    return (
      type === 'openai' ||
      type === 'ollama' ||
      isDualSurfaceProviderType(type) ||
      type === 'custom'
    );
  }

  private currentRuntime(): AgentRuntimeKind {
    const runtime = this.form.connection.agentRuntime;
    if (
      runtime === 'openai-agents-sdk' ||
      runtime === 'claude-agent-sdk' ||
      runtime === 'pi-agent-core' ||
      runtime === 'opencode' ||
      runtime === 'qoder-agent-sdk'
    ) {
      return runtime;
    }
    if (this.form.type === 'openai' || this.form.type === 'ollama') {
      return 'openai-agents-sdk';
    }
    return 'claude-agent-sdk';
  }

  private renderCustomConnection(s: ReturnType<typeof getStyles>): m.Children {
    const runtime = this.currentRuntime();
    return m('div', [
      this.renderRuntimeSelector(s),
      runtime === 'pi-agent-core'
        ? this.renderPiAgentCoreConnectionFields(s)
        : runtime === 'opencode'
          ? this.renderOpenCodeConnectionFields(s)
          : runtime === 'qoder-agent-sdk'
            ? this.renderQoderConnectionFields(s)
            : runtime === 'openai-agents-sdk'
              ? this.renderOpenAIConnectionFields(s, {includeApiKey: true})
              : this.renderClaudeConnectionFields(s, {includeApiKey: true}),
    ]);
  }

  private renderDualSdkConnection(s: ReturnType<typeof getStyles>): m.Children {
    const t = getTokens();
    const runtime = this.currentRuntime();
    return m('div', [
      this.renderRuntimeSelector(s),
      m('div', {style: s.formField}, [
        this.renderFieldLabel(s, text('提供商 API 密钥', 'Provider API Key')),
        m('input[type=password]', {
          style: s.formInput,
          value: this.form.connection.apiKey || '',
          oninput: (e: Event) => {
            this.form.connection.apiKey = (e.target as HTMLInputElement).value;
          },
          placeholder: 'sk-...',
        }),
        m('div', {style: s.formHint}, connectionFieldHint('apiKey')),
      ]),
      this.renderPresetConnectionSummary(),
      m(
        'div',
        {
          style: {
            marginTop: '14px',
            paddingTop: '12px',
            borderTop: `1px solid ${t.border}`,
          },
        },
        [
          this.renderConnectionGroupTitle(
            runtime === 'openai-agents-sdk'
              ? text('OpenAI SDK 可选字段', 'OpenAI SDK optional fields')
              : text('Claude SDK 可选字段', 'Claude SDK optional fields'),
          ),
          runtime === 'openai-agents-sdk'
            ? this.renderOpenAIConnectionFields(s, {includeApiKey: false})
            : this.renderClaudeConnectionFields(s, {includeApiKey: false}),
        ],
      ),
    ]);
  }

  private renderPresetConnectionSummary(): m.Children {
    const t = getTokens();
    const conn = this.form.connection;
    const url =
      this.currentRuntime() === 'openai-agents-sdk'
        ? conn.openaiBaseUrl || conn.baseUrl
        : conn.claudeBaseUrl || conn.baseUrl;
    const protocol =
      this.currentRuntime() === 'openai-agents-sdk'
        ? conn.openaiProtocol || 'chat_completions'
        : undefined;
    const details = [url ? `URL: ${url}` : undefined, protocol]
      .filter(Boolean)
      .join(' · ');

    return m(
      'div',
      {
        style: {
          margin: '10px 0 2px',
          padding: '8px 10px',
          borderRadius: '6px',
          backgroundColor: t.surface,
          border: `1px solid ${t.border}`,
          color: t.textSecondary,
          fontSize: '12px',
          lineHeight: '1.45',
        },
      },
      details
        ? text(
            `模板已预填运行时默认值（${details}）。`,
            `Template already filled the runtime defaults (${details}).`,
          )
        : text(
            '模板已预填运行时默认值。',
            'Template already filled the runtime defaults.',
          ),
    );
  }

  private renderRuntimeSelector(s: ReturnType<typeof getStyles>): m.Children {
    const t = getTokens();
    const current = this.currentRuntime();
    const options: Array<{value: AgentRuntimeKind; label: string}> = [
      {value: 'claude-agent-sdk', label: 'Claude SDK'},
      {value: 'openai-agents-sdk', label: 'OpenAI SDK'},
      ...(this.form.type === 'custom'
        ? [
            {value: 'pi-agent-core' as const, label: 'Pi Agent Core'},
            {value: 'opencode' as const, label: 'OpenCode'},
            {value: 'qoder-agent-sdk' as const, label: 'Qoder SDK'},
          ]
        : []),
    ];

    return m('div', {style: s.formField}, [
      m('label', {style: s.formLabel}, text('运行时', 'Runtime')),
      m(
        'div',
        {
          style: {
            display: 'inline-flex',
            border: `1px solid ${t.border}`,
            borderRadius: '6px',
            overflow: 'hidden',
            backgroundColor: t.surface,
          },
        },
        options.map((option, index) => {
          const active = current === option.value;
          return m(
            'button',
            {
              key: option.value,
              type: 'button',
              style: {
                border: 'none',
                borderRight:
                  index < options.length - 1 ? `1px solid ${t.border}` : 'none',
                padding: '7px 12px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: active ? 600 : 500,
                color: active ? '#1a1a1a' : t.textSecondary,
                background: active ? t.accentGradient : 'transparent',
              },
              onclick: () => {
                this.form.connection.agentRuntime = option.value;
                if (option.value === 'pi-agent-core') {
                  this.form.connection.openaiProtocol = undefined;
                } else if (option.value === 'opencode') {
                  this.form.connection.openaiProtocol ??= 'chat_completions';
                }
              },
            },
            option.label,
          );
        }),
      ),
      m(
        'div',
        {style: s.formHint},
        text(
          '大多数预设提供商无需修改。仅在明确需要使用另一套 SDK 接口时切换运行时。',
          'Most preset providers work without changing this. Switch runtime only when you intentionally want the provider to use another SDK surface.',
        ),
      ),
    ]);
  }

  private renderPiAgentCoreConnectionFields(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    return m('div', [
      this.renderConnectionInput(s, 'piAgentCoreModulePath'),
      this.renderConnectionTextarea(s, 'piAgentCoreModelJson'),
      this.renderConnectionTextarea(s, 'piAgentCoreSystemPrompt'),
      m(
        'div',
        {key: 'piAgentCoreCapabilityHint', style: s.formHint},
        text(
          'Pi Agent Core 能力受限：它是可选的动态加载运行时，不会启用 Shell/文件工具或 .pi 项目发现。',
          'Pi Agent Core is capability-limited: it is optional, dynamically loaded, and does not enable shell/file tools or .pi project discovery.',
        ),
      ),
    ]);
  }

  private renderOpenCodeConnectionFields(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    return m('div', [
      m(
        'div',
        {key: 'openCodeOpenAIFields'},
        this.renderOpenAIConnectionFields(s, {includeApiKey: true}),
      ),
      this.renderConnectionInput(s, 'openCodeSdkModulePath'),
      this.renderConnectionTextarea(s, 'openCodeModelJson'),
      this.renderConnectionTextarea(s, 'openCodeSystemPrompt'),
      m(
        'div',
        {key: 'openCodeCapabilityHint', style: s.formHint},
        text(
          'OpenCode 通过隔离服务器运行，只使用请求范围内的 SmartPerfetto MCP 工具；内置 Shell、文件和项目发现工具仍保持禁用。',
          'OpenCode runs through an isolated server with request-scoped SmartPerfetto MCP tools. Built-in shell/file/project discovery tools remain disabled.',
        ),
      ),
    ]);
  }

  private renderQoderConnectionFields(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    return m('div', [
      this.renderConnectionInput(s, 'qoderAccessToken'),
      this.renderConnectionInput(s, 'qoderCliPath'),
      this.renderConnectionInput(s, 'qoderModel'),
      this.renderConnectionTextarea(s, 'qoderSystemPrompt'),
      m(
        'div',
        {key: 'qoderCapabilityHint', style: s.formHint},
        text(
          'Qoder SDK 通过隔离进程运行，只使用请求范围内的 SmartPerfetto MCP 工具；内置 Shell、文件、编辑和 Web 工具全部禁用。需要 Personal Access Token 或本地 CLI 路径。',
          'Qoder SDK runs through an isolated process with request-scoped SmartPerfetto MCP tools. Built-in shell/file/edit/web tools are all disabled. Requires a Personal Access Token or local CLI path.',
        ),
      ),
    ]);
  }

  private renderConnectionGroupTitle(title: string): m.Children {
    const t = getTokens();
    return m(
      'div',
      {
        style: {
          fontSize: '11px',
          color: t.textSecondary,
          fontWeight: 700,
          textTransform: 'uppercase' as const,
          marginBottom: '10px',
        },
      },
      title,
    );
  }

  private renderClaudeConnectionFields(
    s: ReturnType<typeof getStyles>,
    options: {includeApiKey: boolean},
  ): m.Children {
    return m('div', [
      options.includeApiKey
        ? this.renderConnectionInput(s, 'claudeApiKey')
        : this.renderConnectionInput(
            s,
            'claudeApiKey',
            text(
              'Claude 兼容 API 密钥覆盖',
              'Claude-compatible API Key Override',
            ),
            text('可选', 'Optional'),
          ),
      this.renderConnectionInput(
        s,
        'claudeAuthToken',
        undefined,
        text('可选', 'Optional'),
      ),
      this.renderConnectionInput(
        s,
        'claudeBaseUrl',
        undefined,
        text('预设', 'Preset'),
      ),
    ]);
  }

  private renderOpenAIConnectionFields(
    s: ReturnType<typeof getStyles>,
    options: {includeApiKey: boolean},
  ): m.Children {
    return m('div', [
      options.includeApiKey
        ? this.renderConnectionInput(s, 'openaiApiKey')
        : this.renderConnectionInput(
            s,
            'openaiApiKey',
            text(
              'OpenAI 兼容 API 密钥覆盖',
              'OpenAI-compatible API Key Override',
            ),
            text('可选', 'Optional'),
          ),
      this.renderConnectionInput(
        s,
        'openaiBaseUrl',
        undefined,
        text('预设', 'Preset'),
      ),
      this.renderOpenAIProtocolSelect(s),
    ]);
  }

  private renderOpenAIProtocolSelect(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    const protocol =
      this.form.connection.openaiProtocol ||
      (this.form.type === 'openai' ? 'responses' : 'chat_completions');
    return m('div', {key: 'openaiProtocol', style: s.formField}, [
      this.renderFieldLabel(
        s,
        text('OpenAI 协议', 'OpenAI Protocol'),
        text('预设', 'Preset'),
      ),
      m(
        'select',
        {
          style: s.formSelect,
          value: protocol,
          onchange: (e: Event) => {
            this.form.connection.openaiProtocol = (
              e.target as HTMLSelectElement
            ).value as OpenAIProtocol;
          },
        },
        [
          m('option', {value: 'responses'}, 'Responses'),
          m(
            'option',
            {value: 'chat_completions'},
            text('聊天补全', 'Chat Completions'),
          ),
        ],
      ),
      m(
        'div',
        {style: s.formHint},
        text(
          '官方 OpenAI 请使用 Responses；Ollama 和大多数 OpenAI 兼容网关请保留“聊天补全”。',
          'Use Responses for official OpenAI. Keep Chat Completions for Ollama and most OpenAI-compatible gateways.',
        ),
      ),
    ]);
  }

  private renderConnectionInput(
    s: ReturnType<typeof getStyles>,
    field: string,
    labelOverride?: string,
    qualifierOverride?: string,
  ): m.Children {
    const meta = connectionFieldMetadata(field);
    const conn = this.form.connection as Record<string, string>;
    return m('div', {key: field, style: s.formField}, [
      this.renderFieldLabel(
        s,
        labelOverride || meta.label,
        qualifierOverride ?? connectionFieldQualifier(field),
      ),
      m(`input[type=${meta.type}]`, {
        style: s.formInput,
        value: conn[field] || '',
        oninput: (e: Event) => {
          conn[field] = (e.target as HTMLInputElement).value;
        },
        placeholder: meta.placeholder,
      }),
      connectionFieldHint(field)
        ? m('div', {style: s.formHint}, connectionFieldHint(field))
        : null,
    ]);
  }

  private renderConnectionTextarea(
    s: ReturnType<typeof getStyles>,
    field: string,
  ): m.Children {
    const meta = connectionFieldMetadata(field);
    const conn = this.form.connection as Record<string, string>;
    return m('div', {key: field, style: s.formField}, [
      this.renderFieldLabel(s, meta.label, connectionFieldQualifier(field)),
      m('textarea', {
        style: {
          ...s.formInput,
          minHeight: field === 'piAgentCoreModelJson' ? '96px' : '72px',
          resize: 'vertical',
          fontFamily: 'monospace',
        },
        value: conn[field] || '',
        oninput: (e: Event) => {
          conn[field] = (e.target as HTMLTextAreaElement).value;
        },
        placeholder: meta.placeholder,
      }),
      connectionFieldHint(field)
        ? m('div', {style: s.formHint}, connectionFieldHint(field))
        : null,
    ]);
  }

  private renderBedrockConnection(s: ReturnType<typeof getStyles>): m.Children {
    const t = getTokens();
    const conn = this.form.connection as Record<string, string>;

    const authFields: Record<
      BedrockAuthMethod,
      Array<{key: string; label: string; type: string; placeholder: string}>
    > = {
      bearer: [
        {
          key: 'awsBearerToken',
          label: text('AWS Bearer 令牌', 'AWS Bearer Token'),
          type: 'password',
          placeholder: text(
            '用于访问 Bedrock 的 Bearer 令牌',
            'Bearer token for Bedrock access',
          ),
        },
      ],
      accessKey: [
        {
          key: 'awsAccessKeyId',
          label: text('AWS 访问密钥 ID', 'AWS Access Key ID'),
          type: 'text',
          placeholder: 'AKIA...',
        },
        {
          key: 'awsSecretAccessKey',
          label: text('AWS 私密访问密钥', 'AWS Secret Access Key'),
          type: 'password',
          placeholder: text('私密密钥……', 'Secret key...'),
        },
        {
          key: 'awsSessionToken',
          label: text('会话令牌（可选）', 'Session Token (optional)'),
          type: 'password',
          placeholder: text('临时会话令牌……', 'Temporary session token...'),
        },
      ],
      profile: [
        {
          key: 'awsProfile',
          label: text('AWS 配置文件名称', 'AWS Profile Name'),
          type: 'text',
          placeholder: 'default',
        },
      ],
    };

    return m('div', [
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, text('AWS 区域', 'AWS Region')),
        m('input[type=text]', {
          style: s.formInput,
          value: conn['awsRegion'] || '',
          oninput: (e: Event) => {
            conn['awsRegion'] = (e.target as HTMLInputElement).value;
          },
          placeholder: text(
            'us-east-1（留空则使用 AWS_REGION 环境变量）',
            'us-east-1 (leave empty to use AWS_REGION env)',
          ),
        }),
        m(
          'div',
          {style: s.formHint},
          text(
            '留空则继承 AWS_REGION 环境变量。',
            'Leave empty to inherit from AWS_REGION environment variable',
          ),
        ),
      ]),

      m('div', {style: s.formField}, [
        m(
          'label',
          {style: s.formLabel},
          text('API 密钥（可选）', 'API Key (optional)'),
        ),
        m('input[type=password]', {
          style: s.formInput,
          value: conn['apiKey'] || '',
          oninput: (e: Event) => {
            conn['apiKey'] = (e.target as HTMLInputElement).value;
          },
          placeholder: text(
            'sk-ant-…（适用于 Anthropic 代理）',
            'sk-ant-... (for Anthropic proxy, if applicable)',
          ),
        }),
        m(
          'div',
          {style: s.formHint},
          text(
            '仅在 Bedrock 前使用 Anthropic API 代理时需要。',
            'Only needed if using an Anthropic API proxy in front of Bedrock',
          ),
        ),
      ]),

      m(
        'div',
        {
          style: {
            marginTop: '16px',
            paddingTop: '12px',
            borderTop: `1px solid ${t.border}`,
          },
        },
        [
          m(
            'div',
            {
              key: 'adv-title',
              style: {
                ...s.formLabel,
                fontSize: '12px',
                color: t.textSecondary,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.5px',
                marginBottom: '12px',
              },
            },
            text('高级配置', 'Advanced Configuration'),
          ),

          m(
            'div',
            {
              key: 'adv-usebedrock',
              style: {
                ...s.formField,
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
              },
            },
            [
              m('input[type=checkbox]', {
                checked: this.form.useBedrock,
                onchange: (e: Event) => {
                  this.form.useBedrock = (e.target as HTMLInputElement).checked;
                },
              }),
              m(
                'label',
                {style: {...s.formLabel, margin: 0}},
                text('使用 Bedrock', 'Use Bedrock'),
              ),
              m(
                'span',
                {style: {fontSize: '11px', color: t.textMuted}},
                '(CLAUDE_CODE_USE_BEDROCK=1)',
              ),
            ],
          ),

          m('div', {key: 'adv-authmethod', style: s.formField}, [
            m(
              'label',
              {style: s.formLabel},
              text('认证方式', 'Authentication Method'),
            ),
            m(
              'select',
              {
                style: s.formSelect,
                value: this.form.bedrockAuthMethod,
                onchange: (e: Event) => {
                  this.form.bedrockAuthMethod = (e.target as HTMLSelectElement)
                    .value as BedrockAuthMethod;
                },
              },
              [
                m(
                  'option',
                  {value: 'accessKey'},
                  text(
                    '访问密钥（AWS_ACCESS_KEY_ID + Secret）',
                    'Access Key (AWS_ACCESS_KEY_ID + Secret)',
                  ),
                ),
                m(
                  'option',
                  {value: 'bearer'},
                  text(
                    'Bearer 令牌（AWS_BEARER_TOKEN_BEDROCK）',
                    'Bearer Token (AWS_BEARER_TOKEN_BEDROCK)',
                  ),
                ),
                m(
                  'option',
                  {value: 'profile'},
                  text(
                    'AWS 配置文件（AWS_PROFILE）',
                    'AWS Profile (AWS_PROFILE)',
                  ),
                ),
              ],
            ),
          ]),

          ...authFields[this.form.bedrockAuthMethod].map((field) =>
            m('div', {key: field.key, style: s.formField}, [
              m('label', {style: s.formLabel}, field.label),
              m(`input[type=${field.type}]`, {
                style: s.formInput,
                value: conn[field.key] || '',
                oninput: (e: Event) => {
                  conn[field.key] = (e.target as HTMLInputElement).value;
                },
                placeholder: field.placeholder,
              }),
            ]),
          ),

          m('div', {key: 'adv-baseurl', style: s.formField}, [
            m(
              'label',
              {style: s.formLabel},
              text('Bedrock 基础 URL（可选）', 'Bedrock Base URL (optional)'),
            ),
            m('input[type=text]', {
              style: s.formInput,
              value: conn['baseUrl'] || '',
              oninput: (e: Event) => {
                conn['baseUrl'] = (e.target as HTMLInputElement).value;
              },
              placeholder: 'https://bedrock-runtime.us-east-1.amazonaws.com',
            }),
            m(
              'div',
              {style: s.formHint},
              text(
                '对应 ANTHROPIC_BEDROCK_BASE_URL；留空则使用默认值。',
                'Maps to ANTHROPIC_BEDROCK_BASE_URL. Leave empty for default.',
              ),
            ),
          ]),
        ],
      ),
    ]);
  }

  private renderModelsSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    const hasAvailableModels = !!(
      template?.availableModels && template.availableModels.length > 0
    );

    const modelField = (
      label: string,
      key: 'primary' | 'light',
      defaultVal?: string,
    ) =>
      m('div', {style: s.formField}, [
        this.renderFieldLabel(
          s,
          label,
          defaultVal ? text('预设', 'Preset') : undefined,
        ),
        hasAvailableModels
          ? m(
              'select',
              {
                style: s.formSelect,
                value: this.form.models[key] || '',
                onchange: (e: Event) => {
                  this.form.models[key] = (e.target as HTMLSelectElement).value;
                },
              },
              [
                m('option', {value: ''}, text('-- 请选择 --', '-- Select --')),
                ...(template?.availableModels || []).map((mdl) =>
                  m('option', {value: mdl.id}, `${mdl.name} (${mdl.tier})`),
                ),
              ],
            )
          : m('input[type=text]', {
              style: s.formInput,
              value: this.form.models[key] || '',
              oninput: (e: Event) => {
                this.form.models[key] = (e.target as HTMLInputElement).value;
              },
              placeholder: defaultVal || text('模型 ID', 'Model ID'),
            }),
        defaultVal
          ? m(
              'div',
              {style: s.formHint},
              text(
                `已预填：${defaultVal}。仅在提供商套餐使用其他模型 ID 时修改。`,
                `Prefilled: ${defaultVal}. Change only if your provider plan uses another model ID.`,
              ),
            )
          : null,
      ]);

    return m('div', [
      modelField(
        text('主模型', 'Primary Model'),
        'primary',
        template?.defaultModels.primary,
      ),
      modelField(
        text('轻量模型', 'Light Model'),
        'light',
        template?.defaultModels.light,
      ),
      m('div', {style: s.formField}, [
        this.renderFieldLabel(
          s,
          text('子 Agent 模型', 'Sub-agent Model'),
          text('可选', 'Optional'),
        ),
        m('input[type=text]', {
          style: s.formInput,
          value: this.form.models.subAgent || '',
          oninput: (e: Event) => {
            this.form.models.subAgent =
              (e.target as HTMLInputElement).value || undefined;
          },
          placeholder: text(
            '留空则继承主模型',
            'Leave empty to inherit primary',
          ),
        }),
      ]),
    ]);
  }

  private renderTuningSection(
    t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    const tuning = this.form.tuning;

    const numField = (
      label: string,
      key: keyof ProviderTuning,
      placeholder: string,
      attrs: Record<string, unknown> = {},
    ) =>
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, label),
        m('input[type=number]', {
          style: s.formInput,
          ...attrs,
          value: tuning[key] ?? '',
          oninput: (e: Event) => {
            const val = (e.target as HTMLInputElement).value;
            if (val === '') {
              delete tuning[key];
            } else {
              (tuning as Record<string, unknown>)[key] = Number(val);
            }
          },
          placeholder,
        }),
      ]);

    const boolField = (
      label: string,
      key: 'enableSubAgents' | 'enableVerification',
    ) =>
      m(
        'div',
        {
          style: {
            ...s.formField,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
          },
        },
        [
          m('input[type=checkbox]', {
            checked: tuning[key] ?? true,
            onchange: (e: Event) => {
              tuning[key] = (e.target as HTMLInputElement).checked;
            },
          }),
          m('label', {style: {...s.formLabel, margin: 0}}, label),
        ],
      );

    return m(
      'div',
      {style: {paddingLeft: '12px', borderLeft: `2px solid ${t.border}`}},
      [
        m(
          'div',
          {style: {...s.formHint, margin: '0 0 12px'}},
          text(
            '均为可选；留空则继承 SmartPerfetto 运行时默认值。',
            'Optional. Leave these empty to inherit SmartPerfetto runtime defaults.',
          ),
        ),
        numField(text('最大轮数', 'Max Turns'), 'maxTurns', '100', {
          min: 2,
          step: 1,
        }),
        m('div', {style: s.formField}, [
          m('label', {style: s.formLabel}, text('推理强度', 'Effort Level')),
          m(
            'select',
            {
              style: s.formSelect,
              value: tuning.effort || '',
              onchange: (e: Event) => {
                const val = (e.target as HTMLSelectElement).value;
                if (val) {
                  tuning.effort = val;
                } else {
                  delete tuning.effort;
                }
              },
            },
            [
              m('option', {value: ''}, text('-- 默认 --', '-- Default --')),
              m('option', {value: 'low'}, text('低', 'Low')),
              m('option', {value: 'medium'}, text('中', 'Medium')),
              m('option', {value: 'high'}, text('高', 'High')),
            ],
          ),
        ]),
        numField(
          text('最大预算（USD）', 'Max Budget (USD)'),
          'maxBudgetUsd',
          '5',
        ),
        numField(
          text('完整分析单轮超时（ms）', 'Full Per-turn Timeout (ms)'),
          'fullPerTurnMs',
          '60000',
        ),
        numField(
          text('快速分析单轮超时（ms）', 'Quick Per-turn Timeout (ms)'),
          'quickPerTurnMs',
          '40000',
        ),
        numField(
          text('验证器超时（ms）', 'Verifier Timeout (ms)'),
          'verifierTimeoutMs',
          '60000',
        ),
        numField(
          text('分类器超时（ms）', 'Classifier Timeout (ms)'),
          'classifierTimeoutMs',
          '30000',
        ),
        boolField(text('启用子 Agent', 'Enable Sub-agents'), 'enableSubAgents'),
        boolField(
          text('启用验证', 'Enable Verification'),
          'enableVerification',
        ),
      ],
    );
  }
}
