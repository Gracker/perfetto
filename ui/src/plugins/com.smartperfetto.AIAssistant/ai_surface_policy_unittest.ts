// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {
  getAIAssistantSurfacePolicy,
  type SurfaceLocation,
} from './ai_surface_policy';

function location(hash: string, search = ''): SurfaceLocation {
  return {hash, search};
}

describe('getAIAssistantSurfacePolicy', () => {
  it('gives the primary page sole ownership of assistant surfaces', () => {
    expect(getAIAssistantSurfacePolicy(location('#!/?url=trace'))).toEqual({
      installFrameRedrawBridge: true,
      registerCommands: true,
      setupAssistantOwner: true,
    });
  });

  it('limits a dual Trace iframe to the parent redraw bridge', () => {
    expect(
      getAIAssistantSurfacePolicy(
        location(
          '#!/?url=trace&mode=embedded&smartperfettoDualTrace=true&smartperfettoPane=current',
        ),
      ),
    ).toEqual({
      installFrameRedrawBridge: true,
      registerCommands: false,
      setupAssistantOwner: false,
    });
  });

  it('does not treat unrelated embedded pages as dual Trace frames', () => {
    expect(
      getAIAssistantSurfacePolicy(
        location('#!/?url=trace&mode=embedded&smartperfettoDualTrace=false'),
      ).setupAssistantOwner,
    ).toBe(true);
  });

  it('recognizes a direct query before hash routing initializes', () => {
    expect(
      getAIAssistantSurfacePolicy(
        location('', '?smartperfettoDualTrace=true&mode=embedded'),
      ).registerCommands,
    ).toBe(false);
  });
});
