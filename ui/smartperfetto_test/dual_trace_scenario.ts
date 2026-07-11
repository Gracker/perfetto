// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect, type APIRequestContext, type Page} from '@playwright/test';
import {
  agentStatus,
  cancelAgent,
  deleteTrace,
  getDualTraceFixturePaths,
  getTraceProcessorPortRange,
  listTraces,
  uploadTrace,
  type WorkspaceTrace,
} from './smartperfetto_e2e_helper';
import {parseUploadResponse} from './dual_trace_contract';
import {
  aiStatusLocator,
  acceptCookieConsent,
  BrowserNetworkLedger,
  dragSplitterToPercent,
  DualTracePerfettoHelper,
  installFrameProbes,
  readFrameProbes,
  waitForEmbeddedTraces,
  type FrameProbe,
} from './dual_trace_browser_harness';
import {expectEmbeddedFramesWithoutAssistantOwners} from './dual_trace_assertions';

export class DualTraceScenario {
  readonly ledger: BrowserNetworkLedger;
  lightTrace: WorkspaceTrace | null = null;
  heavyTraceId: string | null = null;
  initialFrameProbes: ReadonlyArray<FrameProbe> = [];
  initialTraceFileRequests: ReadonlyArray<string> = [];

  constructor(
    readonly page: Page,
    readonly request: APIRequestContext,
  ) {
    this.ledger = new BrowserNetworkLedger(page);
  }

  async open(): Promise<void> {
    const backendApiKey = process.env.SMARTPERFETTO_E2E_BACKEND_API_KEY;
    if (!backendApiKey) {
      throw new Error('Dual Trace E2E backend API key is unavailable');
    }
    await this.page.addInitScript((apiKey) => {
      localStorage.setItem(
        'smartperfetto-ai-settings',
        JSON.stringify({backendApiKey: apiKey}),
      );
    }, backendApiKey);
    expect(await listTraces(this.request)).toEqual([]);
    const fixtures = getDualTraceFixturePaths();
    this.lightTrace = await uploadTrace(this.request, fixtures.light);
    const traceProcessorPorts = getTraceProcessorPortRange();
    expect(this.lightTrace.port).toBeGreaterThanOrEqual(
      traceProcessorPorts.min,
    );
    expect(this.lightTrace.port).toBeLessThanOrEqual(traceProcessorPorts.max);

    await this.page.goto('/');
    await this.page.evaluate(() => {
      localStorage.setItem('ai-analysis-mode', 'full');
    });
    const uploadResponsePromise = this.page.waitForResponse((response) => {
      const path = new URL(response.url()).pathname;
      return (
        response.request().method() === 'POST' &&
        path.endsWith('/traces/upload')
      );
    });
    const perfetto = new DualTracePerfettoHelper(this.page, {
      'lacunh_heavy.pftrace': fixtures.heavy,
    });
    await perfetto.openProductionTraceFile('lacunh_heavy.pftrace');
    const heavyUpload = await parseUploadResponse(await uploadResponsePromise);
    this.heavyTraceId = heavyUpload.trace.id;

    await acceptCookieConsent(this.page);
    await expect(aiStatusLocator(this.page)).toBeVisible();
    await aiStatusLocator(this.page).click();
    await expect(this.page.locator('.ai-panel')).toBeVisible();
    await this.page.getByTitle('打开双 Trace 工作区').click();
    await expect(this.page.locator('.ai-trace-pair-workspace')).toBeVisible();

    const referenceSelector = this.page.locator(
      'section[data-trace-side="reference"] select.ai-trace-pair-selector',
    );
    await expect(
      referenceSelector.locator(`option[value="${this.lightTrace.id}"]`),
    ).toContainText('launch_light.pftrace');
    await referenceSelector.selectOption(this.lightTrace.id);
    await expect(referenceSelector.locator('option:checked')).toContainText(
      'launch_light.pftrace',
    );
    await expect(this.page.locator('.ai-trace-pair-summary')).toContainText(
      'lacunh_heavy.pftrace',
    );
    await expect(this.page.locator('.ai-trace-pair-summary')).toContainText(
      'launch_light.pftrace',
    );

    await waitForEmbeddedTraces(this.page);
    expect(this.ledger.traceFileAuthenticated).toEqual([true, true]);
    const frameTraceSources = await this.page
      .locator('iframe.ai-trace-pair-frame')
      .evaluateAll((frames) =>
        frames.map((frame) => {
          if (!(frame instanceof HTMLIFrameElement)) {
            throw new Error('Trace pair frame is not an iframe');
          }
          const hashQuery = new URL(frame.src).hash.split('?')[1] ?? '';
          return new URLSearchParams(hashQuery).get('url') ?? '';
        }),
      );
    expect(frameTraceSources).toHaveLength(2);
    expect(frameTraceSources.every((source) => source.startsWith('blob:'))).toBe(
      true,
    );
    expect(
      frameTraceSources.every(
        (source) =>
          !source.includes(backendApiKey) &&
          !source.includes(process.env.SMARTPERFETTO_E2E_BACKEND_URL ?? ''),
      ),
    ).toBe(true);
    await expectEmbeddedFramesWithoutAssistantOwners(this.page);
    this.initialFrameProbes = await installFrameProbes(this.page);
    await dragSplitterToPercent(this.page, 58);
    await this.page.locator('section[data-trace-side="current"]').hover();
    await this.swapPanePositionsTwice();
    await this.expectFramesStable();
    this.initialTraceFileRequests = this.ledger.traceFileSnapshot();
  }

