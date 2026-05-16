// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {
  ProviderType,
  ProviderTuning,
  ProviderConfig,
  ProviderTemplate,
  FormState,
  BedrockAuthMethod,
  AgentRuntimeKind,
  OpenAIProtocol,
  CONNECTION_FIELD_LABELS,
  buildHeaders,
  apiUrl,
  createEmptyForm,
} from './provider_types';
import {renderProviderIcon} from './provider_icons';
import {getTokens, STYLES as getStyles} from './provider_styles';

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

const CONNECTION_FIELD_HINTS: Record<string, string> = {
  apiKey:
    'This is the model provider key stored in Provider Manager. Preset providers reuse it for both SDK runtimes unless an override below is set.',
  claudeApiKey:
    'Used only by the Claude SDK path and sent as x-api-key. Leave empty when the shared provider key should be reused.',
  claudeAuthToken:
    'Used only by the Claude SDK path and sent as Authorization: Bearer <token>. Do not include the Bearer prefix.',
  claudeBaseUrl:
    'Used only by Claude SDK. Keep the preset unless your provider console shows a different Claude/Anthropic-compatible URL.',
  openaiApiKey:
    'Used only by the OpenAI SDK path. Leave empty when the shared provider key should be reused.',
  openaiBaseUrl:
    'Used only by OpenAI SDK. OpenAI-compatible gateways usually use a URL ending in /v1.',
};

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
        name: `${src.name} (Copy)`,
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
      conn.openaiProtocol ??= type === 'openai' ? 'responses' : 'chat_completions';
    } else if (isDualSurfaceProviderType(type)) {
      conn.claudeBaseUrl ??= conn.baseUrl;
      conn.openaiProtocol ??= 'chat_completions';
      conn.agentRuntime ??= 'claude-agent-sdk';
    } else if (type === 'custom') {
      if (conn.agentRuntime === 'openai-agents-sdk' || conn.openaiProtocol) {
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
          return !!(conn.apiKey || conn.claudeApiKey || conn.claudeAuthToken || conn.openaiApiKey);
        }
        if (this.form.type === 'openai') {
          return !!(conn.openaiApiKey || conn.apiKey);
        }
        if (this.form.type === 'ollama') {
          return !!(conn.openaiBaseUrl || conn.baseUrl);
        }
        if (this.form.type === 'custom') {
          return this.currentRuntime() === 'openai-agents-sdk'
            ? !!(conn.openaiBaseUrl || conn.baseUrl)
            : !!(conn.claudeBaseUrl || conn.baseUrl);
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
          (errData as {error?: string}).error || `Save failed: ${res.status}`,
        );
      }

      onSaved();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Save failed';
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
              this.isEdit ? 'Edit Provider' : 'Add Provider',
            ),
            m(
              'p',
              {style: s.subtitle},
              this.isEdit
                ? 'Modify provider credentials, runtime, and models'
                : 'Save the provider, then test and activate it from the list',
            ),
          ]),
          m(
            'button',
            {
              style: {...s.btn, ...s.btnSecondary},
              onclick: () => onCancel(),
            },
            '← Back',
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
              'Close',
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
                ? 'Saving...'
                : this.isEdit
                  ? 'Save Changes'
                  : 'Create Provider',
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
      {key: 'name', title: 'Name & Identity'},
      {key: 'connection', title: 'Connection'},
      {key: 'models', title: 'Models'},
      {key: 'tuning', title: 'Advanced Tuning'},
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
      m('label', {style: s.formLabel}, 'Display Name'),
      m('input[type=text]', {
        style: s.formInput,
        value: this.form.name,
        oninput: (e: Event) => {
          this.form.name = (e.target as HTMLInputElement).value;
        },
        placeholder: `My ${template?.displayName || 'Provider'}`,
      }),
      m(
        'div',
        {style: s.formHint},
        'Saving creates a profile only. It affects analysis after you activate it or choose it from the provider switcher.',
      ),
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
        m('span', {style: s.formHint}, 'Select a provider type first.'),
      );
    }

    if (this.form.type === 'bedrock') {
      return this.renderBedrockConnection(s);
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
        m('span', {style: s.formHint}, 'No connection fields required.'),
      );
    }

    return m(
      'div',
      {},
      requiredFields.map((field) => {
        const meta = CONNECTION_FIELD_LABELS[field] || {
          label: field,
          type: 'text',
          placeholder: '',
        };
        return m('div', {key: field, style: s.formField}, [
          m('label', {style: s.formLabel}, meta.label),
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
          CONNECTION_FIELD_HINTS[field]
            ? m('div', {style: s.formHint}, CONNECTION_FIELD_HINTS[field])
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
    if (runtime === 'openai-agents-sdk' || runtime === 'claude-agent-sdk') {
      return runtime;
    }
    if (this.form.type === 'openai' || this.form.type === 'ollama') {
      return 'openai-agents-sdk';
    }
    return 'claude-agent-sdk';
  }

  private renderDualSdkConnection(
    s: ReturnType<typeof getStyles>,
  ): m.Children {
    const t = getTokens();
    return m('div', [
      this.renderRuntimeSelector(s),
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, 'Provider API Key (shared)'),
        m('input[type=password]', {
          style: s.formInput,
          value: this.form.connection.apiKey || '',
          oninput: (e: Event) => {
            this.form.connection.apiKey = (e.target as HTMLInputElement).value;
          },
          placeholder: 'sk-...',
        }),
        m('div', {style: s.formHint}, CONNECTION_FIELD_HINTS.apiKey),
      ]),
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
          this.renderConnectionGroupTitle('Claude Code SDK'),
          this.renderClaudeConnectionFields(s, {includeApiKey: false}),
        ],
      ),
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
          this.renderConnectionGroupTitle('OpenAI SDK'),
          this.renderOpenAIConnectionFields(s, {includeApiKey: false}),
        ],
      ),
    ]);
  }

  private renderRuntimeSelector(s: ReturnType<typeof getStyles>): m.Children {
    const t = getTokens();
    const current = this.currentRuntime();
    const options: Array<{value: AgentRuntimeKind; label: string}> = [
      {value: 'claude-agent-sdk', label: 'Claude SDK'},
      {value: 'openai-agents-sdk', label: 'OpenAI SDK'},
    ];

    return m('div', {style: s.formField}, [
      m('label', {style: s.formLabel}, 'SDK Runtime'),
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
        options.map((option) => {
          const active = current === option.value;
          return m(
            'button',
            {
              key: option.value,
              type: 'button',
              style: {
                border: 'none',
                borderRight:
                  option.value === 'claude-agent-sdk'
                    ? `1px solid ${t.border}`
                    : 'none',
                padding: '7px 12px',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: active ? 600 : 500,
                color: active ? '#1a1a1a' : t.textSecondary,
                background: active ? t.accentGradient : 'transparent',
              },
              onclick: () => {
                this.form.connection.agentRuntime = option.value;
              },
            },
            option.label,
          );
        }),
      ),
      m(
        'div',
        {style: s.formHint},
        'Claude SDK uses the Claude-compatible fields. OpenAI SDK uses the OpenAI-compatible fields. Switching runtime changes which side is active.',
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
            'Claude-compatible API Key Override',
          ),
      this.renderConnectionInput(s, 'claudeAuthToken'),
      this.renderConnectionInput(s, 'claudeBaseUrl'),
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
            'OpenAI-compatible API Key Override',
          ),
      this.renderConnectionInput(s, 'openaiBaseUrl'),
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
      m('label', {style: s.formLabel}, 'OpenAI Protocol'),
      m(
        'select',
        {
          style: s.formSelect,
          value: protocol,
          onchange: (e: Event) => {
            this.form.connection.openaiProtocol = (e.target as HTMLSelectElement)
              .value as OpenAIProtocol;
          },
        },
        [
          m('option', {value: 'responses'}, 'Responses'),
          m('option', {value: 'chat_completions'}, 'Chat Completions'),
        ],
      ),
      m(
        'div',
        {style: s.formHint},
        'Use Responses for official OpenAI. Use Chat Completions for Ollama and most OpenAI-compatible gateways.',
      ),
    ]);
  }

  private renderConnectionInput(
    s: ReturnType<typeof getStyles>,
    field: string,
    labelOverride?: string,
  ): m.Children {
    const meta = CONNECTION_FIELD_LABELS[field] || {
      label: field,
      type: 'text',
      placeholder: '',
    };
    const conn = this.form.connection as Record<string, string>;
    return m('div', {key: field, style: s.formField}, [
      m('label', {style: s.formLabel}, labelOverride || meta.label),
      m(`input[type=${meta.type}]`, {
        style: s.formInput,
        value: conn[field] || '',
        oninput: (e: Event) => {
          conn[field] = (e.target as HTMLInputElement).value;
        },
        placeholder: meta.placeholder,
      }),
      CONNECTION_FIELD_HINTS[field]
        ? m('div', {style: s.formHint}, CONNECTION_FIELD_HINTS[field])
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
          label: 'AWS Bearer Token',
          type: 'password',
          placeholder: 'Bearer token for Bedrock access',
        },
      ],
      accessKey: [
        {
          key: 'awsAccessKeyId',
          label: 'AWS Access Key ID',
          type: 'text',
          placeholder: 'AKIA...',
        },
        {
          key: 'awsSecretAccessKey',
          label: 'AWS Secret Access Key',
          type: 'password',
          placeholder: 'Secret key...',
        },
        {
          key: 'awsSessionToken',
          label: 'Session Token (optional)',
          type: 'password',
          placeholder: 'Temporary session token...',
        },
      ],
      profile: [
        {
          key: 'awsProfile',
          label: 'AWS Profile Name',
          type: 'text',
          placeholder: 'default',
        },
      ],
    };

    return m('div', [
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, 'AWS Region'),
        m('input[type=text]', {
          style: s.formInput,
          value: conn['awsRegion'] || '',
          oninput: (e: Event) => {
            conn['awsRegion'] = (e.target as HTMLInputElement).value;
          },
          placeholder: 'us-east-1 (leave empty to use AWS_REGION env)',
        }),
        m(
          'div',
          {style: s.formHint},
          'Leave empty to inherit from AWS_REGION environment variable',
        ),
      ]),

      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, 'API Key (optional)'),
        m('input[type=password]', {
          style: s.formInput,
          value: conn['apiKey'] || '',
          oninput: (e: Event) => {
            conn['apiKey'] = (e.target as HTMLInputElement).value;
          },
          placeholder: 'sk-ant-... (for Anthropic proxy, if applicable)',
        }),
        m(
          'div',
          {style: s.formHint},
          'Only needed if using an Anthropic API proxy in front of Bedrock',
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
            'Advanced Configuration',
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
              m('label', {style: {...s.formLabel, margin: 0}}, 'Use Bedrock'),
              m(
                'span',
                {style: {fontSize: '11px', color: t.textMuted}},
                '(CLAUDE_CODE_USE_BEDROCK=1)',
              ),
            ],
          ),

          m('div', {key: 'adv-authmethod', style: s.formField}, [
            m('label', {style: s.formLabel}, 'Authentication Method'),
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
                  'Access Key (AWS_ACCESS_KEY_ID + Secret)',
                ),
                m(
                  'option',
                  {value: 'bearer'},
                  'Bearer Token (AWS_BEARER_TOKEN_BEDROCK)',
                ),
                m('option', {value: 'profile'}, 'AWS Profile (AWS_PROFILE)'),
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
            m('label', {style: s.formLabel}, 'Bedrock Base URL (optional)'),
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
              'Maps to ANTHROPIC_BEDROCK_BASE_URL. Leave empty for default.',
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
        m('label', {style: s.formLabel}, label),
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
                m('option', {value: ''}, '-- Select --'),
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
              placeholder: defaultVal || 'Model ID',
            }),
        defaultVal
          ? m('div', {style: s.formHint}, `Default: ${defaultVal}`)
          : null,
      ]);

    return m('div', [
      modelField('Primary Model', 'primary', template?.defaultModels.primary),
      modelField('Light Model', 'light', template?.defaultModels.light),
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, 'Sub-agent Model (optional)'),
        m('input[type=text]', {
          style: s.formInput,
          value: this.form.models.subAgent || '',
          oninput: (e: Event) => {
            this.form.models.subAgent =
              (e.target as HTMLInputElement).value || undefined;
          },
          placeholder: 'Leave empty to inherit primary',
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
    ) =>
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, label),
        m('input[type=number]', {
          style: s.formInput,
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
        numField('Max Turns', 'maxTurns', '30'),
        m('div', {style: s.formField}, [
          m('label', {style: s.formLabel}, 'Effort Level'),
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
              m('option', {value: ''}, '-- Default --'),
              m('option', {value: 'low'}, 'Low'),
              m('option', {value: 'medium'}, 'Medium'),
              m('option', {value: 'high'}, 'High'),
            ],
          ),
        ]),
        numField('Max Budget (USD)', 'maxBudgetUsd', '5'),
        numField('Full Per-turn Timeout (ms)', 'fullPerTurnMs', '60000'),
        numField('Quick Per-turn Timeout (ms)', 'quickPerTurnMs', '40000'),
        numField('Verifier Timeout (ms)', 'verifierTimeoutMs', '60000'),
        numField('Classifier Timeout (ms)', 'classifierTimeoutMs', '30000'),
        boolField('Enable Sub-agents', 'enableSubAgents'),
        boolField('Enable Verification', 'enableVerification'),
      ],
    );
  }
}
