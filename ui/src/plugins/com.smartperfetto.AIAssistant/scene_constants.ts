// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Scene Reconstruction constants and pure helpers — the single source of
 * truth for scene display names, pin mappings, thresholds, and small
 * presentational formatters used by the AI Assistant plugin.
 */

import {uiText} from './ui_language';

/**
 * Scene category → 中文显示名
 */
export const SCENE_DISPLAY_NAMES: Record<string, string> = {
  cold_start: '冷启动',
  warm_start: '温启动',
  hot_start: '热启动',
  scroll_start: '滑动启动',
  scroll: '滑动浏览',
  inertial_scroll: '惯性滑动',
  navigation: '页面跳转',
  app_switch: '应用切换',
  home_screen: '桌面',
  app_foreground: '应用内',
  screen_on: '屏幕点亮',
  screen_off: '屏幕熄灭',
  screen_sleep: '屏幕休眠',
  screen_unlock: '解锁屏幕',
  notification: '通知操作',
  split_screen: '分屏操作',
  tap: '点击',
  long_press: '长按',
  idle: '空闲',
  back_key: '返回键',
  home_key: 'Home键',
  recents_key: '最近任务键',
  anr: 'ANR',
  jank_region: '卡顿区间',
  ime_show: '键盘弹出',
  ime_hide: '键盘收起',
  window_transition: '窗口转场',
};

export const SCENE_DISPLAY_NAMES_EN: Record<string, string> = {
  cold_start: 'Cold start',
  warm_start: 'Warm start',
  hot_start: 'Hot start',
  scroll_start: 'Scroll start',
  scroll: 'Scroll',
  inertial_scroll: 'Inertial scroll',
  navigation: 'Navigation',
  app_switch: 'App switch',
  home_screen: 'Home screen',
  app_foreground: 'App foreground',
  screen_on: 'Screen on',
  screen_off: 'Screen off',
  screen_sleep: 'Screen sleep',
  screen_unlock: 'Screen unlock',
  notification: 'Notification',
  split_screen: 'Split screen',
  tap: 'Tap',
  long_press: 'Long press',
  idle: 'Idle',
  back_key: 'Back key',
  home_key: 'Home key',
  recents_key: 'Recents key',
  anr: 'ANR',
  jank_region: 'Jank region',
  ime_show: 'Keyboard shown',
  ime_hide: 'Keyboard hidden',
  window_transition: 'Window transition',
};

export function getSceneDisplayName(
  sceneType: string,
  projectedLabel?: string,
): string {
  const zh = SCENE_DISPLAY_NAMES[sceneType];
  const en = SCENE_DISPLAY_NAMES_EN[sceneType];
  if (zh || en) return uiText(zh ?? sceneType, en ?? sceneType);
  return projectedLabel?.trim() || sceneType;
}

/**
 * Pin instruction shape — 与 ai_panel.ts:pinTracksFromInstructions 的 input 结构兼容
 */
export interface ScenePinInstruction {
  pattern: string;
  matchBy: string;
  priority: number;
  reason: string;
  expand?: boolean;
  mainThreadOnly?: boolean;
  smartPin?: boolean;
}

const SCENE_PIN_REASON_EN: Record<string, string> = {
  渲染线程: 'Render thread',
  主线程: 'Main thread',
  合成器: 'Compositor',
  缓冲区: 'Buffer',
  活动管理: 'Activity management',
  进程创建: 'Process creation',
  渲染响应: 'Rendering response',
  窗口管理: 'Window management',
  系统UI: 'System UI',
  系统服务: 'System service',
};

export function localizeScenePinInstruction(
  instruction: ScenePinInstruction,
): ScenePinInstruction {
  return {
    ...instruction,
    reason: uiText(
      instruction.reason,
      SCENE_PIN_REASON_EN[instruction.reason] ?? instruction.reason,
    ),
  };
}

/**
 * Scene-to-pin mapping for auto-pinning relevant tracks based on scene type
 */
