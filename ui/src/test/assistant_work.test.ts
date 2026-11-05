// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {test, expect, type Page, type Route} from '@playwright/test';

/** Browser interaction fixtures; backend authorization is tested by HTTP suites. */
async function openActiveConversation(page: Page, language: 'zh-CN' | 'en', active = true) {
  const viewport = page.viewportSize();
  if (viewport && viewport.width < 768) await page.setViewportSize({...viewport, width: 1440});
  const mutations: string[] = [];
  const pendingStreams: Route[] = [];
  const startInputs: Array<Record<string, unknown>> = [];
  let pendingCount = 0;
  const context = () => ({availability: 'available', queueEpoch: 'browser-epoch',
    pendingCount, durability: 'process_memory'});
  await page.addInitScript(({language}) => {
    const backendUrl = location.origin;
    window.__SMARTPERFETTO_CONFIG__ = {backendUrl, oidcEnabled: false};
    localStorage.setItem('smartperfetto-ai-settings', JSON.stringify({uiLanguage: language, backendUrl}));
    const owner = ['default-dev-tenant', 'dev-user-123', 'default-workspace'];
    localStorage.setItem(`smartperfetto-conversation:v2:${JSON.stringify([...owner, backendUrl])}`,
      JSON.stringify({owner, backendUrl, messages: [], updatedAt: 1,
        locator: {version: 1, owner, backendUrl, conversationId: 'browser-conversation'}}));
  }, {language});
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') mutations.push(path);
    if (path.endsWith('/browser-conversation/stream')) {
      pendingStreams.push(route);
      return; // Keep the restored run active while independent controls are used.
    }
    let body: unknown;
    if (path.endsWith('/conversation') && request.method() === 'POST') {
      startInputs.push(request.postDataJSON());
      await route.fulfill({status: 202, json: {sessionId: 'archived-conversation', runId: 'continued-run',
        isNewSession: false, traceContextAttached: true}});
      return;
    } else if (path.endsWith('/archived-conversation/stream')) {
      await route.fulfill({contentType: 'text/event-stream',
        body: 'event: run_completed\ndata: {"outcome":{"kind":"answered","message":"Trace remains attached."}}\n\n'});
      return;
    } else if (path.endsWith('/work')) {
      const filter = new URL(request.url()).searchParams.get('filter');
      body = {success: true, filter, items: filter === 'recent' ? [
        {surface: 'analysis', metadata: 'available', result: {kind: 'snapshot', id: 'browser-result'},
          work: {sessionId: 'analysis-exact', runId: 'analysis-run', phase: 'ready', hasResult: true}},
        {surface: 'analysis', metadata: 'unavailable', metadataReason: 'latest_run_ambiguous',
          work: {sessionId: 'analysis-ambiguous', phase: 'unknown', hasResult: false}},
      ] : [{surface: 'conversation', metadata: 'available',
        work: {sessionId: 'archived-conversation', runId: 'archived-run', phase: 'needs_input',
          inputReason: 'question', startedAt: 1000, completedAt: 2000, hasResult: true}}]};
    } else if (path.endsWith('/analysis-results/browser-result')) {
      body = {success: true, snapshot: {id: 'browser-result', sessionId: 'analysis-exact', runId: 'analysis-run',
        summary: {conclusion: 'Exact run conclusion from the saved result.'}}};
    } else if (path.endsWith('/analysis-ambiguous/turns/latest')) {
      body = {success: true, sessionId: 'analysis-ambiguous', turn: {id: 'historical-turn',
        result: {conclusion: 'Session history with an unknown run identity.', completion: {status: 'complete'}}}};
    } else if (path.endsWith('/conversation/archived-conversation')) {
      body = {success: true, sessionId: 'archived-conversation', status: 'awaiting_user',
        history: [{role: 'user', content: 'Historical question for inspection.'},
          {role: 'assistant', content: 'Which interval should I inspect?'}],
        historyOmittedMessages: 0, traceContext: {kind: 'attached', traceId: 'trace-archived'},
        sourceSelection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []}};
    } else if (path.endsWith('/browser-conversation/status')) {
      body = {success: true, work: {sessionId: 'browser-conversation', runId: 'browser-run',
        phase: 'running', startedAt: Date.now() - 20_000, hasResult: false,
        activity: {observation: 'partial', attempted: 3, returned: 2, inFlight: 1},
        captureActivity: {observation: 'observed', tables: 2, rowSlots: 9, unavailableTables: 1}},
        context: context()};
    } else if (path.endsWith('/browser-conversation/context')) {
      const input = request.postDataJSON();
      expect(input.expectedRunId).toBe('browser-run');
      expect(input.expectedQueueEpoch).toBe('browser-epoch');
      expect(input.text).toBe('Keep this note for my next question.');
      pendingCount = 1;
      body = {success: true, sessionId: 'browser-conversation', context: context(),
        receipt: {id: input.idempotencyKey, queueEpoch: 'browser-epoch', expectedRunId: 'browser-run',
          status: 'accepted', appliesTo: 'next_user_turn', durability: 'process_memory'}};
    } else if (path.endsWith('/conversation/browser-conversation')) {
      body = {success: true, sessionId: 'browser-conversation', status: active ? 'running' : 'completed',
        history: [{role: 'user', content: 'Explain the next investigation step.'}],
        historyOmittedMessages: 0, traceContext: {kind: 'none'}, ...(active ? {activeRunId: 'browser-run'} : {}),
        sourceSelection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []}};
    } else {
      await route.fulfill({status: 404, json: {error: 'No browser fixture for this endpoint'}});
      return;
    }
    await route.fulfill({json: body});
  });
  await page.goto('/#!/assistant');
  if (active) await expect(page.locator('.ai-conversation-page-running')).toBeVisible();
  else await expect(page.locator('.ai-conversation-controls')).toBeVisible();
  const cookieConsent = page.locator('.pf-cookie-consent');
  if (await cookieConsent.count()) await cookieConsent.getByRole('button', {name: 'OK', exact: true}).click();
  if (viewport && viewport.width < 768) {
    await page.getByTitle('Hide sidebar', {exact: true}).click();
    await page.setViewportSize(viewport);
  }
  return {mutations, pendingStreams, startInputs};
}

