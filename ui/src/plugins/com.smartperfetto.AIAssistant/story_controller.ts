// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Story Controller — orchestrates the scene reconstruction command for the
 * AI Assistant plugin.
 *
 * Transport note: uses fetch + a manual SSE parser so the backend API key
 * can travel in the `x-api-key` header. An EventSource-based implementation
 * would be forced to put the key in a query parameter, which the backend
 * auth middleware does not honor.
 */

import m from 'mithril';
import {buildAssistantApiV1Url} from './assistant_api_v1';
import {
  SCENE_PIN_MAPPING,
  type ScenePinInstruction,
  formatSceneTimestamp,
  getSceneDisplayName,
  getSceneResponseStatusLabel,
  localizeScenePinInstruction,
} from './scene_constants';
import {uiOutputLanguage, uiText, uiTextForLanguage} from './ui_language';
import {STEP_TO_OVERLAY, createOverlayTrack} from './track_overlay';
import type {Message, StoryPreviewResult} from './types';

/**
 * StoryController context — injected by AIPanel.
 *
 * 所有访问 AIPanel 状态或方法的入口都通过这个接口,让 controller 不直接耦合 AIPanel 类。
 */
export interface StoryControllerContext {
  // ── State accessors ──
  getBackendTraceId(): string | null;
  getBackendUrl(): string;
  getTrace(): any;

  // ── Message management (delegates to AIPanel methods) ──
  addMessage(msg: Message): void;
  updateMessage(messageId: string, updates: Partial<Message>): void;
  generateId(): string;
  setLoadingState(loading: boolean): void;

  // ── Network helper (delegates to AIPanel.fetchBackend — handles API key header) ──
  fetchBackend(url: string, opts?: RequestInit): Promise<Response>;

  // ── Track pinning (delegates to AIPanel.pinTracksFromInstructions) ──
  pinTracksFromInstructions(
    instructions: ScenePinInstruction[],
    activeProcesses: Array<{processName: string; frameCount: number}>,
    isCurrent: () => boolean,
  ): Promise<void>;

  // ── Scene state sync (writes AIPanel.state.detectedScenes) ──
  setDetectedScenes(scenes: any[]): void;

  /** Optional debug flag — when true, verbose console.log() messages are emitted */
  debug?: boolean;
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

/**
 * Scene Reconstruction Controller
 *
 * 负责 /scene 命令的完整生命周期:
 *  1. 发起 POST /scene-reconstruct
 *  2. 打开 SSE 连接读取增量事件
 *  3. 渲染场景列表到聊天消息
 *  4. 自动 pin 相关 tracks 到 workspace
 */
export class StoryController {
  private ctx: StoryControllerContext;
  private generation = 0;
  private disposed = false;
  private activeControllers = new Set<AbortController>();

  constructor(ctx: StoryControllerContext) {
    this.ctx = ctx;
  }

