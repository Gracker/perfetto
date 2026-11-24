// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {backendUploadSourceKey} from './backend_uploader';
import type {TraceSource} from './trace_source';
import type {TraceInfo} from '../public/trace_info';

export interface LocalTraceAssetSource {
  sourceKey: string;
  uploadToken: string;
}

const operations = new WeakMap<TraceSource, string>();
const sources = new WeakMap<TraceInfo, LocalTraceAssetSource>();

export function rememberTraceUploadOperation(
  source: TraceSource,
  token: string | undefined,
): void {
  if (token) operations.set(source, token);
}

export function captureTraceAssetSource(trace: TraceInfo, source: TraceSource): void {
  const token = operations.get(source);
  if (!token || !trace.shareable || !trace.downloadable) return;
  if (source.type !== 'FILE' && source.type !== 'ARRAY_BUFFER') return;
  sources.set(trace, {sourceKey: backendUploadSourceKey(source), uploadToken: token});
}

export function getLocalTraceAssetSource(trace: TraceInfo): LocalTraceAssetSource | undefined {
  return sources.get(trace);
}