test('work overview distinguishes an exact result from ambiguous session history', async ({page}) => {
  const {mutations} = await openActiveConversation(page, 'en');
  const input = page.locator('.ai-conversation-page-composer textarea');
  await input.fill('Preserve the current draft.');
  await page.locator('[data-work-overview-toggle]').click();
  await page.locator('[data-work-filter="recent"]').click();
  await page.locator('[data-work-open="analysis-exact"]').click();
  await expect(page.locator('.ai-work-drawer')).toContainText('Exact run conclusion from the saved result.');
  await expect(page.locator('.ai-work-detail-scope')).toHaveText('Result for the selected run');
  await page.locator('[data-work-close]').click();
  await page.locator('[data-work-open="analysis-ambiguous"]').click();
  await expect(page.locator('.ai-work-drawer')).toContainText('Session history with an unknown run identity.');
  await expect(page.locator('.ai-work-detail-scope')).toContainText('Session history;');
  await expect(input).toHaveValue('Preserve the current draft.');
  await expect(page.locator('.ai-conversation-page-running')).toBeVisible();
  expect(mutations).toEqual([]);
  await page.screenshot({path: test.info().outputPath('ambiguous-history.png'), fullPage: true});
});

for (const language of ['zh-CN', 'en'] as const) {
  for (const width of [1440, 390]) {
    test(`assistant controls preserve an active conversation (${language}, ${width})`, async ({page}) => {
      await page.setViewportSize({width, height: 900});
      const {mutations, pendingStreams} = await openActiveConversation(page, language);
      const zh = language === 'zh-CN';
      const input = page.locator('.ai-conversation-page-composer textarea');
      await input.fill('Keep this note for my next question.');
      await page.getByRole('button', {name: zh ? '查看进度' : 'Check progress', exact: true}).click();
      await expect(page.locator('.ai-conversation-controls')).toContainText(zh ? '正在分析' : 'Analyzing');
      await expect(input).toHaveValue('Keep this note for my next question.');
      await page.getByText(zh ? '运行记录' : 'Run activity', {exact: true}).click();
      await expect(page.locator('.ai-conversation-controls')).toContainText(zh ? '记录不完整' : 'partial');
      expect(mutations).toEqual([]);
      await page.locator('[data-work-overview-toggle]').click();
      await page.locator('.ai-work-item [data-work-open]').first().click();
      await expect(page.locator('.ai-work-drawer')).toContainText('Historical question for inspection.');
      await expect(page.locator('[data-work-continue]')).toBeDisabled();
      await expect(input).toHaveValue('Keep this note for my next question.');
      await expect(page.locator('.ai-conversation-page-running')).toBeVisible();
      expect(mutations).toEqual([]);
      await page.screenshot({path: test.info().outputPath(`drawer-${language}-${width}.png`), fullPage: true});
      await page.locator('[data-work-close]').click();
      await page.getByRole('button', {name: zh ? '补充到下一轮' : 'Add for next turn', exact: true}).click();
      await expect(input).toHaveValue('');
      await expect(page.locator('.ai-conversation-control-notice')).toContainText(zh ? '下次提问' : 'next question');
      await expect(page.locator('.ai-conversation-page-running')).toBeVisible();
      expect(mutations).toEqual([expect.stringMatching(/\/conversation\/browser-conversation\/context$/)]);
      expect(pendingStreams).toHaveLength(1);
      const persisted = await page.evaluate(() => Object.keys(localStorage)
        .filter((key) => key.startsWith('smartperfetto-conversation'))
        .map((key) => localStorage.getItem(key)).join(''));
      expect(persisted).not.toContain('Keep this note');
      expect(persisted).not.toContain('sourceSelection');
      const overflow = await page.locator('.ai-conversation-page').evaluate((element) =>
        element.scrollWidth > element.clientWidth + 1);
      expect(overflow).toBe(false);
      await page.screenshot({path: test.info().outputPath(`controls-${language}-${width}.png`), fullPage: true});
    });
  }

  test(`explicit continuation keeps an attached Trace (${language})`, async ({page}) => {
    await page.setViewportSize({width: language === 'zh-CN' ? 390 : 1440, height: 900});
    const {mutations, startInputs} = await openActiveConversation(page, language, false);
    const input = page.locator('.ai-conversation-page-composer textarea');
    await input.fill('Continue attached trace');
    await page.locator('[data-work-overview-toggle]').click();
    await page.locator('.ai-work-item [data-work-open]').first().click();
    await expect(page.locator('[data-work-continue]')).toBeEnabled();
    await page.locator('[data-work-continue]').click();
    await expect(page.locator('.ai-work-drawer')).toHaveCount(0);
    await expect(input).toHaveValue('Continue attached trace');
    await expect(page.locator('.ai-conversation-page-header')).toContainText(
      language === 'zh-CN' ? '已附加 Trace' : 'has an attached trace');
    expect(mutations).toEqual([]);
    await page.locator('.ai-conversation-page-send').click();
    await expect(page.locator('.ai-conversation-page-thread')).toContainText('Trace remains attached.');
    expect(startInputs).toEqual([expect.objectContaining({sessionId: 'archived-conversation',
      traceId: 'trace-archived', query: 'Continue attached trace'})]);
    expect(mutations).toEqual([expect.stringMatching(/\/conversation$/)]);
    await page.screenshot({path: test.info().outputPath(`attached-${language}.png`), fullPage: true});
  });
}
