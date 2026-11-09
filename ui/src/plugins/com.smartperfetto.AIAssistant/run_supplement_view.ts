// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import {isPrivateQueryStoragePlaceholder} from './private_message_storage';
import {
  startsConversationRound,
  type RunSupplementEntry,
} from './run_supplement_state';
import type {RunSupplementReason} from './generated/data_contract.types';
import {uiText} from './ui_language';

type RunSupplementMessageAction = 'retry' | 'edit' | 'restart';

/** Status text keyed only by typed state, reason and failure code. */
export function runSupplementStatusText(entry: RunSupplementEntry): string {
  switch (entry.state) {
    case 'classifying':
      return uiText('正在确认这条补充说明…', 'Checking this supplement…');
    case 'queued':
      return uiText('已排队，等待进入 Agent 上下文', "Queued to enter the agent's context");
    case 'delivered':
      return uiText('已进入 Agent 上下文', "Entered the agent's context");
    case 'not_applied':
      return notAppliedText(entry);
    case 'rejected':
      return rejectedText(entry);
    case 'restart_required':
      return restartRequiredText(entry);
  }
}

function notAppliedText(entry: RunSupplementEntry): string {
  if (entry.failureCode === 'outcome_unknown') {
    return uiText(
      '未确认生效：分析已结束或连接已中断，这条补充可能没有进入 Agent 上下文',
      'Not confirmed: the analysis ended or the connection dropped, so this supplement may not have entered the agent\'s context',
    );
  }
  if (entry.failureCode === 'RUN_NOT_ACTIVE') {
    return uiText('分析已结束，这条补充未生效', 'The analysis has ended, so this supplement was not applied');
  }
  switch (entry.reason) {
    case 'turn_budget':
      return uiText('调查轮次已用完，这条补充未生效', 'Investigation turns ran out, so this supplement was not applied');
    case 'run_stopped':
      return uiText('分析已停止，这条补充未生效', 'The analysis was stopped, so this supplement was not applied');
    case 'run_failed':
      return uiText('分析失败，这条补充未生效', 'The analysis failed, so this supplement was not applied');
    default:
      return uiText(
        '分析已结束调查阶段，这条补充未生效',
        'The analysis has finished investigating, so this supplement was not applied',
      );
  }
}

function rejectedText(entry: RunSupplementEntry): string {
  switch (entry.failureCode) {
    case 'RUN_SUPPLEMENT_TOO_LARGE':
      return uiText('补充说明过长，未发送', 'This supplement is too long and was not sent');
    case 'RUN_SUPPLEMENT_INVALID_BODY':
      return uiText('补充说明格式无效，未发送', 'This supplement is not valid and was not sent');
    case 'RUN_SUPPLEMENT_UNSUPPORTED':
      return uiText('这次分析不支持追加补充说明', 'This analysis does not accept supplements');
    case 'RUN_SUPPLEMENT_CAPACITY_EXCEEDED':
      return uiText('本次分析的补充说明数量已达上限', 'This analysis has reached its supplement limit');
    case 'RUN_SUPPLEMENT_IDEMPOTENCY_CONFLICT':
      return uiText('补充说明发送冲突，请重新发送', 'This supplement conflicted with an earlier one; send it again');
    case 'RUN_NOT_FOUND':
      return uiText('未找到这次分析，补充说明未发送', 'This analysis was not found, so the supplement was not sent');
    case 'request_failed':
      return uiText(
        '发送失败，无法确认后端是否收到；重新发送可能产生重复',
        'Sending failed and receipt could not be confirmed; resending may create a duplicate',
      );
    default:
      break;
  }
  if (entry.reason === 'policy') {
    return uiText('这条补充说明未被接受，分析不受影响', 'This supplement was not accepted; the analysis is unaffected');
  }
  return uiText(
    '暂时无法判断这条补充能否应用，分析不受影响',
    'Could not determine whether this supplement applies; the analysis is unaffected',
  );
}

function restartRequiredText(entry: RunSupplementEntry): string {
  switch (entry.reason) {
    case 'needs_selection':
      return uiText(
        '这条补充需要新的选区：请先调整选区后再发起分析',
        'This supplement needs a different selection. Change the selection first, then start the analysis',
      );
    case 'goal_changed':
      return uiText('这会改变分析目标，需要重新分析', 'This changes the analysis goal and needs a restart');
    case 'scene_changed':
      return uiText('这会改变分析场景，需要重新分析', 'This changes the analysis scene and needs a restart');
    case 'scope_changed':
      return uiText('这会改变分析范围，需要重新分析', 'This changes the analysis scope and needs a restart');
    case 'trace_changed':
      return uiText('这需要换一个 Trace，需要重新分析', 'This needs a different trace and needs a restart');
    case 'provider_changed':
      return uiText('这需要换一个 Provider，需要重新分析', 'This needs a different provider and needs a restart');
    case 'authorization_changed':
      return uiText('这会改变授权范围，需要重新分析', 'This changes what the analysis is authorized to use and needs a restart');
    case 'evidence_access_changed':
      return uiText('这会改变证据访问范围，需要重新分析', 'This changes evidence access and needs a restart');
    case 'deliverable_changed':
      return uiText('这会改变交付内容，需要重新分析', 'This changes what the analysis delivers and needs a restart');
    case 'budget_changed':
      return uiText('这会改变分析预算，需要重新分析', 'This changes the analysis budget and needs a restart');
    default:
      return uiText('这条补充无法就地应用，需要重新分析', 'This supplement cannot be applied in place and needs a restart');
  }
}

