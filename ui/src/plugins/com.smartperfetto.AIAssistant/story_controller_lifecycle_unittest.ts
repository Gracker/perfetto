// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  StoryController,
  StoryControllerInvalidatedError,
  type StoryControllerContext,
} from './story_controller';

function createContext(fetchBackend: StoryControllerContext['fetchBackend']) {
  return {
    getBackendTraceId: vi.fn(() => 'trace-a'),
    getBackendUrl: vi.fn(() => 'http://backend.example'),
    getTrace: vi.fn(() => ({traceInfo: {uuid: 'trace-a'}})),
    addMessage: vi.fn(),
    updateMessage: vi.fn(),
    generateId: vi.fn(() => 'progress-message'),
    setLoadingState: vi.fn(),
    fetchBackend,
    pinTracksFromInstructions: vi.fn(async () => {}),
    setDetectedScenes: vi.fn(),
  } satisfies StoryControllerContext;
}

describe('StoryController lifecycle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('invalidates a pending preview without returning old authority data', async () => {
    const fetchBackend = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            {once: true},
          );
        }),
    );
    const context = createContext(fetchBackend);
    const controller = new StoryController(context);

    const preview = controller.preview('trace-a');
    await vi.waitFor(() => expect(fetchBackend).toHaveBeenCalledOnce());
    controller.dispose();

    await expect(preview).rejects.toBeInstanceOf(
      StoryControllerInvalidatedError,
    );
    expect(context.updateMessage).not.toHaveBeenCalled();
    expect(context.setDetectedScenes).not.toHaveBeenCalled();
    expect(context.pinTracksFromInstructions).not.toHaveBeenCalled();
  });

  it('aborts a pending Story stream and suppresses every late mutation', async () => {
    const fetchBackend = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/scene-reconstruct')) {
        return new Response(
          JSON.stringify({success: true, analysisId: 'analysis-a'}),
          {status: 200},
        );
      }
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          {once: true},
        );
      });
    });
    const context = createContext(fetchBackend);
    const controller = new StoryController(context);

    const run = controller.start();
    await vi.waitFor(() => expect(fetchBackend).toHaveBeenCalledTimes(2));
    controller.dispose();

    await expect(run).rejects.toBeInstanceOf(StoryControllerInvalidatedError);
    expect(context.updateMessage).not.toHaveBeenCalled();
    expect(context.setDetectedScenes).not.toHaveBeenCalled();
    expect(context.pinTracksFromInstructions).not.toHaveBeenCalled();
    expect(context.setLoadingState).toHaveBeenCalledTimes(1);
    expect(context.setLoadingState).toHaveBeenLastCalledWith(true);
  });
});
