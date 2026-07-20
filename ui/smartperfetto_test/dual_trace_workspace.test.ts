// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect, test} from '@playwright/test';
import {writeFile} from 'fs/promises';
import {providerState} from './provider_stub_helper';
import {
  parseAnalyzePayload,
  parseAnalyzeRequest,
  parseAnalyzeResponse,
  parseCancelResponse,
  type AnalyzeResponse,
} from './dual_trace_contract';
import {
  aiStatusLocator,
  createGate,
  dragSplitterToPercent,
  sendAnalysis,
} from './dual_trace_browser_harness';
import {
  assertMonotonicCursors,
  assertProviderStillRunning,
  assertRunningIdentity,
  expectCollapsedRailOwnsWorkspaceEdge,
  expectEmbeddedFramesWithoutAssistantOwners,
  expectTraceSelectors,
} from './dual_trace_assertions';
import {DualTraceScenario} from './dual_trace_scenario';

const ANALYZE_ROUTE = '**/api/workspaces/*/agent/analyze';
const CANCELLATION_NOTICE = '分析已取消。';
const COMPARISON_QUERY =
  '对比左右两个 Trace 的启动速度差异。请先读取窗口映射，然后用 compare_skill 跑 startup_analysis 对比冷启动阶段，最后用证据说明哪边更慢。';

