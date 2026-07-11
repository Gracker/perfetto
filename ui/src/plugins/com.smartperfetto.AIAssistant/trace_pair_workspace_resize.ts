// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import type {TracePairWorkspaceController} from './trace_pair_workspace_state';

export class TracePairWorkspaceResizeController {
  private cleanup?: () => void;
  private resizing = false;

  constructor(private readonly scheduleFrameRedraw: () => void) {}

  isResizing(): boolean {
    return this.resizing;
  }

  start(event: PointerEvent, controller: TracePairWorkspaceController): void {
    if (controller.getState().maximizedTraceSide) return;
    const splitter = event.currentTarget;
    if (!(splitter instanceof HTMLElement)) return;
    const body = splitter.parentElement;
    if (!body) return;
    event.preventDefault();
    this.stop();
    const pointerId = event.pointerId;
    splitter.setPointerCapture(pointerId);
    this.resizing = true;
    const update = (moveEvent: PointerEvent) => {
      const rect = body.getBoundingClientRect();
      const raw =
        controller.getState().layout === 'vertical'
          ? ((moveEvent.clientY - rect.top) / rect.height) * 100
          : ((moveEvent.clientX - rect.left) / rect.width) * 100;
      controller.setSplitPercent(raw);
    };
    const stop = () => this.stop();
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', stop, {once: true});
    window.addEventListener('pointercancel', stop, {once: true});
    this.cleanup = () => {
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      if (splitter.hasPointerCapture(pointerId)) {
        splitter.releasePointerCapture(pointerId);
      }
      this.resizing = false;
      this.cleanup = undefined;
      m.redraw();
      this.scheduleFrameRedraw();
    };
    update(event);
  }

  stop(): void {
    this.cleanup?.();
  }
}
