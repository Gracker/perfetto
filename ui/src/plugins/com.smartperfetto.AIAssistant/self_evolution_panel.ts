// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import {
  createSelfEvolutionApi,
  type SelfEvolutionApi,
  type SelfEvolutionOperationEvent,
  type SelfEvolutionProposal,
  type SelfEvolutionSnapshot,
} from './self_evolution_api';
import {uiText} from './ui_language';

export interface SelfEvolutionPanelAttrs {
  backendUrl: string;
  apiKey?: string;
  readOnly?: boolean;
}

type ProposalAction =
  | 'gate'
  | 'accept'
  | 'reject'
  | 'export'
  | 'apply'
  | 'revert';

const STYLES = {
  root: {
    padding: '20px',
    color: 'var(--chat-text)',
    WebkitFontSmoothing: 'antialiased',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '16px',
    marginBottom: '18px',
  },
  title: {
    margin: 0,
    fontSize: '16px',
    lineHeight: 1.3,
    fontWeight: 650,
    textWrap: 'balance',
  },
  description: {
    margin: '5px 0 0',
    color: 'var(--chat-text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
    textWrap: 'pretty',
  },
  button: {
    minHeight: '40px',
    padding: '8px 14px',
    border: 0,
    borderRadius: '8px',
    background: 'var(--chat-primary, #3d5688)',
    color: '#fff',
    font: 'inherit',
    fontSize: '12px',
    fontWeight: 600,
    cursor: 'pointer',
    boxShadow:
      '0 0 0 1px rgba(0,0,0,.06), 0 1px 2px rgba(0,0,0,.08)',
    transitionProperty: 'transform, opacity, box-shadow',
    transitionDuration: '150ms',
  },
  buttonSecondary: {
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    boxShadow:
      '0 0 0 1px color-mix(in srgb, var(--chat-text) 10%, transparent)',
  },
  buttonDanger: {
    background:
      'color-mix(in srgb, var(--chat-error, #ef4444) 14%, transparent)',
    color: 'var(--chat-error, #ef4444)',
  },
  buttonDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: '10px',
    marginBottom: '16px',
  },
  metric: {
    minWidth: 0,
    padding: '12px',
    borderRadius: '10px',
    background: 'var(--chat-bg-secondary)',
    boxShadow:
      '0 0 0 1px color-mix(in srgb, var(--chat-text) 7%, transparent)',
  },
  metricValue: {
    display: 'block',
    fontSize: '19px',
    fontWeight: 700,
    lineHeight: 1.1,
    fontVariantNumeric: 'tabular-nums',
  },
  metricLabel: {
    display: 'block',
    marginTop: '5px',
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
  },
  notice: {
    marginBottom: '14px',
    padding: '11px 13px',
    borderRadius: '9px',
    background:
      'color-mix(in srgb, var(--chat-warning, #f59e0b) 10%, transparent)',
    color: 'var(--chat-text)',
    fontSize: '12px',
    lineHeight: 1.5,
    textWrap: 'pretty',
  },
  error: {
    background:
      'color-mix(in srgb, var(--chat-error, #ef4444) 12%, transparent)',
    color: 'var(--chat-error, #ef4444)',
  },
  operation: {
    marginBottom: '16px',
    padding: '12px 14px',
    borderRadius: '9px',
    background:
      'color-mix(in srgb, var(--chat-primary, #3d5688) 9%, transparent)',
    fontSize: '12px',
  },
  operationLine: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '10px',
    padding: '3px 0',
  },
  sectionHeading: {
    margin: '20px 0 8px',
    fontSize: '12px',
    fontWeight: 700,
    letterSpacing: '.07em',
    textTransform: 'uppercase',
    color: 'var(--chat-text-secondary)',
  },
  proposal: {
    padding: '16px 0',
    borderTop:
      '1px solid color-mix(in srgb, var(--chat-text) 9%, transparent)',
  },
  proposalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '12px',
  },
  proposalTitle: {
    margin: 0,
    fontSize: '14px',
    lineHeight: 1.4,
    fontWeight: 650,
    textWrap: 'balance',
  },
  badge: {
    flexShrink: 0,
    padding: '3px 8px',
    borderRadius: '999px',
    background:
      'color-mix(in srgb, var(--chat-primary, #3d5688) 12%, transparent)',
    color: 'var(--chat-primary, #3d5688)',
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase',
  },
  meta: {
    margin: '6px 0 0',
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
  },
  rationale: {
    margin: '9px 0',
    fontSize: '12px',
    lineHeight: 1.5,
    textWrap: 'pretty',
  },
  diffGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
    gap: '8px',
  },
  diff: {
    margin: 0,
    minHeight: '54px',
    maxHeight: '180px',
    overflow: 'auto',
    padding: '10px',
    borderRadius: '7px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    fontSize: '10px',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
  },
  diffLabel: {
    display: 'block',
    marginBottom: '5px',
    color: 'var(--chat-text-secondary)',
    fontSize: '10px',
    fontWeight: 650,
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    marginTop: '12px',
  },
  empty: {
    padding: '18px 0',
    borderTop:
      '1px solid color-mix(in srgb, var(--chat-text) 9%, transparent)',
    color: 'var(--chat-text-secondary)',
    fontSize: '12px',
  },
};

