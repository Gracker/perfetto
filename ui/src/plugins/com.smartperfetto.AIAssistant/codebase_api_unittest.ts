// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  acceptPendingCodebaseGeneration,
  authorizeCurrentCodebaseSelection,
  deleteCodebase,
  getCodebaseDirectoryPickerCapability,
  previewCodebaseRoot,
  registerExternalKnowledgeSource,
  reindexExternalKnowledgeSource,
  rejectPendingCodebaseGeneration,
  selectCodebaseDirectory,
  updateCodebaseSelection,
} from './codebase_api';

describe('codebase selection policy API', () => {
  it('PATCHes the complete repeated filter replacement without changing request conventions', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        codebase: {
          codebaseId: 'codebase/a',
          kind: 'app_source',
          displayName: 'App',
          indexGeneration: 3,
          selectionPolicyRevision: 4,
          reindexRequired: 'selection_scope_changed',
        },
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(updateCodebaseSelection(
      'http://backend/',
      'codebase/a',
      {
        pathFilters: ['app', 'lib'],
        excludeGlobs: ['**/generated/**', '**/fixtures/**'],
      },
      'secret-key',
    )).resolves.toMatchObject({
      selectionPolicyRevision: 4,
      reindexRequired: 'selection_scope_changed',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/codebases/codebase%2Fa/selection',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          pathFilters: ['app', 'lib'],
          excludeGlobs: ['**/generated/**', '**/fixtures/**'],
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer secret-key');
  });
});

describe('codebase selection consent API', () => {
  it('uses the explicit current-selection authorization action', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 200,
      json: async () => ({success: true, codebase: {codebaseId: 'codebase/a'}}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await authorizeCurrentCodebaseSelection('http://backend', 'codebase/a', 'key');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/codebases/codebase%2Fa/consent',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({authorizeCurrentSelection: true}),
      }),
    );
  });
});

describe('pending codebase generation API', () => {
  it('binds accept and reject requests to the reviewed candidate generation', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 200,
      json: async () => ({success: true, codebase: {}}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    const pending = {
      codebaseId: 'codebase/a',
      kind: 'app_source' as const,
      displayName: 'App',
      indexGeneration: 2,
      selectionPolicyRevision: 3,
      grantRevision: 4,
      pendingGeneration: {
        candidateGenerationId: 'candidate/a',
        chunkCount: 1,
        createdAt: 1,
        coverage: {
          selectionPolicyRevision: 3,
          enumerationBackend: 'ripgrep' as const,
          backendFidelity: 'exact' as const,
          enumerationComplete: true,
          deterministic: true,
          filesEnumerated: 2,
          filesSelected: 1,
          bytesSelected: 10,
          chunksIndexed: 1,
          truncated: true,
          complete: false,
        },
      },
    };

    await acceptPendingCodebaseGeneration('http://backend', pending, 'key');
    await (rejectPendingCodebaseGeneration as any)(
      'http://backend',
      pending.codebaseId,
      pending.pendingGeneration.candidateGenerationId,
      'key',
    );

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      selectionPolicyRevision: 3,
      grantRevision: 4,
      candidateGenerationId: 'candidate/a',
    }));
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
      candidateGenerationId: 'candidate/a',
    }));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('codebase deletion API', () => {
  it('uses the scoped DELETE endpoint and returns cleanup counts', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
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
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer secret-key');
  });
});

describe('codebase directory picker API', () => {
  it('loads local picker capability and requests a system directory selection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          capability: {
            available: true,
            platform: 'darwin',
            provider: 'macos',
          },
        }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          selected: true,
          rootPath: '/Users/me/App',
          directorySelectionId: 'selection-a',
          displayNameSuggestion: 'App',
          expiresAt: 123,
        }),
      } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCodebaseDirectoryPickerCapability(
      'http://backend/',
      'secret-key',
    )).resolves.toMatchObject({
      available: true,
      provider: 'macos',
    });
    await expect(selectCodebaseDirectory(
      'http://backend/',
      'secret-key',
    )).resolves.toMatchObject({
      selected: true,
      directorySelectionId: 'selection-a',
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://backend/api/rag/codebases/directory-picker',
      expect.any(Object),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer secret-key');
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://backend/api/rag/codebases/directory-picker',
      expect.objectContaining({
        method: 'POST',
        body: '{}',
      }),
    );
  });

  it('keeps the picker authorization attached to preview requests', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        preview: {
          blocked: false,
          acceptedFileCount: 1,
          skippedFileCount: 0,
          acceptedFiles: ['Main.kt'],
          skippedFiles: [],
        },
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await previewCodebaseRoot(
      'http://backend',
      '/Users/me/App',
      'secret-key',
      'selection-a',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/codebases/preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          rootPath: '/Users/me/App',
          directorySelectionId: 'selection-a',
        }),
      }),
    );
  });

  it('surfaces human guidance while the response retains a stable error code', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        error: 'effective_source_selection_empty',
        message: 'No source files matched the effective selection.',
        hint: 'Check path filters and supported extensions.',
      }),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewCodebaseRoot('http://backend', '/empty'))
      .rejects.toThrow(/No source files.*Check path filters/s);
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
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
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
        body: JSON.stringify({
          rootPath: '/knowledge/wiki',
          displayName: 'Android Internals',
          rightsAcknowledged: true,
          sendToProvider: true,
        }),
      }),
    );
    expect(fetchMock.mock.calls[0]?.[1]?.credentials).toBeUndefined();
    expect(
      new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'),
    ).toBe('Bearer secret-key');
  });

  it('reindexes a source using an encoded identifier', async () => {
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
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
