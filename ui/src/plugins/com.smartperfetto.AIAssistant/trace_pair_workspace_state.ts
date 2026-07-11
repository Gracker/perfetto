// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TracePairLayout, TracePairTraceSide} from './types';
import {buildSmartPerfettoWorkspaceApiUrl} from '../../core/smartperfetto_request_context';
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
  private traceFileRequest = 0;
  private readonly traceFileResources = new Map<
    string,
    {
      readonly request: number;
      readonly sourceUrl?: string;
      readonly error?: string;
    }
  >();
  private readonly listeners = new Set<() => void>();

  getState(): Readonly<TracePairWorkspaceState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  open(input: OpenTracePairWorkspaceInput): void {
    if (
      this.state.scope?.key !== input.scope.key ||
      this.state.currentTrace?.id !== input.currentTrace.id
    ) {
      this.releaseTraceFileResources();
    }
    this.state = openTracePairWorkspace(this.state, input);
    this.notify();
    this.prepareVisibleTraceFiles();
  }

  hydrateSessionPair(
    input: HydrateTracePairWorkspaceInput,
    options: HydrateTracePairWorkspaceOptions,
  ): void {
    const state = hydrateTracePairWorkspace(this.state, input, options);
    if (!state) return;
    this.releaseTraceFileResources();
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
    this.releaseTraceFileResources();
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
    this.releaseTraceFileResources();
    this.notify();
  }

  resetScope(): void {
    this.releaseTraceFileResources();
    this.catalogRequest += 1;
    this.state = createInitialTracePairWorkspaceState();
    this.notify();
  }

  setCatalog(catalog: ReadonlyArray<WorkspaceTraceCatalogItem>): void {
    this.state = reconcileTracePairCatalog(this.state, catalog);
    this.notify();
    this.prepareVisibleTraceFiles();
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
    const previousReferenceTraceId = this.state.referenceTrace?.id;
    const result = selectTraceForPane(this.state, input);
    if (result.state !== this.state) {
      this.state = result.state;
      if (
        previousReferenceTraceId &&
        previousReferenceTraceId !== this.state.referenceTrace?.id
      ) {
        this.releaseTraceFileResource(previousReferenceTraceId);
      }
      this.notify();
      this.prepareVisibleTraceFiles();
    }
    return result.selected;
  }

  clearReference(): void {
    const referenceTraceId = this.state.referenceTrace?.id;
    const state = clearTracePairReference(this.state);
    if (!state) return;
    this.state = state;
    if (referenceTraceId) this.releaseTraceFileResource(referenceTraceId);
    this.notify();
  }

  getTraceSourceUrl(traceId: string): string | null {
    const scope = this.state.scope;
    if (!scope) return null;
    if (!scope.backendHeaders) {
      return buildSmartPerfettoWorkspaceApiUrl(
        scope.backendUrl,
        'traces',
        `/${encodeURIComponent(traceId)}/file`,
      );
    }
    return this.traceFileResources.get(traceId)?.sourceUrl ?? null;
  }

  getTraceSourceError(traceId: string): string | null {
    return this.traceFileResources.get(traceId)?.error ?? null;
  }

  isTraceSourceLoading(traceId: string): boolean {
    const resource = this.traceFileResources.get(traceId);
    return resource !== undefined && !resource.sourceUrl && !resource.error;
  }

  retryTraceSource(traceId: string): void {
    this.releaseTraceFileResource(traceId);
    this.prepareTraceFile(traceId);
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

  private prepareVisibleTraceFiles(): void {
    if (!this.state.open) return;
    if (this.state.currentTrace) {
      this.prepareTraceFile(this.state.currentTrace.id);
    }
    if (this.state.referenceTrace) {
      this.prepareTraceFile(this.state.referenceTrace.id);
    }
  }

  private prepareTraceFile(traceId: string): void {
    const scope = this.state.scope;
    if (!scope?.backendHeaders || this.traceFileResources.has(traceId)) return;
    const request = ++this.traceFileRequest;
    this.traceFileResources.set(traceId, {request});
    this.notify();
    const traceFileUrl = buildSmartPerfettoWorkspaceApiUrl(
      scope.backendUrl,
      'traces',
      `/${encodeURIComponent(traceId)}/file`,
    );
    void fetch(traceFileUrl, {
      headers: {...scope.backendHeaders},
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Trace 加载失败 (${response.status})`);
        }
        const sourceUrl = URL.createObjectURL(await response.blob());
        const resource = this.traceFileResources.get(traceId);
        if (resource?.request !== request || this.state.scope?.key !== scope.key) {
          URL.revokeObjectURL(sourceUrl);
          return;
        }
        this.traceFileResources.set(traceId, {request, sourceUrl});
        this.notify();
      })
      .catch((error: unknown) => {
        if (this.traceFileResources.get(traceId)?.request !== request) return;
        this.traceFileResources.set(traceId, {
          request,
          error: error instanceof Error ? error.message : String(error),
        });
        this.notify();
      });
  }

  private releaseTraceFileResource(traceId: string): void {
    const resource = this.traceFileResources.get(traceId);
    if (resource?.sourceUrl) URL.revokeObjectURL(resource.sourceUrl);
    this.traceFileResources.delete(traceId);
  }

  private releaseTraceFileResources(): void {
    this.traceFileRequest += 1;
    for (const traceId of this.traceFileResources.keys()) {
      this.releaseTraceFileResource(traceId);
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
