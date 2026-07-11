// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export interface SurfaceLocation {
  readonly hash: string;
  readonly search: string;
}

export interface AIAssistantSurfacePolicy {
  readonly installFrameRedrawBridge: boolean;
  readonly registerCommands: boolean;
  readonly setupAssistantOwner: boolean;
}

const PRIMARY_SURFACE_POLICY: AIAssistantSurfacePolicy = {
  installFrameRedrawBridge: true,
  registerCommands: true,
  setupAssistantOwner: true,
};

const EMBEDDED_TRACE_SURFACE_POLICY: AIAssistantSurfacePolicy = {
  installFrameRedrawBridge: true,
  registerCommands: false,
  setupAssistantOwner: false,
};

function getHashSearch(hash: string): string {
  const queryStart = hash.indexOf('?');
  return queryStart === -1 ? '' : hash.slice(queryStart + 1);
}

function hasDualTraceMarker(location: SurfaceLocation): boolean {
  return [location.search, getHashSearch(location.hash)].some(
    (search) =>
      new URLSearchParams(search).get('smartperfettoDualTrace') === 'true',
  );
}

export function getAIAssistantSurfacePolicy(
  location: SurfaceLocation = window.location,
): AIAssistantSurfacePolicy {
  return hasDualTraceMarker(location)
    ? EMBEDDED_TRACE_SURFACE_POLICY
    : PRIMARY_SURFACE_POLICY;
}
