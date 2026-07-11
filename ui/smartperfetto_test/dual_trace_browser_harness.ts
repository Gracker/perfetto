// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect, type Frame, type Locator, type Page} from '@playwright/test';
import {PerfettoTestHelper} from '../src/test/perfetto_ui_test_helper';

export interface FrameProbe {
  readonly traceSide: string;
  readonly token: string;
  readonly src: string;
  readonly loadCount: string;
}

export interface StreamRequestProbe {
  readonly url: string;
  readonly lastEventId: number;
}

export interface CancelRequestProbe {
  readonly url: string;
  readonly runId: string;
}

export class BrowserNetworkLedger {
  readonly analyzeUrls: string[] = [];
  readonly cancelUrls: string[] = [];
  readonly cancelRequests: CancelRequestProbe[] = [];
  readonly traceFileUrls: string[] = [];
  readonly traceFileAuthenticated: boolean[] = [];
  readonly streamRequests: StreamRequestProbe[] = [];

  constructor(page: Page) {
    page.on('request', (request) => {
      const url = new URL(request.url());
      const path = url.pathname;
      if (request.method() === 'POST' && path.endsWith('/agent/analyze')) {
        this.analyzeUrls.push(request.url());
      }
      if (request.method() === 'POST' && /\/agent\/[^/]+\/cancel$/.test(path)) {
        this.cancelUrls.push(request.url());
        const payload: unknown = request.postDataJSON();
        const runId =
          typeof payload === 'object' &&
          payload !== null &&
          'runId' in payload &&
          typeof payload.runId === 'string'
            ? payload.runId
            : '';
        this.cancelRequests.push({url: request.url(), runId});
      }
      if (request.method() === 'GET' && /\/traces\/[^/]+\/file$/.test(path)) {
        this.traceFileUrls.push(request.url());
        const headers = request.headers();
        this.traceFileAuthenticated.push(
          Boolean(headers.authorization && headers['x-api-key']),
        );
      }
      if (
        request.method() === 'GET' &&
        /\/agent\/(?:runs\/[^/]+|[^/]+)\/stream$/.test(path)
      ) {
        const rawCursor = request.headers()['last-event-id'];
        const parsedCursor = Number(rawCursor ?? 0);
        this.streamRequests.push({
          url: request.url(),
          lastEventId: Number.isFinite(parsedCursor) ? parsedCursor : 0,
        });
      }
    });
  }

  traceFileSnapshot(): ReadonlyArray<string> {
    return [...this.traceFileUrls].sort();
  }

  streamsForSession(sessionId: string): ReadonlyArray<StreamRequestProbe> {
    return this.streamRequests.filter((request) =>
      request.url.includes(`/agent/${encodeURIComponent(sessionId)}/stream`),
    );
  }
}

export class DualTracePerfettoHelper extends PerfettoTestHelper {
  constructor(
    page: Page,
    private readonly fixturePaths: Readonly<Record<string, string>>,
  ) {
    super(page);
  }

  override getTestTracePath(traceName: string): string {
    const tracePath = this.fixturePaths[traceName];
    if (!tracePath) throw new Error(`Unknown E2E trace fixture: ${traceName}`);
    return tracePath;
  }

  async openProductionTraceFile(traceName: string): Promise<void> {
    await this.page.evaluate(() =>
      localStorage.setItem('dismissedPanningHint', 'true'),
    );
    await this.page
      .locator('input.trace_file')
      .setInputFiles(this.getTestTracePath(traceName));
    await this.waitForPerfettoIdle();
    await this.page.mouse.move(0, 0);
  }
}

export async function waitForEmbeddedTraces(page: Page): Promise<void> {
  await expect
    .poll(() => embeddedTraceFrames(page).length, {timeout: 120_000})
    .toBe(2);
  await Promise.all(
    embeddedTraceFrames(page).map(async (frame) => {
      await frame.waitForFunction(
        () => typeof Reflect.get(window, 'waitForPerfettoIdle') === 'function',
        undefined,
        {timeout: 120_000},
      );
      try {
        await frame.evaluate(async () => {
          const idle = Reflect.get(window, 'waitForPerfettoIdle');
          if (typeof idle !== 'function') {
            throw new Error('Embedded Perfetto idle detector is unavailable');
          }
          await Reflect.apply(idle, window, []);
        });
      } catch (error) {
        const diagnostic = await frame.evaluate(() => ({
          url: window.location.href,
          omniboxMessage:
            document.querySelector('.pf-omnibox--message-mode')?.textContent ??
            null,
          progress:
            document.querySelector('.progress.progress-anim')?.textContent ??
            null,
          title: document.title,
        }));
        throw new Error(
          `Embedded Trace did not become idle: ${JSON.stringify(diagnostic)}`,
          {cause: error},
        );
      }
    }),
  );
}