  dispose(): void {
    if (this.disposed) return;
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

  private debugLog(...args: any[]): void {
    if (this.ctx.debug) console.log('[StoryController]', ...args);
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

  /**
   * Start scene reconstruction.
   * Equivalent to the old AIPanel.handleSceneReconstructCommand().
   */
  async start(opts?: {forceRefresh?: boolean}): Promise<void> {
    const {generation, controller} = this.beginOperation();
    const backendTraceId = this.ctx.getBackendTraceId();
    if (!backendTraceId) {
      this.ctx.addMessage({
        id: this.ctx.generateId(),
        role: 'assistant',
        content: uiText(
          '⚠️ **无法执行场景还原**\n\n请先确保 Trace 已上传到后端。',
          '⚠️ **Cannot reconstruct scenes**\n\nMake sure the trace has been uploaded to the backend.',
        ),
        timestamp: Date.now(),
      });
      this.finishOperation(controller);
      return;
    }

    this.ctx.setLoadingState(true);
    m.redraw();

    const progressMessageId = this.ctx.generateId();
    this.ctx.addMessage({
      id: progressMessageId,
      role: 'assistant',
      content: uiText(
        '🎬 **场景还原中...**\n\n正在回放 Trace 中的用户操作与设备响应...',
        '🎬 **Reconstructing scenes...**\n\nReplaying user interactions and device responses from the trace...',
      ),
      timestamp: Date.now(),
    });

    this.debugLog('Scene reconstruction request with traceId:', backendTraceId);

    try {
      const response = await this.ctx.fetchBackend(
        buildAssistantApiV1Url(this.ctx.getBackendUrl(), '/scene-reconstruct'),
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'Accept-Language': uiOutputLanguage(),
          },
          body: JSON.stringify({
            traceId: backendTraceId,
            options: {
              deepAnalysis: false,
              generateTracks: true,
              forceRefresh: opts?.forceRefresh ?? false,
              outputLanguage: uiOutputLanguage(),
            },
          }),
        },
      );
      this.assertCurrent(generation);

      if (!response.ok) {
        try {
          const errorData = await response.json();
          this.assertCurrent(generation);
          console.error(
            '[StoryController] Scene reconstruction error response:',
            errorData,
          );
          throw new Error(
            errorData.error ||
              `HTTP ${response.status}: ${response.statusText}`,
          );
        } catch (parseErr) {
          if (parseErr instanceof StoryControllerInvalidatedError) throw parseErr;
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data = await response.json();
      this.assertCurrent(generation);
      if (!data.success || !data.analysisId) {
        throw new Error(
          data.error ||
            uiText('启动场景还原失败', 'Failed to start scene reconstruction'),
        );
      }

      const analysisId = data.analysisId;
      this.debugLog(
        'Scene reconstruction started with analysisId:',
        analysisId,
      );
      await this.connectToSSE(
        analysisId,
        progressMessageId,
        generation,
        controller.signal,
      );
      this.assertCurrent(generation);
      this.ctx.setLoadingState(false);
      m.redraw();
    } catch (error: any) {
      if (!this.isCurrent(generation)) {
        throw new StoryControllerInvalidatedError();
      }
      console.error('[StoryController] Scene reconstruction error:', error);
      this.ctx.updateMessage(progressMessageId, {
        content: uiText(
          `❌ **场景还原失败**\n\n${error.message || '未知错误'}`,
          `❌ **Scene reconstruction failed**\n\n${error.message || 'Unknown error'}`,
        ),
      });
      this.ctx.setLoadingState(false);
      m.redraw();
      throw error;
    } finally {
      this.finishOperation(controller);
    }
  }

  /**
   * Connect to the backend scene-reconstruct SSE stream. See the file header
   * for the reason this uses fetch + manual SSE parsing rather than EventSource.
   */
  private async connectToSSE(
    analysisId: string,
    progressMessageId: string,
    generation: number,
    operationSignal: AbortSignal,
  ): Promise<void> {
    const sceneSseUrl = buildAssistantApiV1Url(
      this.ctx.getBackendUrl(),
      `/scene-reconstruct/${analysisId}/stream`,
    );

    let scenes: any[] = [];
    let trackEvents: any[] = [];
    let narrative = '';
    let findings: any[] = [];

    const unwrapEventData = (raw: any): any => {
      if (!raw || typeof raw !== 'object') return {};
      // Agent-driven backend wraps payload as: { type, data, timestamp }.
      if (raw.data && typeof raw.data === 'object') return raw.data;
      return raw;
    };

    const applyScenePayload = (payload: any) => {
      if (!payload || typeof payload !== 'object') return;
      if (Array.isArray(payload.scenes)) scenes = payload.scenes;
      if (Array.isArray(payload.trackEvents)) trackEvents = payload.trackEvents;
      if (Array.isArray(payload.tracks) && trackEvents.length === 0)
        {trackEvents = payload.tracks;}
      if (typeof payload.narrative === 'string' && payload.narrative)
        {narrative = payload.narrative;}
      if (
        typeof payload.conclusion === 'string' &&
        payload.conclusion &&
        !narrative
      )
        {narrative = payload.conclusion;}
      if (Array.isArray(payload.findings)) findings = payload.findings;
    };

    // Use AbortController for timeout (5 minutes)
    const abortController = new AbortController();
    const abortForOperation = () => abortController.abort();
    operationSignal.addEventListener('abort', abortForOperation, {once: true});
    const timeoutId = setTimeout(
      () => {
        console.warn('[StoryController] Scene SSE timeout');
        abortController.abort();
      },
      5 * 60 * 1000,
    );

    try {
      // fetchBackend sends API key via x-api-key header (no URL exposure)
      const response = await this.ctx.fetchBackend(sceneSseUrl, {
        signal: abortController.signal,
      });
      this.assertCurrent(generation);

      if (!response.ok) {
        throw new Error(`Scene SSE connection failed: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body for scene SSE');
      }

      this.debugLog('Scene SSE connected');

      const decoder = new TextDecoder();
      let buffer = '';
      let currentEventType = '';

      while (true) {
        if (abortController.signal.aborted) break;

        const {done, value} = await reader.read();
        this.assertCurrent(generation);
        if (done) {
          this.debugLog('Scene SSE stream ended normally');
          reader.releaseLock();
          break;
        }

        buffer += decoder.decode(value, {stream: true});
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          if (line.startsWith(':')) continue; // Skip keep-alive comments

          if (line.startsWith('event:')) {
            currentEventType = line.replace('event:', '').trim();
          } else if (line.startsWith('data:')) {
            const dataStr = line.replace('data:', '').trim();
            if (!dataStr) {
              currentEventType = '';
              continue;
            }
            try {
              const rawData = JSON.parse(dataStr);
              const eventType = currentEventType || rawData.type || '';

              const isTerminal =
                eventType === 'end' ||
                eventType === 'error' ||
                eventType === 'scene_story_report_ready';
              console.log(
                '[StoryController] Scene SSE event:',
                eventType,
                'terminal?',
                isTerminal,
              );

              this.handleSSEEvent(
                eventType,
                rawData,
                unwrapEventData,
                applyScenePayload,
                progressMessageId,
                scenes,
                findings,
                trackEvents,
                generation,
              );

              // Terminal events
              if (isTerminal) {
                reader.releaseLock();
                clearTimeout(timeoutId);
                if (eventType === 'error') {
                  const errData = unwrapEventData(rawData);
                  console.error(
                    '[StoryController] Scene SSE error event:',
                    errData,
                  );
                  // Backend sends {content: {message: "..."}} but legacy paths
                  // use {error: "..."}. Check all variants.
                  const errMsg =
                    errData.message ||
                    errData.error ||
                    rawData.content?.message ||
                    rawData.error ||
                    'Scene reconstruction failed';
                  throw new Error(errMsg);
                }
                // Terminal event ('end' or 'scene_story_report_ready') — render
                // whatever scenes/narrative we've collected and tear down.
                this.debugLog('Scene SSE: terminal event received:', eventType);
                this.renderResult(
                  progressMessageId,
                  scenes,
                  trackEvents,
                  narrative,
                  findings,
                  generation,
                );
                await this.autoPinTracks(scenes, generation);
                this.assertCurrent(generation);
                this.ctx.setDetectedScenes(scenes);
                m.redraw();
                return;
              }
            } catch (e) {
              // Re-throw everything except JSON parse failures (SyntaxError).
              // The old check `e.message.includes('Scene reconstruction')`
              // silently swallowed errors whose message didn't match that
              // exact casing/wording (e.g. `scene_reconstruction skill
              // failed: ...`), causing the reader to be used after release.
              if (!(e instanceof SyntaxError)) throw e;
              console.warn(
                '[StoryController] Failed to parse scene SSE data:',
                e,
              );
            }
            currentEventType = '';
          }
        }
      }

      // Stream ended without explicit 'end' event - render what we have
      this.renderResult(
        progressMessageId,
        scenes,
        trackEvents,
        narrative,
        findings,
        generation,
      );
      await this.autoPinTracks(scenes, generation);
      this.assertCurrent(generation);
      this.ctx.setDetectedScenes(scenes);
      m.redraw();
    } catch (e: any) {
      if (!this.isCurrent(generation)) {
        throw new StoryControllerInvalidatedError();
      }
      if (
        abortController.signal.aborted &&
        this.isCurrent(generation) &&
        !e.message?.includes('Scene reconstruction')
      ) {
        throw new Error('Scene reconstruction timeout');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
      operationSignal.removeEventListener('abort', abortForOperation);
    }
  }

  /**
   * Dispatch a single scene SSE event to the appropriate sub-handler.
   * Extracted to keep connectToSSE() readable.
   */
  private handleSSEEvent(
    eventType: string,
    rawData: any,
    unwrapEventData: (raw: any) => any,
    applyScenePayload: (payload: any) => void,
    progressMessageId: string,
    scenes: any[],
    findings: any[],
    trackEvents: any[],
    generation: number,
  ): void {
    this.assertCurrent(generation);
    const data = unwrapEventData(rawData);

    switch (eventType) {
      case 'connected':
        this.debugLog('Scene SSE: connected event received');
        break;

      case 'progress': {
        const content = buildSceneProgressContent({
          eventType: 'progress',
          data,
          rawData,
          language: uiOutputLanguage(),
        });
        if (!content) break;
        this.debugLog('Scene progress:', data.message ?? data.phase, data);
        this.ctx.updateMessage(progressMessageId, {
          content,
        });
        m.redraw();
        break;
      }

      case 'phase_start':
        this.debugLog('Scene phase start:', data);
        this.ctx.updateMessage(progressMessageId, {
          content: buildSceneProgressContent({
            eventType: 'phase_start',
            data,
            rawData,
            language: uiOutputLanguage(),
          }),
        });
        m.redraw();
        break;

      case 'scene_detected':
        this.debugLog('Scene detected:', data);
        if (data.scene) {
          scenes.push(data.scene);
        }
        this.ctx.updateMessage(progressMessageId, {
          content: uiText(
            `🎬 **场景还原中...**\n\n已检测到 ${scenes.length} 个场景...`,
            `🎬 **Reconstructing scenes...**\n\nDetected ${scenes.length} scenes...`,
          ),
        });
        m.redraw();
        break;

      case 'finding':
        this.debugLog('Scene finding:', data);
        if (data.finding) {
          findings.push(data.finding);
        }
        break;

      case 'track_events':
        this.debugLog('Track events:', data);
        if (Array.isArray(data.events)) {
          trackEvents.length = 0;
          trackEvents.push(...data.events);
        } else if (Array.isArray(data.trackEvents)) {
          trackEvents.length = 0;
          trackEvents.push(...data.trackEvents);
        }
        break;

      case 'track_data':
        this.debugLog('Track data:', data);
        if (Array.isArray(data.scenes)) {
          scenes.length = 0;
          scenes.push(...data.scenes);
        }
        if (Array.isArray(data.tracks)) {
          trackEvents.length = 0;
          trackEvents.push(...data.tracks);
        }
        if (Array.isArray(data.trackEvents)) {
          trackEvents.length = 0;
          trackEvents.push(...data.trackEvents);
        }
        break;

      // DataEnvelope events — route to track overlay for state timeline lanes
      case 'data': {
        const envelopes = Array.isArray(rawData.envelope)
          ? rawData.envelope
          : rawData.envelope
            ? [rawData.envelope]
            : [];
        const trace = this.ctx.getTrace();
        for (const envelope of envelopes) {
          if (
            !envelope?.meta?.stepId ||
            !envelope?.data?.columns ||
            !envelope?.data?.rows
          )
            {continue;}
          const overlayId = STEP_TO_OVERLAY.get(envelope.meta.stepId);
          if (overlayId && trace) {
            this.debugLog('Creating overlay track:', overlayId);
            createOverlayTrack(
              trace,
              overlayId,
              envelope.data.columns,
              envelope.data.rows,
              () => this.isCurrent(generation),
            ).catch((err: Error) =>
              console.warn(
                '[StoryController] Overlay track creation failed:',
                err,
              ),
            );
          }
        }
        break;
      }

      case 'result':
        this.debugLog('Scene result:', data);
        applyScenePayload(data);
        break;

      case 'analysis_completed':
        this.debugLog('Analysis completed:', data);
        applyScenePayload(data);
        break;

      case 'scene_reconstruction_completed':
        this.debugLog('Scene reconstruction completed:', data);
        applyScenePayload(data);
        break;

      // ── Scene Story Pipeline events ────────────────────────────────────
      // Until the dedicated Story Panel UI lands, these lifecycle events
      // are routed into the existing chat-message progress flow so users
      // still see something while the scene_story_* protocol stabilises.

      case 'scene_story_detected': {
        const sceneCount = Array.isArray(data.scenes) ? data.scenes.length : 0;
        const queuedCount = Number(data.analysisIntervals ?? 0);
        this.debugLog(
          'Story scenes detected:',
          sceneCount,
          'queued:',
          queuedCount,
        );
        this.ctx.updateMessage(progressMessageId, {
          content: uiText(
            `🎬 **场景还原中...**\n\n已检测到 ${sceneCount} 个场景，排队深度分析 ${queuedCount} 个`,
            `🎬 **Reconstructing scenes...**\n\nDetected ${sceneCount} scenes; ${queuedCount} queued for deep analysis`,
          ),
        });
        m.redraw();
        break;
      }

      case 'scene_story_queued':
      case 'scene_story_started':
      case 'scene_story_retrying':
        this.debugLog('Story job lifecycle:', eventType, data);
        break;

      case 'scene_story_completed':
      case 'scene_story_failed':
      case 'scene_story_dropped':
        this.debugLog('Story job terminal:', eventType, data);
        break;

      case 'scene_story_cancelled': {
        const scope = data.scope === 'session' ? 'session' : 'job';
        this.debugLog('Story cancelled:', scope, data);
        if (scope === 'session') {
          this.ctx.updateMessage(progressMessageId, {
            content: uiText(
              '🎬 **场景还原已取消**\n\n部分结果可能尚未生成。',
              '🎬 **Scene reconstruction cancelled**\n\nSome results may not have been generated.',
            ),
          });
          m.redraw();
        }
        break;
      }

      case 'scene_story_report_ready': {
        // Terminal event for the new pipeline. Surface the Stage 3 summary
        // (when present) as the narrative so the existing renderResult
        // pipeline displays it, then let the connectToSSE() outer loop
        // notice the terminal type and render the final scene table.
        this.debugLog('Story report ready:', data);
        if (typeof data.summary === 'string' && data.summary.length > 0) {
          applyScenePayload({narrative: data.summary});
        }
        break;
      }

      default:
        this.debugLog('Scene SSE unknown event:', eventType);
        break;
    }
  }

  /**
   * Render the scene reconstruction result as a markdown message.
   * Equivalent to the old AIPanel.renderSceneReconstructionResult().
   */
  private renderResult(
    messageId: string,
    scenes: any[],
    _trackEvents: any[],
    narrative: string,
    _findings: any[],
    generation: number,
  ): void {
    this.assertCurrent(generation);
    if (scenes.length === 0) {
      this.ctx.updateMessage(messageId, {
        content: uiText(
          '🎬 **场景还原完成**\n\n未检测到明显的用户操作场景。',
          '🎬 **Scene reconstruction complete**\n\nNo clear user-interaction scenes were detected.',
        ),
      });
      m.redraw();
      return;
    }

    // Build scene cards content
    let content = uiText(
      '## 🎬 场景还原结果\n\n',
      '## 🎬 Scene reconstruction result\n\n',
    );

    // Scene summary
    content += uiText(
      `共还原 **${scenes.length}** 个操作场景（仅回放，不含根因诊断）：\n\n`,
      `Reconstructed **${scenes.length}** interaction scenes (replay only; no root-cause diagnosis):\n\n`,
    );

    // Scene timeline as a table
    content += uiText(
      '| 序号 | 类型 | 开始时间 | 时长 | 应用/活动 | 响应状态 |\n',
      '| # | Type | Start time | Duration | App/Activity | Response |\n',
    );
    content += '|------|------|----------|------|-----------|-----------|\n';

    scenes.forEach((scene, index) => {
      const displayName = getSceneDisplayName(scene.type, scene.label);
      const durationStr =
        scene.durationMs >= 1000
          ? `${(scene.durationMs / 1000).toFixed(2)}s`
          : `${scene.durationMs.toFixed(0)}ms`;
      const responseStatus = getSceneResponseStatusLabel(
        scene.type,
        scene.durationMs,
        scene.metadata,
      );
      const appInfo = scene.appPackage
        ? scene.activityName
          ? `${scene.appPackage}/${scene.activityName}`
          : scene.appPackage
        : '-';

      // Make start timestamp clickable for navigation
      const startTsNs = scene.startTs;
      content += `| ${index + 1} | ${displayName} | `;
      content += `@ts[${startTsNs}|${formatSceneTimestamp(startTsNs)}] | `;
      content += `${durationStr} | ${appInfo.length > 30 ? appInfo.substring(0, 30) + '...' : appInfo} | ${responseStatus} |\n`;
    });

    // Add narrative if available
    if (narrative) {
      content += uiText(
        `\n---\n\n### 📝 操作回放摘要\n\n${narrative}\n`,
        `\n---\n\n### 📝 Interaction replay summary\n\n${narrative}\n`,
      );
    }

    // Add navigation tips
    content += uiText(
      '\n---\n\n💡 **提示**：点击时间戳可跳转到对应位置，相关泳道已自动 Pin 到顶部。',
      '\n---\n\n💡 **Tip**: Select a timestamp to navigate there. Relevant tracks are pinned automatically.',
    );

    this.ctx.updateMessage(messageId, {content});
    m.redraw();
  }

  /**
   * Auto-pin tracks based on detected scene types.
   * Equivalent to the old AIPanel.autoPinTracksForScenes().
   */
  private async autoPinTracks(
    scenes: any[],
    generation: number,
  ): Promise<void> {
    this.assertCurrent(generation);
    const trace = this.ctx.getTrace();
    if (!trace || scenes.length === 0) return;

    // Collect unique scene types
    const sceneTypes = new Set(scenes.map((s) => s.type));

    // Collect pin instructions for all detected scene types
    const allInstructions: ScenePinInstruction[] = [];

    sceneTypes.forEach((sceneType) => {
      const instructions = SCENE_PIN_MAPPING[sceneType];
      if (instructions) {
        instructions.forEach((inst) => {
          // Avoid duplicates
          if (!allInstructions.some((i) => i.pattern === inst.pattern)) {
            allInstructions.push(localizeScenePinInstruction(inst));
          }
        });
      }
    });

    if (allInstructions.length === 0) return;

    // Get active processes from scenes
    const activeProcesses = scenes
      .filter((s) => s.appPackage)
      .map((s) => ({processName: s.appPackage, frameCount: 1}));

    this.debugLog(
      'Auto-pinning tracks for scenes:',
      sceneTypes,
      'with',
      allInstructions.length,
      'instructions',
    );

    // Delegate to AIPanel via ctx
    await this.ctx.pinTracksFromInstructions(
      allInstructions,
      activeProcesses,
      () => this.isCurrent(generation),
    );
    this.assertCurrent(generation);
  }
}
