// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {WorkspaceTraceCatalogItem} from './workspace_trace_catalog';
import {
  createInitialTracePairWorkspaceState,
  type HydrateTracePairWorkspaceInput,
  type HydrateTracePairWorkspaceOptions,
  type OpenTracePairWorkspaceInput,
  type SelectTraceForPaneInput,
  type TracePairWorkspaceState,
} from './trace_pair_workspace_state_model';

interface TraceSelectionResult {
  readonly state: TracePairWorkspaceState;
  readonly selected: boolean;
}

function shouldPreserveLivePair(
  state: TracePairWorkspaceState,
  input: OpenTracePairWorkspaceInput,
  options: HydrateTracePairWorkspaceOptions,
): boolean {
  return (
    options.preserveLivePair &&
    state.scope?.key === input.scope.key &&
    state.pageTrace?.id === input.currentTrace?.id &&
    (state.open || state.referenceTrace !== null)
  );
}

export function normalizeTracePairSplitPercent(splitPercent: number): number {
  return Math.min(82, Math.max(18, Math.round(splitPercent)));
}

export function openTracePairWorkspace(
  state: TracePairWorkspaceState,
  input: OpenTracePairWorkspaceInput,
): TracePairWorkspaceState {
  const sameScope = state.scope?.key === input.scope.key;
  const nextPageTrace = input.currentTrace ?? null;
  const samePageTrace = state.pageTrace?.id === nextPageTrace?.id;
  if (sameScope && samePageTrace) {
    const baselineWasPageTrace = state.currentTrace?.id === state.pageTrace?.id;
    return {
      ...state,
      open: true,
      scope: input.scope,
      pageTrace: nextPageTrace,
      currentTrace: baselineWasPageTrace
        ? nextPageTrace
        : state.currentTrace,
    };
  }
  return {
    ...createInitialTracePairWorkspaceState(),
    open: true,
    scope: input.scope,
    pageTrace: nextPageTrace,
    currentTrace: nextPageTrace,
    selectionLocked: state.selectionLocked,
  };
}

export function hydrateTracePairWorkspace(
  state: TracePairWorkspaceState,
  input: HydrateTracePairWorkspaceInput,
  options: HydrateTracePairWorkspaceOptions,
): TracePairWorkspaceState | null {
  if (shouldPreserveLivePair(state, input, options)) return null;
  const splitPercent =
    typeof input.splitPercent === 'number' &&
    Number.isFinite(input.splitPercent)
      ? normalizeTracePairSplitPercent(input.splitPercent)
      : 50;
  return {
    ...createInitialTracePairWorkspaceState(),
    scope: input.scope,
    pageTrace: input.currentTrace ?? null,
    currentTrace: input.baselineTrace ?? input.currentTrace ?? null,
    referenceTrace: input.referenceTrace,
    currentPane: 'first',
    catalog: [
      ...(input.baselineTrace && input.baselineTrace.id !== input.currentTrace?.id
        ? [input.baselineTrace]
        : []),
      input.referenceTrace,
    ],
    layout: input.layout === 'vertical' ? 'vertical' : 'horizontal',
    splitPercent,
    activeTraceSide:
      input.activeTraceSide === 'reference' ? 'reference' : 'current',
  };
}

export function hydrateSingleTraceWorkspace(
  state: TracePairWorkspaceState,
  input: OpenTracePairWorkspaceInput,
  options: HydrateTracePairWorkspaceOptions,
): TracePairWorkspaceState | null {
  if (shouldPreserveLivePair(state, input, options)) return null;
  return {
    ...createInitialTracePairWorkspaceState(),
    scope: input.scope,
    pageTrace: input.currentTrace ?? null,
    currentTrace: input.currentTrace ?? null,
  };
}

function reconcileTrace(
  trace: WorkspaceTraceCatalogItem | null,
  catalog: ReadonlyArray<WorkspaceTraceCatalogItem>,
): WorkspaceTraceCatalogItem | null {
  if (!trace) return null;
  return catalog.find((item) => item.id === trace.id) ?? trace;
}

