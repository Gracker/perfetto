// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Raf} from '../../public/raf';
import type {TracePairWorkspaceState} from './trace_pair_workspace_state';

const TRACE_PAIR_FRAME_REDRAW_MESSAGE = 'smartperfetto:trace-pair-frame-redraw';

function isFrameRedrawMessage(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'type') === TRACE_PAIR_FRAME_REDRAW_MESSAGE
  );
}

export function installTracePairFrameRedrawListener(raf: Raf): () => void {
  if (window.parent === window) return () => {};
  let redrawFrame: number | undefined;
  const onMessage = (event: MessageEvent) => {
    if (
      event.source !== window.parent ||
      event.origin !== window.location.origin
    ) {
      return;
    }
    if (!isFrameRedrawMessage(event.data)) return;
    if (redrawFrame !== undefined) cancelAnimationFrame(redrawFrame);
    redrawFrame = requestAnimationFrame(() => {
      redrawFrame = undefined;
      raf.scheduleFullRedraw();
    });
  };
  window.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('message', onMessage);
    if (redrawFrame !== undefined) cancelAnimationFrame(redrawFrame);
  };
}

export function getTracePairLayoutSignature(
  state: Readonly<TracePairWorkspaceState>,
): string {
  return [
    state.open,
    state.layout,
    state.currentPane,
    state.referenceTrace?.id || '',
    state.splitPercent,
    state.maximizedTraceSide || '',
    ...state.minimizedTraceSides,
  ].join(':');
}

export class TracePairFrameRedrawCoordinator {
  private resizeObserver?: ResizeObserver;
  private observedWorkspace?: Element;
  private readonly observedFrames = new Set<HTMLIFrameElement>();
  private scheduledFrame?: number;
  private layoutSignature = '';

  start(layoutSignature: string): void {
    this.layoutSignature = layoutSignature;
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver = new ResizeObserver(() => this.schedule());
    this.resizeObserver.observe(document.documentElement);
    this.observeWorkspace();
  }

  update(layoutSignature: string): void {
    this.observeWorkspace();
    if (layoutSignature === this.layoutSignature) return;
    this.layoutSignature = layoutSignature;
    this.schedule();
  }

  schedule(): void {
    if (this.scheduledFrame !== undefined) {
      cancelAnimationFrame(this.scheduledFrame);
    }
    this.scheduledFrame = requestAnimationFrame(() => {
      this.scheduledFrame = undefined;
      document
        .querySelectorAll<HTMLIFrameElement>('.ai-trace-pair-frame')
        .forEach((frame) => {
          frame.contentWindow?.postMessage(
            {type: TRACE_PAIR_FRAME_REDRAW_MESSAGE},
            window.location.origin,
          );
        });
    });
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.observedWorkspace = undefined;
    this.observedFrames.clear();
    if (this.scheduledFrame !== undefined) {
      cancelAnimationFrame(this.scheduledFrame);
      this.scheduledFrame = undefined;
    }
  }

  private observeWorkspace(): void {
    const workspace = document.querySelector('.ai-trace-pair-workspace');
    if (workspace !== this.observedWorkspace) {
      if (this.observedWorkspace) {
        this.resizeObserver?.unobserve(this.observedWorkspace);
      }
      this.observedWorkspace = workspace ?? undefined;
      if (workspace) this.resizeObserver?.observe(workspace);
    }

    const frames = new Set(
      document.querySelectorAll<HTMLIFrameElement>('.ai-trace-pair-frame'),
    );
    for (const frame of this.observedFrames) {
      if (frames.has(frame)) continue;
      this.resizeObserver?.unobserve(frame);
      this.observedFrames.delete(frame);
    }
    for (const frame of frames) {
      if (this.observedFrames.has(frame)) continue;
      this.resizeObserver?.observe(frame);
      this.observedFrames.add(frame);
    }
  }
}
