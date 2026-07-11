// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {TraceSource} from '../../core/trace_source';
import type {TraceInfo} from '../../public/trace_info';

type TraceNameInfo = Pick<TraceInfo, 'traceTitle'> & {
  readonly source?: TraceSource;
};

export function getCanonicalTraceName(
  traceInfo: TraceNameInfo | null | undefined,
  fallback: string,
): string {
  const sourceName = traceInfo?.source
    ? getTraceSourceName(traceInfo.source)
    : undefined;
  return sourceName || traceInfo?.traceTitle?.trim() || fallback;
}

function getTraceSourceName(source: TraceSource): string | undefined {
  switch (source.type) {
    case 'FILE':
      return basename(source.file.name);
    case 'ARRAY_BUFFER':
      return basename(source.fileName || source.title);
    case 'URL':
      return urlBasename(source.url);
    default:
      return undefined;
  }
}

function basename(value: string): string | undefined {
  return value.split(/[/\\]/).pop()?.trim() || undefined;
}

function urlBasename(value: string): string | undefined {
  try {
    const pathname = new URL(value, 'http://smartperfetto.invalid').pathname;
    const name = basename(pathname);
    return name ? decodeURIComponent(name) : undefined;
  } catch {
    return basename(value);
  }
}
