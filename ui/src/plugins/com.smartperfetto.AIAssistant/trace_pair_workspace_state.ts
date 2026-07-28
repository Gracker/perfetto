// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TracePairLayout, TracePairTraceSide} from './types';
import type {WorkspaceTraceCatalogItem} from './workspace_trace_catalog';
import {
  createInitialTracePairWorkspaceState,
  type HydrateTracePairWorkspaceInput,
  type HydrateTracePairWorkspaceOptions,
  type OpenTracePairWorkspaceInput,
  type SelectTraceForPaneInput,
  type TracePairPaneSlot,
  type TracePairWorkspaceState,
  type TracePairWorkspaceTrace,
} from './trace_pair_workspace_state_model';
import {
  clearTracePairReference,
  hydrateSingleTraceWorkspace,
  hydrateTracePairWorkspace,
  normalizeTracePairSplitPercent,
  openTracePairWorkspace,
  reconcileTracePairCatalog,
  selectTraceForPane,
} from './trace_pair_workspace_state_transitions';

export type {
  HydrateTracePairWorkspaceInput,
  HydrateTracePairWorkspaceOptions,
  OpenTracePairWorkspaceInput,
  SelectTraceForPaneInput,
  TracePairPaneSlot,
  TracePairWorkspaceScope,
  TracePairWorkspaceState,
  TracePairWorkspaceTrace,
} from './trace_pair_workspace_state_model';

export class TracePairWorkspaceController {
  private state = createInitialTracePairWorkspaceState();
  private catalogRequest = 0;
  private readonly listeners = new Set<() => void>();

  getState(): Readonly<TracePairWorkspaceState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(input: OpenTracePairWorkspaceInput): void {
    this.state = openTracePairWorkspace(this.state, input);
    this.notify();
  }

  hydrateSessionPair(
    input: HydrateTracePairWorkspaceInput,
    options: HydrateTracePairWorkspaceOptions,
  ): void {
    const state = hydrateTracePairWorkspace(this.state, input, options);
    if (!state) return;
    this.catalogRequest += 1;
    this.state = state;
    this.notify();
  }

  hydrateSingleSession(
    input: OpenTracePairWorkspaceInput,
    options: HydrateTracePairWorkspaceOptions,
  ): void {
    const state = hydrateSingleTraceWorkspace(this.state, input, options);
    if (!state) return;
    this.catalogRequest += 1;
    this.state = state;
    this.notify();
  }

  close(): void {
    if (!this.state.open || this.state.selectionLocked) return;
    this.state = {
      ...this.state,
      open: false,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set(),
    };
    this.notify();
  }

  resetScope(): void {
    this.catalogRequest += 1;
    this.state = createInitialTracePairWorkspaceState();
    this.notify();
  }

  setCatalog(catalog: ReadonlyArray<WorkspaceTraceCatalogItem>): void {
    this.state = reconcileTracePairCatalog(this.state, catalog);
    this.notify();
  }

  beginCatalogLoad(): number {
    const request = ++this.catalogRequest;
    this.state = {...this.state, catalogLoading: true, catalogError: null};
    this.notify();
    return request;
  }

  completeCatalogLoad(
    request: number,
    catalog: ReadonlyArray<WorkspaceTraceCatalogItem>,
  ): boolean {
    if (request !== this.catalogRequest || this.state.scope === null)
      return false;
    this.setCatalog(catalog);
    return true;
  }

  failCatalogLoad(request: number, error: string): boolean {
    if (request !== this.catalogRequest || this.state.scope === null)
      return false;
    this.state = {...this.state, catalogLoading: false, catalogError: error};
    this.notify();
    return true;
  }

  selectTrace(input: SelectTraceForPaneInput): boolean {
    const result = selectTraceForPane(this.state, input);
    if (result.state !== this.state) {
      this.state = result.state;
      this.notify();
    }
    return result.selected;
  }

  clearReference(): void {
    const state = clearTracePairReference(this.state);
    if (!state) return;
    this.state = state;
    this.notify();
  }

  setSelectionLocked(selectionLocked: boolean): void {
    if (selectionLocked === this.state.selectionLocked) return;
    this.state = {...this.state, selectionLocked};
    this.notify();
  }

  getTraceForPane(
    pane: TracePairPaneSlot,
  ): TracePairWorkspaceTrace | WorkspaceTraceCatalogItem | null {
    return this.state.currentPane === pane
      ? this.state.currentTrace
      : this.state.referenceTrace;
  }

  setLayout(layout: TracePairLayout): void {
    if (layout === this.state.layout) return;
    this.state = {...this.state, layout, maximizedTraceSide: null};
    this.notify();
  }

  setActiveTraceSide(activeTraceSide: TracePairTraceSide): void {
    if (activeTraceSide === this.state.activeTraceSide) return;
    this.state = {...this.state, activeTraceSide};
    this.notify();
  }

  setSplitPercent(splitPercent: number): void {
    if (!Number.isFinite(splitPercent)) return;
    const normalized = normalizeTracePairSplitPercent(splitPercent);
    if (normalized === this.state.splitPercent) return;
    this.state = {...this.state, splitPercent: normalized};
    this.notify();
  }

  toggleMaximized(traceSide: TracePairTraceSide): void {
    this.state = {
      ...this.state,
      maximizedTraceSide:
        this.state.maximizedTraceSide === traceSide ? null : traceSide,
      minimizedTraceSides: new Set(),
      activeTraceSide: traceSide,
    };
    this.notify();
  }

  toggleMinimized(traceSide: TracePairTraceSide): void {
    const restoring = this.state.minimizedTraceSides.has(traceSide);
    this.state = {
      ...this.state,
      maximizedTraceSide: null,
      minimizedTraceSides: restoring
        ? new Set<TracePairTraceSide>()
        : new Set<TracePairTraceSide>([traceSide]),
      activeTraceSide: restoring
        ? traceSide
        : traceSide === 'current'
          ? 'reference'
          : 'current',
    };
    this.notify();
  }

  resetLayout(): void {
    this.state = {
      ...this.state,
      splitPercent: 50,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set(),
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