export async function installFrameProbes(
  page: Page,
): Promise<ReadonlyArray<FrameProbe>> {
  const frames = page.locator('iframe.ai-trace-pair-frame');
  await expect(frames).toHaveCount(2);
  await frames.evaluateAll((elements) => {
    for (const element of elements) {
      if (!(element instanceof HTMLIFrameElement)) {
        throw new Error('Trace pair frame is not an iframe');
      }
      element.dataset.e2eToken = crypto.randomUUID();
      element.dataset.e2eLoadCount = '0';
      element.addEventListener('load', () => {
        const current = Number(element.dataset.e2eLoadCount ?? 0);
        element.dataset.e2eLoadCount = String(current + 1);
      });
    }
  });
  return readFrameProbes(page);
}

export async function readFrameProbes(
  page: Page,
): Promise<ReadonlyArray<FrameProbe>> {
  return page.locator('iframe.ai-trace-pair-frame').evaluateAll((elements) =>
    elements.map((element) => {
      if (!(element instanceof HTMLIFrameElement)) {
        throw new Error('Trace pair frame is not an iframe');
      }
      return {
        traceSide: element.dataset.traceSide ?? '',
        token: element.dataset.e2eToken ?? '',
        src: element.src,
        loadCount: element.dataset.e2eLoadCount ?? '',
      };
    }),
  );
}

export function aiStatusLocator(page: Page): Locator {
  return page.getByText(/^(?:AI Ready|AI: .+)$/).last();
}

export async function acceptCookieConsent(page: Page): Promise<void> {
  const consent = page.locator('.pf-cookie-consent');
  if (await consent.isVisible()) {
    await consent.getByRole('button', {name: 'OK', exact: true}).click();
    await expect(consent).toHaveCount(0);
  }
}

export async function sendAnalysis(page: Page, query: string): Promise<void> {
  await page.locator('textarea#ai-input').fill(query);
  await page.locator('button.ai-send-btn:not(.ai-stop-btn)').click();
}

export async function dragSplitterToPercent(
  page: Page,
  percent: number,
): Promise<void> {
  const body = page.locator('.ai-trace-pair-body');
  const splitter = page.locator('.ai-trace-pair-splitter');
  const workspace = page.locator('.ai-trace-pair-workspace');
  const bodyBox = await body.boundingBox();
  const splitterBox = await splitter.boundingBox();
  if (!bodyBox || !splitterBox) {
    throw new Error('Trace pair splitter is not measurable');
  }
  const vertical = await body.evaluate((element) =>
    element.classList.contains('layout-vertical'),
  );
  await page.mouse.move(
    splitterBox.x + splitterBox.width / 2,
    splitterBox.y + splitterBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    vertical
      ? bodyBox.x + bodyBox.width / 2
      : bodyBox.x + (bodyBox.width * percent) / 100,
    vertical
      ? bodyBox.y + (bodyBox.height * percent) / 100
      : bodyBox.y + bodyBox.height / 2,
  );
  await expect(workspace).toHaveClass(/is-resizing/);
  await page.mouse.up();
  await expect(body).toHaveAttribute(
    'style',
    new RegExp(`--ai-trace-pair-split: ${percent}(?:\\.0+)?%;`),
  );
  await expect(workspace).not.toHaveClass(/is-resizing/);
  const frames = page.locator('.ai-trace-pair-frame');
  await expect(frames).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    await expect(frames.nth(index)).toHaveCSS('pointer-events', 'auto');
  }
}

export function createGate(): {readonly wait: Promise<void>; release(): void} {
  let release: () => void = () => {
    throw new Error('Gate was not initialized');
  };
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {wait, release};
}

function embeddedTraceFrames(page: Page): ReadonlyArray<Frame> {
  return page
    .frames()
    .filter((frame) => frame.url().includes('smartperfettoDualTrace=true'));
}