test('keeps heavy/light analysis stable through window operations and confirms stop', async ({
  page,
  request,
}, testInfo) => {
  const scenario = new DualTraceScenario(page, request);
  const capture = async (name: string) => {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForTimeout(300);
    if (process.env.SMARTPERFETTO_E2E_HEADLESS === '0') {
      await page.screenshot({path: testInfo.outputPath(name)});
      return;
    }
    const cdp = await page.context().newCDPSession(page);
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: false,
      captureBeyondViewport: false,
    });
    await cdp.detach();
    await writeFile(testInfo.outputPath(name), Buffer.from(screenshot.data, 'base64'));
  };
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let activeSessionId: string | undefined;
  let activeRunId: string | undefined;
  let routeInstalled = false;
  const responseGate = createGate();

  try {
    await scenario.open();
    if (!scenario.lightTrace || !scenario.heavyTraceId) {
      throw new Error('Dual Trace scenario did not initialize both traces');
    }
    await capture('00-dual-trace-ready.png');

    const workspaceAssistant = page.locator('[data-trace-pair-assistant]');
    await expect(workspaceAssistant).toContainText('AI 助手');
    await expect(workspaceAssistant).toHaveAttribute('title', '收起 AI 助手');
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).not.toBeVisible();
    await expect(page.locator('.ai-trace-pair-workspace')).toBeVisible();
    await scenario.expectFramesStable();
    await expect(workspaceAssistant).toHaveAttribute('title', '打开 AI 助手');
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await scenario.expectFramesStable();
    await capture('00-idle-panel-restored.png');

    const heldAnalyze: {value: AnalyzeResponse | null} = {value: null};
    await page.route(ANALYZE_ROUTE, async (route) => {
      const response = await route.fetch();
      const payload: unknown = await response.json();
      heldAnalyze.value = parseAnalyzePayload(payload);
      await responseGate.wait;
      await route.fulfill({response});
    });
    routeInstalled = true;

    await sendAnalysis(page, '停止响应返回前的双 Trace 对比');
    await expect
      .poll(() => heldAnalyze.value?.sessionId ?? '', {timeout: 120_000})
      .not.toBe('');
    await expect(page.locator('button.ai-stop-btn')).toBeVisible();
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).not.toBeVisible();
    await expect(page.locator('.ai-trace-pair-workspace')).toBeVisible();
    await expectCollapsedRailOwnsWorkspaceEdge(page);
    await expectEmbeddedFramesWithoutAssistantOwners(page);
    await scenario.expectFramesStable();
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await expect(page.locator('button.ai-stop-btn')).toBeVisible();
    await page.locator('button.ai-stop-btn').click();
    expect(scenario.ledger.cancelUrls).toHaveLength(0);
    const firstSessionId = heldAnalyze.value?.sessionId;
    if (!firstSessionId)
      throw new Error('Held analyze response has no session');
    const firstCancelResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/agent/${firstSessionId}/cancel`,
        ),
    );
    const firstDeleteResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname.endsWith(`/agent/${firstSessionId}`),
    );
    responseGate.release();

    const firstCancelled = await parseCancelResponse(
      await firstCancelResponsePromise,
    );
    expect(firstCancelled.status).toBe('cancelled');
    expect(firstCancelled.runId).toBe(heldAnalyze.value?.runId);
    expect((await firstDeleteResponsePromise).ok()).toBe(true);
    await expect(
      page.getByText(CANCELLATION_NOTICE, {exact: true}),
    ).toBeVisible();
    expect(scenario.ledger.streamsForSession(firstSessionId)).toHaveLength(0);
    expect(scenario.ledger.cancelUrls).toHaveLength(1);
    expect(scenario.ledger.cancelRequests[0]?.runId).toBe(
      heldAnalyze.value?.runId,
    );
    expect(await providerState(request)).toMatchObject({
      opened: 0,
      closed: 0,
      active: 0,
      requests: [],
    });
    await page.unroute(ANALYZE_ROUTE);
    routeInstalled = false;

    const analyzeResponsePromise = page.waitForResponse((response) =>
      isAnalyzeResponse(response.url(), response.request().method()),
    );
    await sendAnalysis(page, COMPARISON_QUERY);
    const analyzeResponse = await analyzeResponsePromise;
    const analysis = await parseAnalyzeResponse(analyzeResponse);
    const analyzeRequest = parseAnalyzeRequest(analyzeResponse.request());
    activeSessionId = analysis.sessionId;
    activeRunId = analysis.runId;

    expect(analyzeRequest).toMatchObject({
      traceId: scenario.heavyTraceId,
      referenceTraceId: scenario.lightTrace.id,
      options: {
        analysisMode: 'full',
        tracePairContext: {
          layout: 'horizontal',
          primarySide: 'left',
          referenceSide: 'right',
          workspaceOpen: true,
          splitPercent: 58,
        },
      },
    });
    expect(analyzeRequest.sessionId).toBeUndefined();
    expect(analyzeRequest.options.tracePairContext.panes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          traceSide: 'current',
          traceId: scenario.heavyTraceId,
          traceName: 'lacunh_heavy.pftrace',
        }),
        expect.objectContaining({
          traceSide: 'reference',
          traceId: scenario.lightTrace.id,
          traceName: 'launch_light.pftrace',
        }),
      ]),
    );

    await expect
      .poll(() => providerState(request).then((state) => state.active), {
        timeout: 120_000,
      })
      .toBeGreaterThan(0);
    const runningProvider = await providerState(request);
    expect(runningProvider).toMatchObject({
      opened: 1,
      closed: 0,
      active: 1,
    });
    expect(runningProvider.requests).toHaveLength(1);
    await assertRunningIdentity(request, analysis);
    await expectTraceSelectors(page, true);
    await expect(
      page.locator('select.ai-trace-pair-selector').first(),
    ).toHaveAttribute('title', '分析运行中，Trace 选择已锁定');
    const workspaceExit = page.locator('button[data-trace-pair-exit]');
    await expect(workspaceExit).toBeDisabled();
    await expect(workspaceExit).toHaveAttribute(
      'title',
      '分析运行中，停止后可退出双窗',
    );
    await expect(workspaceExit).toContainText('退出双窗');
    await expect(page.getByTitle('New Chat')).toBeDisabled();
    await expect(page.getByTitle('分析运行中，设置保持只读')).toBeDisabled();
    await expect(page.locator('[data-switcher] > button')).toBeDisabled();
    await expect(page.getByTitle('请先停止当前分析再退出对比')).toBeDisabled();

    await page.getByTitle('上下排列').click();
    await expect(page.locator('.ai-trace-pair-body')).toHaveClass(
      /layout-vertical/,
    );
    await capture('01-running-vertical.png');
    await page
      .locator('section[data-trace-side="current"]')
      .getByTitle('最大化窗口')
      .click();
    await capture('02-running-maximized.png');
    await page.getByTitle('恢复分屏').click();
    await capture('03-running-restored.png');
    await page
      .locator('section[data-trace-side="reference"]')
      .getByTitle('最小化窗口')
      .click();
    await capture('04-running-minimized.png');
    await page
      .locator(
        'section[data-trace-side="reference"] button.ai-trace-pair-minimized-rail',
      )
      .click();
    await dragSplitterToPercent(page, 64);
    await capture('05-running-split.png');
    await scenario.expectFramesStable();
    expect(scenario.ledger.cancelUrls).toHaveLength(1);
    await assertRunningIdentity(request, analysis);

    const streamsBeforeHide = scenario.ledger.streamsForSession(
      analysis.sessionId,
    ).length;
    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).not.toBeVisible();
    await expect(page.locator('.ai-trace-pair-workspace')).toBeVisible();
    await expectCollapsedRailOwnsWorkspaceEdge(page);
    await capture('06-ai-panel-hidden.png');
    await scenario.expectFramesStable();
    await assertProviderStillRunning(request);
    await assertRunningIdentity(request, analysis);
    expect(scenario.ledger.cancelUrls).toHaveLength(1);

    await workspaceAssistant.click();
    await expect(page.locator('.ai-panel')).toBeVisible();
    await expect(page.locator('button.ai-stop-btn')).toBeVisible();
    await capture('07-ai-panel-restored.png');
    await expect
      .poll(() => scenario.ledger.streamsForSession(analysis.sessionId).length)
      .toBe(streamsBeforeHide);
    assertMonotonicCursors(scenario.ledger, analysis.sessionId);
    await scenario.expectFramesStable();
    await assertProviderStillRunning(request);
    expect(scenario.ledger.cancelUrls).toHaveLength(1);

    const cancelResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname.endsWith(
          `/agent/${analysis.sessionId}/cancel`,
        ),
    );
    const deleteResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'DELETE' &&
        new URL(response.url()).pathname.endsWith(
          `/agent/${analysis.sessionId}`,
        ),
    );
    await page.locator('button.ai-stop-btn').click();
    const cancelled = await parseCancelResponse(await cancelResponsePromise);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.runId).toBe(analysis.runId);
    expect((await deleteResponsePromise).ok()).toBe(true);
    await expect
      .poll(() => providerState(request).then((state) => state.active))
      .toBe(0);
    const stoppedProvider = await providerState(request);
    expect(stoppedProvider).toMatchObject({
      opened: 1,
      closed: 1,
      active: 0,
    });
    expect(stoppedProvider.requests).toHaveLength(1);
    expect(scenario.ledger.cancelUrls).toHaveLength(2);
    expect(scenario.ledger.cancelRequests.map(({runId}) => runId)).toEqual([
      heldAnalyze.value?.runId,
      analysis.runId,
    ]);
    expect(scenario.ledger.analyzeUrls).toHaveLength(2);
    await expect(
      page.getByText(CANCELLATION_NOTICE, {exact: true}),
    ).toHaveCount(2);
    await expect(
      page.getByText('流程完成，结论已生成。', {exact: true}),
    ).toHaveCount(0);
    await expect(
      page.getByText('流程已取消，未生成完整结论。', {exact: true}).last(),
    ).toBeVisible();
    await expect(aiStatusLocator(page)).toHaveText('AI: Cancelled');
    await expect(page.locator('textarea#ai-input')).toBeEnabled();
    await expectTraceSelectors(page, false);
    await expect(workspaceExit).toBeEnabled();
    await expect(workspaceExit).toHaveAttribute('title', '退出双 Trace 工作区');
    await scenario.expectFramesStable();
    await capture('08-analysis-cancelled.png');
    expect(pageErrors).toEqual([]);
  } finally {
    responseGate.release();
    if (routeInstalled) await page.unroute(ANALYZE_ROUTE);
    await testInfo.attach('dual-trace-network-ledger', {
      body: JSON.stringify(scenario.ledger, null, 2),
      contentType: 'application/json',
    });
    await scenario.cleanup(activeSessionId, activeRunId);
  }
});

function isAnalyzeResponse(url: string, method: string): boolean {
  return method === 'POST' && new URL(url).pathname.endsWith('/agent/analyze');
}