export class SelfEvolutionPanel
implements m.ClassComponent<SelfEvolutionPanelAttrs> {
  private api!: SelfEvolutionApi;
  private snapshot: SelfEvolutionSnapshot | null = null;
  private loading = true;
  private error: string | null = null;
  private success: string | null = null;
  private busyProposalId: string | null = null;
  private curationRunning = false;
  private operationEvents: SelfEvolutionOperationEvent[] = [];
  private streamAbort?: AbortController;
  private binding = '';

  oninit(vnode: m.Vnode<SelfEvolutionPanelAttrs>): void {
    this.bind(vnode.attrs);
    void this.refresh();
  }

  onupdate(vnode: m.Vnode<SelfEvolutionPanelAttrs>): void {
    const nextBinding = bindingKey(vnode.attrs);
    if (nextBinding === this.binding) return;
    this.streamAbort?.abort();
    this.bind(vnode.attrs);
    void this.refresh();
  }

  onremove(): void {
    this.streamAbort?.abort();
  }

  view(vnode: m.Vnode<SelfEvolutionPanelAttrs>): m.Children {
    const overview = this.snapshot?.overview;
    const mutationDisabled =
      vnode.attrs.readOnly === true ||
      this.curationRunning ||
      overview?.config.enabled !== true;
    return m('div', {style: STYLES.root}, [
      m('div', {style: STYLES.header}, [
        m('div', [
          m(
            'h4',
            {style: STYLES.title},
            uiText('自进化控制台', 'Self-evolution control plane'),
          ),
          m(
            'p',
            {style: STYLES.description},
            uiText(
              '显式触发公开反馈策展；固定评测门禁通过后，才可人工接受并应用 overlay。',
              'Explicitly curate public feedback. A fixed evaluation gate and human acceptance are required before an overlay can be applied.',
            ),
          ),
        ]),
        this.actionButton(
          this.curationRunning
            ? uiText('策展中…', 'Curating…')
            : uiText('开始策展', 'Start curation'),
          () => void this.startCuration(),
          mutationDisabled,
        ),
      ]),
      this.loading && !this.snapshot
        ? m(
            'div',
            {style: STYLES.empty, 'aria-live': 'polite'},
            uiText('正在加载控制面状态…', 'Loading control-plane status…'),
          )
        : null,
      this.error
        ? m(
            'div',
            {
              style: {...STYLES.notice, ...STYLES.error},
              role: 'alert',
            },
            this.error,
          )
        : null,
      this.success
        ? m('div', {style: STYLES.notice, role: 'status'}, this.success)
        : null,
      overview ? this.renderOverview(overview) : null,
      this.operationEvents.length > 0 ? this.renderOperation() : null,
      this.snapshot ? this.renderProposals(vnode.attrs.readOnly === true) : null,
      this.snapshot ? this.renderRuntimeState() : null,
    ]);
  }

  private bind(attrs: SelfEvolutionPanelAttrs): void {
    this.binding = bindingKey(attrs);
    this.api = createSelfEvolutionApi(attrs.backendUrl, attrs.apiKey);
    this.snapshot = null;
    this.error = null;
    this.success = null;
    this.operationEvents = [];
  }

  private async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    m.redraw();
    try {
      this.snapshot = await this.api.snapshot();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.loading = false;
      m.redraw();
    }
  }

  private async startCuration(): Promise<void> {
    if (this.curationRunning) return;
    this.curationRunning = true;
    this.error = null;
    this.success = null;
    this.operationEvents = [];
    this.streamAbort?.abort();
    this.streamAbort = new AbortController();
    m.redraw();
    try {
      const {operationId} = await this.api.startCuration();
      await this.api.streamOperation(
        operationId,
        (event) => {
          this.operationEvents = [...this.operationEvents, event].slice(-64);
          if (event.type === 'failed') {
            this.error = event.errorCode ?? event.message;
          }
          m.redraw();
        },
        this.streamAbort.signal,
      );
      await this.refresh();
    } catch (error) {
      if (!this.streamAbort.signal.aborted) {
        this.error = errorMessage(error);
      }
    } finally {
      this.curationRunning = false;
      m.redraw();
    }
  }

  private renderOverview(
    overview: SelfEvolutionSnapshot['overview'],
  ): m.Children {
    const persistenceReady = overview.persistence.persistence === 'available';
    return [
      m('div', {style: STYLES.metrics}, [
        this.metric(
          String(
            overview.proposalCounts.draft +
              overview.proposalCounts.gated +
              overview.proposalCounts.accepted,
          ),
          uiText('待处理提案', 'Pending proposals'),
        ),
        this.metric(
          String(overview.overlayCounts.effective),
          uiText('生效 Overlay', 'Effective overlays'),
        ),
        this.metric(
          String(overview.operations.running),
          uiText('运行中任务', 'Running operations'),
        ),
      ]),
      !overview.config.enabled
        ? m(
            'div',
            {style: STYLES.notice},
            uiText(
              '自进化默认关闭。需要部署者显式设置 SELF_EVOLUTION_ENABLED=true。',
              'Self-evolution is off by default. A deployer must explicitly set SELF_EVOLUTION_ENABLED=true.',
            ),
          )
        : !persistenceReady
          ? m(
              'div',
              {style: STYLES.notice},
              uiText(
                `持久化不可用（${overview.persistence.reason}）；apply/revert 已 fail-closed。`,
                `Persistence is unavailable (${overview.persistence.reason}); apply/revert are fail-closed.`,
              ),
            )
          : !overview.config.applyEnabled
            ? m(
                'div',
                {style: STYLES.notice},
                uiText(
                  '策展已启用，但应用仍关闭。需要部署者显式设置 SELF_EVOLUTION_APPLY=true。',
                  'Curation is enabled, but apply remains off. A deployer must explicitly set SELF_EVOLUTION_APPLY=true.',
                ),
              )
            : null,
      m(
        'div',
        {style: STYLES.notice},
        uiText(
          'L2 外部裁判未配置。只有在逐次明确授权后，采样或争议案例才允许发送给外部裁判；当前不会发起外部调用。',
          'The external L2 judge is not configured. Only sampled or disputed cases may be sent after per-use explicit consent; no external call is made now.',
        ),
      ),
    ];
  }

  private renderOperation(): m.Children {
    return m(
      'div',
      {style: STYLES.operation, 'aria-live': 'polite'},
      this.operationEvents.map((event) =>
        m('div', {key: event.sequence, style: STYLES.operationLine}, [
          m('span', formatOperationMessage(event)),
          m(
            'span',
            {style: {fontVariantNumeric: 'tabular-nums'}},
            `#${event.sequence}`,
          ),
        ]),
      ),
    );
  }

  private renderProposals(readOnly: boolean): m.Children {
    const proposals = this.snapshot?.proposals ?? [];
    return [
      m(
        'h5',
        {style: STYLES.sectionHeading},
        uiText('提案与差异', 'Proposals and diffs'),
      ),
      proposals.length === 0
        ? m(
            'div',
            {style: STYLES.empty},
            uiText(
              '暂无提案。只有有效的公开反馈会进入显式策展。',
              'No proposals. Only effective public feedback enters explicit curation.',
            ),
          )
        : proposals.map((proposal) =>
            this.renderProposal(proposal, readOnly),
          ),
    ];
  }

  private renderProposal(
    proposal: SelfEvolutionProposal,
    readOnly: boolean,
  ): m.Children {
    const delta = proposal.deltas[0];
    const actions = proposalActions(proposal);
    const mutationDisabled =
      readOnly ||
      this.busyProposalId !== null ||
      this.snapshot?.overview.config.enabled !== true;
    const persistenceAvailable =
      this.snapshot?.overview.persistence.persistence === 'available';
    return m('section', {key: proposal.proposalId, style: STYLES.proposal}, [
      m('div', {style: STYLES.proposalHeader}, [
        m('div', [
          m('h6', {style: STYLES.proposalTitle}, proposal.title),
          m(
            'div',
            {style: STYLES.meta},
            `${proposal.tier} · ${proposal.kind} · ${
              proposal.evidence.labeledCount
            } ${uiText('条证据', 'evidence items')}`,
          ),
        ]),
        m('span', {style: STYLES.badge}, proposal.status),
      ]),
      m('p', {style: STYLES.rationale}, proposal.rationale),
      delta
        ? m('div', {style: STYLES.diffGrid}, [
            m('div', [
              m(
                'span',
                {style: STYLES.diffLabel},
                uiText('变更前', 'Before'),
              ),
              m('pre', {style: STYLES.diff}, pretty(delta.before)),
            ]),
            m('div', [
              m(
                'span',
                {style: STYLES.diffLabel},
                uiText('变更后', 'After'),
              ),
              m('pre', {style: STYLES.diff}, pretty(delta.after)),
            ]),
          ])
        : null,
      actions.length > 0
        ? m(
            'div',
            {style: STYLES.actions},
            actions.map((action) =>
              this.actionButton(
                actionLabel(action),
                () => void this.runProposalAction(proposal, action),
                mutationDisabled ||
                  ((action === 'apply' || action === 'revert') &&
                    this.snapshot?.overview.config.applyEnabled !== true) ||
                  (action === 'export' && !persistenceAvailable),
                action === 'reject' || action === 'revert'
                  ? STYLES.buttonDanger
                  : action === 'accept' || action === 'apply'
                    ? undefined
                    : STYLES.buttonSecondary,
              ),
            ),
          )
        : null,
    ]);
  }

  private renderRuntimeState(): m.Children {
    const overlays = this.snapshot?.overlays ?? [];
    const reconciliation = this.snapshot?.reconciliation;
    return [
      m(
        'h5',
        {style: STYLES.sectionHeading},
        uiText('运行状态', 'Runtime state'),
      ),
      m('div', {style: STYLES.empty}, [
        m(
          'div',
          `${uiText('Overlay 总数', 'Total overlays')}: ${overlays.length}`,
        ),
        m(
          'div',
          `${uiText('生效', 'Effective')}: ${
            overlays.filter((overlay) => overlay.effectiveEnabled).length
          }`,
        ),
        m(
          'div',
          `${uiText('最近对账', 'Latest reconciliation')}: ${
            reconciliation?.contentHash
              ? reconciliation.contentHash.slice(0, 16)
              : uiText('无', 'None')
          }`,
        ),
      ]),
    ];
  }

  private async runProposalAction(
    proposal: SelfEvolutionProposal,
    action: ProposalAction,
  ): Promise<void> {
    if (
      (action === 'apply' || action === 'revert' || action === 'reject') &&
      !window.confirm(actionConfirmation(action))
    ) {
      return;
    }
    this.busyProposalId = proposal.proposalId;
    this.error = null;
    this.success = null;
    m.redraw();
    try {
      if (action === 'gate') await this.api.gate(proposal.proposalId);
      else if (action === 'accept') {
        await this.api.accept(proposal.proposalId);
      } else if (action === 'reject') {
        await this.api.reject(proposal.proposalId);
      } else if (action === 'export') {
        const artifact = await this.api.exportContribution(
          proposal.proposalId,
        );
        this.success = uiText(
          `已生成去标识贡献包：${artifact.archiveContentHash.slice(0, 16)}`,
          `Deidentified contribution bundle created: ${artifact.archiveContentHash.slice(0, 16)}`,
        );
      } else if (action === 'apply') {
        await this.api.apply(proposal.proposalId, actionId('apply'));
      } else {
        await this.api.revert(proposal.proposalId, actionId('revert'));
      }
      await this.refresh();
    } catch (error) {
      this.error = errorMessage(error);
    } finally {
      this.busyProposalId = null;
      m.redraw();
    }
  }

  private metric(value: string, label: string): m.Children {
    return m('div', {style: STYLES.metric}, [
      m('span', {style: STYLES.metricValue}, value),
      m('span', {style: STYLES.metricLabel}, label),
    ]);
  }

  private actionButton(
    label: string,
    onclick: () => void,
    disabled: boolean,
    variant?: Record<string, unknown>,
  ): m.Children {
    return m(
      'button',
      {
        'type': 'button',
        'style': {
          ...STYLES.button,
          ...(variant ?? {}),
          ...(disabled ? STYLES.buttonDisabled : {}),
        },
        'disabled': disabled,
        'onclick': (event: MouseEvent) => {
          if (disabled) return;
          const button = event.currentTarget as HTMLElement;
          button.style.transform = 'scale(0.96)';
          requestAnimationFrame(() => {
            button.style.transform = '';
          });
          onclick();
        },
      },
      label,
    );
  }
}

