// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {z} from 'zod';
import {uiText} from './ui_language';

const WorkspaceTraceEnvelopeSchema = z.object({
  traces: z.array(z.unknown()),
});

const WorkspaceTraceRowSchema = z.object({
  id: z.string(),
  filename: z.string().optional(),
  originalName: z.string().optional(),
  name: z.string().optional(),
  uploadedAt: z.string().optional(),
  size: z.number().finite().nonnegative().optional(),
  status: z.string().optional(),
});

export interface WorkspaceTraceCatalogItem {
  readonly id: string;
  readonly filename: string;
  readonly uploadedAt?: string;
  readonly size?: number;
}

export type WorkspaceTraceCatalogParseResult =
  | {
      readonly ok: true;
      readonly items: ReadonlyArray<WorkspaceTraceCatalogItem>;
    }
  | {
      readonly ok: false;
      readonly error: string;
    };

export function parseWorkspaceTraceCatalogResponse(
  value: unknown,
): WorkspaceTraceCatalogParseResult {
  const envelope = WorkspaceTraceEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    return {
      ok: false,
      error: uiText(
        'Trace 列表响应格式无效',
        'Invalid trace catalog response',
      ),
    };
  }

  const items: WorkspaceTraceCatalogItem[] = [];
  for (const value of envelope.data.traces) {
    const parsed = WorkspaceTraceRowSchema.safeParse(value);
    if (!parsed.success) continue;
    const row = parsed.data;
    const id = row.id.trim();
    const filename = [row.filename, row.originalName, row.name]
      .find((candidate) => candidate?.trim())
      ?.trim();
    if (!id || !filename || (row.status && row.status !== 'ready')) continue;
    items.push({
      id,
      filename,
      ...(row.uploadedAt ? {uploadedAt: row.uploadedAt} : {}),
      ...(row.size !== undefined ? {size: row.size} : {}),
    });
  }
  return {ok: true, items};
}

export function formatWorkspaceTraceCatalogMeta(
  item: WorkspaceTraceCatalogItem,
): string {
  const parts: string[] = [];
  if (item.uploadedAt) {
    const timestamp = Date.parse(item.uploadedAt);
    if (Number.isFinite(timestamp)) {
      parts.push(new Date(timestamp).toLocaleString());
    }
  }
  if (item.size !== undefined) {
    parts.push(`${(item.size / 1024 / 1024).toFixed(1)} MB`);
  }
  return parts.join(' · ');
}
