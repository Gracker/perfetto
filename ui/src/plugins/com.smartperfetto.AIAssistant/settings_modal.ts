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

import m from 'mithril';
import type {AISettings} from './ai_panel';

export interface SettingsModalAttrs {
  settings: AISettings;
  onClose: () => void;
  onSave: (settings: AISettings) => void;
  onTest: () => Promise<boolean>;
}

// Modern color scheme
const COLORS = {
  primary: '#6366f1',
  primaryHover: '#4f46e5',
  primaryLight: 'rgba(99, 102, 241, 0.1)',
  success: '#10b981',
  successLight: 'rgba(16, 185, 129, 0.1)',
  warning: '#f59e0b',
  warningLight: 'rgba(245, 158, 11, 0.1)',
  error: '#ef4444',
  errorLight: 'rgba(239, 68, 68, 0.1)',
  info: '#3b82f6',
  infoLight: 'rgba(59, 130, 246, 0.1)',
};

// Inline styles for modal
const MODAL_STYLES = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    zIndex: 10000,
    animation: 'fadeIn 0.2s ease-out',
  },
  modal: {
    backgroundColor: 'var(--background, #1e1e1e)',
    color: 'var(--text, #e0e0e0)',
    borderRadius: '12px',
    width: '540px',
    maxWidth: '90vw',
    maxHeight: '85vh',
    overflow: 'hidden' as const,
    display: 'flex' as const,
    flexDirection: 'column' as const,
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.4), 0 0 1px rgba(255, 255, 255, 0.1)',
    border: '1px solid var(--border, #333)',
    animation: 'slideUp 0.3s ease-out',
  },
  header: {
    display: 'flex' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    padding: '20px 24px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--background2, #252525)',
  },
  headerLeft: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '12px',
  },
  headerIcon: {
    fontSize: '20px',
  },
  title: {
    margin: 0,
    fontSize: '18px',
    fontWeight: 600,
    color: 'var(--text)',
  },
  closeBtn: {
    background: 'transparent',
    border: 'none',
    fontSize: '22px',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    padding: '4px',
    width: '32px',
    height: '32px',
    display: 'flex' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: '6px',
    transition: 'all 0.15s ease',
  },
  content: {
    padding: '24px',
    overflowY: 'auto' as const,
    flex: 1,
  },
  section: {
    marginBottom: '24px',
  },
  sectionTitle: {
    margin: '0 0 16px 0',
    fontSize: '13px',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
  },
  radioGroup: {
    display: 'grid' as const,
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '12px',
  },
  radioCard: {
    position: 'relative' as const,
    border: '2px solid var(--border)',
    borderRadius: '10px',
    padding: '14px 12px',
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    background: 'var(--background)',
  },
  radioCardSelected: {
    borderColor: COLORS.primary,
    background: COLORS.primaryLight,
  },
  radioCardHover: {
    borderColor: 'var(--border-hover)',
  },
  radioInput: {
    position: 'absolute' as const,
    opacity: 0,
    pointerEvents: 'none' as const,
  },
  radioIcon: {
    fontSize: '24px',
    marginBottom: '8px',
    display: 'block' as const,
  },
  radioTitle: {
    fontSize: '14px',
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: '4px',
  },
  radioDescription: {
    fontSize: '12px',
    color: 'var(--text-secondary)',
    lineHeight: '1.4',
  },
  field: {
    marginBottom: '20px',
  },
  fieldLabel: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    marginBottom: '8px',
    fontSize: '14px',
    fontWeight: 500,
    color: 'var(--text)',
  },
  fieldIcon: {
    fontSize: '14px',
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    backgroundColor: 'var(--background2, #252525)',
    color: 'var(--text)',
    fontSize: '14px',
    boxSizing: 'border-box' as const,
    transition: 'all 0.15s ease',
    fontFamily: 'inherit',
  },
  inputFocus: {
    borderColor: COLORS.primary,
    outline: 'none',
    boxShadow: `0 0 0 3px ${COLORS.primaryLight}`,
  },
  select: {
    width: '100%',
    padding: '11px 14px',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    backgroundColor: 'var(--background2, #252525)',
    color: 'var(--text)',
    fontSize: '14px',
    cursor: 'pointer',
    transition: 'all 0.15s ease',
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23888' d='M6 9L1 4h10z'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'calc(100% - 12px) center',
    paddingRight: '36px',
  },
  hint: {
    fontSize: '12px',
    color: 'var(--text-secondary)',
    marginTop: '6px',
    lineHeight: '1.4',
  },
  alertBox: {
    display: 'flex' as const,
    gap: '10px',
    padding: '12px 14px',
    borderRadius: '8px',
    fontSize: '13px',
    lineHeight: '1.4',
  },
  alertInfo: {
    background: COLORS.infoLight,
    border: `1px solid ${COLORS.info}40`,
    color: COLORS.info,
  },
  alertWarning: {
    background: COLORS.warningLight,
    border: `1px solid ${COLORS.warning}40`,
    color: COLORS.warning,
  },
  alertError: {
    background: COLORS.errorLight,
    border: `1px solid ${COLORS.error}40`,
    color: COLORS.error,
  },
  alertIcon: {
    fontSize: '16px',
    flexShrink: 0,
  },
  testBtn: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    padding: '10px 18px',
    border: '1px solid var(--border)',
    borderRadius: '8px',
    backgroundColor: 'var(--background2, #252525)',
    color: 'var(--text)',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    transition: 'all 0.15s ease',
  },
  testBtnDisabled: {
    opacity: 0.6,
    cursor: 'not-allowed',
  },
  testResult: {
    display: 'flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    fontSize: '13px',
    fontWeight: 500,
    padding: '8px 14px',
    borderRadius: '6px',
  },
  testSuccess: {
    background: COLORS.successLight,
    color: COLORS.success,
  },
  testError: {
    background: COLORS.errorLight,
    color: COLORS.error,
  },
  footer: {
    display: 'flex' as const,
    justifyContent: 'flex-end' as const,
    gap: '10px',
    padding: '16px 24px',
    borderTop: '1px solid var(--border)',
    background: 'var(--background2, #252525)',
  },
  btn: {
    display: 'inline-flex' as const,
    alignItems: 'center' as const,
    gap: '6px',
    padding: '10px 20px',
    border: 'none',
    borderRadius: '8px',
    fontSize: '14px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'all 0.15s ease',
  },
  btnSecondary: {
    backgroundColor: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border)',
  },
  btnPrimary: {
    backgroundColor: COLORS.primary,
    color: 'white',
  },
  btnPrimaryHover: {
    backgroundColor: COLORS.primaryHover,
  },
};

