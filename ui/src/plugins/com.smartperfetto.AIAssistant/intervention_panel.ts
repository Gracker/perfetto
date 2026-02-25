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

/**
 * Intervention Panel Component
 *
 * Displays when the AI analysis requires user input to continue.
 * This component is part of the Agent-Driven Architecture v2.0.
 *
 * Intervention types:
 * - low_confidence: Analysis results are uncertain
 * - ambiguity: Multiple valid analysis directions
 * - timeout: Analysis taking too long
 * - agent_request: Agent explicitly needs user input
 * - circuit_breaker: Too many failures
 * - validation_required: Need user to confirm action
 */

import m from 'mithril';
import {
  InterventionState,
  InterventionOption,
  InterventionAction,
  InterventionType,
} from './types';

/**
 * Props for the InterventionPanel component.
 */
export interface InterventionPanelAttrs {
  state: InterventionState;
  sessionId: string | null;
  backendUrl: string;
  backendApiKey?: string;
  onStateChange: (state: Partial<InterventionState>) => void;
  onComplete: () => void;
}

/**
 * Get the title and description for an intervention type.
 */
function getInterventionInfo(type: InterventionType): { title: string; icon: string; color: string } {
  switch (type) {
    case 'low_confidence':
      return {
        title: '分析置信度较低',
        icon: '🤔',
        color: '#f59e0b', // amber
      };
    case 'ambiguity':
      return {
        title: '存在多个分析方向',
        icon: '🔀',
        color: '#6366f1', // indigo
      };
    case 'timeout':
      return {
        title: '分析时间较长',
        icon: '⏰',
        color: '#ef4444', // red
      };
    case 'agent_request':
      return {
        title: '需要更多信息',
        icon: '❓',
        color: '#3b82f6', // blue
      };
    case 'circuit_breaker':
      return {
        title: '检测到异常',
        icon: '⚠️',
        color: '#ef4444', // red
      };
    case 'validation_required':
      return {
        title: '需要确认操作',
        icon: '✅',
        color: '#22c55e', // green
      };
    default:
      return {
        title: '需要用户输入',
        icon: '📝',
        color: '#6b7280', // gray
      };
  }
}

/**
 * Get the button style for an action type.
 */
function getActionButtonStyle(action: InterventionAction, recommended: boolean): Record<string, string> {
  const baseStyle: Record<string, string> = {
    padding: '12px 20px',
    borderRadius: '8px',
    border: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500',
    transition: 'all 0.2s ease',
    width: '100%',
    textAlign: 'left',
  };

  if (recommended) {
    return {
      ...baseStyle,
      background: '#3b82f6',
      color: 'white',
      boxShadow: '0 2px 4px rgba(59, 130, 246, 0.3)',
    };
  }

  switch (action) {
    case 'abort':
      return {
        ...baseStyle,
        background: '#fef2f2',
        color: '#dc2626',
        border: '1px solid #fecaca',
      };
    case 'continue':
      return {
        ...baseStyle,
        background: '#f0fdf4',
        color: '#16a34a',
        border: '1px solid #bbf7d0',
      };
    case 'focus':
      return {
        ...baseStyle,
        background: '#eef2ff',
        color: '#4f46e5',
        border: '1px solid #c7d2fe',
      };
    default:
      return {
        ...baseStyle,
        background: '#f9fafb',
        color: '#374151',
        border: '1px solid #e5e7eb',
      };
  }
}

/**
 * Send the intervention response to the backend.
 */
