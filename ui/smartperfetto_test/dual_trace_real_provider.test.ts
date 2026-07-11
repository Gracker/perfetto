// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect, test} from '@playwright/test';
import {z} from 'zod';

import {agentStatus} from './smartperfetto_e2e_helper';
import {
  parseAnalyzeRequest,
  parseAnalyzeResponse,
  parseCancelResponse,
} from './dual_trace_contract';
import {aiStatusLocator, sendAnalysis} from './dual_trace_browser_harness';
import {DualTraceScenario} from './dual_trace_scenario';

const ResultSchema = z.object({
  answer: z.string().min(1),
  claimVerificationResult: z.object({status: z.literal('passed')}),
  partial: z.boolean().optional(),
});

test.skip(
  process.env.SMARTPERFETTO_E2E_REAL_PROVIDER !== '1',
  'requires the opt-in real provider runner',
);

test('keeps a real DeepSeek comparison alive through window operations', async ({
  page,
  request,
}, testInfo) => {
  const scenario = new DualTraceScenario(page, request);
  let sessionId: string | undefined;
  let runId: string | undefined;
  try {
    await scenario.open();
    const analyzeResponsePromise = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith('/agent/analyze'),
    );
    await sendAnalysis(
      page,
      '对比左右两个 Trace 的启动速度差异。请先读取窗口映射，然后用 compare_skill 跑 startup_analysis 对比冷启动阶段，最后用证据说明哪边更慢。',
    );
    const analyzeResponse = await analyzeResponsePromise;
    const analysis = await parseAnalyzeResponse(analyzeResponse);
    const analyzeRequest = parseAnalyzeRequest(analyzeResponse.request());
    sessionId = analysis.sessionId;
    runId = analysis.runId;
    expect(analyzeRequest.traceId).toBe(scenario.heavyTraceId);
    expect(analyzeRequest.referenceTraceId).toBe(scenario.lightTrace?.id);

    await expect(page.locator('button.ai-stop-btn')).toBeVisible();
    await page.getByTitle('上下排列').click();
    await page
      .locator('section[data-trace-side="current"]')
      .getByTitle('最大化窗口')
      .click();
    await page.getByTitle('恢复分屏').click();
    await page
      .locator('section[data-trace-side="reference"]')
      .getByTitle('最小化窗口')
      .click();
    await page
      .locator(
        'section[data-trace-side="reference"] button.ai-trace-pair-minimized-rail',
      )
      .click();
    const workspaceAssistant = page.locator('[data-trace-pair-assistant]');
    await expect(workspaceAssistant).toContainText('AI 助手');
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).not.toBeVisible();
    await expect(page.locator('.ai-trace-pair-workspace')).toBeVisible();
    await scenario.expectFramesStable();
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await scenario.expectFramesStable();
    await page.screenshot({path: testInfo.outputPath('real-running-operations.png')});

    await expect
      .poll(async () => (await agentStatus(request, analysis.sessionId)).status, {
        timeout: 12 * 60_000,
      })
      .toBe('completed');
    const completed = await agentStatus(request, analysis.sessionId);
    const result = ResultSchema.parse(completed.result);
    expect(result.partial).not.toBe(true);
    expect(result.answer.length).toBeGreaterThan(100);
    await scenario.expectFramesStable();
    await page.screenshot({path: testInfo.outputPath('real-completed.png')});

    const completedNotices = page.getByText('流程完成，结论已生成。', {
      exact: true,
    });
    await expect(completedNotices.last()).toBeVisible();
    const completedNoticeCount = await completedNotices.count();
    expect(completedNoticeCount).toBeGreaterThan(0);
    await expect(aiStatusLocator(page)).toHaveText('AI: Done');
    await expect(page.locator('textarea#ai-input')).toBeEnabled();
    const providerStartNotices = page.getByText(
      'AI 分析引擎分析中 (deepseek-v4-pro)...',
      {exact: true},
    );
    const providerStartCount = await providerStartNotices.count();
    const resumeResponsePromise = page.waitForResponse((response) => {
      const pathname = new URL(response.url()).pathname;
      return (
        response.request().method() === 'POST' &&
        (pathname.endsWith('/agent/analyze') ||
          /\/agent\/sessions\/[^/]+\/runs$/.test(pathname))
      );
    });
    await sendAnalysis(
      page,
      '继续验证两个 Trace 的启动差异；保持当前双窗映射并重新读取证据。',
    );
    const cancellableAnalysis = await parseAnalyzeResponse(
      await resumeResponsePromise,
    );
    sessionId = cancellableAnalysis.sessionId;
    runId = cancellableAnalysis.runId;
    expect(cancellableAnalysis.sessionId).toBe(analysis.sessionId);
    expect(cancellableAnalysis.runId).not.toBe(analysis.runId);
    await expect(page.locator('button.ai-stop-btn')).toBeVisible();
    await expect
      .poll(() => providerStartNotices.count(), {timeout: 120_000})
      .toBeGreaterThan(providerStartCount);
    await scenario.expectFramesStable();

    const cancelResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/agent/${cancellableAnalysis.sessionId}/cancel`,
        ),
    );
    await page.locator('button.ai-stop-btn').click();
    const cancelled = await parseCancelResponse(await cancelResponsePromise);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.runId).toBe(cancellableAnalysis.runId);
    await expect
      .poll(
        async () =>
          (await agentStatus(request, cancellableAnalysis.sessionId)).status,
        {timeout: 30_000},
      )
      .toBe('cancelled');
    await expect(completedNotices).toHaveCount(completedNoticeCount);
    await expect(
      page.getByText('流程已取消，未生成完整结论。', {exact: true}).last(),
    ).toBeVisible();
    await scenario.expectFramesStable();
    await page.screenshot({path: testInfo.outputPath('real-cancelled.png')});
  } finally {
    await scenario.cleanup(sessionId, runId);
  }
});
