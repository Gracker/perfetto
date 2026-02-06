// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Scene reconstruction module for the AI Assistant plugin.
 *
 * This module handles:
 * - Scene detection and analysis (/scene command)
 * - SSE connection for real-time scene updates
 * - Scene result rendering
 * - Auto-pinning tracks based on detected scenes
 *
 * Scene reconstruction identifies user operation scenes in a trace
 * (e.g., cold_start, scroll, navigation) and provides performance analysis.
 */

import m from 'mithril';
import {Message, AISettings} from './types';

/**
 * Scene data structure returned from backend analysis.
 */
export interface SceneData {
  type: string;
  startTs: string;
  endTs?: string;
  durationMs: number;
  confidence?: number;
  appPackage?: string;
  activityName?: string;
  metadata?: Record<string, any>;
}

/**
 * Finding from scene analysis.
 */
export interface SceneFinding {
  severity: 'critical' | 'warning' | 'info';
  message?: string;
  summary?: string;
  description?: string;
}

/**
 * Pin instruction for auto-pinning tracks based on scene type.
 */
export interface PinInstruction {
  pattern: string;
  matchBy: string;
  priority: number;
  reason: string;
  expand?: boolean;
  mainThreadOnly?: boolean;
  smartPin?: boolean;
}

/**
 * Context required by the scene reconstruction handler.
 * Allows dependency injection from the parent AIPanel.
 */
export interface SceneHandlerContext {
  backendTraceId: string | null;
  settings: AISettings;
  trace: any;  // Trace type from perfetto
  addMessage: (message: Message) => void;
  updateMessage: (messageId: string, updates: Partial<Message>) => void;
  generateId: () => string;
  setLoading: (loading: boolean) => void;
  pinTracksFromInstructions: (
    instructions: PinInstruction[],
    activeProcesses: Array<{processName: string; frameCount: number}>
  ) => Promise<void>;
}

// =============================================================================
// Scene Constants
// =============================================================================

/**
 * Scene category display names for UI rendering.
 * Maps backend scene type keys to Chinese display names.
 */
export const SCENE_DISPLAY_NAMES: Record<string, string> = {
  'cold_start': '冷启动',
  'warm_start': '温启动',
  'hot_start': '热启动',
  'scroll': '滑动浏览',
  'inertial_scroll': '惯性滑动',
  'navigation': '页面跳转',
  'app_switch': '应用切换',
  'screen_unlock': '解锁屏幕',
  'notification': '通知操作',
  'split_screen': '分屏操作',
  'tap': '点击',
  'long_press': '长按',
  'idle': '空闲',
};

/**
 * Scene-to-pin mapping for auto-pinning relevant tracks based on scene type.
 * Each scene type maps to an array of track pinning instructions.
 */
