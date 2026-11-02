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
    if (!event.isPrimary || event.button !== 0) return;
    if (controller.getState().maximizedTraceSide) return;
    const splitter = event.currentTarget;
    if (!(splitter instanceof HTMLElement)) return;
    const body = splitter.parentElement;
    if (!body) return;
    event.preventDefault();
    this.stop();
    const pointerId = event.pointerId;
    const startPercent = controller.getState().splitPercent;
    const vertical = controller.getState().layout === 'vertical';
    splitter.setPointerCapture(pointerId);
    this.resizing = true;
    const update = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      const rect = body.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const delta = vertical
        ? (moveEvent.clientY - event.clientY) / rect.height
        : (moveEvent.clientX - event.clientX) / rect.width;
      const raw = startPercent + delta * 100;
      controller.setSplitPercent(raw);
    };
    const stop = () => this.stop();
    const up = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      update(upEvent);
      stop();
    };
    const cancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId === pointerId) stop();
    };
    const visibility = () => {
      if (document.hidden) stop();
    };
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', visibility);
    splitter.addEventListener('lostpointercapture', cancel);
    this.cleanup = () => {
      this.cleanup = undefined;
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', visibility);
      splitter.removeEventListener('lostpointercapture', cancel);
      if (splitter.hasPointerCapture(pointerId)) {
        splitter.releasePointerCapture(pointerId);
      }
      this.resizing = false;
      m.redraw();
      this.scheduleFrameRedraw();
    };
  }

  stop(): void {
    this.cleanup?.();
  }
}
