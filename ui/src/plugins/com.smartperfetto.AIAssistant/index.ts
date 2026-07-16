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

import './styles.scss';
import {isTimelineRouteActive} from '../../frontend/timeline_route';
import {App} from '../../public/app';
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {Intent} from '../../widgets/common';
import {
  emitClearChatCommand,
  emitOpenSettingsCommand,
} from './assistant_command_bus';
import {restoreOverlayTracks} from './track_overlay';
import {createAIAreaSelectionTab} from './ai_area_selection_tab';
import {getAISharedState, resetAISharedState} from './ai_shared_state';
import {resetActiveNoteIds} from './ai_timeline_notes';
import {locateFloatingWindow, setupFloatingWindow} from './ai_floating_window';
import {getFloatingState, updateFloatingState} from './ai_floating_state';
import {
  resetTransientState,
  switchFloatingMode,
  toggleSidebarCollapsedWithTransientState,
} from './ai_transient_state';
import {setupCriticalPathExtension} from './critical_path_extension';
import {
  setDefaultBackendCredential,
  setDefaultBackendUrl,
} from '../../core/backend_uploader';
import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {installTracePairFrameRedrawListener} from './trace_pair_workspace';
import {getAIAssistantSurfacePolicy} from './ai_surface_policy';
import {sessionManager} from './session_manager';

// Inject smart-detected backend URL at module load time, BEFORE any trace
// auto-upload kicks in.
(function injectBackendUrl() {
  try {
    const settings = sessionManager.loadSettings();
    setDefaultBackendUrl(settings.backendUrl || getDefaultSmartPerfettoBackendUrl());
    setDefaultBackendCredential(settings.backendApiKey);
  } catch {}
})();

function toggleSidebarPanel(): void {
  if (!isTimelineRouteActive()) return;
  const state = getFloatingState();
  if (state.mode === 'floating') {
    // Keep floating windows discoverable instead of silently hiding them.
    locateFloatingWindow();
  } else if (state.mode === 'sidebar') {
    if (state.sidebar.collapsed) {
      toggleSidebarCollapsedWithTransientState();
    } else {
      switchFloatingMode('tab');
    }
  } else {
    switchFloatingMode('sidebar');
  }
}

export default class implements PerfettoPlugin {
  static readonly id = 'com.smartperfetto.AIAssistant';

  static onActivate(app: App): void {
    if (!getAIAssistantSurfacePolicy().registerCommands) return;
    app.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.OpenPanel',
      name: 'Open AI Assistant',
      callback: () => {
        toggleSidebarPanel();
      },
    });

    // Dedicated "locate" command for users who explicitly know the popup
    // exists but can't find it on screen. Always works regardless of mode
    // — in tab mode it's a no-op, no confusing behavior.
    app.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.LocateFloating',
      name: 'Locate AI Floating Window',
      callback: () => {
        if (getFloatingState().mode === 'floating') {
          locateFloatingWindow();
        }
      },
    });

    app.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.ClearChat',
      name: 'Clear AI Chat',
      callback: () => {
        emitClearChatCommand();
      },
    });

    app.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.Settings',
      name: 'AI Assistant Settings',
      callback: () => {
        emitOpenSettingsCommand();
      },
    });

    // Toggle sidebar mode — switches between sidebar and tab.
    app.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.ToggleSidebar',
      name: 'Toggle AI Sidebar',
      callback: () => {
        const mode = getFloatingState().mode;
        if (mode === 'sidebar') {
          switchFloatingMode('tab');
        } else {
          switchFloatingMode('sidebar');
        }
      },
    });
  }

  async onTraceLoad(ctx: Trace): Promise<void> {
    const surfacePolicy = getAIAssistantSurfacePolicy();
    if (surfacePolicy.installFrameRedrawBridge) {
      ctx.trash.defer(installTracePairFrameRedrawListener(ctx.raf));
    }
    if (!surfacePolicy.setupAssistantOwner) return;
    // Reset shared state to prevent cross-trace leakage (Codex #5).
    resetAISharedState();
    // Reset timeline note tracking so old trace IDs don't leak into the new
    // trace's cleanup path (the old trace's NoteManager is gone).
    resetActiveNoteIds();
    // Drop any transient state left over from a previous trace — a new
    // trace should not inherit the old trace's input draft, SSE cursor, etc.
    resetTransientState();
    // Force floating mode off on trace load (popup never auto-opens)
    updateFloatingState({mode: 'tab'});

    const tracePairWorkspaceController = new TracePairWorkspaceController();
    const tracePairIdentity = (): string => {
      const state = tracePairWorkspaceController.getState();
      return [
        state.scope?.key || '',
        state.currentTrace?.id || '',
        state.referenceTrace?.id || '',
      ].join(':');
    };
    let previousTracePairIdentity = tracePairIdentity();
    const unsubscribeTracePair = tracePairWorkspaceController.subscribe(() => {
      const nextTracePairIdentity = tracePairIdentity();
      if (nextTracePairIdentity === previousTracePairIdentity) return;
      previousTracePairIdentity = nextTracePairIdentity;
      resetTransientState();
    });
    const surfaceHandle = setupFloatingWindow(
      ctx,
      tracePairWorkspaceController,
    );
    ctx.trash.defer(() => {
      unsubscribeTracePair();
      surfaceHandle.dispose();
      tracePairWorkspaceController.resetScope();
    });
    const criticalPathHandle = setupCriticalPathExtension(ctx);
    ctx.trash.defer(() => criticalPathHandle.dispose());

    // ── F1: Area Selection Analysis Tab ──
    // When user selects a time range, show quick stats + AI analyze button
    // in the bottom details panel — no tab switch needed.
    ctx.selection.registerAreaSelectionTab(createAIAreaSelectionTab(ctx));

    // ── F3: Status Bar Widget ──
    // Persistent indicator in the bottom status bar showing AI analysis state.
    ctx.statusbar.registerItem({
      renderItem: () => {
        const state = getAISharedState();
        const labels: Record<string, string> = {
          idle: 'AI Ready',
          ready: 'AI Ready',
          analyzing: `AI: ${state.currentPhase || 'Analyzing...'}`,
          completed:
            state.issueCount > 0
              ? `AI: ${state.issueCount} issue${state.issueCount > 1 ? 's' : ''}`
              : 'AI: Done',
          partial: 'AI: Partial',
          quota_exceeded: 'AI: Quota',
          cancelled: 'AI: Cancelled',
          error: 'AI: Error',
        };
        const intents: Record<string, Intent> = {
          idle: Intent.None,
          ready: Intent.None,
          analyzing: Intent.Primary,
          completed: state.issueCount > 0 ? Intent.Warning : Intent.Success,
          partial: Intent.Warning,
          quota_exceeded: Intent.Warning,
          cancelled: Intent.Warning,
          error: Intent.Danger,
        };
        return {
          label: labels[state.status] ?? 'AI',
          icon: 'smart_toy',
          intent: intents[state.status] ?? Intent.None,
          onclick: () => {
            toggleSidebarPanel();
          },
        };
      },
    });

    // Restore persisted overlay tracks after hot-reload (build.mjs --watch).
    // Deferred to onTraceReady to ensure workspace is fully initialized.
    ctx.onTraceReady.addListener(() => {
      restoreOverlayTracks(ctx).catch((e) => {
        console.warn('[AIAssistant] Failed to restore overlay tracks:', e);
      });
    });
  }
}