export const SCENE_PIN_MAPPING: Record<string, PinInstruction[]> = {
  'scroll': [
    { pattern: '^RenderThread$', matchBy: 'name', priority: 1, reason: '渲染线程', smartPin: true },
    { pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器' },
    { pattern: '^BufferTX', matchBy: 'name', priority: 3, reason: '缓冲区', smartPin: true },
  ],
  'inertial_scroll': [
    { pattern: '^RenderThread$', matchBy: 'name', priority: 1, reason: '渲染线程', smartPin: true },
    { pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器' },
    { pattern: '^BufferTX', matchBy: 'name', priority: 3, reason: '缓冲区', smartPin: true },
  ],
  'cold_start': [
    { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
    { pattern: 'ActivityManager', matchBy: 'name', priority: 2, reason: '活动管理' },
    { pattern: 'Zygote', matchBy: 'name', priority: 3, reason: '进程创建' },
  ],
  'warm_start': [
    { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
    { pattern: 'ActivityManager', matchBy: 'name', priority: 2, reason: '活动管理' },
  ],
  'hot_start': [
    { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
  ],
  'tap': [
    { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
    { pattern: '^RenderThread$', matchBy: 'name', priority: 2, reason: '渲染响应', smartPin: true },
  ],
  'navigation': [
    { pattern: '^main$', matchBy: 'name', priority: 1, reason: '主线程', smartPin: true, mainThreadOnly: true },
    { pattern: '^RenderThread$', matchBy: 'name', priority: 2, reason: '渲染线程', smartPin: true },
  ],
  'app_switch': [
    { pattern: 'ActivityManager', matchBy: 'name', priority: 1, reason: '活动管理' },
    { pattern: 'WindowManager', matchBy: 'name', priority: 2, reason: '窗口管理' },
  ],
};

/**
 * Performance rating thresholds for scenes.
 * Used to determine green/yellow/red performance indicators.
 */
export const SCENE_THRESHOLDS: Record<string, { good: number; acceptable: number }> = {
  'cold_start': { good: 500, acceptable: 1000 },
  'warm_start': { good: 300, acceptable: 600 },
  'hot_start': { good: 100, acceptable: 200 },
  'scroll_fps': { good: 55, acceptable: 45 },
  'inertial_scroll': { good: 500, acceptable: 1000 },
  'tap': { good: 100, acceptable: 200 },
  'navigation': { good: 300, acceptable: 500 },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get performance rating emoji based on scene type and duration.
 *
 * @param sceneType - The type of scene (cold_start, scroll, etc.)
 * @param durationMs - Duration in milliseconds
 * @param metadata - Optional metadata (used for FPS in scroll scenes)
 * @returns Performance emoji: 🟢 (good), 🟡 (acceptable), 🔴 (poor), ⚪ (unknown)
 */
export function getScenePerformanceRating(
  sceneType: string,
  durationMs: number,
  metadata?: Record<string, any>
): string {
  // For scroll, check FPS instead of duration
  if ((sceneType === 'scroll' || sceneType === 'inertial_scroll') && metadata?.averageFps !== undefined) {
    const fps = metadata.averageFps;
    const thresholds = SCENE_THRESHOLDS['scroll_fps'];
    if (fps >= thresholds.good) return '🟢';
    if (fps >= thresholds.acceptable) return '🟡';
    return '🔴';
  }

  // For other scenes, check duration
  const thresholds = SCENE_THRESHOLDS[sceneType];
  if (!thresholds) return '⚪'; // Unknown scene type

  if (durationMs <= thresholds.good) return '🟢';
  if (durationMs <= thresholds.acceptable) return '🟡';
  return '🔴';
}

/**
 * Format scene timestamp for display (ns string to human readable).
 * Handles BigInt string timestamps from scene reconstruction.
 *
 * @param tsNs - Timestamp in nanoseconds as a string
 * @returns Human-readable timestamp string (e.g., "1.234s" or "2m 3.456s")
 */
export function formatSceneTimestamp(tsNs: string): string {
  try {
    const ns = BigInt(tsNs);
    const ms = Number(ns / BigInt(1000000));
    const seconds = ms / 1000;
    if (seconds < 60) {
      return `${seconds.toFixed(3)}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds.toFixed(3)}s`;
  } catch {
    return tsNs;
  }
}

// =============================================================================
// Scene Reconstruction Handler
// =============================================================================

/**
 * Scene Reconstruction Handler class.
 *
 * Manages the scene reconstruction workflow:
 * 1. Initiates backend analysis request
 * 2. Connects to SSE for real-time updates
 * 3. Renders the final result
 * 4. Auto-pins relevant tracks
 */
export class SceneReconstructionHandler {
  private ctx: SceneHandlerContext;

  constructor(ctx: SceneHandlerContext) {
    this.ctx = ctx;
  }

  /**
   * Handle /scene command.
   * Detects user operation scenes in the trace and provides performance analysis.
   */
  async handleSceneReconstructCommand(): Promise<void> {
    if (!this.ctx.backendTraceId) {
      this.ctx.addMessage({
        id: this.ctx.generateId(),
        role: 'assistant',
        content: '⚠️ **无法执行场景还原**\n\n请先确保 Trace 已上传到后端。',
        timestamp: Date.now(),
      });
      return;
    }

    this.ctx.setLoading(true);
    m.redraw();

    // Add initial progress message
    const progressMessageId = this.ctx.generateId();
    this.ctx.addMessage({
      id: progressMessageId,
      role: 'assistant',
      content: '🎬 **场景还原中...**\n\n正在分析 Trace 中的用户操作场景...',
      timestamp: Date.now(),
    });

    console.log('[SceneReconstruction] Request with traceId:', this.ctx.backendTraceId);

    try {
      // Start scene reconstruction
      const response = await fetch(`${this.ctx.settings.backendUrl}/api/agent/scene-reconstruct`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          traceId: this.ctx.backendTraceId,
          options: {
            deepAnalysis: true,
            generateTracks: true,
          },
        }),
      });

      if (!response.ok) {
        try {
          const errorData = await response.json();
          console.error('[SceneReconstruction] Error response:', errorData);
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
      console.log('[SceneReconstruction] Started with analysisId:', analysisId);

      // Connect to SSE for real-time updates
      await this.connectToSceneSSE(analysisId, progressMessageId);

    } catch (error: any) {
      console.error('[SceneReconstruction] Error:', error);
      // Update the progress message with error
      this.ctx.updateMessage(progressMessageId, {
        content: `❌ **场景还原失败**\n\n${error.message || '未知错误'}`,
      });
    }

    this.ctx.setLoading(false);
    m.redraw();
  }

  /**
   * Connect to SSE endpoint for scene reconstruction updates.
   *
   * @param analysisId - Backend analysis session ID
   * @param progressMessageId - Message ID to update with progress
   */
  private connectToSceneSSE(analysisId: string, progressMessageId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const eventSource = new EventSource(
        `${this.ctx.settings.backendUrl}/api/agent/scene-reconstruct/${analysisId}/stream`
      );

      let scenes: SceneData[] = [];
      let trackEvents: any[] = [];
      let narrative = '';
      let findings: SceneFinding[] = [];

      const unwrapEventData = (raw: any): any => {
        if (!raw || typeof raw !== 'object') return {};
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

      eventSource.onopen = () => {
        console.log('[SceneReconstruction] SSE connected');
      };

      eventSource.onerror = (error) => {
        console.error('[SceneReconstruction] SSE error:', error);
        eventSource.close();
        reject(new Error('SSE connection failed'));
      };

      // Handle different event types
      eventSource.addEventListener('connected', () => {
        console.log('[SceneReconstruction] SSE: connected event received');
      });

      eventSource.addEventListener('progress', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          const phase = data.phase || raw.phase;
          if (!phase) return;
          console.log('[SceneReconstruction] Progress:', phase, data);
          this.ctx.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n${phase}...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse progress event:', e);
        }
      });

      // Backward compatibility with legacy scene SSE.
      eventSource.addEventListener('phase_start', (event) => {
        try {
          const data = JSON.parse(event.data);
          console.log('[SceneReconstruction] Phase start:', data);
          this.ctx.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n${data.phase || '正在分析'}...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse phase_start event:', e);
        }
      });

      eventSource.addEventListener('scene_detected', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Scene detected:', data);
          if (data.scene) {
            scenes.push(data.scene);
          }
          this.ctx.updateMessage(progressMessageId, {
            content: `🎬 **场景还原中...**\n\n已检测到 ${scenes.length} 个场景...`,
          });
          m.redraw();
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse scene_detected event:', e);
        }
      });

      eventSource.addEventListener('finding', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Finding:', data);
          if (data.finding) {
            findings.push(data.finding);
          }
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse finding event:', e);
        }
      });

      eventSource.addEventListener('track_events', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Track events:', data);
          if (Array.isArray(data.events)) {
            trackEvents = data.events;
          } else if (Array.isArray(data.trackEvents)) {
            trackEvents = data.trackEvents;
          }
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse track_events:', e);
        }
      });

      eventSource.addEventListener('track_data', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Track data:', data);
          if (Array.isArray(data.scenes)) scenes = data.scenes;
          if (Array.isArray(data.tracks)) trackEvents = data.tracks;
          if (Array.isArray(data.trackEvents)) trackEvents = data.trackEvents;
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse track_data event:', e);
        }
      });

      eventSource.addEventListener('result', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Result:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse result event:', e);
        }
      });

      eventSource.addEventListener('analysis_completed', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Analysis completed:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse analysis_completed event:', e);
        }
      });

      eventSource.addEventListener('scene_reconstruction_completed', (event) => {
        try {
          const raw = JSON.parse(event.data);
          const data = unwrapEventData(raw);
          console.log('[SceneReconstruction] Scene reconstruction completed:', data);
          applyScenePayload(data);
        } catch (e) {
          console.warn('[SceneReconstruction] Failed to parse scene_reconstruction_completed event:', e);
        }
      });

      eventSource.addEventListener('end', () => {
        console.log('[SceneReconstruction] SSE: end event received');
        eventSource.close();

        // Render the final result
        this.renderSceneReconstructionResult(progressMessageId, scenes, trackEvents, narrative, findings);

        // Auto-pin tracks based on detected scenes
        this.autoPinTracksForScenes(scenes);

        resolve();
      });

      eventSource.addEventListener('error', (event) => {
        try {
          const data = JSON.parse((event as any).data || '{}');
          console.error('[SceneReconstruction] SSE error event:', data);
          eventSource.close();
          reject(new Error(data.error || 'Scene reconstruction failed'));
        } catch (e) {
          // Not a data event, might be connection error
          eventSource.close();
          reject(new Error('Scene reconstruction connection failed'));
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        if (eventSource.readyState !== EventSource.CLOSED) {
          console.warn('[SceneReconstruction] SSE timeout');
          eventSource.close();
          reject(new Error('Scene reconstruction timeout'));
        }
      }, 5 * 60 * 1000);
    });
  }

  /**
   * Render the scene reconstruction result.
   *
   * @param messageId - Message ID to update
   * @param scenes - Detected scenes
   * @param _trackEvents - Track events (unused, reserved for future)
   * @param narrative - AI-generated narrative description
   * @param findings - Analysis findings
   */
  private renderSceneReconstructionResult(
    messageId: string,
    scenes: SceneData[],
    _trackEvents: any[],
    narrative: string,
    findings: SceneFinding[]
  ): void {
    if (scenes.length === 0) {
      this.ctx.updateMessage(messageId, {
        content: '🎬 **场景还原完成**\n\n未检测到明显的用户操作场景。',
      });
      m.redraw();
      return;
    }

    // Build scene cards content
    let content = '## 🎬 场景还原结果\n\n';

    // Scene summary
    content += `共检测到 **${scenes.length}** 个操作场景：\n\n`;

    // Scene timeline as a table
    content += '| 序号 | 类型 | 开始时间 | 时长 | 应用/活动 | 评级 |\n';
    content += '|------|------|----------|------|-----------|------|\n';

    scenes.forEach((scene, index) => {
      const displayName = SCENE_DISPLAY_NAMES[scene.type] || scene.type;
      const rating = getScenePerformanceRating(scene.type, scene.durationMs, scene.metadata);
      const durationStr = scene.durationMs >= 1000
        ? `${(scene.durationMs / 1000).toFixed(2)}s`
        : `${scene.durationMs.toFixed(0)}ms`;
      const appInfo = scene.appPackage
        ? (scene.activityName ? `${scene.appPackage}/${scene.activityName}` : scene.appPackage)
        : '-';

      // Make start timestamp clickable for navigation
      const startTsNs = scene.startTs;
      content += `| ${index + 1} | ${displayName} | `;
      content += `<span class="clickable-ts" data-ts="${startTsNs}">${formatSceneTimestamp(startTsNs)}</span> | `;
      content += `${durationStr} | ${appInfo.length > 30 ? appInfo.substring(0, 30) + '...' : appInfo} | ${rating} |\n`;
    });

    // Add narrative if available
    if (narrative) {
      content += `\n---\n\n### 📝 场景描述\n\n${narrative}\n`;
    }

    // Add key findings
    if (findings && findings.length > 0) {
      content += `\n---\n\n### 🔍 关键发现\n\n`;
      const criticalFindings = findings.filter(f => f.severity === 'critical' || f.severity === 'warning');
      if (criticalFindings.length > 0) {
        criticalFindings.slice(0, 5).forEach(finding => {
          const icon = finding.severity === 'critical' ? '🔴' : '🟡';
          content += `- ${icon} ${finding.message || finding.summary || finding.description}\n`;
        });
      } else {
        content += '未发现明显性能问题。\n';
      }
    }

    // Add navigation tips
    content += `\n---\n\n💡 **提示**: 点击时间戳可跳转到对应位置，关键泳道已自动 Pin 到顶部。`;

    this.ctx.updateMessage(messageId, { content });
    m.redraw();
  }

  /**
   * Auto-pin tracks based on detected scene types.
   * Uses SCENE_PIN_MAPPING to determine which tracks to pin.
   *
   * @param scenes - Detected scenes
   */
  private async autoPinTracksForScenes(scenes: SceneData[]): Promise<void> {
    if (!this.ctx.trace || scenes.length === 0) return;

    // Collect unique scene types
    const sceneTypes = new Set(scenes.map(s => s.type));

    // Collect pin instructions for all detected scene types
    const allInstructions: PinInstruction[] = [];

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
      .map(s => ({ processName: s.appPackage!, frameCount: 1 }));

    console.log('[SceneReconstruction] Auto-pinning tracks for scenes:', sceneTypes, 'with', allInstructions.length, 'instructions');

    // Use existing pinTracksFromInstructions method
    await this.ctx.pinTracksFromInstructions(allInstructions, activeProcesses);
  }
}

/**
 * Default singleton instance for convenient access.
 * Note: Must be initialized with context before use.
 */
let handlerInstance: SceneReconstructionHandler | null = null;

/**
 * Initialize the scene reconstruction handler with context.
 *
 * @param ctx - The handler context from AIPanel
 * @returns The initialized handler
 */
export function initSceneHandler(ctx: SceneHandlerContext): SceneReconstructionHandler {
  handlerInstance = new SceneReconstructionHandler(ctx);
  return handlerInstance;
}

/**
 * Get the current scene reconstruction handler instance.
 * Throws if not initialized.
 */
export function getSceneHandler(): SceneReconstructionHandler {
  if (!handlerInstance) {
    throw new Error('SceneReconstructionHandler not initialized. Call initSceneHandler first.');
  }
  return handlerInstance;
}
