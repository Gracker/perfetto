// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

import m from 'mithril';
import {Trace} from '../../public/trace';
import {Time} from '../../base/time';
import {getSceneDisplayName} from './scene_constants';
import {uiText} from './ui_language';

/**
 * Detected scene from trace analysis
 */
export interface DetectedScene {
  type: string;
  startTs: string;
  endTs: string;
  durationMs: number;
  confidence: number;
  label?: string;
  appPackage?: string;
  activityName?: string;
  metadata?: Record<string, any>;
}

export interface SceneNavigationBarAttrs {
  scenes: DetectedScene[];
  trace: Trace;
  isLoading?: boolean;
  onSceneClick?: (scene: DetectedScene, index: number) => void;
  onRefresh?: () => void;
}

// Scene type icons
const SCENE_ICONS: Record<string, string> = {
  'cold_start': '🚀',
  'warm_start': '🔄',
  'hot_start': '⚡',
  'scroll_start': '🎯',
  'scroll': '📜',
  'inertial_scroll': '🌀',
  'navigation': '🔀',
  'app_switch': '🔁',
  'home_screen': '🏠',
  'app_foreground': '📲',
  'screen_on': '💡',
  'screen_off': '🌙',
  'screen_sleep': '😴',
  'screen_unlock': '🔓',
  'notification': '🔔',
  'split_screen': '📱',
  'tap': '👆',
  'long_press': '✋',
  'idle': '💤',
  'back_key': '⬅️',
  'home_key': '🏠',
  'recents_key': '📋',
  'anr': '🚨',
  'ime_show': '⌨️',
  'ime_hide': '⌨️',
  'window_transition': '🔄',
};

// Performance thresholds
const PERF_THRESHOLDS: Record<string, { good: number; acceptable: number }> = {
  'cold_start': { good: 500, acceptable: 1000 },
  'warm_start': { good: 300, acceptable: 600 },
  'hot_start': { good: 100, acceptable: 200 },
  'scroll_fps': { good: 55, acceptable: 45 },
  'inertial_scroll': { good: 500, acceptable: 1000 },
  'tap': { good: 100, acceptable: 200 },
  'navigation': { good: 300, acceptable: 500 },
};

/**
 * Scene Navigation Bar Component
 * Displays detected scenes for quick navigation
 */
export class SceneNavigationBar implements m.ClassComponent<SceneNavigationBarAttrs> {
  private currentIndex: number = -1;

  view(vnode: m.Vnode<SceneNavigationBarAttrs>): m.Children {
    const {scenes, trace, isLoading, onSceneClick, onRefresh} = vnode.attrs;

    return m('div.scene-nav-bar', [
      m('div.scene-nav-header', [
        m('span.scene-nav-label', [
          m('i.pf-icon', 'movie'),
          uiText(' 场景导航', ' Scene navigation'),
        ]),
        isLoading
          ? m('span.scene-nav-loading', [
              m('i.pf-icon.spinning', 'sync'),
              uiText(' 检测中...', ' Detecting...'),
            ])
          : m('span.scene-nav-count', uiText(`${scenes.length} 个场景`, `${scenes.length} scenes`)),
      ]),

      m(
        'div.scene-nav-content',
        scenes.length > 0
          ? m('div.scene-nav-chips', [
              m('button.scene-nav-arrow', {
                onclick: () => this.jumpToPrevious(scenes, trace, onSceneClick),
                disabled: this.currentIndex <= 0,
                title: uiText('上一个场景', 'Previous scene'),
              }, m('i.pf-icon', 'chevron_left')),
              m('div.scene-nav-chips-scroll',
                scenes.map((scene, index) => this.renderSceneChip(scene, index, scenes, trace, onSceneClick))
              ),
              m('button.scene-nav-arrow', {
                onclick: () => this.jumpToNext(scenes, trace, onSceneClick),
                disabled: this.currentIndex >= scenes.length - 1,
                title: uiText('下一个场景', 'Next scene'),
              }, m('i.pf-icon', 'chevron_right')),
            ])
          : isLoading
            ? m('div.scene-nav-empty', uiText('正在检测操作场景...', 'Detecting interaction scenes...'))
            : m('div.scene-nav-empty', uiText('未检测到场景', 'No scenes detected')),
      ),

      onRefresh
        ? m('button.scene-nav-refresh', {
            onclick: onRefresh,
            disabled: isLoading,
            title: uiText('刷新场景检测', 'Refresh scene detection'),
          }, m('i.pf-icon', 'refresh'))
        : null,
    ]);
  }

