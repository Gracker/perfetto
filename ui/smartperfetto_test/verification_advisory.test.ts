// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {expect, test} from '@playwright/test';
import {sendAnalysis} from './dual_trace_browser_harness';
import {DualTraceScenario} from './dual_trace_scenario';

test('delivers completed analysis with an expandable verification advisory', async ({page, request}, testInfo) => {
  const scenario = new DualTraceScenario(page, request);
  await scenario.open();
  const sessionId = 'advisory-browser-fixture';
  const runId = 'advisory-browser-run';
  const conclusion = '# 分析结果\n\n观察到的帧耗时为 32.7 ms。';
  // Only the transport fixture is controlled here. The shipped renderer and
  // real trace workspace remain in use; this test makes no provider calls.
  await page.route('**/api/workspaces/*/agent/analyze', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({success: true, sessionId, runId,
      requestId: 'advisory-request', runSequence: 1}),
  }));
  await page.route('**/api/**/agent/**/stream*', route => route.fulfill({
    contentType: 'text/event-stream', body: `event: analysis_completed\ndata: ${JSON.stringify({
      type: 'analysis_completed', sessionId, runId, traceId: scenario.heavyHistoryTrace!.id,
      data: {sessionId, runId, conclusion, success: true, terminalRunStatus: 'completed',
        completion: {schemaVersion: 1, status: 'completed'},
        deliveryAssurance: {schemaVersion: 1, completion: 'passed', claims: 'failed'},
        claimVerificationResult: {schemaVersion: 'claim_verifier@2', status: 'failed', passed: false,
          policy: 'record_only', checkedClaimCount: 1, unsupportedClaimCount: 1,
          claimResults: [{claimId: 'frame-duration', status: 'unsupported'}],
          issues: [{claimId: 'frame-duration', severity: 'error', code: 'numeric_presentation_mismatch',
            message: '显示数值与原始证据不符，请检查该项。'}]},
      },
    })}\n\n`,
  }));
  await sendAnalysis(page, '展示核验存在疑点时的完整分析结果');
  await expect(page.locator('.ai-panel')).toContainText('观察到的帧耗时为 32.7 ms。');
  await expect(page.locator('.ai-server-verification-notice')).toContainText('核验提示');
  await expect(page.locator('button.ai-stop-btn')).toHaveCount(0);
  await expect(page.locator('textarea#ai-input')).toBeEnabled();
  await expect(page.getByText('流程完成，结论已生成。', {exact: true})).toBeVisible();
  const details = page.locator('details.ai-server-verification-details').last();
  await details.locator('summary').click();
  await expect(details).toContainText('numeric_presentation_mismatch');
  await expect(details).toContainText('显示数值与原始证据不符');
  await page.screenshot({path: testInfo.outputPath('completed-with-verification-advisory.png')});
});