export function proposalActions(
  proposal: SelfEvolutionProposal,
): ProposalAction[] {
  if (proposal.status === 'draft') return ['gate', 'reject'];
  if (proposal.status === 'gated') return ['accept', 'reject', 'export'];
  if (proposal.status === 'accepted') return ['export', 'apply'];
  if (proposal.status === 'applied') return ['export', 'revert'];
  return proposal.gateResult?.overallVerdict === 'passed' ? ['export'] : [];
}

function actionLabel(action: ProposalAction): string {
  const labels: Record<ProposalAction, [string, string]> = {
    gate: ['运行固定评测', 'Run fixed evaluation'],
    accept: ['接受', 'Accept'],
    reject: ['拒绝', 'Reject'],
    export: ['导出贡献包', 'Export bundle'],
    apply: ['应用 Overlay', 'Apply overlay'],
    revert: ['回滚', 'Revert'],
  };
  return uiText(...labels[action]);
}

function actionConfirmation(action: ProposalAction): string {
  if (action === 'apply') {
    return uiText(
      '确认将已通过门禁的提案应用为运行时 Overlay？',
      'Apply the gated proposal as a runtime overlay?',
    );
  }
  if (action === 'revert') {
    return uiText(
      '确认回滚该提案当前生效的 Overlay？',
      'Revert the currently effective overlay for this proposal?',
    );
  }
  return uiText('确认拒绝该提案？', 'Reject this proposal?');
}

function bindingKey(attrs: SelfEvolutionPanelAttrs): string {
  return `${attrs.backendUrl.replace(/\/+$/, '')}\0${attrs.apiKey ?? ''}`;
}

function actionId(kind: 'apply' | 'revert'): string {
  const suffix =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${kind}-${suffix}`;
}

function pretty(value: unknown): string {
  if (value === undefined) return '∅';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : uiText('自进化请求失败', 'Self-evolution request failed');
}

function formatOperationMessage(event: SelfEvolutionOperationEvent): string {
  if (event.type === 'failed') {
    return `${event.stage}: ${event.errorCode ?? event.message}`;
  }
  return `${event.stage}: ${event.message}`;
}
