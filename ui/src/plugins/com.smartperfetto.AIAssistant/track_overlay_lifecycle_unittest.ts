// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {beforeEach, describe, expect, it, vi} from 'vitest';

const {addDebugSliceTrackMock} = vi.hoisted(() => ({
  addDebugSliceTrackMock: vi.fn(),
}));

vi.mock('../../components/tracks/debug_tracks', () => ({
  addDebugSliceTrack: addDebugSliceTrackMock,
}));

import {createOverlayTrack} from './track_overlay';

describe('track overlay lifecycle', () => {
  beforeEach(() => {
    sessionStorage.clear();
    addDebugSliceTrackMock.mockReset();
  });

  it('removes a track created after its owning authority is invalidated', async () => {
    let finishCreation: (() => void) | undefined;
    const creationGate = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    const children: Array<{id: string; remove: ReturnType<typeof vi.fn>}> = [];
    const trace = {
      traceInfo: {uuid: 'trace-a'},
      currentWorkspace: {
        pinnedTracksNode: {children},
      },
    } as any;
    const remove = vi.fn(() => {
      const index = children.findIndex((node) => node.id === 'story-overlay');
      if (index >= 0) children.splice(index, 1);
    });
    addDebugSliceTrackMock.mockImplementation(async () => {
      await creationGate;
      children.push({id: 'story-overlay', remove});
    });
    let current = true;

    const creation = createOverlayTrack(
      trace,
      'scene_timeline',
      ['ts', 'dur', 'event'],
      [[1, 2, 'Launch']],
      () => current,
    );
    current = false;
    finishCreation?.();
    await creation;

    expect(remove).toHaveBeenCalledOnce();
    expect(children).toEqual([]);
    expect(sessionStorage.length).toBe(0);
  });
});
