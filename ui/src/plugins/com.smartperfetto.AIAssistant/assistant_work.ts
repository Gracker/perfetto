// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import m from 'mithril';
import type {AssistantWorkSummary, AssistantWorkPhase} from './generated/data_contract.types';
import {uiText} from './ui_language';

export function assistantWorkPhaseText(phase: AssistantWorkPhase): string {
  const labels: Record<AssistantWorkPhase, [string, string]> = {
    running: ['正在分析', 'Analyzing'], reviewing: ['答案已生成，正在核验', 'Answer ready, verifying'],
    finished: ['已结束，结果暂不可用', 'Finished; result unavailable'],
    needs_input: ['需要你补充或选择', 'Needs your input'], ready: ['结果可查看', 'Result available'],
    interrupted: ['执行中断', 'Interrupted'], failed: ['执行失败', 'Failed'],
    cancelled: ['已停止', 'Stopped'], unknown: ['当前执行状态未知', 'Execution state unknown'],
  };
  return uiText(...labels[phase]);
}

/** Closed lifecycle/activity projection, never a verification verdict. */
export function renderAssistantWorkDetails(work: AssistantWorkSummary): m.Children {
  const activity = work.activity;
  const capture = work.captureActivity;
  return m('details', [
    m('summary', uiText('运行记录', 'Run activity')),
    m('div', activity && activity.observation !== 'unavailable'
      ? uiText(`工具：尝试 ${activity.attempted}，返回 ${activity.returned}，未观察到完成 ${activity.inFlight}；${activity.observation === 'partial' ? '记录不完整' : '已观测'}`,
        `Tools: ${activity.attempted} attempted, ${activity.returned} returned, ${activity.inFlight} without observed completion; ${activity.observation}`)
      : uiText('工具调用记录不可用', 'Tool activity unavailable')),
    activity && activity.observation !== 'unavailable' && activity.repeatedExactCalls !== undefined
      ? m('div', uiText(`相同参数的重复调用：${activity.repeatedExactCalls}`,
        `Repeated calls with identical arguments: ${activity.repeatedExactCalls}`)) : null,
    m('div', capture
      ? uiText(`已登记 ${capture.tables} 张表，其中 ${capture.unavailableTables} 张不可用；${capture.observation === 'partial' ? '记录不完整' : '已观测'}。`,
        `Recorded ${capture.tables} tables, ${capture.unavailableTables} unavailable; ${capture.observation}.`)
      : uiText('采集注册记录不可用', 'Capture activity unavailable')),
  ]);
}
