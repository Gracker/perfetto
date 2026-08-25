// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");

export const WORKSPACE_TRACE_LAUNCH_ARG = 'smartperfettoWorkspaceTrace';
export const WORKSPACE_TRACE_ID_ARG = 'smartperfettoWorkspaceTraceId';

export interface WorkspaceTraceLaunch {
  readonly traceId: string;
  readonly traceFileName: string;
}

export function buildWorkspaceTraceViewerHash(input: {
  readonly id: string;
  readonly filename: string;
}): string {
  const params = new URLSearchParams({
    [WORKSPACE_TRACE_LAUNCH_ARG]: 'true',
    [WORKSPACE_TRACE_ID_ARG]: input.id,
    traceFileName: input.filename,
  });
  return `#!/viewer?${params.toString()}`;
}

export function parseWorkspaceTraceLaunch(
  url: string,
): WorkspaceTraceLaunch | undefined {
  const hashQuery = new URL(url).hash.split('?')[1] ?? '';
  const params = new URLSearchParams(hashQuery);
  if (params.get(WORKSPACE_TRACE_LAUNCH_ARG) !== 'true') return undefined;
  const traceId = params.get(WORKSPACE_TRACE_ID_ARG)?.trim();
  if (!traceId) return undefined;
  return {
    traceId,
    traceFileName:
      params.get('traceFileName')?.trim() || 'trace.perfetto-trace',
  };
}
