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
    const children: Array<{
      id: string;
      name: string;
      remove: ReturnType<typeof vi.fn>;
    }> = [];
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
    addDebugSliceTrackMock.mockImplementation(async ({title}) => {
      await creationGate;
      children.push({id: 'story-overlay', name: title, remove});
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

  it('preserves unrelated tracks pinned while stale overlay creation is pending', async () => {
    let finishCreation: (() => void) | undefined;
    const creationGate = new Promise<void>((resolve) => {
      finishCreation = resolve;
    });
    const children: Array<{
      id: string;
      name: string;
      remove: ReturnType<typeof vi.fn>;
    }> = [];
    const trace = {
      traceInfo: {uuid: 'trace-a'},
      currentWorkspace: {
        pinnedTracksNode: {children},
      },
    } as any;
    const overlayRemove = vi.fn(() => {
      const index = children.findIndex((node) => node.id === 'story-overlay');
      if (index >= 0) children.splice(index, 1);
    });
    const unrelatedRemove = vi.fn(() => {
      const index = children.findIndex((node) => node.id === 'user-track');
      if (index >= 0) children.splice(index, 1);
    });
    addDebugSliceTrackMock.mockImplementation(async ({title}) => {
      await creationGate;
      children.push({id: 'story-overlay', name: title, remove: overlayRemove});
    });
    let current = true;

    const creation = createOverlayTrack(
      trace,
      'scene_timeline',
      ['ts', 'dur', 'event'],
      [[1, 2, 'Launch']],
      () => current,
    );
    children.push({
      id: 'user-track',
      name: 'User SQL Track',
      remove: unrelatedRemove,
    });
    current = false;
    finishCreation?.();
    await creation;

    expect(overlayRemove).toHaveBeenCalledOnce();
    expect(unrelatedRemove).not.toHaveBeenCalled();
    expect(children.map(({id}) => id)).toEqual(['user-track']);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('canonical scene overlay capacity', () => {
  it('keeps all 2000 segments in three lanes and never stores the canonical track in sessionStorage', async () => {
    sessionStorage.clear(); addDebugSliceTrackMock.mockReset();
    addDebugSliceTrackMock.mockResolvedValue(undefined);
    const trace = {traceInfo: {uuid: 'canonical-trace'}, currentWorkspace: {pinnedTracksNode: {children: []}}} as any;
    const rows = Array.from({length: 6000}, (_, i) => [String(9007199254740993n + BigInt(i)), '1', `observation-${i}`,
      ['userAction', 'deviceState', 'appResponse'][i % 3], `segment-${Math.floor(i / 3)}`]);
    await createOverlayTrack(trace, 'scene_canonical', ['ts', 'dur', 'event', 'dimension', 'segment_id'], rows);
    const request = addDebugSliceTrackMock.mock.calls[0][0];
    expect(request.data.sqlSource).toContain('observation-5999');
    expect(request.data.sqlSource).toContain('9007199254740993');
    expect(request.pivotOn).toBe('dimension');
    expect(sessionStorage.length).toBe(0);
  });
});
