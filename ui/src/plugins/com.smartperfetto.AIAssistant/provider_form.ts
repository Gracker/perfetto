// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import {
  type ProviderType,
  type ProviderTuning,
  type ProviderConfig,
  type ProviderModelOption,
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
import {getTokens, STYLES as getStyles} from './provider_styles';
import {uiText as text} from './ui_language';

export interface ProviderFormAttrs {
  backendUrl: string;
  apiKey?: string;
  editingProvider?: ProviderConfig;
  cloneSource?: ProviderConfig;
  templates: ProviderTemplate[];
  availableModels?: ProviderModelOption[];
  onSaved: () => void;
  onCancel: () => void;
}

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

const CONNECTION_FIELD_HINTS: Partial<Record<string, [string, string]>> = {
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
  private generatedName: string | undefined;
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
      if (templates.length > 0) {
        this.form.name = firstTemplate.displayName;
        this.generatedName = firstTemplate.displayName;
        this.form.type = firstTemplate.type;
        this.form.models = {...firstTemplate.defaultModels};
        this.form.connection = {...(firstTemplate.defaultConnection || {})};
      }
    }
  }

  private onTypeChange(type: ProviderType, templates: ProviderTemplate[]) {
    const useGeneratedName =
      !this.form.name.trim() || this.form.name === this.generatedName;
    this.form.type = type;
    const template = templates.find((t) => t.type === type);
    if (template) {
      if (useGeneratedName) this.form.name = template.displayName;
      this.generatedName = template.displayName;
      this.form.models = {...template.defaultModels};
      this.form.connection = {...(template.defaultConnection || {})};
    }
    if (type === 'bedrock') {
      this.form.useBedrock = true;
      this.form.bedrockAuthMethod = 'accessKey';
    }
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

  private async saveProvider(attrs: ProviderFormAttrs) {
    const {templates, backendUrl, apiKey, onSaved} = attrs;
    const template = templates.find((tmpl) => tmpl.type === this.form.type);
    const connection = {...this.form.connection};
    if (this.form.type === 'bedrock') {
      connection.useBedrock = this.form.useBedrock;
    }
    const primary =
      this.form.models.primary.trim() || template?.defaultModels.primary || '';
    if (!primary) {
      this.error = text('请输入主模型 ID。', 'Enter a primary model ID.');
      return;
    }
    const source = attrs.editingProvider || attrs.cloneSource;
    const body: Record<string, unknown> = {
      name: this.form.name.trim() || template?.displayName || this.form.type,
      category: this.form.type === 'custom' ? 'custom' : 'official',
      type: this.form.type,
      models: {
        primary,
        light: this.form.models.light.trim() || primary,
        ...(this.form.models.subAgent?.trim()
          ? {subAgent: this.form.models.subAgent.trim()}
          : {}),
      },
      connection,
      ...(source?.custom ? {custom: source.custom} : {}),
    };

    if (Object.keys(this.form.tuning).length > 0) {
      body.tuning = this.form.tuning;
    }

    this.saving = true;
    this.error = null;
    m.redraw();

    try {
      let res: Response;
      if (this.isEdit && this.editingId) {
        res = await smartPerfettoFetch(
          apiUrl(backendUrl, `/${this.editingId}`),
          {
            method: 'PATCH',
            headers: buildHeaders(apiKey),
            body: JSON.stringify(body),
          },
        );
      } else {
        res = await smartPerfettoFetch(apiUrl(backendUrl, ''), {
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
    const {templates, availableModels, onCancel} = vnode.attrs;
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
            this.renderTypeSelector(s, templates),
            m(
              'div',
              {style: {marginTop: '16px'}},
              this.renderFields(t, s, template, availableModels),
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
                style: {
                  ...s.btn,
                  ...s.btnPrimary,
                  ...(this.saving ? s.btnDisabled : {}),
                },
                disabled: this.saving,
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

  private renderTypeSelector(
    s: ReturnType<typeof getStyles>,
    templates: ProviderTemplate[],
  ): m.Children {
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(
        s,
        text('供应商', 'Provider'),
        undefined,
        'provider-type',
      ),
      m(
        'select',
        {
          id: 'provider-type',
          name: 'provider-type',
          style: s.formSelect,
          value: this.form.type,
          disabled: this.isEdit,
          onchange: (e: Event) =>
            this.onTypeChange(
              (e.target as HTMLSelectElement).value as ProviderType,
              templates,
            ),
        },
        templates.map((template) =>
          m('option', {value: template.type}, template.displayName),
        ),
      ),
    ]);
  }

  private primaryCredentialField(): string {
    const conn = this.form.connection;
    if (this.currentRuntime() === 'openai-agents-sdk') {
      return conn.openaiApiKey ||
        this.form.type === 'openai' ||
        this.form.type === 'ollama'
        ? 'openaiApiKey'
        : 'apiKey';
    }
    if (conn.claudeAuthToken) return 'claudeAuthToken';
    return conn.claudeApiKey || this.form.type === 'anthropic'
      ? 'claudeApiKey'
      : 'apiKey';
  }

  private renderFields(
    t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
    availableModels?: ProviderModelOption[],
  ): m.Children {
    const special =
      this.form.type === 'custom' ||
      this.form.type === 'bedrock' ||
      this.form.type === 'vertex';
    return m('div', [
      special
        ? this.renderConnectionSection(s, template)
        : this.renderConnectionInput(
            s,
            this.primaryCredentialField(),
            text('API 密钥', 'API Key'),
            undefined,
            false,
          ),
      this.renderModelField(
        s,
        'primary',
        text('模型', 'Model'),
        template,
        availableModels,
      ),
      m(
        'div',
        {style: s.formHint},
        text(
          '可选择已有模型，也可直接输入新模型 ID。',
          'Choose a listed model or enter any new model ID.',
        ),
      ),
      m('details', {style: {marginTop: '20px'}}, [
        m(
          'summary',
          {
            style: {
              cursor: 'pointer',
              padding: '12px 0',
              color: t.textSecondary,
            },
          },
          text('高级设置', 'Advanced settings'),
        ),
        this.renderNameSection(s, template),
        this.renderModelField(
          s,
          'light',
          text('轻量模型', 'Light Model'),
          template,
          availableModels,
        ),
        this.renderModelField(
          s,
          'subAgent',
          text('子 Agent 模型', 'Sub-agent Model'),
          template,
          availableModels,
        ),
        this.form.type === 'custom'
          ? this.renderCustomConnection(s, true)
          : this.form.type === 'bedrock'
            ? this.renderBedrockConnection(s, true)
            : !special
              ? this.renderAdvancedConnection(s)
              : null,
        this.renderTuningSection(t, s),
      ]),
    ]);
  }

  private renderAdvancedConnection(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    const dual = isDualSurfaceProviderType(this.form.type);
    const mainField = this.primaryCredentialField();
    const openai = this.currentRuntime() === 'openai-agents-sdk';
    const fields = openai
      ? ['openaiApiKey', 'openaiBaseUrl']
      : ['claudeApiKey', 'claudeAuthToken', 'claudeBaseUrl'];
    return m('div', [
      dual ? this.renderRuntimeSelector(s) : null,
      dual && mainField !== 'apiKey'
        ? this.renderConnectionInput(s, 'apiKey')
        : null,
      ...fields
        .filter((field) => field !== mainField)
        .map((field) => this.renderConnectionInput(s, field)),
      openai ? this.renderOpenAIProtocolSelect(s) : null,
    ]);
  }

  private renderNameSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(
        s,
        text('显示名称', 'Display Name'),
        undefined,
        'provider-name',
      ),
      m('input[type=text]', {
        style: s.formInput,
        id: 'provider-name',
        name: 'provider-name',
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
    id?: string,
  ): m.Children {
    const t = getTokens();
    return m('label', {style: s.formLabel, for: id}, [
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

    const requiredFields = template.requiredFields.map((f) =>
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
        return m('div', {style: s.formField}, [
          this.renderFieldLabel(
            s,
            meta.label,
            connectionFieldQualifier(field),
            `provider-${field}`,
          ),
          m(`input[type=${meta.type}]`, {
            id: `provider-${field}`,
            name: field,
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

  private renderCustomConnection(
    s: ReturnType<typeof getStyles>,
    advanced = false,
  ): m.Children {
    const runtime = this.currentRuntime();
    let fields: string[];
    switch (runtime) {
      case 'pi-agent-core':
        fields = advanced
          ? ['piAgentCoreModulePath', 'piAgentCoreSystemPrompt']
          : ['piAgentCoreModelJson'];
        break;
      case 'qoder-agent-sdk':
        fields = advanced
          ? ['qoderModel', 'qoderSystemPrompt']
          : ['qoderAccessToken', 'qoderCliPath'];
        break;
      case 'opencode':
        fields = advanced
          ? ['openCodeSdkModulePath', 'openCodeSystemPrompt']
          : ['openaiApiKey', 'openaiBaseUrl', 'openCodeModelJson'];
        break;
      case 'openai-agents-sdk':
        fields = advanced ? [] : ['openaiApiKey', 'openaiBaseUrl'];
        break;
      default:
        fields = advanced
          ? ['claudeAuthToken']
          : ['claudeApiKey', 'claudeBaseUrl'];
    }
    return m('div', [
      !advanced ? this.renderRuntimeSelector(s) : null,
      ...fields.map((field) =>
        field.endsWith('Json') || field.endsWith('SystemPrompt')
          ? this.renderConnectionTextarea(s, field)
          : this.renderConnectionInput(s, field),
      ),
      advanced && (runtime === 'openai-agents-sdk' || runtime === 'opencode')
        ? this.renderOpenAIProtocolSelect(s)
        : null,
    ]);
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

  private renderOpenAIProtocolSelect(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    const protocol =
      this.form.connection.openaiProtocol ||
      (this.form.type === 'openai' ? 'responses' : 'chat_completions');
    return m('div', {style: s.formField}, [
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
    showHint = true,
  ): m.Children {
    const meta = connectionFieldMetadata(field);
    const conn = this.form.connection as Record<string, string>;
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(
        s,
        labelOverride || meta.label,
        qualifierOverride ?? connectionFieldQualifier(field),
        `provider-${field}`,
      ),
      m(`input[type=${meta.type}]`, {
        id: `provider-${field}`,
        name: field,
        style: s.formInput,
        value: conn[field] || '',
        oninput: (e: Event) => {
          conn[field] = (e.target as HTMLInputElement).value;
        },
        placeholder: meta.placeholder,
      }),
      showHint && connectionFieldHint(field)
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
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(
        s,
        meta.label,
        connectionFieldQualifier(field),
        `provider-${field}`,
      ),
      m('textarea', {
        id: `provider-${field}`,
        name: field,
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

  private renderBedrockConnection(
    s: ReturnType<typeof getStyles>,
    advanced = false,
  ): m.Children {
    if (advanced) {
      return m('div', [
        this.renderConnectionInput(s, 'apiKey'),
        this.renderConnectionInput(s, 'awsSessionToken'),
        this.renderConnectionInput(
          s,
          'baseUrl',
          text('Bedrock 基础 URL', 'Bedrock Base URL'),
        ),
        m('label', {style: s.formField}, [
          m('input[type=checkbox]', {
            checked: this.form.useBedrock,
            onchange: (e: Event) => {
              this.form.useBedrock = (e.target as HTMLInputElement).checked;
            },
          }),
          text('使用 Bedrock', 'Use Bedrock'),
        ]),
      ]);
    }
    const authFields: Record<BedrockAuthMethod, string[]> = {
      bearer: ['awsBearerToken'],
      accessKey: ['awsAccessKeyId', 'awsSecretAccessKey'],
      profile: ['awsProfile'],
    };
    return m('div', [
      this.renderConnectionInput(s, 'awsRegion'),
      m('div', {style: s.formField}, [
        this.renderFieldLabel(
          s,
          text('认证方式', 'Authentication Method'),
          undefined,
          'provider-bedrock-auth',
        ),
        m(
          'select',
          {
            id: 'provider-bedrock-auth',
            name: 'bedrockAuthMethod',
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
              text('AWS 访问密钥', 'AWS Access Key'),
            ),
            m('option', {value: 'bearer'}, text('Bearer 令牌', 'Bearer Token')),
            m(
              'option',
              {value: 'profile'},
              text('AWS 配置文件', 'AWS Profile'),
            ),
          ],
        ),
      ]),
      ...authFields[this.form.bedrockAuthMethod].map((field) =>
        this.renderConnectionInput(s, field),
      ),
    ]);
  }

  private renderModelField(
    s: ReturnType<typeof getStyles>,
    key: 'primary' | 'light' | 'subAgent',
    label: string,
    template?: ProviderTemplate,
    availableModels?: ProviderModelOption[],
  ): m.Children {
    const id = `provider-model-${key}`;
    return m('div', {style: s.formField}, [
      this.renderFieldLabel(s, label, undefined, id),
      m('input[type=text]', {
        id,
        name: key,
        list: `${id}-options`,
        style: s.formInput,
        value: this.form.models[key] || '',
        autocomplete: 'off',
        spellcheck: false,
        placeholder:
          key === 'primary'
            ? text('模型 ID', 'Model ID')
            : text('留空则继承主模型', 'Leave empty to inherit primary'),
        oninput: (e: Event) => {
          this.form.models[key] = (e.target as HTMLInputElement).value;
        },
      }),
      m(
        'datalist',
        {id: `${id}-options`},
        (availableModels || template?.availableModels || []).map((model) =>
          m('option', {value: model.id}, model.name),
        ),
      ),
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
