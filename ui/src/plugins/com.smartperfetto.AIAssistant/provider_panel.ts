// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {
  ProviderType,
  ProviderTuning,
  ProviderConfig,
  ProviderTemplate,
  ProviderPanelAttrs,
  FormState,
  TYPE_ICONS,
  CATEGORY_LABELS,
  CONNECTION_FIELD_LABELS,
  buildHeaders,
  apiUrl,
  createEmptyForm,
} from './provider_types';
import {getTokens, STYLES as getStyles} from './provider_styles';

export {ProviderPanelAttrs};

export class ProviderPanel implements m.ClassComponent<ProviderPanelAttrs> {
  private providers: ProviderConfig[] = [];
  private templates: ProviderTemplate[] = [];
  private loading = true;
  private error: string | null = null;
  private success: string | null = null;
  private view_mode: 'list' | 'add' | 'edit' = 'list';
  private editingId: string | null = null;
  private form: FormState = createEmptyForm();
  private testingId: string | null = null;
  private testResult: {success: boolean; latencyMs?: number; error?: string} | null = null;
  private deleting: string | null = null;
  private backendUrl = '';
  private apiKey?: string;

  oninit(vnode: m.Vnode<ProviderPanelAttrs>) {
    this.backendUrl = vnode.attrs.backendUrl;
    this.apiKey = vnode.attrs.apiKey;
    this.loadData();
  }

  onupdate(vnode: m.Vnode<ProviderPanelAttrs>) {
    if (vnode.attrs.backendUrl !== this.backendUrl || vnode.attrs.apiKey !== this.apiKey) {
      this.backendUrl = vnode.attrs.backendUrl;
      this.apiKey = vnode.attrs.apiKey;
      this.loadData();
    }
  }

  private async loadData() {
    this.loading = true;
    this.error = null;
    m.redraw();

    try {
      const [providersRes, templatesRes] = await Promise.all([
        fetch(apiUrl(this.backendUrl, ''), {headers: buildHeaders(this.apiKey)}),
        fetch(apiUrl(this.backendUrl, '/templates'), {headers: buildHeaders(this.apiKey)}),
      ]);

      if (!providersRes.ok) throw new Error(`Failed to load providers: ${providersRes.status}`);
      if (!templatesRes.ok) throw new Error(`Failed to load templates: ${templatesRes.status}`);

      const providersData = await providersRes.json();
      const templatesData = await templatesRes.json();

      this.providers = providersData.providers || [];
      this.templates = templatesData.templates || [];
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Failed to load provider data';
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async activateProvider(id: string) {
    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}/activate`), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`Activation failed: ${res.status}`);
      this.success = 'Provider activated successfully';
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Activation failed';
      m.redraw();
    }
  }

  private async deleteProvider(id: string) {
    this.deleting = id;
    m.redraw();

    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}`), {
        method: 'DELETE',
        headers: buildHeaders(this.apiKey),
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      this.success = 'Provider deleted';
      this.deleting = null;
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Delete failed';
      this.deleting = null;
      m.redraw();
    }
  }

  private async testConnection(id: string) {
    this.testingId = id;
    this.testResult = null;
    m.redraw();

    try {
      const res = await fetch(apiUrl(this.backendUrl, `/${id}/test`), {
        method: 'POST',
        headers: buildHeaders(this.apiKey),
      });
      const data = await res.json();
      const result = data.result || data;
      this.testResult = {
        success: result.success,
        latencyMs: result.latencyMs,
        error: result.error,
      };
    } catch (e: unknown) {
      this.testResult = {
        success: false,
        error: e instanceof Error ? e.message : 'Connection test failed',
      };
    } finally {
      this.testingId = null;
      m.redraw();
    }
  }

