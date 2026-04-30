// SPDX-License-Identifier: AGPL-3.0-or-later

import m from 'mithril';

import {
  ProviderType,
  ProviderTuning,
  ProviderConfig,
  ProviderTemplate,
  FormState,
  TYPE_ICONS,
  CONNECTION_FIELD_LABELS,
  buildHeaders,
  apiUrl,
  createEmptyForm,
} from './provider_types';
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
        connection: {...editingProvider.connection},
        tuning: editingProvider.tuning ? {...editingProvider.tuning} : {},
        showTuning: !!editingProvider.tuning && Object.keys(editingProvider.tuning).length > 0,
      };
    } else if (cloneSource) {
      const src = cloneSource;
      this.isEdit = false;
      this.editingId = null;
      this.form = {
        name: `${src.name} (Copy)`,
        type: src.type,
        models: {...src.models},
        connection: {...src.connection},
        tuning: src.tuning ? {...src.tuning} : {},
        showTuning: !!src.tuning && Object.keys(src.tuning).length > 0,
      };
    } else {
      this.isEdit = false;
      this.editingId = null;
      this.form = createEmptyForm();
      const firstTemplate = templates[0];
      if (firstTemplate) {
        this.form.type = firstTemplate.type;
        this.form.models = {...firstTemplate.defaultModels};
      }
    }
    this.expandedSection = 'name';
  }

  private onTypeChange(type: ProviderType, templates: ProviderTemplate[]) {
    this.form.type = type;
    const template = templates.find((t) => t.type === type);
    if (template) {
      this.form.models = {...template.defaultModels};
      this.form.connection = {};
    }
    this.expandedSection = 'name';
  }

  private toggleSection(section: AccordionSection) {
    if (this.isEdit) {
      this.expandedSection = section;
    } else {
      this.expandedSection = this.expandedSection === section ? ('' as AccordionSection) : section;
    }
  }

  private isSectionComplete(section: AccordionSection, template?: ProviderTemplate): boolean {
    switch (section) {
      case 'name':
        return this.form.name.trim().length > 0;
      case 'connection': {
        if (!template) return false;
        const requiredFields = (template.requiredFields || [])
          .map((f) => f.replace(/^connection\./, ''));
        return requiredFields.every((f) => {
          const val = (this.form.connection as Record<string, string>)[f];
          return val && val.trim().length > 0;
        });
      }
      case 'models':
        return !!(this.form.models.primary?.trim() && this.form.models.light?.trim());
      case 'tuning':
        return true;
    }
  }

  private async saveProvider(attrs: ProviderFormAttrs) {
    const {templates, backendUrl, apiKey, onSaved} = attrs;
    const template = templates.find((tmpl) => tmpl.type === this.form.type);
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
        throw new Error((errData as {error?: string}).error || `Save failed: ${res.status}`);
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

    return m('div', {style: s.container}, [
      this.error
        ? m('div', {style: s.errorBanner}, [
            m('span', '⚠️'),
            m('span', this.error),
          ])
        : null,

      m('div', {style: s.header}, [
        m('div', [
          m('h3', {style: s.title}, this.isEdit ? 'Edit Provider' : 'Add Provider'),
          m('p', {style: s.subtitle}, this.isEdit ? 'Modify provider configuration' : 'Configure a new AI provider'),
        ]),
        m('button', {
          style: {...s.btn, ...s.btnSecondary},
          onclick: () => onCancel(),
        }, '← Back'),
      ]),

      this.renderTypeGrid(t, s, templates),

      m('div', {style: {marginTop: '16px'}},
        this.renderAccordion(t, s, template, vnode.attrs),
      ),
    ]);
  }

  private renderTypeGrid(
    _t: ReturnType<typeof getTokens>,
    s: ReturnType<typeof getStyles>,
    templates: ProviderTemplate[],
  ): m.Children {
    return m('div', {style: s.typeGrid},
      templates.map((tmpl) => {
        const isSelected = this.form.type === tmpl.type;
        const isDisabled = this.isEdit;
        const cardStyle = {
          ...s.typeCard,
          ...(isSelected ? s.typeCardSelected : {}),
          ...(isDisabled ? s.typeCardDisabled : {}),
        };
        return m('div', {
          key: tmpl.type,
          style: cardStyle,
          onclick: isDisabled ? undefined : () => {
            this.onTypeChange(tmpl.type, templates);
            m.redraw();
          },
        }, [
          m('div', {style: s.typeCardIcon}, TYPE_ICONS[tmpl.type] || '\u{1F527}'),
          m('div', {style: s.typeCardLabel}, tmpl.displayName),
        ]);
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
          m('div', {
            style: s.accordionHeader,
            onclick: () => {
              this.toggleSection(key);
              m.redraw();
            },
          }, [
            m('div', {style: s.accordionHeaderLeft}, [
              m('div', {
                style: {
                  ...s.accordionDot,
                  ...(isComplete ? s.accordionDotComplete : s.accordionDotPending),
                },
              }),
              m('span', {style: s.accordionTitle}, title),
            ]),
            m('span', {
              style: {
                ...s.accordionChevron,
                transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
              },
            }, '▼'),
          ]),

          isOpen
            ? m('div', {style: s.accordionBody},
                this.renderSectionContent(key, t, s, template, attrs),
              )
            : null,
        ]);
      }),

      m('div', {key: 'actions', style: {...s.formActions, marginTop: '16px'}}, [
        m('button', {
          style: {
            ...s.btn,
            ...s.btnPrimary,
            ...(!this.form.name || this.saving ? s.btnDisabled : {}),
          },
          disabled: !this.form.name || this.saving,
          onclick: () => this.saveProvider(attrs),
        }, this.saving ? 'Saving...' : (this.isEdit ? 'Save Changes' : 'Create Provider')),
      ]),
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
    ]);
  }

  private renderConnectionSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    if (!template) {
      return m('div', {style: s.formField}, m('span', {style: s.formHint}, 'Select a provider type first.'));
    }

    const requiredFields = (template.requiredFields || [])
      .map((f) => f.replace(/^connection\./, ''));

    if (requiredFields.length === 0) {
      return m('div', {style: s.formField}, m('span', {style: s.formHint}, 'No connection fields required.'));
    }

    return m('div', {},
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
            value: (this.form.connection as Record<string, string>)[field] || '',
            oninput: (e: Event) => {
              (this.form.connection as Record<string, string>)[field] =
                (e.target as HTMLInputElement).value;
            },
            placeholder: meta.placeholder,
          }),
        ]);
      }),
    );
  }

  private renderModelsSection(
    s: ReturnType<typeof getStyles>,
    template?: ProviderTemplate,
  ): m.Children {
    const hasAvailableModels = !!(template?.availableModels && template.availableModels.length > 0);

    const modelField = (label: string, key: 'primary' | 'light', defaultVal?: string) =>
      m('div', {style: s.formField}, [
        m('label', {style: s.formLabel}, label),
        hasAvailableModels
          ? m('select', {
              style: s.formSelect,
              value: this.form.models[key] || '',
              onchange: (e: Event) => {
                this.form.models[key] = (e.target as HTMLSelectElement).value;
              },
            }, [
              m('option', {value: ''}, '-- Select --'),
              ...(template?.availableModels || []).map((mdl) =>
                m('option', {value: mdl.id}, `${mdl.name} (${mdl.tier})`),
              ),
            ])
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
            this.form.models.subAgent = (e.target as HTMLInputElement).value || undefined;
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
