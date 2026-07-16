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
import {uiText} from './ui_language';

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

export const DEFAULT_TRACE_PAIR_PROTECTED_BYTES_BUDGET = 512 * 1024 * 1024;
export const DEFAULT_TRACE_PAIR_ENGINE_MEMORY_BUDGET = 3 * 1024 * 1024 * 1024;
export const TRACE_ENGINE_MEMORY_AMPLIFICATION = 4;

export interface TracePairWorkspaceControllerOptions {
  /** Total retained Blob bytes for authenticated trace panes. */
  readonly maxProtectedTraceBytes?: number;
  /** Estimated total memory for the parent engine plus both trace panes. */
  readonly maxEstimatedEngineBytes?: number;
}

export class TracePairWorkspaceController {
  private state = createInitialTracePairWorkspaceState();
  private catalogRequest = 0;
  private traceFileRequest = 0;
  private traceFileQueue: Promise<void> = Promise.resolve();
  private readonly maxProtectedTraceBytes: number;
  private readonly maxEstimatedEngineBytes: number;
  private readonly traceFileResources = new Map<
    string,
    {
      readonly request: number;
      readonly abortController?: AbortController;
      readonly sourceUrl?: string;
      readonly error?: string;
      readonly sizeBytes?: number;
      readonly objectUrl?: boolean;
    }
  >();
  private readonly listeners = new Set<() => void>();

