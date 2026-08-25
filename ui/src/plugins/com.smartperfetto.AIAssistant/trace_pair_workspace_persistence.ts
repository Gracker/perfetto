// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {z} from 'zod';

import {buildSmartPerfettoStorageKey} from '../../core/smartperfetto_request_context';
import {isSmartPerfettoOidcMode} from '../../core/smartperfetto_auth';
import type {TracePairWorkspaceState} from './trace_pair_workspace_state';
import type {WorkspaceTraceCatalogItem} from './workspace_trace_catalog';

const TRACE_PAIR_WORKSPACE_KEY = 'smartperfetto-trace-pair-workspace';

const TraceSchema = z.object({
  id: z.string().trim().min(1),
  filename: z.string().trim().min(1),
  uploadedAt: z.string().optional(),
  size: z.number().finite().nonnegative().optional(),
});

const PersistedTracePairWorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  backendUrl: z.string().trim().min(1),
  open: z.boolean(),
  baseline: TraceSchema.optional(),
  comparison: TraceSchema.optional(),
  layout: z.enum(['horizontal', 'vertical']),
  splitPercent: z.number().finite().min(18).max(82),
  updatedAt: z.number().finite().nonnegative(),
});

export interface PersistedTracePairWorkspace {
  readonly open: boolean;
  readonly baseline?: WorkspaceTraceCatalogItem;
  readonly comparison?: WorkspaceTraceCatalogItem;
  readonly layout: 'horizontal' | 'vertical';
  readonly splitPercent: number;
}

function storageKey(): string {
  return buildSmartPerfettoStorageKey(TRACE_PAIR_WORKSPACE_KEY, 'workspace');
}

function normalizeBackendUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export function persistTracePairWorkspace(
  state: Readonly<TracePairWorkspaceState>,
  backendUrl: string,
): void {
  if (isSmartPerfettoOidcMode()) return;
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        schemaVersion: 1,
        backendUrl: normalizeBackendUrl(backendUrl),
        open: state.open,
        ...(state.currentTrace ? {baseline: state.currentTrace} : {}),
        ...(state.referenceTrace ? {comparison: state.referenceTrace} : {}),
        layout: state.layout,
        splitPercent: state.splitPercent,
        updatedAt: Date.now(),
      }),
    );
  } catch {
    // Storage may be unavailable in private browsing or over quota.
  }
}

export function loadPersistedTracePairWorkspace(
  backendUrl: string,
): PersistedTracePairWorkspace | undefined {
  if (isSmartPerfettoOidcMode()) return undefined;
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return undefined;
    const parsed = PersistedTracePairWorkspaceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    if (
      normalizeBackendUrl(parsed.data.backendUrl) !==
      normalizeBackendUrl(backendUrl)
    ) {
      return undefined;
    }
    return {
      open: parsed.data.open,
      ...(parsed.data.baseline ? {baseline: parsed.data.baseline} : {}),
      ...(parsed.data.comparison
        ? {comparison: parsed.data.comparison}
        : {}),
      layout: parsed.data.layout,
      splitPercent: parsed.data.splitPercent,
    };
  } catch {
    return undefined;
  }
}
