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
  type TracePairPaneSlot,
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
    state.currentTrace?.id === input.currentTrace.id &&
    (state.open || state.referenceTrace !== null)
  );
}

function otherPane(pane: TracePairPaneSlot): TracePairPaneSlot {
  return pane === 'first' ? 'second' : 'first';
}

export function normalizeTracePairSplitPercent(splitPercent: number): number {
  return Math.min(82, Math.max(18, Math.round(splitPercent)));
}

export function openTracePairWorkspace(
  state: TracePairWorkspaceState,
  input: OpenTracePairWorkspaceInput,
): TracePairWorkspaceState {
  const sameScope = state.scope?.key === input.scope.key;
  const sameCurrent = state.currentTrace?.id === input.currentTrace.id;
  if (sameScope && sameCurrent) {
    return {
      ...state,
      open: true,
      scope: input.scope,
      currentTrace: input.currentTrace,
    };
  }
  return {
    ...createInitialTracePairWorkspaceState(),
    open: true,
    scope: input.scope,
    currentTrace: input.currentTrace,
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
    currentTrace: input.currentTrace,
    referenceTrace: input.referenceTrace,
    currentPane: input.currentPane === 'second' ? 'second' : 'first',
    catalog: [input.referenceTrace],
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
    currentTrace: input.currentTrace,
  };
}

export function reconcileTracePairCatalog(
  state: TracePairWorkspaceState,
  catalog: ReadonlyArray<WorkspaceTraceCatalogItem>,
): TracePairWorkspaceState {
  const referenceTrace = state.referenceTrace
    ? catalog.find((item) => item.id === state.referenceTrace?.id) ??
      state.referenceTrace
    : null;
  return {
    ...state,
    catalog: [...catalog],
    referenceTrace,
    catalogLoading: false,
    catalogError: null,
  };
}

export function selectTraceForPane(
  state: TracePairWorkspaceState,
  input: SelectTraceForPaneInput,
): TraceSelectionResult {
  if (state.selectionLocked || !state.currentTrace) {
    return {state, selected: false};
  }
  if (input.traceId === state.currentTrace.id) {
    if (state.currentPane === input.pane) return {state, selected: true};
    return {
      selected: true,
      state: {
        ...state,
        currentPane: input.pane,
        maximizedTraceSide: null,
        minimizedTraceSides: new Set(),
      },
    };
  }
  const reference = state.catalog.find((item) => item.id === input.traceId);
  if (!reference) return {state, selected: false};
  return {
    selected: true,
    state: {
      ...state,
      currentPane: otherPane(input.pane),
      referenceTrace: reference,
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
    referenceTrace: null,
    currentPane: 'first',
    maximizedTraceSide: null,
    minimizedTraceSides: new Set(),
    activeTraceSide: 'current',
  };
}
