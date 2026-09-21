// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Scene request lifecycle. AIPanel owns the shared Agent SSE transport and UI projection. */

import {buildAssistantApiV1Url} from './assistant_api_v1';
import {uiOutputLanguage, uiText, uiTextForLanguage} from './ui_language';
import type {StoryPreviewResult} from './types';

/**
 * StoryController context — injected by AIPanel.
 *
 * 所有访问 AIPanel 状态或方法的入口都通过这个接口,让 controller 不直接耦合 AIPanel 类。
 */
export interface StoryControllerContext {
  getBackendTraceId(): string | null;
  getBackendUrl(): string;
  fetchBackend(url: string, opts?: RequestInit): Promise<Response>;
}

export class StoryControllerInvalidatedError extends Error {
  constructor() {
    super('Story controller was invalidated');
    this.name = 'StoryControllerInvalidatedError';
  }
}

function sceneProgressFallback(
  phase: unknown,
  language: string | undefined,
): string {
  switch (phase) {
    case 'detecting':
    case 'scene_detection':
      return uiTextForLanguage(language, '正在检测场景', 'Detecting scenes');
    case 'analyzing':
    case 'deep_analysis':
      return uiTextForLanguage(language, '正在分析场景', 'Analyzing scenes');
    case 'summarizing':
    case 'finalizing':
      return uiTextForLanguage(
        language,
        '正在生成场景摘要',
        'Summarizing scenes',
      );
    default:
      return uiTextForLanguage(language, '正在分析', 'Analyzing');
  }
}

/** Prefer the backend-localized message; never expose an internal phase code. */
export function buildSceneProgressContent(input: {
  eventType: 'progress' | 'phase_start';
  data: any;
  rawData?: any;
  language?: string;
}): string | undefined {
  const message = input.data?.message ?? input.rawData?.message;
  const phase = input.data?.phase ?? input.rawData?.phase;
  if (input.eventType === 'progress' && !message && !phase) return undefined;
  const detail =
    typeof message === 'string' && message.trim()
      ? message.trim()
      : sceneProgressFallback(phase, input.language);
  return uiTextForLanguage(
    input.language,
    `🎬 **场景还原中...**\n\n${detail}`,
    `🎬 **Reconstructing scenes...**\n\n${detail}`,
  );
}

export class StoryControllerCancelledError extends Error {
  constructor() { super('Scene analysis cancelled before stream attachment'); }
}

export interface SceneRunReceipt {
  sessionId: string;
  analysisId: string;
  runId: string;
  traceId: string;
  cancellationError?: string;
}

export class StoryController {
  private ctx: StoryControllerContext;
  private generation = 0;
  private disposed = false;
  private activeControllers = new Set<AbortController>();
  private startFlight: Promise<SceneRunReceipt> | null = null;
  private receipt: SceneRunReceipt | null = null;
  private runActive = false;
  private pendingCancel = false;
  private runBackendUrl = '';
  private cancelFlight: Promise<{status: string} | undefined> | null = null;

  constructor(ctx: StoryControllerContext) {
    this.ctx = ctx;
  }

  dispose(): void {
    if (this.disposed) return;
    this.pendingCancel = true;
    if (this.receipt && this.runActive) void this.cancel().catch(() => {});
    this.disposed = true;
    this.generation += 1;
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private beginOperation(): {generation: number; controller: AbortController} {
    if (this.disposed) throw new StoryControllerInvalidatedError();
    const controller = new AbortController();
    this.activeControllers.add(controller);
    return {generation: this.generation, controller};
  }

  private finishOperation(controller: AbortController): void {
    this.activeControllers.delete(controller);
  }

  private assertCurrent(generation: number): void {
    if (this.disposed || generation !== this.generation) {
      throw new StoryControllerInvalidatedError();
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  /**
   * Cheap preview: POST /scene-reconstruct/preview → estimate + cache status.
   * Used by the Story Panel to show "cache hit" or "confirm before running"
   * before committing to the heavy pipeline.
   */
  async preview(traceId: string): Promise<StoryPreviewResult> {
    const {generation, controller} = this.beginOperation();
    try {
      const url = buildAssistantApiV1Url(
        this.ctx.getBackendUrl(),
        '/scene-reconstruct/preview',
      );
      const response = await this.ctx.fetchBackend(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept-Language': uiOutputLanguage(),
        },
        body: JSON.stringify({traceId, outputLanguage: uiOutputLanguage()}),
      });
      this.assertCurrent(generation);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        this.assertCurrent(generation);
        throw new Error(
          (errData as any).error ||
            uiText(
              `预览失败：HTTP ${response.status}`,
              `Preview failed: HTTP ${response.status}`,
            ),
        );
      }
      const data = await response.json();
      this.assertCurrent(generation);
      if (!(data as any).success) {
        throw new Error(
          (data as any).error || uiText('预览请求失败', 'Preview request failed'),
        );
      }
      return data as StoryPreviewResult;
    } catch (error) {
      if (!this.isCurrent(generation)) {
        throw new StoryControllerInvalidatedError();
      }
      throw error;
    } finally {
      this.finishOperation(controller);
    }
  }