async function sendInterventionResponse(
  backendUrl: string,
  sessionId: string,
  backendApiKey: string | undefined,
  interventionId: string,
  action: InterventionAction,
  selectedOptionId?: string,
  customInput?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const apiKey = (backendApiKey || '').trim();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) {
      headers['x-api-key'] = apiKey;
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${backendUrl}/api/agent/${sessionId}/intervene`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        interventionId,
        action,
        selectedOptionId,
        customInput,
      }),
    });

    const result = await response.json();
    return result;
  } catch (error: any) {
    return {
      success: false,
      error: error.message || 'Failed to send intervention response',
    };
  }
}

/**
 * Intervention Panel Component.
 *
 * Displays intervention options and handles user responses.
 */
export const InterventionPanel: m.Component<InterventionPanelAttrs> = {
  view(vnode) {
    const { state, sessionId, backendUrl, backendApiKey, onStateChange, onComplete } = vnode.attrs;

    if (!state.isActive || !state.intervention) {
      return null;
    }

    const intervention = state.intervention;
    const info = getInterventionInfo(intervention.type);

    // Handle option selection
    const handleOptionSelect = (option: InterventionOption) => {
      onStateChange({ selectedOptionId: option.id });
    };

    // Handle confirm button click
    const handleConfirm = async () => {
      if (!sessionId || !state.selectedOptionId) return;

      const selectedOption = intervention.options.find(
        o => o.id === state.selectedOptionId
      );
      if (!selectedOption) return;

      onStateChange({ isSending: true });

      const result = await sendInterventionResponse(
        backendUrl,
        sessionId,
        backendApiKey,
        intervention.interventionId,
        selectedOption.action,
        selectedOption.id,
        state.customInput || undefined,
      );

      if (result.success) {
        onStateChange({
          isActive: false,
          intervention: null,
          selectedOptionId: null,
          customInput: '',
          isSending: false,
        });
        onComplete();
      } else {
        console.error('[InterventionPanel] Failed to send response:', result.error);
        onStateChange({ isSending: false });
      }
    };

    // Handle abort button click
    const handleAbort = async () => {
      if (!sessionId) return;

      onStateChange({ isSending: true });

      // Send abort response (result not needed for abort)
      await sendInterventionResponse(
        backendUrl,
        sessionId,
        backendApiKey,
        intervention.interventionId,
        'abort',
      );

      onStateChange({
        isActive: false,
        intervention: null,
        selectedOptionId: null,
        customInput: '',
        isSending: false,
      });
      onComplete();
    };

    // Panel styles
    const panelStyle: Record<string, string> = {
      background: 'white',
      borderRadius: '12px',
      boxShadow: '0 4px 20px rgba(0, 0, 0, 0.15)',
      padding: '20px',
      margin: '16px 0',
      border: `2px solid ${info.color}`,
    };

    const headerStyle: Record<string, string> = {
      display: 'flex',
      alignItems: 'center',
      gap: '12px',
      marginBottom: '16px',
      paddingBottom: '12px',
      borderBottom: '1px solid #e5e7eb',
    };

    const titleStyle: Record<string, string> = {
      fontSize: '18px',
      fontWeight: '600',
      color: '#1f2937',
      margin: '0',
    };

    const contextStyle: Record<string, string> = {
      background: '#f9fafb',
      borderRadius: '8px',
      padding: '12px',
      marginBottom: '16px',
      fontSize: '13px',
      color: '#6b7280',
    };

    const optionsContainerStyle: Record<string, string> = {
      display: 'flex',
      flexDirection: 'column',
      gap: '8px',
      marginBottom: '16px',
    };

    const actionsStyle: Record<string, string> = {
      display: 'flex',
      justifyContent: 'flex-end',
      gap: '12px',
      paddingTop: '12px',
      borderTop: '1px solid #e5e7eb',
    };

    return m('div.intervention-panel', { style: panelStyle }, [
      // Header
      m('div.intervention-header', { style: headerStyle }, [
        m('span.intervention-icon', { style: { fontSize: '24px' } }, info.icon),
        m('h3.intervention-title', { style: titleStyle }, info.title),
      ]),

      // Context information
      m('div.intervention-context', { style: contextStyle }, [
        intervention.context.triggerReason && m('p', { style: { margin: '0 0 8px 0' } },
          intervention.context.triggerReason
        ),
        m('div', { style: { display: 'flex', gap: '16px', flexWrap: 'wrap' } }, [
          intervention.context.confidence > 0 && m('span',
            `置信度: ${Math.round(intervention.context.confidence * 100)}%`
          ),
          intervention.context.roundsCompleted > 0 && m('span',
            `已完成轮次: ${intervention.context.roundsCompleted}`
          ),
          intervention.context.findingsCount > 0 && m('span',
            `已发现: ${intervention.context.findingsCount} 个问题`
          ),
        ]),
      ]),

      // Options
      m('div.intervention-options', { style: optionsContainerStyle },
        intervention.options.map(option =>
          m('button.intervention-option', {
            key: option.id,
            style: {
              ...getActionButtonStyle(option.action, option.recommended || false),
              ...(state.selectedOptionId === option.id ? {
                outline: '2px solid #3b82f6',
                outlineOffset: '2px',
              } : {}),
            },
            onclick: () => handleOptionSelect(option),
            disabled: state.isSending,
          }, [
            m('div', { style: { fontWeight: '500', marginBottom: '4px' } }, [
              option.label,
              option.recommended && m('span', {
                style: {
                  marginLeft: '8px',
                  background: '#dbeafe',
                  color: '#1d4ed8',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                },
              }, '推荐'),
            ]),
            option.description && m('div', {
              style: { fontSize: '12px', opacity: 0.8 },
            }, option.description),
          ])
        )
      ),

      // Custom input (if custom action is selected)
      state.selectedOptionId && intervention.options.find(
        o => o.id === state.selectedOptionId && o.action === 'custom'
      ) && m('div.intervention-custom-input', {
        style: { marginBottom: '16px' },
      }, [
        m('textarea', {
          style: {
            width: '100%',
            minHeight: '80px',
            padding: '12px',
            borderRadius: '8px',
            border: '1px solid #d1d5db',
            fontSize: '14px',
            resize: 'vertical',
          },
          placeholder: '请输入您的具体需求...',
          value: state.customInput,
          oninput: (e: InputEvent) => {
            onStateChange({ customInput: (e.target as HTMLTextAreaElement).value });
          },
          disabled: state.isSending,
        }),
      ]),

      // Action buttons
      m('div.intervention-actions', { style: actionsStyle }, [
        m('button.intervention-abort', {
          style: {
            padding: '10px 20px',
            borderRadius: '6px',
            border: '1px solid #d1d5db',
            background: 'white',
            color: '#6b7280',
            cursor: 'pointer',
            fontSize: '14px',
          },
          onclick: handleAbort,
          disabled: state.isSending,
        }, '中止分析'),
        m('button.intervention-confirm', {
          style: {
            padding: '10px 20px',
            borderRadius: '6px',
            border: 'none',
            background: state.selectedOptionId ? '#3b82f6' : '#9ca3af',
            color: 'white',
            cursor: state.selectedOptionId ? 'pointer' : 'not-allowed',
            fontSize: '14px',
            fontWeight: '500',
          },
          onclick: handleConfirm,
          disabled: !state.selectedOptionId || state.isSending,
        }, state.isSending ? '发送中...' : '确认选择'),
      ]),
    ]);
  },
};

/**
 * Default initial state for intervention.
 */
export const DEFAULT_INTERVENTION_STATE: InterventionState = {
  isActive: false,
  intervention: null,
  selectedOptionId: null,
  customInput: '',
  isSending: false,
  timeoutRemaining: null,
};
