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
  ScenePinInstruction,
  formatSceneTimestamp,
  getSceneDisplayName,
  getSceneResponseStatusLabel,
} from './scene_constants';
import {uiOutputLanguage, uiText, uiTextForLanguage} from './ui_language';
import {STEP_TO_OVERLAY, createOverlayTrack} from './track_overlay';
import {Message, StoryPreviewResult} from './types';

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
  ): Promise<void>;

  // ── Scene state sync (writes AIPanel.state.detectedScenes) ──
  setDetectedScenes(scenes: any[]): void;

  /** Optional debug flag — when true, verbose console.log() messages are emitted */
  debug?: boolean;
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
      return uiTextForLanguage(language, '正在生成场景摘要', 'Summarizing scenes');
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
  const detail = typeof message === 'string' && message.trim()
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

  constructor(ctx: StoryControllerContext) {
    this.ctx = ctx;
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
    const url = buildAssistantApiV1Url(
      this.ctx.getBackendUrl(),
      '/scene-reconstruct/preview',
    );
    const response = await this.ctx.fetchBackend(url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({traceId}),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(
        (errData as any).error || `Preview failed: HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    if (!(data as any).success) {
      throw new Error((data as any).error || 'Preview request failed');
    }
    return data as StoryPreviewResult;
  }

  /**
   * Load a previously persisted SceneReport by reportId.
   * GET /scene-reconstruct/report/:reportId
   */
  async loadReport(reportId: string): Promise<any> {
    const url = buildAssistantApiV1Url(
      this.ctx.getBackendUrl(),
      `/scene-reconstruct/report/${encodeURIComponent(reportId)}?outputLanguage=${encodeURIComponent(uiOutputLanguage())}`,
    );
    const response = await this.ctx.fetchBackend(url);
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(
        (errData as any).error || `Load report failed: HTTP ${response.status}`,
      );
    }
    const data = await response.json();
    if (!(data as any).success) {
      throw new Error((data as any).error || 'Failed to load report');
    }
    return (data as any).report;
  }

  /**
   * Start scene reconstruction.
   * Equivalent to the old AIPanel.handleSceneReconstructCommand().
   */
  async start(opts?: {forceRefresh?: boolean}): Promise<void> {
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
      return;
    }

    this.ctx.setLoadingState(true);
    m.redraw();

    // Add initial progress message
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
      // Start scene reconstruction
      const response = await this.ctx.fetchBackend(
        buildAssistantApiV1Url(this.ctx.getBackendUrl(), '/scene-reconstruct'),
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
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

      if (!response.ok) {
        try {
          const errorData = await response.json();
          console.error('[StoryController] Scene reconstruction error response:', errorData);
          throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
        } catch (parseErr) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      }

      const data = await response.json();
      if (!data.success || !data.analysisId) {
        throw new Error(data.error || 'Failed to start scene reconstruction');
      }

      const analysisId = data.analysisId;
      this.debugLog('Scene reconstruction started with analysisId:', analysisId);

      // Connect to SSE for real-time updates
      await this.connectToSSE(analysisId, progressMessageId);
    } catch (error: any) {
      console.error('[StoryController] Scene reconstruction error:', error);
      this.ctx.updateMessage(progressMessageId, {
        content: uiText(
          `❌ **场景还原失败**\n\n${error.message || '未知错误'}`,
          `❌ **Scene reconstruction failed**\n\n${error.message || 'Unknown error'}`,
        ),
      });
      this.ctx.setLoadingState(false);
      m.redraw();
      // Re-throw so the Story Panel state machine can transition to 'failed'.
      throw error;
    }

    this.ctx.setLoadingState(false);
    m.redraw();
  }

  /**
   * Connect to the backend scene-reconstruct SSE stream. See the file header
   * for the reason this uses fetch + manual SSE parsing rather than EventSource.
   */
  private async connectToSSE(analysisId: string, progressMessageId: string): Promise<void> {
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
      if (Array.isArray(payload.tracks) && trackEvents.length === 0) trackEvents = payload.tracks;
      if (typeof payload.narrative === 'string' && payload.narrative) narrative = payload.narrative;
      if (typeof payload.conclusion === 'string' && payload.conclusion && !narrative) narrative = payload.conclusion;
      if (Array.isArray(payload.findings)) findings = payload.findings;
    };

    // Use AbortController for timeout (5 minutes)
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => {
      console.warn('[StoryController] Scene SSE timeout');
      abortController.abort();
    }, 5 * 60 * 1000);

    try {
      // fetchBackend sends API key via x-api-key header (no URL exposure)
      const response = await this.ctx.fetchBackend(sceneSseUrl, {
        signal: abortController.signal,
      });

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
              console.log('[StoryController] Scene SSE event:', eventType, 'terminal?', isTerminal);

              this.handleSSEEvent(
                eventType, rawData, unwrapEventData, applyScenePayload,
                progressMessageId, scenes, findings, trackEvents,
              );

              // Terminal events
              if (isTerminal) {
                reader.releaseLock();
                clearTimeout(timeoutId);
                if (eventType === 'error') {
                  const errData = unwrapEventData(rawData);
                  console.error('[StoryController] Scene SSE error event:', errData);
                  // Backend sends {content: {message: "..."}} but legacy paths
                  // use {error: "..."}. Check all variants.
                  const errMsg = errData.message || errData.error
                    || rawData.content?.message || rawData.error
                    || 'Scene reconstruction failed';
                  throw new Error(errMsg);
                }
                // Terminal event ('end' or 'scene_story_report_ready') — render
                // whatever scenes/narrative we've collected and tear down.
                this.debugLog('Scene SSE: terminal event received:', eventType);
                this.renderResult(progressMessageId, scenes, trackEvents, narrative, findings);
                this.autoPinTracks(scenes);
                // Update scene navigation bar with reconstruction results
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
              console.warn('[StoryController] Failed to parse scene SSE data:', e);
            }
            currentEventType = '';
          }
        }
      }

      // Stream ended without explicit 'end' event - render what we have
      this.renderResult(progressMessageId, scenes, trackEvents, narrative, findings);
      this.autoPinTracks(scenes);
      // Update scene navigation bar with reconstruction results
      this.ctx.setDetectedScenes(scenes);
      m.redraw();
    } catch (e: any) {
      if (abortController.signal.aborted && !e.message?.includes('Scene reconstruction')) {
        throw new Error('Scene reconstruction timeout');
      }
      throw e;
    } finally {
      clearTimeout(timeoutId);
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
  ): void {
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
          : (rawData.envelope ? [rawData.envelope] : []);
        const trace = this.ctx.getTrace();
        for (const envelope of envelopes) {
          if (!envelope?.meta?.stepId || !envelope?.data?.columns || !envelope?.data?.rows) continue;
          const overlayId = STEP_TO_OVERLAY.get(envelope.meta.stepId);
          if (overlayId && trace) {
            this.debugLog('Creating overlay track:', overlayId);
            createOverlayTrack(trace, overlayId, envelope.data.columns, envelope.data.rows)
              .catch((err: Error) => console.warn('[StoryController] Overlay track creation failed:', err));
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
        this.debugLog('Story scenes detected:', sceneCount, 'queued:', queuedCount);
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
          applyScenePayload({ narrative: data.summary });
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
  ): void {
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
    let content = uiText('## 🎬 场景还原结果\n\n', '## 🎬 Scene reconstruction result\n\n');

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
      const durationStr = scene.durationMs >= 1000
        ? `${(scene.durationMs / 1000).toFixed(2)}s`
        : `${scene.durationMs.toFixed(0)}ms`;
      const responseStatus = getSceneResponseStatusLabel(scene.type, scene.durationMs, scene.metadata);
      const appInfo = scene.appPackage
        ? (scene.activityName ? `${scene.appPackage}/${scene.activityName}` : scene.appPackage)
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
  private async autoPinTracks(scenes: any[]): Promise<void> {
    const trace = this.ctx.getTrace();
    if (!trace || scenes.length === 0) return;

    // Collect unique scene types
    const sceneTypes = new Set(scenes.map(s => s.type));

    // Collect pin instructions for all detected scene types
    const allInstructions: ScenePinInstruction[] = [];

    sceneTypes.forEach(sceneType => {
      const instructions = SCENE_PIN_MAPPING[sceneType];
      if (instructions) {
        instructions.forEach(inst => {
          // Avoid duplicates
          if (!allInstructions.some(i => i.pattern === inst.pattern)) {
            allInstructions.push(inst);
          }
        });
      }
    });

    if (allInstructions.length === 0) return;

    // Get active processes from scenes
    const activeProcesses = scenes
      .filter(s => s.appPackage)
      .map(s => ({processName: s.appPackage, frameCount: 1}));

    this.debugLog('Auto-pinning tracks for scenes:', sceneTypes, 'with', allInstructions.length, 'instructions');

    // Delegate to AIPanel via ctx
    await this.ctx.pinTracksFromInstructions(allInstructions, activeProcesses);
  }
}
