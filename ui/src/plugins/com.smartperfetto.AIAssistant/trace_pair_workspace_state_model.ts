// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TracePairLayout, TracePairTraceSide} from './types';
import type {WorkspaceTraceCatalogItem} from './workspace_trace_catalog';

export type TracePairPaneSlot = 'first' | 'second';

export interface TracePairWorkspaceTrace extends WorkspaceTraceCatalogItem {
  readonly fingerprint?: string;
}

export interface TracePairWorkspaceScope {
  readonly key: string;
  readonly backendUrl: string;
  readonly backendHeaders?: Readonly<Record<string, string>>;
}

export interface TracePairWorkspaceState {
  readonly open: boolean;
  readonly scope: TracePairWorkspaceScope | null;
  readonly currentTrace: TracePairWorkspaceTrace | null;
  readonly referenceTrace: WorkspaceTraceCatalogItem | null;
  readonly currentPane: TracePairPaneSlot;
  readonly catalog: ReadonlyArray<WorkspaceTraceCatalogItem>;
  readonly catalogLoading: boolean;
  readonly catalogError: string | null;
  readonly selectionLocked: boolean;
  readonly layout: TracePairLayout;
  readonly splitPercent: number;
  readonly maximizedTraceSide: TracePairTraceSide | null;
  readonly minimizedTraceSides: ReadonlySet<TracePairTraceSide>;
  readonly activeTraceSide: TracePairTraceSide;
}

export interface OpenTracePairWorkspaceInput {
  readonly scope: TracePairWorkspaceScope;
  readonly currentTrace: TracePairWorkspaceTrace;
}

export interface SelectTraceForPaneInput {
  readonly pane: TracePairPaneSlot;
  readonly traceId: string;
}

export interface HydrateTracePairWorkspaceInput
  extends OpenTracePairWorkspaceInput {
  readonly referenceTrace: WorkspaceTraceCatalogItem;
  readonly currentPane?: TracePairPaneSlot;
  readonly layout?: TracePairLayout;
  readonly splitPercent?: number;
  readonly activeTraceSide?: TracePairTraceSide;
}

export interface HydrateTracePairWorkspaceOptions {
  readonly preserveLivePair: boolean;
}

export function createInitialTracePairWorkspaceState(): TracePairWorkspaceState {
  return {
    open: false,
    scope: null,
    currentTrace: null,
    referenceTrace: null,
    currentPane: 'first',
    catalog: [],
    catalogLoading: false,
    catalogError: null,
    selectionLocked: false,
    layout: 'horizontal',
    splitPercent: 50,
    maximizedTraceSide: null,
    minimizedTraceSides: new Set(),
    activeTraceSide: 'current',
  };
}