export class SettingsModal implements m.ClassComponent<SettingsModalAttrs> {
  private settings!: AISettings;
  private isTesting = false;
  private testResult: boolean | null = null;
  private availableModels: string[] = [];
  private isLoadingModels = false;

  oninit(vnode: m.Vnode<SettingsModalAttrs>) {
    this.settings = {...vnode.attrs.settings};
    this.loadAvailableModels();
  }

  async loadAvailableModels() {
    if (this.settings.provider === 'ollama') {
      this.isLoadingModels = true;
      m.redraw();
      try {
        const response = await fetch(`${this.settings.ollamaUrl}/api/tags`);
        if (response.ok) {
          const data = await response.json();
          this.availableModels = data.models?.map((m: any) => m.name) || [];
        }
      } catch {
        // Ignore errors - will show hardcoded options as fallback
      } finally {
        this.isLoadingModels = false;
        m.redraw();
      }
    }
  }

  view(vnode: m.Vnode<SettingsModalAttrs>) {
    const modelOptions = this.availableModels.length > 0
      ? this.availableModels.map((model) =>
          m('option', {value: model}, model)
        )
      : [m('option', {value: ''}, 'No models found - check endpoint')];

    return m(
      'div',
      {style: MODAL_STYLES.overlay},
      m(
        'div',
        {style: MODAL_STYLES.modal},
        [
          m('div', {style: MODAL_STYLES.header}, [
            m('div', {style: MODAL_STYLES.headerLeft}, [
              m('span', {style: MODAL_STYLES.headerIcon}, '⚙️'),
              m('h3', {style: MODAL_STYLES.title}, 'AI Assistant Settings'),
            ]),
            m(
              'button',
              {
                style: MODAL_STYLES.closeBtn,
                onclick: () => vnode.attrs.onClose(),
              },
              '×'
            ),
          ]),

          m('div', {style: MODAL_STYLES.content}, [
            // Provider Selection
            m('div', {style: MODAL_STYLES.section}, [
              m('h4', {style: MODAL_STYLES.sectionTitle}, 'AI Provider'),
              m('div', {style: MODAL_STYLES.radioGroup}, [
                // DeepSeek Card
                m('label', {
                  style: {
                    ...MODAL_STYLES.radioCard,
                    ...(this.settings.provider === 'deepseek' ? MODAL_STYLES.radioCardSelected : {}),
                  },
                }, [
                  m('input[type=radio]', {
                    style: MODAL_STYLES.radioInput,
                    name: 'provider',
                    value: 'deepseek',
                    checked: this.settings.provider === 'deepseek',
                    onchange: () => {
                      this.settings.provider = 'deepseek';
                    },
                  }),
                  m('span', {style: MODAL_STYLES.radioIcon}, '🚀'),
                  m('div', {style: MODAL_STYLES.radioTitle}, 'DeepSeek AI'),
                  m('div', {style: MODAL_STYLES.radioDescription}, 'Fast & cost-effective'),
                ]),

                // Ollama Card
                m('label', {
                  style: {
                    ...MODAL_STYLES.radioCard,
                    ...(this.settings.provider === 'ollama' ? MODAL_STYLES.radioCardSelected : {}),
                  },
                }, [
                  m('input[type=radio]', {
                    style: MODAL_STYLES.radioInput,
                    name: 'provider',
                    value: 'ollama',
                    checked: this.settings.provider === 'ollama',
                    onchange: () => {
                      this.settings.provider = 'ollama';
                      this.loadAvailableModels();
                    },
                  }),
                  m('span', {style: MODAL_STYLES.radioIcon}, '🏠'),
                  m('div', {style: MODAL_STYLES.radioTitle}, 'Local AI'),
                  m('div', {style: MODAL_STYLES.radioDescription}, 'Runs on your machine'),
                ]),

                // OpenAI Card
                m('label', {
                  style: {
                    ...MODAL_STYLES.radioCard,
                    ...(this.settings.provider === 'openai' ? MODAL_STYLES.radioCardSelected : {}),
                  },
                }, [
                  m('input[type=radio]', {
                    style: MODAL_STYLES.radioInput,
                    name: 'provider',
                    value: 'openai',
                    checked: this.settings.provider === 'openai',
                    onchange: () => {
                      this.settings.provider = 'openai';
                    },
                  }),
                  m('span', {style: MODAL_STYLES.radioIcon}, '🔌'),
                  m('div', {style: MODAL_STYLES.radioTitle}, 'OpenAI'),
                  m('div', {style: MODAL_STYLES.radioDescription}, 'GPT-4 & compatible APIs'),
                ]),
              ]),
            ]),

            // Ollama Configuration
            this.settings.provider === 'ollama'
              ? m('div', {style: MODAL_STYLES.section}, [
                  m('h4', {style: MODAL_STYLES.sectionTitle}, 'Ollama Configuration'),
                  m('div', {style: {...MODAL_STYLES.alertBox, ...MODAL_STYLES.alertWarning}}, [
                    m('span', {style: MODAL_STYLES.alertIcon}, '⚠️'),
                    m('div', [
                      m('strong', {}, 'CORS Required: '),
                      m('span', {}, 'Ollama must be started with OLLAMA_ORIGINS="*"'),
                      m('br'),
                      m('code', {style: {background: 'rgba(0,0,0,0.2)', padding: '2px 6px', borderRadius: '4px', fontSize: '12px'}}, 'OLLAMA_ORIGINS="*" ollama serve'),
                    ]),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🔗'),
                      'Endpoint',
                    ]),
                    m('input[type=text]', {
                      style: MODAL_STYLES.input,
                      value: this.settings.ollamaUrl,
                      onchange: (e: Event) => {
                        this.settings.ollamaUrl = (e.target as HTMLInputElement).value;
                      },
                      placeholder: 'http://localhost:11434',
                    }),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '📦'),
                      'Model',
                    ]),
                    this.isLoadingModels
                      ? m('div', {style: {...MODAL_STYLES.hint, display: 'flex', alignItems: 'center', gap: '6px'}}, [
                          m('span', {style: {animation: 'spin 1s linear infinite'}}, '⏳'),
                          'Loading models...',
                        ])
                      : m(
                          'select',
                          {
                            style: MODAL_STYLES.select,
                            value: this.settings.ollamaModel,
                            onchange: (e: Event) => {
                              this.settings.ollamaModel = (e.target as HTMLSelectElement).value;
                            },
                          },
                          modelOptions
                        ),
                    this.availableModels.length === 0 && !this.isLoadingModels
                      ? m('div', {style: {...MODAL_STYLES.hint, color: COLORS.error}}, 'Could not fetch models. Make sure Ollama is running with CORS enabled.')
                      : null,
                  ]),
                ])
              : null,

            // OpenAI Configuration
            this.settings.provider === 'openai'
              ? m('div', {style: MODAL_STYLES.section}, [
                  m('h4', {style: MODAL_STYLES.sectionTitle}, 'OpenAI Configuration'),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🔗'),
                      'API Endpoint',
                    ]),
                    m('input[type=text]', {
                      style: MODAL_STYLES.input,
                      value: this.settings.openaiUrl,
                      onchange: (e: Event) => {
                        this.settings.openaiUrl = (e.target as HTMLInputElement).value;
                      },
                      placeholder: 'https://api.openai.com/v1',
                    }),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🤖'),
                      'Model',
                    ]),
                    m('input[type=text]', {
                      style: MODAL_STYLES.input,
                      value: this.settings.openaiModel,
                      onchange: (e: Event) => {
                        this.settings.openaiModel = (e.target as HTMLInputElement).value;
                      },
                      placeholder: 'gpt-4o',
                    }),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🔑'),
                      'API Key',
                    ]),
                    m('input[type=password]', {
                      style: MODAL_STYLES.input,
                      value: this.settings.openaiApiKey,
                      onchange: (e: Event) => {
                        this.settings.openaiApiKey = (e.target as HTMLInputElement).value;
                      },
                      placeholder: 'sk-...',
                    }),
                  ]),
                ])
              : null,

            // DeepSeek Configuration
            this.settings.provider === 'deepseek'
              ? m('div', {style: MODAL_STYLES.section}, [
                  m('h4', {style: MODAL_STYLES.sectionTitle}, 'DeepSeek Configuration'),
                  m('div', {style: {...MODAL_STYLES.alertBox, ...MODAL_STYLES.alertInfo}}, [
                    m('span', {style: MODAL_STYLES.alertIcon}, 'ℹ️'),
                    m('div', [
                      m('strong', {}, 'DeepSeek AI: '),
                      m('span', {}, 'Fast and cost-effective AI service for trace analysis.'),
                      m('br'),
                      m('span', {style: {fontSize: '12px'}}, 'Get your API key at '),
                      m('a', {
                        href: 'https://platform.deepseek.com',
                        target: '_blank',
                        style: {color: COLORS.primary, textDecoration: 'none'},
                      }, 'platform.deepseek.com'),
                    ]),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🤖'),
                      'Model',
                    ]),
                    m('select', {
                      style: MODAL_STYLES.select,
                      value: (this.settings as any).deepseekModel || 'deepseek-chat',
                      onchange: (e: Event) => {
                        (this.settings as any).deepseekModel = (e.target as HTMLSelectElement).value;
                      },
                    }, [
                      m('option', {value: 'deepseek-chat'}, 'deepseek-chat (V3 - General)'),
                      m('option', {value: 'deepseek-coder'}, 'deepseek-coder (Code Specialized)'),
                    ]),
                  ]),
                  m('div', {style: MODAL_STYLES.field}, [
                    m('label', {style: MODAL_STYLES.fieldLabel}, [
                      m('span', {style: MODAL_STYLES.fieldIcon}, '🔑'),
                      'API Key',
                    ]),
                    m('input[type=password]', {
                      style: MODAL_STYLES.input,
                      value: (this.settings as any).deepseekApiKey || '',
                      onchange: (e: Event) => {
                        (this.settings as any).deepseekApiKey = (e.target as HTMLInputElement).value;
                      },
                      placeholder: 'sk-xxxxxxxxxxxxxxxxxxxxxxxx',
                    }),
                  ]),
                ])
              : null,


            // Test Connection
            m('div', {style: MODAL_STYLES.section}, [
              m('div', {style: {display: 'flex', alignItems: 'center', gap: '12px'}}, [
                m(
                  'button',
                  {
                    style: {
                      ...MODAL_STYLES.testBtn,
                      ...(this.isTesting ? MODAL_STYLES.testBtnDisabled : {}),
                    },
                    onclick: async () => {
                      this.isTesting = true;
                      this.testResult = null;
                      m.redraw();

                      const result = await vnode.attrs.onTest();
                      this.testResult = result;
                      this.isTesting = false;
                      m.redraw();
                    },
                    disabled: this.isTesting,
                  },
                  this.isTesting ? '⏳ Testing...' : '🔌 Test Connection'
                ),
                this.testResult === true
                  ? m('div', {style: {...MODAL_STYLES.testResult, ...MODAL_STYLES.testSuccess}}, [
                      m('span', '✓'),
                      m('span', 'Connection successful!'),
                    ])
                  : null,
                this.testResult === false
                  ? m('div', {style: {...MODAL_STYLES.testResult, ...MODAL_STYLES.testError}}, [
                      m('span', '✗'),
                      m('span', 'Connection failed. Check your settings.'),
                    ])
                  : null,
              ]),
            ]),
          ]),

          // Footer
          m('div', {style: MODAL_STYLES.footer}, [
            m(
              'button',
              {
                style: {...MODAL_STYLES.btn, ...MODAL_STYLES.btnSecondary},
                onclick: () => vnode.attrs.onClose(),
              },
              'Cancel'
            ),
            m(
              'button',
              {
                style: {...MODAL_STYLES.btn, ...MODAL_STYLES.btnPrimary},
                onclick: () => vnode.attrs.onSave(this.settings),
              },
              '💾 Save Settings'
            ),
          ]),
        ]
      )
    );
  }
}