  async expectFramesStable(): Promise<void> {
    expect(await readFrameProbes(this.page)).toEqual(this.initialFrameProbes);
    expect(this.ledger.traceFileSnapshot()).toEqual(
      this.initialTraceFileRequests.length === 0
        ? this.ledger.traceFileSnapshot()
        : this.initialTraceFileRequests,
    );
  }

  async cleanup(activeSessionId?: string, activeRunId?: string): Promise<void> {
    if (activeSessionId && activeRunId) {
      try {
        const status = await agentStatus(this.request, activeSessionId);
        if (
          status.status === 'pending' ||
          status.status === 'running' ||
          status.status === 'awaiting_user'
        ) {
          await cancelAgent(this.request, activeSessionId, activeRunId);
          await expect
            .poll(
              async () =>
                (await agentStatus(this.request, activeSessionId)).status,
              {timeout: 30_000},
            )
            .toBe('cancelled');
        }
      } catch {}
    }
    const exitButton = this.page.locator('button[data-trace-pair-exit]');
    await expect(exitButton).toBeEnabled();
    await exitButton.click();
    await expect(this.page.locator('iframe.ai-trace-pair-frame')).toHaveCount(
      0,
    );
    if (this.heavyTraceId) {
      await deleteTrace(this.request, this.heavyTraceId);
      this.heavyTraceId = null;
    }
    if (this.lightTrace) {
      await deleteTrace(this.request, this.lightTrace.id);
      this.lightTrace = null;
    }
    expect(await listTraces(this.request)).toEqual([]);
  }

  private async swapPanePositionsTwice(): Promise<void> {
    const referenceSelector = this.page.locator(
      'section[data-trace-side="reference"] select.ai-trace-pair-selector',
    );
    if (!this.heavyTraceId) throw new Error('Heavy trace is unavailable');
    await referenceSelector.selectOption(this.heavyTraceId);
    await expect(
      this.page.locator('section[data-trace-side="current"]'),
    ).toHaveAttribute('data-pane-slot', 'second');
    await referenceSelector.selectOption(this.heavyTraceId);
    await expect(
      this.page.locator('section[data-trace-side="current"]'),
    ).toHaveAttribute('data-pane-slot', 'first');
  }
}