/** Which actions a settled supplement offers. Private placeholders offer none: the raw text is gone. */
export function runSupplementMessageActions(
  entry: RunSupplementEntry,
  context: {windowOpen: boolean; textAvailable: boolean; supersededByActiveRun?: boolean},
): RunSupplementMessageAction[] {
  if (!context.textAvailable) return [];
  switch (entry.state) {
    case 'rejected': {
      const retryable =
        context.windowOpen &&
        entry.failureCode !== 'RUN_SUPPLEMENT_TOO_LARGE' &&
        entry.failureCode !== 'RUN_SUPPLEMENT_INVALID_BODY';
      return retryable ? ['retry', 'edit'] : ['edit'];
    }
    case 'not_applied':
      return ['edit'];
    case 'restart_required':
      return entry.reason === 'needs_selection' || entry.restartConsumed || context.supersededByActiveRun ? [] : ['restart'];
    default:
      return [];
  }
}

/** The new question built from the original one and the supplement. */
export function composeRestartQuery(
  originalQuestion: string | undefined,
  supplement: string,
  reason?: RunSupplementReason,
): string {
  const original = originalQuestion?.trim();
  const note = supplement.trim();
  // A changed goal replaces the question; a slash-command question cannot carry extra text.
  if (reason === 'goal_changed' || !original || original.startsWith('/')) return note;
  return `${original}\n\n${uiText('补充说明：', 'Additional note:')}\n${note}`;
}

interface RestartSourceMessage {
  id: string;
  role: string;
  flowTag?: string;
  content: string;
  privateContent?: boolean;
}

export interface RunSupplementRestartSubmission {
  query: string;
  /** The restart inherits privacy from its sources, whatever the context is by now. */
  privateContent: boolean;
}

/** The new question a restart sends, and whether it must stay out of browser storage. */
export function runSupplementRestartSubmission(
  messages: readonly RestartSourceMessage[],
  supplement: RestartSourceMessage & {runSupplement?: {reason?: RunSupplementReason}},
): RunSupplementRestartSubmission {
  const index = messages.findIndex((msg) => msg.id === supplement.id);
  const question = messages.slice(0, Math.max(index, 0)).reverse().find(startsConversationRound);
  const original =
    question && !isPrivateQueryStoragePlaceholder(question.content)
      ? question.content
      : undefined;
  return {
    query: composeRestartQuery(original, supplement.content, supplement.runSupplement?.reason),
    privateContent: question?.privateContent === true || supplement.privateContent === true,
  };
}

export function runSupplementComposerPlaceholder(): string {
  return uiText(
    '补充说明会发送给正在运行的分析...',
    'A supplement goes to the running analysis...',
  );
}

export function runSupplementComposerHint(input: string): string {
  return input.trim().startsWith('/')
    ? uiText(
        '运行中不能使用斜杠命令；请先停止分析或等待完成',
        'Slash commands are unavailable during a run; stop the analysis or wait for it to finish',
      )
    : uiText(
        '按 Enter 发送补充说明，Shift+Enter 换行',
        'Press Enter to send this supplement, Shift+Enter for a new line',
      );
}

interface RunSupplementStatusHandlers {
  onRetry: () => void;
  onEdit: () => void;
  onRestart: () => void;
}

function actionButton(
  label: string,
  onclick: () => void,
): m.Vnode {
  return m('button.ai-run-supplement-action', {type: 'button', onclick}, label);
}

/** Status line and actions below a supplement bubble. */
export function renderRunSupplementStatus(
  entry: RunSupplementEntry,
  context: {
    windowOpen: boolean;
    textAvailable: boolean;
    runActive: boolean;
    supersededByActiveRun: boolean;
  },
  handlers: RunSupplementStatusHandlers,
): m.Vnode {
  const actions = runSupplementMessageActions(entry, context);
  const buttons: m.Children = actions.map((action) => {
    switch (action) {
      case 'retry':
        return actionButton(uiText('重新发送', 'Retry'), handlers.onRetry);
      case 'edit':
        return actionButton(uiText('放回输入框', 'Back to input'), handlers.onEdit);
      case 'restart':
        return actionButton(
          context.runActive
            ? uiText('停止并以此重新分析', 'Stop and restart with this')
            : uiText('以此重新分析', 'Restart with this'),
          handlers.onRestart,
        );
    }
  });
  return m(
    'div.ai-run-supplement-status',
    {class: `ai-run-supplement-${entry.state}`, role: 'status'},
    [m('span.ai-run-supplement-text', runSupplementStatusText(entry)), buttons],
  );
}
