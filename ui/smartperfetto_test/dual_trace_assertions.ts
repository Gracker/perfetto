// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {expect, type APIRequestContext, type Page} from '@playwright/test';
import {statusRunId, type AnalyzeResponse} from './dual_trace_contract';
import type {BrowserNetworkLedger} from './dual_trace_browser_harness';
import {providerState} from './provider_stub_helper';
import {agentStatus} from './smartperfetto_e2e_helper';

export async function assertRunningIdentity(
  request: APIRequestContext,
  analysis: AnalyzeResponse,
): Promise<void> {
  await expect
    .poll(async () => {
      const status = await agentStatus(request, analysis.sessionId);
      return (
        ['pending', 'running', 'awaiting_user'].includes(status.status) &&
        statusRunId(status) === analysis.runId
      );
    })
    .toBe(true);
}

export async function assertProviderStillRunning(
  request: APIRequestContext,
): Promise<void> {
  const state = await providerState(request);
  expect(state.active).toBeGreaterThan(0);
}

export function assertMonotonicCursors(
  ledger: BrowserNetworkLedger,
  sessionId: string,
): void {
  const cursors = ledger
    .streamsForSession(sessionId)
    .map((request) => request.lastEventId);
  for (let index = 1; index < cursors.length; index++) {
    expect(cursors[index]).toBeGreaterThanOrEqual(cursors[index - 1]);
  }
}

export async function expectTraceSelectors(
  page: Page,
  disabled: boolean,
): Promise<void> {
  const selectors = page.locator('select.ai-trace-pair-selector');
  await expect(selectors).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    const selector = selectors.nth(index);
    if (disabled) await expect(selector).toBeDisabled();
    else await expect(selector).toBeEnabled();
  }
}

export async function expectEmbeddedFramesWithoutAssistantOwners(
  page: Page,
): Promise<void> {
  const frames = page.locator('iframe.ai-trace-pair-frame');
  await expect(frames).toHaveCount(2);
  const snapshots = await frames.evaluateAll((nodes) =>
    nodes.map((node) => {
      const frame = node instanceof HTMLIFrameElement ? node : null;
      const document = frame?.contentDocument;
      const exactLabels = document
        ? Array.from(document.querySelectorAll('*')).map((element) =>
            element.textContent?.trim(),
          )
        : [];
      return {
        assistantOwnerCount:
          document?.querySelectorAll(
            '#smartperfetto-floating-window-host, .ai-panel, .ai-sidebar-collapsed, .ai-sidebar-expanded, [data-ai-floating-window]',
          ).length ?? -1,
        aiAssistantLabelCount: exactLabels.filter(
          (label) => label === 'AI Assistant',
        ).length,
        aiReadyLabelCount: exactLabels.filter((label) => label === 'AI Ready')
          .length,
      };
    }),
  );
  expect(snapshots).toEqual([
    {
      assistantOwnerCount: 0,
      aiAssistantLabelCount: 0,
      aiReadyLabelCount: 0,
    },
    {
      assistantOwnerCount: 0,
      aiAssistantLabelCount: 0,
      aiReadyLabelCount: 0,
    },
  ]);
}

export async function expectCollapsedRailOwnsWorkspaceEdge(
  page: Page,
): Promise<void> {
  const rail = page.locator(
    'button.ai-sidebar-collapsed[data-workspace-open="true"]',
  );
  await expect(rail).toBeVisible();
  await expect(rail.locator('.ai-sidebar-collapsed-label')).toHaveText('AI');
  const geometry = await rail.evaluate((element) => {
    const railRect = element.getBoundingClientRect();
    const workspace = document.querySelector('.ai-trace-pair-workspace');
    const workspaceRect = workspace?.getBoundingClientRect();
    const topRightOwner = document.elementFromPoint(window.innerWidth - 1, 1);
    return {
      viewportWidth: window.innerWidth,
      railTop: railRect.top,
      railRight: railRect.right,
      railWidth: railRect.width,
      workspaceRight: workspaceRect?.right ?? -1,
      ownsTopRight:
        topRightOwner === element || element.contains(topRightOwner),
    };
  });
  expect(geometry.railTop).toBe(0);
  expect(
    Math.abs(geometry.railRight - geometry.viewportWidth),
  ).toBeLessThanOrEqual(1);
  expect(geometry.railWidth).toBe(36);
  expect(
    Math.abs(
      geometry.workspaceRight - (geometry.viewportWidth - geometry.railWidth),
    ),
  ).toBeLessThanOrEqual(1);
  expect(geometry.ownsTopRight).toBe(true);
}
