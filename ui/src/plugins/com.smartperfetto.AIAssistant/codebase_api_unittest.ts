// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  deleteCodebase,
  registerExternalKnowledgeSource,
  reindexExternalKnowledgeSource,
} from './codebase_api';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codebase deletion API', () => {
  it('uses the scoped DELETE endpoint and returns cleanup counts', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        codebaseId: 'codebase/a',
        removedChunkCount: 7,
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteCodebase(
      'http://backend/',
      'codebase/a',
      'secret-key',
    )).resolves.toEqual({
      success: true,
      codebaseId: 'codebase/a',
      removedChunkCount: 7,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/codebases/codebase%2Fa',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({Authorization: 'Bearer secret-key'}),
      }),
    );
  });
});

describe('external knowledge source API', () => {
  it('registers a source through the scoped RAG endpoint', async () => {
    const source = {
      sourceId: 'wiki-a',
      kind: 'android_internals_wiki' as const,
      displayName: 'Android Internals',
      revision: 'rev-a',
      contentFingerprint: 'fingerprint-a',
      dirty: false,
      license: 'CC-BY-NC-SA-4.0',
      rightsAcknowledged: true,
      sendToProvider: true,
      indexGeneration: 0,
    };
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({success: true, source}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(registerExternalKnowledgeSource('http://backend/', {
      rootPath: '/knowledge/wiki',
      displayName: 'Android Internals',
      rightsAcknowledged: true,
      sendToProvider: true,
    }, 'secret-key')).resolves.toEqual(source);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/android-internals/sources',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({Authorization: 'Bearer secret-key'}),
        body: JSON.stringify({
          rootPath: '/knowledge/wiki',
          displayName: 'Android Internals',
          rightsAcknowledged: true,
          sendToProvider: true,
        }),
      }),
    );
  });

  it('reindexes a source using an encoded identifier', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({success: true}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(reindexExternalKnowledgeSource(
      'http://backend',
      'wiki/a',
      'secret-key',
    )).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/android-internals/sources/wiki%2Fa/reindex',
      expect.objectContaining({method: 'POST'}),
    );
  });
});
