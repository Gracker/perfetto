// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';

import {
  getTracePairLayoutSignature,
  TracePairFrameRedrawCoordinator,
} from './trace_pair_workspace_frame_bridge';
import type {TracePairWorkspaceController} from './trace_pair_workspace_state';
import {TracePairWorkspaceResizeController} from './trace_pair_workspace_resize';
import {renderTracePairWorkspace} from './trace_pair_workspace_view';

export {installTracePairFrameRedrawListener} from './trace_pair_workspace_frame_bridge';

export interface TracePairWorkspaceAttrs {
  readonly controller: TracePairWorkspaceController;
}

export class TracePairWorkspace
  implements m.ClassComponent<TracePairWorkspaceAttrs>
{
  private unsubscribe?: () => void;
  private readonly frameRedraw = new TracePairFrameRedrawCoordinator();
  private readonly resize = new TracePairWorkspaceResizeController(() =>
    this.frameRedraw.schedule(),
  );

  oncreate({attrs}: m.VnodeDOM<TracePairWorkspaceAttrs>): void {
    this.unsubscribe = attrs.controller.subscribe(() => m.redraw());
    this.frameRedraw.start(
      getTracePairLayoutSignature(attrs.controller.getState()),
    );
  }

  onupdate({attrs}: m.VnodeDOM<TracePairWorkspaceAttrs>): void {
    this.frameRedraw.update(
      getTracePairLayoutSignature(attrs.controller.getState()),
    );
  }

  onremove(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.resize.stop();
    this.frameRedraw.dispose();
  }

  view({attrs}: m.Vnode<TracePairWorkspaceAttrs>): m.Children {
    return renderTracePairWorkspace(
      attrs.controller,
      this.resize.isResizing(),
      (event) => this.resize.start(event, attrs.controller),
    );
  }
}
