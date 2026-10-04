// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  CodebaseApiError,
  acceptPendingCodebaseGeneration,
  deleteKnowledgeBase,
  reindexCodebase,
  authorizeCodebaseContent,
  previewCodebaseSelection,
  revokeCodebaseContentConsent,
  deleteCodebase,
  getCodebaseDirectoryPickerCapability,
  previewCodebaseRoot,
  rejectPendingCodebaseGeneration,
  searchKnowledgeCollection,
  selectDirectory,
  updateCodebaseSelection,
} from './codebase_api';
import {
  setSmartPerfettoWorkspaceId,
  tryGetSmartPerfettoRequestContext,
} from '../../core/smartperfetto_request_context';

describe('requests pinned to a scope', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('names the scope an operation pinned, not the scope the window switched to since', async () => {
    setSmartPerfettoWorkspaceId('workspace-a');
    const pinned = tryGetSmartPerfettoRequestContext()!;
    setSmartPerfettoWorkspaceId('workspace-b');
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ok: true, status: 200, json: async () => ({success: true, hits: []})} as Response));
    vi.stubGlobal('fetch', fetchMock);

    await searchKnowledgeCollection('http://backend', 'kb-a', 'binder', undefined, pinned);
    await searchKnowledgeCollection('http://backend', 'kb-a', 'binder');

    const sent = fetchMock.mock.calls.map(call => call[1]?.headers as Record<string, string>);
    expect(sent[0]).toMatchObject({'X-Workspace-Id': 'workspace-a', 'X-Tenant-Id': pinned.tenantId,
      'X-Window-Id': pinned.windowId});
    // Without a pinned scope the request names the current one.
    expect(sent[1]).toMatchObject({'X-Workspace-Id': 'workspace-b'});
  });
});

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

describe('codebase content consent and selection preview API', () => {
  function stubFetch(body: unknown) {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true, status: 200, json: async () => body,
    } as Response));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('grants content only with the disclosed token, and revokes with an explicit false', async () => {
    const fetchMock = stubFetch({success: true, codebase: {codebaseId: 'codebase/a'}});
    await authorizeCodebaseContent('http://backend', 'codebase/a', 'disclosure-token-1', 'key');
    await revokeCodebaseContentConsent('http://backend', 'codebase/a', 'key');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method, init?.body])).toEqual([
      ['http://backend/api/rag/codebases/codebase%2Fa/consent', 'PATCH',
        JSON.stringify({authorizeContent: true, contentDisclosureToken: 'disclosure-token-1'})],
      ['http://backend/api/rag/codebases/codebase%2Fa/consent', 'PATCH', JSON.stringify({sendToProvider: false})],
    ]);
  });

  it('previews a proposed selection and saves with the previewed revision', async () => {
    const fetchMock = stubFetch({success: true, selectionPreview: {status: 'partial', selectionPolicyRevision: 4,
      preview: {acceptedFileCount: 12}}, codebase: {codebaseId: 'codebase/a'}});
    const preview = await previewCodebaseSelection('http://backend', 'codebase/a',
      {pathFilters: ['app'], excludeGlobs: []});
    expect(preview).toEqual({status: 'partial', selectionPolicyRevision: 4, preview: {acceptedFileCount: 12}});
    await updateCodebaseSelection('http://backend', 'codebase/a',
      {pathFilters: ['app'], excludeGlobs: [], expectedSelectionPolicyRevision: 4});
    expect(fetchMock.mock.calls[0][0]).toBe('http://backend/api/rag/codebases/codebase%2Fa/selection/preview');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      pathFilters: ['app'], excludeGlobs: [], expectedSelectionPolicyRevision: 4,
    });
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
    await expect(selectDirectory(
      'http://backend/',
      'codebase',
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
        body: JSON.stringify({purpose: 'codebase'}),
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

describe('retired legacy Wiki records', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are deleted through the shared `/knowledge` endpoint; no legacy route is called', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ok: true, status: 200, json: async () => ({success: true})} as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(deleteKnowledgeBase('http://backend/', 'wiki/a', 'secret-key')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'http://backend/api/rag/knowledge/wiki%2Fa',
      expect.objectContaining({method: 'DELETE'}),
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/android-internals/'))).toBe(false);
  });
});

describe('structured codebase failures', () => {
  it('retains typed availability without assuming a truthy malformed value is permission', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 422, json: async () => ({success: false,
        code: 'CODEBASE_INDEX_CAPACITY_EXCEEDED', message: 'Optional index capacity exceeded', onDemandAvailable: true,
      }),
    } as Response)));
    await expect(reindexCodebase('http://backend', 'cb-a')).rejects.toMatchObject({
      name: 'CodebaseApiError', code: 'CODEBASE_INDEX_CAPACITY_EXCEEDED', onDemandAvailable: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 403, json: async () => ({success: false, error: 'forbidden', onDemandAvailable: 'true'}),
    } as Response)));
    await expect(reindexCodebase('http://backend', 'cb-a')).rejects.toBeInstanceOf(CodebaseApiError);
    await expect(reindexCodebase('http://backend', 'cb-a')).rejects.toMatchObject({onDemandAvailable: undefined, status: 403});
  });
});