export function reconcileTracePairCatalog(
  state: TracePairWorkspaceState,
  catalog: ReadonlyArray<WorkspaceTraceCatalogItem>,
): TracePairWorkspaceState {
  const pageCatalogItem = reconcileTrace(state.pageTrace, catalog);
  const pageTrace = state.pageTrace && pageCatalogItem
    ? {
        ...pageCatalogItem,
        filename: state.pageTrace.filename || pageCatalogItem.filename,
        ...(state.pageTrace.fingerprint
          ? {fingerprint: state.pageTrace.fingerprint}
          : {}),
      }
    : state.pageTrace;
  const currentCatalogItem = reconcileTrace(state.currentTrace, catalog);
  const currentTrace = state.currentTrace && currentCatalogItem
    ? {
        ...currentCatalogItem,
        filename: state.currentTrace.filename || currentCatalogItem.filename,
        ...(state.currentTrace.fingerprint
          ? {fingerprint: state.currentTrace.fingerprint}
          : {}),
      }
    : state.currentTrace;
  const referenceTrace = reconcileTrace(state.referenceTrace, catalog);
  return {
    ...state,
    pageTrace,
    currentTrace,
    catalog: [...catalog],
    referenceTrace,
    catalogLoading: false,
    catalogError: null,
  };
}

function findSelectableTrace(
  state: TracePairWorkspaceState,
  traceId: string,
): WorkspaceTraceCatalogItem | null {
  if (state.pageTrace?.id === traceId) return state.pageTrace;
  if (state.currentTrace?.id === traceId) return state.currentTrace;
  if (state.referenceTrace?.id === traceId) return state.referenceTrace;
  return state.catalog.find((item) => item.id === traceId) ?? null;
}

export function swapTracePair(
  state: TracePairWorkspaceState,
): TraceSelectionResult {
  if (
    state.selectionLocked ||
    !state.currentTrace ||
    !state.referenceTrace
  ) {
    return {state, selected: false};
  }
  return {
    selected: true,
    state: {
      ...state,
      currentPane: 'first',
      currentTrace: state.referenceTrace,
      referenceTrace: state.currentTrace,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set(),
    },
  };
}

export function selectTraceForPane(
  state: TracePairWorkspaceState,
  input: SelectTraceForPaneInput,
): TraceSelectionResult {
  if (state.selectionLocked) {
    return {state, selected: false};
  }
  const selectedTrace = findSelectableTrace(state, input.traceId);
  if (!selectedTrace) return {state, selected: false};

  if (input.pane === 'first') {
    if (selectedTrace.id === state.currentTrace?.id) {
      return {state, selected: true};
    }
    if (selectedTrace.id === state.referenceTrace?.id) {
      if (state.currentTrace) return swapTracePair(state);
      return {
        selected: true,
        state: {
          ...state,
          currentTrace: selectedTrace,
          referenceTrace: null,
        },
      };
    }
    return {
      selected: true,
      state: {
        ...state,
        currentPane: 'first',
        currentTrace: selectedTrace,
        maximizedTraceSide: null,
        minimizedTraceSides: new Set(),
      },
    };
  }

  if (selectedTrace.id === state.referenceTrace?.id) {
    return {state, selected: true};
  }
  if (selectedTrace.id === state.currentTrace?.id) {
    return state.referenceTrace
      ? swapTracePair(state)
      : {
          selected: true,
          state: {
            ...state,
            currentTrace: null,
            referenceTrace: selectedTrace,
          },
        };
  }
  return {
    selected: true,
    state: {
      ...state,
      currentPane: 'first',
      referenceTrace: selectedTrace,
      maximizedTraceSide: null,
      minimizedTraceSides: new Set(),
    },
  };
}

export function clearTracePairReference(
  state: TracePairWorkspaceState,
): TracePairWorkspaceState | null {
  if (state.selectionLocked || !state.referenceTrace) return null;
  return {
    ...state,
    currentTrace: state.pageTrace,
    referenceTrace: null,
    currentPane: 'first',
    maximizedTraceSide: null,
    minimizedTraceSides: new Set(),
    activeTraceSide: 'current',
  };
}