  private async saveProvider() {
    const template = this.templates.find((t) => t.type === this.form.type);
    const body: Record<string, unknown> = {
      name: this.form.name,
      type: this.form.type,
      models: {
        primary: this.form.models.primary || template?.defaultModels.primary || '',
        light: this.form.models.light || template?.defaultModels.light || '',
        ...(this.form.models.subAgent ? {subAgent: this.form.models.subAgent} : {}),
      },
      connection: this.form.connection,
    };

    if (this.form.showTuning && Object.keys(this.form.tuning).length > 0) {
      body.tuning = this.form.tuning;
    }

    try {
      let res: Response;
      if (this.view_mode === 'edit' && this.editingId) {
        res = await fetch(apiUrl(this.backendUrl, `/${this.editingId}`), {
          method: 'PATCH',
          headers: buildHeaders(this.apiKey),
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch(apiUrl(this.backendUrl, ''), {
          method: 'POST',
          headers: buildHeaders(this.apiKey),
          body: JSON.stringify(body),
        });
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error((errData as {error?: string}).error || `Save failed: ${res.status}`);
      }

      this.success = this.view_mode === 'edit' ? 'Provider updated' : 'Provider created';
      this.view_mode = 'list';
      this.editingId = null;
      this.form = createEmptyForm();
      await this.loadData();
      this.clearSuccessAfterDelay();
    } catch (e: unknown) {
      this.error = e instanceof Error ? e.message : 'Save failed';
      m.redraw();
    }
  }

  private startEdit(provider: ProviderConfig) {
    this.view_mode = 'edit';
    this.editingId = provider.id;
    this.form = {
      name: provider.name,
      type: provider.type,
      models: {...provider.models},
      connection: {...provider.connection},
      tuning: provider.tuning ? {...provider.tuning} : {},
      showTuning: !!provider.tuning && Object.keys(provider.tuning).length > 0,
    };
    this.error = null;
    this.success = null;
    this.testResult = null;
    m.redraw();
  }

  private startAdd() {
    this.view_mode = 'add';
    this.editingId = null;
    this.form = createEmptyForm();
    this.error = null;
    this.success = null;
    this.testResult = null;

    const firstTemplate = this.templates[0];
    if (firstTemplate) {
      this.form.type = firstTemplate.type;
      this.form.models = {...firstTemplate.defaultModels};
    }
    m.redraw();
  }

  private cancelForm() {
    this.view_mode = 'list';
    this.editingId = null;
    this.form = createEmptyForm();
    this.error = null;
    this.testResult = null;
  }

  private clearSuccessAfterDelay() {
    setTimeout(() => {
      this.success = null;
      m.redraw();
    }, 3000);
  }

  private onTypeChange(type: ProviderType) {
    this.form.type = type;
    const template = this.templates.find((t) => t.type === type);
    if (template) {
      this.form.models = {...template.defaultModels};
      this.form.connection = {};
    }
  }

  view(_vnode: m.Vnode<ProviderPanelAttrs>): m.Children {
    if (this.view_mode === 'add' || this.view_mode === 'edit') {
      return this.renderForm();
    }
    return this.renderList();
  }

  private renderList(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    return m('div', {style: s.container}, [
      this.error ? m('div', {style: s.errorBanner}, [
        m('span', '⚠️'),
        m('span', this.error),
      ]) : null,
      this.success ? m('div', {style: s.successBanner}, [
        m('span', '✅'),
        m('span', this.success),
      ]) : null,

      m('div', {style: s.header}, [
        m('div', [
          m('h3', {style: s.title}, 'Provider Management'),
          m('p', {style: s.subtitle}, 'Configure and switch between AI providers'),
        ]),
        m('button', {
          style: s.addBtn,
          onclick: () => this.startAdd(),
        }, '+ Add Provider'),
      ]),

      this.loading
        ? m('div', {style: s.loadingState}, [
            m('span', '⏳'),
            'Loading providers...',
          ])
        : this.providers.length === 0
          ? this.renderEmpty()
          : this.renderGrid(),

      this.renderTestResult(),
    ]);
  }

  private renderEmpty(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    return m('div', {style: s.emptyState}, [
      m('div', {style: s.emptyIcon}, '\u{1F50C}'),
      m('h4', {style: {margin: '0 0 8px', color: t.text}}, 'No providers configured'),
      m('p', {style: {margin: 0, fontSize: '14px'}}, 'Add a provider to start using AI analysis'),
      m('button', {
        style: {...s.btn, ...s.btnPrimary, marginTop: '16px'},
        onclick: () => this.startAdd(),
      }, '+ Add Your First Provider'),
    ]);
  }

  private renderGrid(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    return m('div', {style: s.grid},
      this.providers.map((p) => this.renderCard(p)),
    );
  }

  private renderCard(provider: ProviderConfig): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const isActive = provider.isActive;
    const cardStyle = {
      ...s.card,
      ...(isActive ? s.cardActive : {}),
    };

    return m('div', {style: cardStyle, key: provider.id}, [
      m('div', {style: s.cardHeader}, [
        m('div', {style: s.cardIcon}, TYPE_ICONS[provider.type] || '\u{1F527}'),
        m('div', {style: {flex: 1, minWidth: 0}}, [
          m('div', {style: s.cardName}, provider.name),
          m('div', {style: {display: 'flex', gap: '6px', marginTop: '4px', flexWrap: 'wrap' as const}}, [
            isActive
              ? m('span', {style: {...s.cardBadge, ...s.activeBadge}}, [
                  m('span', {style: {width: '6px', height: '6px', borderRadius: '50%', backgroundColor: t.accent, display: 'inline-block'}}),
                  'Active',
                ])
              : null,
            m('span', {style: {...s.cardBadge, ...s.categoryBadge}},
              CATEGORY_LABELS[provider.category] || provider.category),
          ]),
        ]),
      ]),

      m('div', {style: s.cardModels}, [
        m('div', `Primary: ${provider.models.primary}`),
        m('div', `Light: ${provider.models.light}`),
        provider.models.subAgent
          ? m('div', `Sub-agent: ${provider.models.subAgent}`)
          : null,
      ]),

      m('div', {style: s.cardActions}, [
        !isActive
          ? m('button', {
              style: s.actionBtn,
              onclick: () => this.activateProvider(provider.id),
              title: 'Activate',
            }, '⭐ Activate')
          : null,
        m('button', {
          style: s.actionBtn,
          onclick: () => this.testConnection(provider.id),
          disabled: this.testingId === provider.id,
          title: 'Test Connection',
        }, this.testingId === provider.id ? '⏳' : '\u{1F50C} Test'),
        m('button', {
          style: s.actionBtn,
          onclick: () => this.startEdit(provider),
          title: 'Edit',
        }, '✏️ Edit'),
        m('button', {
          style: {...s.actionBtn, ...s.actionBtnDanger},
          onclick: () => this.deleteProvider(provider.id),
          disabled: this.deleting === provider.id || isActive,
          title: isActive ? 'Cannot delete active provider' : 'Delete',
        }, this.deleting === provider.id ? '⏳' : '\u{1F5D1}️'),
      ]),
    ]);
  }

  private renderTestResult(): m.Children {
    if (!this.testResult) return null;

    const t = getTokens();
    const s = getStyles(t);
    const style = {
      ...s.testResult,
      ...(this.testResult.success
        ? {backgroundColor: `${t.success}15`, color: t.success, border: `1px solid ${t.success}`}
        : {backgroundColor: `${t.error}15`, color: t.error, border: `1px solid ${t.error}`}),
      marginTop: '16px',
    };

    return m('div', {style}, [
      this.testResult.success
        ? m('span', `✅ Connection successful${this.testResult.latencyMs ? ` (${this.testResult.latencyMs}ms)` : ''}`)
        : m('span', `❌ Connection failed: ${this.testResult.error || 'Unknown error'}`),
    ]);
  }

  private renderForm(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const template = this.templates.find((tmpl) => tmpl.type === this.form.type);
    // requiredFields from API are "connection.apiKey" format — strip prefix
    const requiredFields = (template?.requiredFields || ['connection.apiKey'])
      .map((f) => f.replace(/^connection\./, ''));
    const isEdit = this.view_mode === 'edit';

    return m('div', {style: s.container}, [
      this.error ? m('div', {style: s.errorBanner}, [
        m('span', '⚠️'),
        m('span', this.error),
      ]) : null,

      m('div', {style: s.header}, [
        m('div', [
          m('h3', {style: s.title}, isEdit ? 'Edit Provider' : 'Add Provider'),
          m('p', {style: s.subtitle}, isEdit ? 'Modify provider configuration' : 'Configure a new AI provider'),
        ]),
      ]),

      m('div', {style: s.form}, [
        // Type selector
        m('div', {style: s.formSection}, [
          m('h4', {style: s.formSectionTitle}, 'Provider Type'),
          m('div', {style: s.formField}, [
            m('select', {
              style: s.formSelect,
              value: this.form.type,
              onchange: (e: Event) => this.onTypeChange((e.target as HTMLSelectElement).value as ProviderType),
              disabled: isEdit,
            },
              this.templates.map((tmpl) =>
                m('option', {value: tmpl.type}, `${TYPE_ICONS[tmpl.type]} ${tmpl.displayName}`),
              ),
            ),
          ]),
        ]),

        // Name
        m('div', {style: s.formSection}, [
          m('h4', {style: s.formSectionTitle}, 'Name'),
          m('div', {style: s.formField}, [
            m('input[type=text]', {
              style: s.formInput,
              value: this.form.name,
              oninput: (e: Event) => {
                this.form.name = (e.target as HTMLInputElement).value;
              },
              placeholder: `My ${template?.displayName || 'Provider'}`,
            }),
          ]),
        ]),

        // Connection
        m('div', {style: s.formSection}, [
          m('h4', {style: s.formSectionTitle}, 'Connection'),
          ...requiredFields.map((field) => {
            const meta = CONNECTION_FIELD_LABELS[field] || {
              label: field,
              type: 'text',
              placeholder: '',
            };
            return m('div', {style: s.formField}, [
              m('label', {style: s.formLabel}, meta.label),
              m(`input[type=${meta.type}]`, {
                style: s.formInput,
                value: (this.form.connection as Record<string, string>)[field] || '',
                oninput: (e: Event) => {
                  (this.form.connection as Record<string, string>)[field] =
                    (e.target as HTMLInputElement).value;
                },
                placeholder: meta.placeholder,
              }),
            ]);
          }),
        ]),

        // Models
        m('div', {style: s.formSection}, [
          m('h4', {style: s.formSectionTitle}, 'Models'),
          m('div', {style: s.formField}, [
            m('label', {style: s.formLabel}, 'Primary Model'),
            template?.availableModels && template.availableModels.length > 0
              ? m('select', {
                  style: s.formSelect,
                  value: this.form.models.primary,
                  onchange: (e: Event) => {
                    this.form.models.primary = (e.target as HTMLSelectElement).value;
                  },
                }, [
                  m('option', {value: ''}, '-- Select --'),
                  ...template.availableModels.map((mdl) =>
                    m('option', {value: mdl.id}, `${mdl.name} (${mdl.tier})`),
                  ),
                ])
              : m('input[type=text]', {
                  style: s.formInput,
                  value: this.form.models.primary,
                  oninput: (e: Event) => {
                    this.form.models.primary = (e.target as HTMLInputElement).value;
                  },
                  placeholder: template?.defaultModels.primary || 'Model ID',
                }),
            template?.defaultModels.primary
              ? m('div', {style: s.formHint}, `Default: ${template.defaultModels.primary}`)
              : null,
          ]),
          m('div', {style: s.formField}, [
            m('label', {style: s.formLabel}, 'Light Model'),
            template?.availableModels && template.availableModels.length > 0
              ? m('select', {
                  style: s.formSelect,
                  value: this.form.models.light,
                  onchange: (e: Event) => {
                    this.form.models.light = (e.target as HTMLSelectElement).value;
                  },
                }, [
                  m('option', {value: ''}, '-- Select --'),
                  ...template.availableModels.map((mdl) =>
                    m('option', {value: mdl.id}, `${mdl.name} (${mdl.tier})`),
                  ),
                ])
              : m('input[type=text]', {
                  style: s.formInput,
                  value: this.form.models.light,
                  oninput: (e: Event) => {
                    this.form.models.light = (e.target as HTMLInputElement).value;
                  },
                  placeholder: template?.defaultModels.light || 'Model ID',
                }),
            template?.defaultModels.light
              ? m('div', {style: s.formHint}, `Default: ${template.defaultModels.light}`)
              : null,
          ]),
          m('div', {style: s.formField}, [
            m('label', {style: s.formLabel}, 'Sub-agent Model (optional)'),
            m('input[type=text]', {
              style: s.formInput,
              value: this.form.models.subAgent || '',
              oninput: (e: Event) => {
                this.form.models.subAgent = (e.target as HTMLInputElement).value || undefined;
              },
              placeholder: 'Leave empty to inherit primary',
            }),
          ]),
        ]),

        // Tuning (collapsible)
        m('div', {style: s.formSection}, [
          m('div', {
            style: s.tuningToggle,
            onclick: () => {
              this.form.showTuning = !this.form.showTuning;
            },
          }, [
            m('span', this.form.showTuning ? '▼' : '▶'),
            'Advanced Tuning',
          ]),
          this.form.showTuning ? this.renderTuningFields() : null,
        ]),

        // Actions
        m('div', {style: s.formActions}, [
          m('button', {
            style: {...s.btn, ...s.btnSecondary},
            onclick: () => this.cancelForm(),
          }, 'Cancel'),
          m('button', {
            style: {
              ...s.btn,
              ...s.btnPrimary,
              ...(!this.form.name ? s.btnDisabled : {}),
            },
            onclick: () => this.saveProvider(),
            disabled: !this.form.name,
          }, isEdit ? 'Save Changes' : 'Create Provider'),
        ]),
      ]),
    ]);
  }

  private renderTuningFields(): m.Children {
    const t = getTokens();
    const s = getStyles(t);
    const tuning = this.form.tuning;

    const numField = (label: string, key: keyof ProviderTuning, placeholder: string) =>
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

    const boolField = (label: string, key: 'enableSubAgents' | 'enableVerification') =>
      m('div', {style: {...s.formField, display: 'flex', alignItems: 'center', gap: '8px'}}, [
        m('input[type=checkbox]', {
          checked: tuning[key] ?? true,
          onchange: (e: Event) => {
            tuning[key] = (e.target as HTMLInputElement).checked;
          },
        }),
        m('label', {style: {...s.formLabel, margin: 0}}, label),
      ]);

    return m('div', {style: {paddingLeft: '12px', borderLeft: `2px solid ${t.border}`}}, [
      numField('Max Turns', 'maxTurns', '30'),
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, 'Effort Level'),
        m('select', {
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
        }, [
          m('option', {value: ''}, '-- Default --'),
          m('option', {value: 'low'}, 'Low'),
          m('option', {value: 'medium'}, 'Medium'),
          m('option', {value: 'high'}, 'High'),
        ]),
      ]),
      numField('Max Budget (USD)', 'maxBudgetUsd', '5'),
      numField('Full Per-turn Timeout (ms)', 'fullPerTurnMs', '60000'),
      numField('Quick Per-turn Timeout (ms)', 'quickPerTurnMs', '40000'),
      numField('Verifier Timeout (ms)', 'verifierTimeoutMs', '60000'),
      numField('Classifier Timeout (ms)', 'classifierTimeoutMs', '30000'),
      boolField('Enable Sub-agents', 'enableSubAgents'),
      boolField('Enable Verification', 'enableVerification'),
    ]);
  }
}

