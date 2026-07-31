// Copyright (C) 2024 SmartPerfetto

import {afterEach, describe, expect, it, vi} from 'vitest';

import {fetchSmartPerfettoBackend} from './smartperfetto_backend_fetch';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchSmartPerfettoBackend', () => {
  it('includes the HttpOnly OIDC session cookie by default', async () => {
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', fetchMock);

    await fetchSmartPerfettoBackend('https://backend.example/api/session', {
      headers: {'X-Workspace-Id': 'workspace-a'},
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example/api/session',
      expect.objectContaining({
        credentials: 'include',
        headers: {'X-Workspace-Id': 'workspace-a'},
      }),
    );
  });

  it('preserves an explicit credential mode', async () => {
    const fetchMock = vi.fn(async () => new Response());
    vi.stubGlobal('fetch', fetchMock);

    await fetchSmartPerfettoBackend('https://backend.example/health', {
      credentials: 'omit',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://backend.example/health',
      expect.objectContaining({credentials: 'omit'}),
    );
  });
});
