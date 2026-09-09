// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {uiText} from './ui_language';

/** Shared disclosure for enabling source text in an analysis. */
export function sourceAnalysisDisclosure(): string {
  return uiText(
    '分析时会将相关源码片段发送给当前配置的 AI 服务（包括公司内部服务）。分析结果及其中引用的源码可随本地历史和导出报告保存；AI 服务的内容留存取决于该服务的配置与政策。检索、读取源码和额外的模型分析会使流程变长、耗时增加。',
    'Relevant source snippets are sent to the configured AI service, including an internal company service. Analysis results and quoted source may be saved in local history and exported reports; retention by the AI service depends on its configuration and policy. Source searches, reads, and additional model analysis make the workflow longer and increase analysis time.',
  );
}