  private renderSceneChip(
    scene: DetectedScene,
    index: number,
    scenes: DetectedScene[],
    trace: Trace,
    onSceneClick?: (scene: DetectedScene, index: number) => void
  ): m.Children {
    const displayName = getSceneDisplayName(scene.type, scene.label);
    const icon = SCENE_ICONS[scene.type] || '📍';
    const rating = this.getPerformanceRating(scene);
    const isActive = index === this.currentIndex;

    // Format duration
    const durationStr = scene.durationMs >= 1000
      ? `${(scene.durationMs / 1000).toFixed(1)}s`
      : `${scene.durationMs}ms`;

    return m('button.scene-chip', {
      key: `scene-${index}`,
      class: isActive ? 'active' : '',
      onclick: () => this.jumpTo(index, scenes, trace, onSceneClick),
      title: this.getSceneTooltip(scene),
    }, [
      m('span.scene-chip-rating', rating),
      m('span.scene-chip-icon', icon),
      m('span.scene-chip-label', displayName),
      m('span.scene-chip-duration', durationStr),
    ]);
  }

  private getPerformanceRating(scene: DetectedScene): string {
    // For scroll, check FPS instead of duration
    if ((scene.type === 'scroll' || scene.type === 'inertial_scroll') && scene.metadata?.averageFps !== undefined) {
      const fps = scene.metadata.averageFps;
      const thresholds = PERF_THRESHOLDS['scroll_fps'];
      if (fps >= thresholds.good) return '🟢';
      if (fps >= thresholds.acceptable) return '🟡';
      return '🔴';
    }

    // For other scenes, check duration
    const thresholds = PERF_THRESHOLDS[scene.type];
    if (!thresholds) return '⚪';

    if (scene.durationMs <= thresholds.good) return '🟢';
    if (scene.durationMs <= thresholds.acceptable) return '🟡';
    return '🔴';
  }

  private getSceneTooltip(scene: DetectedScene): string {
    const displayName = getSceneDisplayName(scene.type, scene.label);
    const parts = [displayName];

    if (scene.appPackage) {
      parts.push(`App: ${scene.appPackage}`);
    }

    parts.push(uiText(`时长: ${scene.durationMs}ms`, `Duration: ${scene.durationMs}ms`));

    if ((scene.type === 'scroll' || scene.type === 'inertial_scroll') && scene.metadata?.averageFps !== undefined) {
      parts.push(`FPS: ${scene.metadata.averageFps}`);
    }

    parts.push(uiText(
      `置信度: ${(scene.confidence * 100).toFixed(0)}%`,
      `Confidence: ${(scene.confidence * 100).toFixed(0)}%`,
    ));

    return parts.join('\n');
  }

  private jumpTo(
    index: number,
    scenes: DetectedScene[],
    trace: Trace,
    onSceneClick?: (scene: DetectedScene, index: number) => void
  ): void {
    if (index < 0 || index >= scenes.length) return;

    this.currentIndex = index;
    const scene = scenes[index];

    // Navigate to scene time range
    try {
      const startTs = BigInt(scene.startTs);
      const endTs = BigInt(scene.endTs);

      trace.scrollTo({
        time: {
          start: Time.fromRaw(startTs),
          end: Time.fromRaw(endTs),
          behavior: 'focus',
        },
      });
    } catch (e) {
      console.warn('[SceneNavBar] Failed to navigate to scene:', e);
    }

    if (onSceneClick) {
      onSceneClick(scene, index);
    }

    m.redraw();
  }

  private jumpToPrevious(
    scenes: DetectedScene[],
    trace: Trace,
    onSceneClick?: (scene: DetectedScene, index: number) => void
  ): void {
    if (this.currentIndex > 0) {
      this.jumpTo(this.currentIndex - 1, scenes, trace, onSceneClick);
    }
  }

  private jumpToNext(
    scenes: DetectedScene[],
    trace: Trace,
    onSceneClick?: (scene: DetectedScene, index: number) => void
  ): void {
    if (this.currentIndex < scenes.length - 1) {
      this.jumpTo(this.currentIndex + 1, scenes, trace, onSceneClick);
    }
  }

  public resetIndex(): void {
    this.currentIndex = -1;
  }
}