  constructor(options: TracePairWorkspaceControllerOptions = {}) {
    const configuredBudget = options.maxProtectedTraceBytes;
    this.maxProtectedTraceBytes =
      configuredBudget !== undefined &&
      Number.isFinite(configuredBudget) &&
      configuredBudget > 0
        ? Math.floor(configuredBudget)
        : DEFAULT_TRACE_PAIR_PROTECTED_BYTES_BUDGET;
    const configuredEngineBudget = options.maxEstimatedEngineBytes;
    this.maxEstimatedEngineBytes =
      configuredEngineBudget !== undefined &&
      Number.isFinite(configuredEngineBudget) &&
      configuredEngineBudget > 0
        ? Math.floor(configuredEngineBudget)
        : DEFAULT_TRACE_PAIR_ENGINE_MEMORY_BUDGET;
  }

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
    if (!scope || this.traceFileResources.has(traceId)) return;
    if (!scope.backendHeaders) {
      try {
        this.assertTracePairEngineBudget();
        this.traceFileResources.set(traceId, {
          request: ++this.traceFileRequest,
          sourceUrl: buildSmartPerfettoWorkspaceApiUrl(
            scope.backendUrl,
            'traces',
            `/${encodeURIComponent(traceId)}/file`,
          ),
          sizeBytes: this.getKnownTraceSize(traceId),
        });
      } catch (error: unknown) {
        this.traceFileResources.set(traceId, {
          request: ++this.traceFileRequest,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.notify();
      return;
    }
    const request = ++this.traceFileRequest;
    const abortController = new AbortController();
    this.traceFileResources.set(traceId, {request, abortController});
    this.notify();
    this.traceFileQueue = this.traceFileQueue
      .catch(() => {})
      .then(() => this.fetchProtectedTraceFile(traceId, request, scope, abortController));
  }

  private async fetchProtectedTraceFile(
    traceId: string,
    request: number,
    scope: NonNullable<TracePairWorkspaceState['scope']>,
    abortController: AbortController,
  ): Promise<void> {
    const pending = this.traceFileResources.get(traceId);
    if (pending?.request !== request || this.state.scope?.key !== scope.key) return;
    const knownSize = this.getKnownTraceSize(traceId);
    try {
      this.assertTracePairEngineBudget();
      this.assertProtectedTraceBudget(traceId, knownSize);
    const traceFileUrl = buildSmartPerfettoWorkspaceApiUrl(
      scope.backendUrl,
      'traces',
      `/${encodeURIComponent(traceId)}/file`,
    );
      const response = await fetch(traceFileUrl, {
      headers: {...scope.backendHeaders},
      credentials: 'include',
      signal: abortController.signal,
      });
      if (!response.ok) {
        throw new Error(uiText(
          `Trace 加载失败 (${response.status})`,
          `Trace loading failed (${response.status})`,
        ));
      }
      const contentLength = parseContentLength(response.headers.get('Content-Length'));
      this.assertProtectedTraceBudget(traceId, contentLength ?? knownSize);
      const blob = await this.readProtectedTraceBlob(response, traceId);
      const sourceUrl = URL.createObjectURL(blob);
      const resource = this.traceFileResources.get(traceId);
      if (resource?.request !== request || this.state.scope?.key !== scope.key) {
        URL.revokeObjectURL(sourceUrl);
        return;
      }
      this.traceFileResources.set(traceId, {
        request,
        sourceUrl,
        sizeBytes: blob.size,
        objectUrl: true,
      });
      this.notify();
    } catch (error: unknown) {
      if (this.traceFileResources.get(traceId)?.request !== request) return;
      this.traceFileResources.set(traceId, {
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      this.notify();
    }
  }

  private getKnownTraceSize(traceId: string): number | undefined {
    const candidates = [
      this.state.currentTrace,
      this.state.referenceTrace,
      ...this.state.catalog,
    ];
    const size = candidates.find(trace => trace?.id === traceId)?.size;
    return typeof size === 'number' && Number.isFinite(size) && size >= 0
      ? size
      : undefined;
  }

  private assertProtectedTraceBudget(
    traceId: string,
    candidateSize: number | undefined,
  ): void {
    if (candidateSize === undefined) return;
    const retainedBytes = [...this.traceFileResources.entries()].reduce(
      (total, [id, resource]) =>
        id === traceId || !resource.sourceUrl ? total : total + (resource.sizeBytes ?? 0),
      0,
    );
    if (candidateSize > this.maxProtectedTraceBytes - retainedBytes) {
      throw new Error(
        uiText(
          `TRACE_PAIR_RESOURCE_BUDGET_EXCEEDED: ${formatBytes(candidateSize)} 的 Trace 会超过双窗鉴权资源预算 ${formatBytes(this.maxProtectedTraceBytes)}`,
          `TRACE_PAIR_RESOURCE_BUDGET_EXCEEDED: ${formatBytes(candidateSize)} trace would exceed the ${formatBytes(this.maxProtectedTraceBytes)} authenticated workspace budget`,
        ),
      );
    }
  }

  private async readProtectedTraceBlob(
    response: Response,
    traceId: string,
  ): Promise<Blob> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error(uiText(
        'TRACE_PAIR_RESOURCE_SIZE_UNKNOWN: 浏览器无法对 Trace 响应执行有界流式读取',
        'TRACE_PAIR_RESOURCE_SIZE_UNKNOWN: the browser cannot stream the trace response with a bounded reader',
      ));
    }
    const chunks: ArrayBuffer[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        this.assertProtectedTraceBudget(
          traceId,
          totalBytes + value.byteLength,
        );
        // Stream chunks may be backed by SharedArrayBuffer. Copy into an
        // owned ArrayBuffer so Blob construction has a stable transferable
        // backing store across browsers and TypeScript runtimes.
        const ownedChunk = new Uint8Array(value.byteLength);
        ownedChunk.set(value);
        chunks.push(ownedChunk.buffer);
        totalBytes += value.byteLength;
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
    return new Blob(chunks, {
      type: response.headers.get('Content-Type') ?? 'application/octet-stream',
    });
  }

  private assertTracePairEngineBudget(): void {
    const currentTrace = this.state.currentTrace;
    const referenceTrace = this.state.referenceTrace;
    if (!currentTrace || !referenceTrace) return;
    const currentSize = this.getKnownTraceSize(currentTrace.id);
    const referenceSize = this.getKnownTraceSize(referenceTrace.id);
    if (currentSize === undefined || referenceSize === undefined) {
      throw new Error(uiText(
        'TRACE_PAIR_RESOURCE_SIZE_UNKNOWN: 无法确认双窗 Trace 大小，请刷新 Trace 列表后重试',
        'TRACE_PAIR_RESOURCE_SIZE_UNKNOWN: trace sizes are unavailable; refresh the trace catalog and retry',
      ));
    }
    // The current trace already has the parent UI engine and opens another
    // pane engine; the reference opens one pane engine. Perfetto parsing and
    // indexes are conservatively estimated at 4x the protobuf bytes.
    const estimatedBytes =
      (currentSize * 2 + referenceSize) * TRACE_ENGINE_MEMORY_AMPLIFICATION;
    if (estimatedBytes > this.maxEstimatedEngineBytes) {
      throw new Error(uiText(
        `TRACE_PAIR_ENGINE_BUDGET_EXCEEDED: 预计需要 ${formatBytes(estimatedBytes)}，超过双窗引擎预算 ${formatBytes(this.maxEstimatedEngineBytes)}`,
        `TRACE_PAIR_ENGINE_BUDGET_EXCEEDED: estimated ${formatBytes(estimatedBytes)} exceeds the ${formatBytes(this.maxEstimatedEngineBytes)} trace-engine budget`,
      ));
    }
  }

  private releaseTraceFileResource(traceId: string): void {
    const resource = this.traceFileResources.get(traceId);
    resource?.abortController?.abort();
    if (resource?.sourceUrl && resource.objectUrl) {
      URL.revokeObjectURL(resource.sourceUrl);
    }
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

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