  /**
   * Load a previously persisted SceneReport by reportId.
   * GET /scene-reconstruct/report/:reportId
   */
  async loadReport(reportId: string): Promise<any> {
    const {generation, controller} = this.beginOperation();
    try {
      const url = buildAssistantApiV1Url(
        this.ctx.getBackendUrl(),
        `/scene-reconstruct/report/${encodeURIComponent(reportId)}?outputLanguage=${encodeURIComponent(uiOutputLanguage())}`,
      );
      const response = await this.ctx.fetchBackend(url, {
        signal: controller.signal,
      });
      this.assertCurrent(generation);
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        this.assertCurrent(generation);
        throw new Error(
          (errData as any).error ||
            uiText(
              `加载报告失败：HTTP ${response.status}`,
              `Load report failed: HTTP ${response.status}`,
            ),
        );
      }
      const data = await response.json();
      this.assertCurrent(generation);
      if (!(data as any).success) {
        throw new Error(
          (data as any).error || uiText('加载报告失败', 'Failed to load report'),
        );
      }
      return (data as any).report;
    } catch (error) {
      if (!this.isCurrent(generation)) {
        throw new StoryControllerInvalidatedError();
      }
      throw error;
    } finally {
      this.finishOperation(controller);
    }
  }

  /** Reserve synchronously. Hiding/reopening the drawer attaches to this same run. */
  start(opts: {providerId?: string; forceRefresh?: boolean} = {}): Promise<SceneRunReceipt> {
    if (this.disposed) return Promise.reject(new StoryControllerInvalidatedError());
    if (this.startFlight) return this.startFlight;
    if (this.receipt && (this.runActive || !opts.forceRefresh)) return Promise.resolve(this.receipt);
    const traceId = this.ctx.getBackendTraceId();
    if (!traceId) return Promise.reject(new Error('Trace is not available in the backend'));
    const generation = this.generation;
    this.pendingCancel = false;
    this.runActive = true;
    this.receipt = null;
    this.runBackendUrl = this.ctx.getBackendUrl();
    // Do not abort an admitted POST before its receipt arrives: cancellation
    // must address the exact run even after this panel switches trace/disposes.
    this.startFlight = this.startRequest(traceId, generation, opts).finally(() => {
      this.startFlight = null;
    });
    return this.startFlight;
  }

  private async startRequest(
    traceId: string,
    generation: number,
    opts: {providerId?: string; forceRefresh?: boolean},
  ): Promise<SceneRunReceipt> {
    try {
      const response = await this.ctx.fetchBackend(
        buildAssistantApiV1Url(this.runBackendUrl, '/scene-reconstruct'), {
          method: 'POST',
          headers: {'Content-Type': 'application/json', 'Accept-Language': uiOutputLanguage()},
          body: JSON.stringify({traceId, providerId: opts.providerId,
            options: {forceRefresh: opts.forceRefresh ?? false, outputLanguage: uiOutputLanguage()}}),
        });
      const data = await response.json();
      if (!response.ok || data.success === false) throw new Error(data.error || `HTTP ${response.status}`);
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : data.analysisId;
      if (typeof sessionId !== 'string' || !sessionId || typeof data.runId !== 'string' || !data.runId) {
        throw new Error('Scene analysis receipt is missing its session or run identity');
      }
      this.receipt = {sessionId, analysisId: sessionId, runId: data.runId, traceId};
      if (!this.isCurrent(generation) || this.ctx.getBackendTraceId() !== traceId) {
        await this.cancel().catch(() => {});
        throw new StoryControllerInvalidatedError();
      }
      if (this.pendingCancel) {
        try {
          const result = await this.cancel();
          if (result?.status === 'cancelled') throw new StoryControllerCancelledError();
        } catch (error) {
          if (error instanceof StoryControllerCancelledError) throw error;
          // A rejected stop leaves a live run. Attach to its stream instead of
          // dropping its receipt and presenting a failed-start state.
          this.receipt.cancellationError = error instanceof Error ? error.message : String(error);
        }
      }
      return this.receipt;
    } catch (error) {
      if (!this.receipt) this.runActive = false;
      throw error;
    }
  }

  /** Pending cancellation survives the POST and is sent once the receipt exists. */
  cancel(): Promise<{status: string} | undefined> {
    this.pendingCancel = true;
    if (this.cancelFlight) return this.cancelFlight;
    const receipt = this.receipt;
    if (!receipt || !this.runActive) return Promise.resolve(undefined);
    this.cancelFlight = this.ctx.fetchBackend(buildAssistantApiV1Url(this.runBackendUrl,
      `/scene-reconstruct/${encodeURIComponent(receipt.sessionId)}/cancel`), {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({runId: receipt.runId}),
    }).then(async response => {
      const result = await response.json();
      const terminalConflict = response.status === 409 &&
        ['RUN_NOT_CANCELLABLE', 'RUN_NOT_ACTIVE'].includes(result.code);
      if ((!response.ok && !terminalConflict) || result.runId !== receipt.runId ||
          !['cancelled', 'completed', 'failed', 'quota_exceeded'].includes(result.status)) {
        throw new Error(result.error || 'Cancellation did not return the matching run terminal state');
      }
      this.runActive = false;
      return {status: result.status};
    }).finally(() => { this.cancelFlight = null; });
    return this.cancelFlight;
  }

  markTerminal(runId: string): void {
    if (this.receipt?.runId === runId) this.runActive = false;
  }
}