export const SCENE_PIN_MAPPING: Record<string, ScenePinInstruction[]> = {
  scroll_start: [
    {
      pattern: '^RenderThread$',
      matchBy: 'name',
      priority: 1,
      reason: '渲染线程',
      smartPin: true,
    },
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 2,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
  ],
  scroll: [
    {
      pattern: '^RenderThread$',
      matchBy: 'name',
      priority: 1,
      reason: '渲染线程',
      smartPin: true,
    },
    {pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器'},
    {
      pattern: '^BufferTX',
      matchBy: 'name',
      priority: 3,
      reason: '缓冲区',
      smartPin: true,
    },
  ],
  inertial_scroll: [
    {
      pattern: '^RenderThread$',
      matchBy: 'name',
      priority: 1,
      reason: '渲染线程',
      smartPin: true,
    },
    {pattern: 'SurfaceFlinger', matchBy: 'name', priority: 2, reason: '合成器'},
    {
      pattern: '^BufferTX',
      matchBy: 'name',
      priority: 3,
      reason: '缓冲区',
      smartPin: true,
    },
  ],
  cold_start: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
    {
      pattern: 'ActivityManager',
      matchBy: 'name',
      priority: 2,
      reason: '活动管理',
    },
    {pattern: 'Zygote', matchBy: 'name', priority: 3, reason: '进程创建'},
  ],
  warm_start: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
    {
      pattern: 'ActivityManager',
      matchBy: 'name',
      priority: 2,
      reason: '活动管理',
    },
  ],
  hot_start: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
  ],
  tap: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
    {
      pattern: '^RenderThread$',
      matchBy: 'name',
      priority: 2,
      reason: '渲染响应',
      smartPin: true,
    },
  ],
  navigation: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
    {
      pattern: '^RenderThread$',
      matchBy: 'name',
      priority: 2,
      reason: '渲染线程',
      smartPin: true,
    },
  ],
  app_switch: [
    {
      pattern: 'ActivityManager',
      matchBy: 'name',
      priority: 1,
      reason: '活动管理',
    },
    {
      pattern: 'WindowManager',
      matchBy: 'name',
      priority: 2,
      reason: '窗口管理',
    },
  ],
  back_key: [
    {
      pattern: 'com.android.systemui',
      matchBy: 'name',
      priority: 1,
      reason: '系统UI',
    },
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 2,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
  ],
  home_key: [
    {
      pattern: 'com.android.systemui',
      matchBy: 'name',
      priority: 1,
      reason: '系统UI',
    },
    {
      pattern: 'ActivityManager',
      matchBy: 'name',
      priority: 2,
      reason: '活动管理',
    },
  ],
  anr: [
    {
      pattern: '^main$',
      matchBy: 'name',
      priority: 1,
      reason: '主线程',
      smartPin: true,
      mainThreadOnly: true,
    },
    {
      pattern: 'system_server',
      matchBy: 'name',
      priority: 2,
      reason: '系统服务',
    },
  ],
};

/**
 * Performance rating thresholds for scenes
 */
export const SCENE_THRESHOLDS: Record<
  string,
  {good: number; acceptable: number}
> = {
  cold_start: {good: 500, acceptable: 1000},
  warm_start: {good: 300, acceptable: 600},
  hot_start: {good: 100, acceptable: 200},
  scroll_fps: {good: 55, acceptable: 45},
  inertial_scroll: {good: 500, acceptable: 1000},
  tap: {good: 100, acceptable: 200},
  navigation: {good: 300, acceptable: 500},
  anr: {good: 99999, acceptable: 99999}, // ANR is always severe
  window_transition: {good: 300, acceptable: 500},
};

/**
 * Get performance rating emoji based on scene type and duration
 */
export function getScenePerformanceRating(
  sceneType: string,
  durationMs: number,
  metadata?: Record<string, any>,
): string {
  // For scroll, check FPS instead of duration
  if (
    (sceneType === 'scroll' || sceneType === 'inertial_scroll') &&
    metadata?.averageFps !== undefined
  ) {
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
 * Get short Chinese status label with emoji (used in scene result table).
 */
export function getSceneResponseStatusLabel(
  sceneType: string,
  durationMs: number,
  metadata?: Record<string, any>,
): string {
  const rating = getScenePerformanceRating(sceneType, durationMs, metadata);
  if (rating === '🟢') return uiText('🟢 流畅', '🟢 Smooth');
  if (rating === '🟡') return uiText('🟡 轻微波动', '🟡 Minor fluctuation');
  if (rating === '🔴')
    {return uiText('🔴 明显波动', '🔴 Significant fluctuation');}
  return uiText('⚪ 未知', '⚪ Unknown');
}

/**
 * Format scene timestamp for display (ns BigInt string → human readable).
 * Handles BigInt string timestamps from scene reconstruction.
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
