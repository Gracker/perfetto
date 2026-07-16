// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {TracePairWorkspaceController} from './trace_pair_workspace_state';

describe('TracePairWorkspaceController', () => {
  let controller: TracePairWorkspaceController;

  beforeEach(() => {
    controller = new TracePairWorkspaceController();
    controller.open({
      scope: {
        key: 'tenant-a/workspace-a/backend-current',
        backendUrl: 'http://127.0.0.1:3000',
      },
      currentTrace: {
        id: 'backend-current',
        filename: 'current.pftrace',
        fingerprint: 'fingerprint-current',
        size: 10,
      },
    });
    controller.setCatalog([
      {id: 'history-a', filename: 'history-a.pftrace', size: 10},
      {id: 'history-b', filename: 'history-b.pftrace', size: 10},
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens a draft workspace before a reference trace is selected', () => {
    expect(controller.getState()).toMatchObject({
      open: true,
      currentPane: 'first',
      currentTrace: {
        id: 'backend-current',
        filename: 'current.pftrace',
      },
      referenceTrace: null,
    });
    expect(controller.getTraceForPane('first')?.id).toBe('backend-current');
    expect(controller.getTraceForPane('second')).toBeNull();
  });

  it('loads protected trace files with workspace authentication once', async () => {
    const sourceUrl = 'blob:http://localhost/secure-current';
    vi.spyOn(URL, 'createObjectURL').mockReturnValue(sourceUrl);
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL');
    const fetchTrace = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(new Blob(['trace bytes']), {
        status: 200,
        headers: {'Content-Type': 'application/octet-stream'},
      }),
    );
    const protectedController = new TracePairWorkspaceController();

    protectedController.open({
      scope: {
        key: 'tenant-a/workspace-a/secure-current',
        backendUrl: 'http://127.0.0.1:3000',
        backendHeaders: {
          Authorization: 'Bearer test-only-key',
          'X-Workspace-Id': 'workspace-a',
        },
      },
      currentTrace: {
        id: 'secure-current',
        filename: 'secure-current.pftrace',
      },
    });

    await vi.waitFor(() => {
      expect(protectedController.getTraceSourceUrl('secure-current')).toBe(
        sourceUrl,
      );
    });
    expect(fetchTrace).toHaveBeenCalledTimes(1);
    expect(fetchTrace).toHaveBeenCalledWith(
      expect.stringContaining(
        '/api/workspaces/default-workspace/traces/secure-current/file',
      ),
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-only-key',
          'X-Workspace-Id': 'workspace-a',
        }),
      }),
    );

    protectedController.toggleMaximized('current');
    protectedController.toggleMinimized('current');
    protectedController.setLayout('vertical');
    expect(fetchTrace).toHaveBeenCalledTimes(1);

    protectedController.close();
    expect(revokeObjectUrl).toHaveBeenCalledWith(sourceUrl);
  });

  it('serializes protected loads and rejects a pair beyond the retained Blob budget', async () => {
    const createObjectUrl = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:http://localhost/budget-current');
    vi.spyOn(URL, 'revokeObjectURL');
    const fetchTrace = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('123456', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '6',
        },
      }),
    );
    const protectedController = new TracePairWorkspaceController({
      maxProtectedTraceBytes: 10,
    });
    protectedController.open({
      scope: {
        key: 'tenant-a/workspace-a/budget-current',
        backendUrl: 'http://127.0.0.1:3000',
        backendHeaders: {Authorization: 'Bearer budget-test'},
      },
      currentTrace: {
        id: 'budget-current',
        filename: 'budget-current.pftrace',
        size: 6,
      },
    });

    await vi.waitFor(() => {
      expect(protectedController.getTraceSourceUrl('budget-current')).toBe(
        'blob:http://localhost/budget-current',
      );
    });
    protectedController.setCatalog([{
      id: 'budget-reference',
      filename: 'budget-reference.pftrace',
      size: 6,
    }]);
    protectedController.selectTrace({pane: 'second', traceId: 'budget-reference'});

    await vi.waitFor(() => {
      expect(protectedController.getTraceSourceError('budget-reference'))
        .toContain('TRACE_PAIR_RESOURCE_BUDGET_EXCEEDED');
    });
    expect(fetchTrace).toHaveBeenCalledTimes(1);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    protectedController.close();
  });

  it.each([
    ['without Content-Length', {}],
    ['when Content-Length understates the body', {'Content-Length': '2'}],
  ])('stops a protected trace stream at the byte budget %s', async (_case, headers) => {
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL');
    vi.spyOn(URL, 'revokeObjectURL');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('123456', {
        status: 200,
        headers: {
          'Content-Type': 'application/octet-stream',
          ...headers,
        },
      }),
    );
    const protectedController = new TracePairWorkspaceController({
      maxProtectedTraceBytes: 5,
    });

    protectedController.open({
      scope: {
        key: `tenant-a/workspace-a/stream-budget-${_case}`,
        backendUrl: 'http://127.0.0.1:3000',
        backendHeaders: {Authorization: 'Bearer stream-budget-test'},
      },
      currentTrace: {
        id: 'stream-budget-current',
        filename: 'stream-budget-current.pftrace',
        ...(_case.includes('understates') ? {size: 2} : {}),
      },
    });

    await vi.waitFor(() => {
      expect(protectedController.getTraceSourceError('stream-budget-current'))
        .toContain('TRACE_PAIR_RESOURCE_BUDGET_EXCEEDED');
    });
    expect(createObjectUrl).not.toHaveBeenCalled();
    protectedController.close();
  });

  it('enforces the amplified engine budget for direct-url workspaces', () => {
    const directController = new TracePairWorkspaceController({
      maxEstimatedEngineBytes: 100,
    });
    directController.open({
      scope: {
        key: 'tenant-a/workspace-a/direct-current',
        backendUrl: 'http://127.0.0.1:3000',
      },
      currentTrace: {
        id: 'direct-current',
        filename: 'direct-current.pftrace',
        size: 10,
      },
    });
    directController.setCatalog([
      {id: 'direct-current', filename: 'direct-current.pftrace', size: 10},
      {id: 'direct-reference', filename: 'direct-reference.pftrace', size: 10},
    ]);

    directController.selectTrace({
      pane: 'second',
      traceId: 'direct-reference',
    });

    expect(directController.getTraceSourceError('direct-reference'))
      .toContain('TRACE_PAIR_ENGINE_BUDGET_EXCEEDED');
    expect(directController.getTraceSourceUrl('direct-reference')).toBeNull();
  });

  it('refuses a direct-url pair when catalog sizes are unknown', () => {
    const unknownSizeController = new TracePairWorkspaceController();
    unknownSizeController.open({
      scope: {
        key: 'tenant-a/workspace-a/unknown-size',
        backendUrl: 'http://127.0.0.1:3000',
      },
      currentTrace: {
        id: 'unknown-current',
        filename: 'unknown-current.pftrace',
      },
    });
    unknownSizeController.setCatalog([{
      id: 'unknown-reference',
      filename: 'unknown-reference.pftrace',
    }]);
    unknownSizeController.selectTrace({
      pane: 'second',
      traceId: 'unknown-reference',
    });

    expect(unknownSizeController.getTraceSourceError('unknown-reference'))
      .toContain('TRACE_PAIR_RESOURCE_SIZE_UNKNOWN');
    expect(unknownSizeController.getTraceSourceUrl('unknown-reference')).toBeNull();
  });

  it('atomically moves current to the other pane when history is selected there', () => {
    expect(controller.selectTrace({pane: 'first', traceId: 'history-a'})).toBe(
      true,
    );

    expect(controller.getState()).toMatchObject({
      currentPane: 'second',
      currentTrace: {id: 'backend-current'},
      referenceTrace: {id: 'history-a', filename: 'history-a.pftrace'},
    });
    expect(controller.getTraceForPane('first')?.id).toBe('history-a');
    expect(controller.getTraceForPane('second')?.id).toBe('backend-current');
  });

  it('lets either selector swap the same pair without duplicating a trace', () => {
    controller.selectTrace({pane: 'first', traceId: 'history-a'});
    expect(
      controller.selectTrace({pane: 'first', traceId: 'backend-current'}),
    ).toBe(true);

    expect(controller.getState().currentPane).toBe('first');
    expect(controller.getTraceForPane('first')?.id).toBe('backend-current');
    expect(controller.getTraceForPane('second')?.id).toBe('history-a');
  });

  it('changes only the reference identity when another history trace is selected', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    const listener = vi.fn();
    controller.subscribe(listener);

    expect(controller.selectTrace({pane: 'second', traceId: 'history-b'})).toBe(
      true,
    );

    expect(controller.getState()).toMatchObject({
      currentPane: 'first',
      currentTrace: {id: 'backend-current'},
      referenceTrace: {id: 'history-b'},
    });
    expect(listener).toHaveBeenCalled();
  });

  it('replaces a live pair when an explicit session is hydrated', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});

    controller.hydrateSessionPair(
      {
        scope: {
          key: 'tenant-a/workspace-a/backend-current',
          backendUrl: 'http://127.0.0.1:3000',
        },
        currentTrace: {
          id: 'backend-current',
          filename: 'current.pftrace',
        },
        referenceTrace: {
          id: 'history-b',
          filename: 'history-b.pftrace',
        },
        currentPane: 'second',
        layout: 'vertical',
        splitPercent: 64,
        activeTraceSide: 'reference',
      },
      {preserveLivePair: false},
    );

    expect(controller.getState()).toMatchObject({
      open: false,
      currentPane: 'second',
      referenceTrace: {id: 'history-b'},
      layout: 'vertical',
      splitPercent: 64,
      activeTraceSide: 'reference',
    });
  });

  it('preserves a live pair during non-authoritative panel restoration', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});

    controller.hydrateSessionPair(
      {
        scope: {
          key: 'tenant-a/workspace-a/backend-current',
          backendUrl: 'http://127.0.0.1:3000',
        },
        currentTrace: {
          id: 'backend-current',
          filename: 'current.pftrace',
        },
        referenceTrace: {
          id: 'history-b',
          filename: 'history-b.pftrace',
        },
        currentPane: 'second',
        layout: 'vertical',
      },
      {preserveLivePair: true},
    );

    expect(controller.getState()).toMatchObject({
      open: true,
      currentPane: 'first',
      referenceTrace: {id: 'history-a'},
      layout: 'horizontal',
    });
  });

  it('atomically replaces a live pair with an explicit single session', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});

    controller.hydrateSingleSession(
      {
        scope: {
          key: 'tenant-a/workspace-a/backend-current',
          backendUrl: 'http://127.0.0.1:3000',
        },
        currentTrace: {
          id: 'backend-current',
          filename: 'current.pftrace',
        },
      },
      {preserveLivePair: false},
    );

    expect(controller.getState()).toMatchObject({
      open: false,
      currentPane: 'first',
      referenceTrace: null,
      layout: 'horizontal',
      activeTraceSide: 'current',
    });
  });

  it('reconciles a legacy reference label from the canonical catalog', () => {
    controller.setCatalog([{id: 'history-a', filename: 'history-a'}]);
    controller.selectTrace({pane: 'second', traceId: 'history-a'});

    controller.setCatalog([
      {
        id: 'history-a',
        filename: 'history-a.pftrace',
        uploadedAt: '2026-07-10T07:00:00.000Z',
      },
    ]);

    expect(controller.getState().referenceTrace).toEqual({
      id: 'history-a',
      filename: 'history-a.pftrace',
      uploadedAt: '2026-07-10T07:00:00.000Z',
    });
  });

  it('rejects unknown trace ids', () => {
    expect(controller.selectTrace({pane: 'second', traceId: 'missing'})).toBe(
      false,
    );
    expect(controller.getState().referenceTrace).toBeNull();
  });

  it('locks semantic selection while analysis is running', () => {
    controller.setSelectionLocked(true);

    expect(controller.selectTrace({pane: 'second', traceId: 'history-a'})).toBe(
      false,
    );
    expect(controller.getState().referenceTrace).toBeNull();
  });

  it('preserves the semantic lock when the workspace is opened again', () => {
    const unopened = new TracePairWorkspaceController();
    unopened.setSelectionLocked(true);

    unopened.open({
      scope: {
        key: 'tenant-b/workspace-b/backend-other',
        backendUrl: 'http://127.0.0.1:4000',
      },
      currentTrace: {
        id: 'backend-other',
        filename: 'other.pftrace',
      },
    });
    unopened.setCatalog([{id: 'history-a', filename: 'history-a.pftrace'}]);

    expect(unopened.getState()).toMatchObject({
      open: true,
      selectionLocked: true,
      currentTrace: {id: 'backend-other'},
    });
    expect(unopened.selectTrace({pane: 'second', traceId: 'history-a'})).toBe(
      false,
    );
  });

  it('does not clear the semantic pair while selection is locked', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    controller.setSelectionLocked(true);

    controller.clearReference();

    expect(controller.getState().referenceTrace?.id).toBe('history-a');
  });

  it('reopens an existing pair without unlocking trace selection', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    controller.setSelectionLocked(true);
    controller.close();

    controller.open({
      scope: {
        key: 'tenant-a/workspace-a/backend-current',
        backendUrl: 'http://127.0.0.1:3000',
      },
      currentTrace: {
        id: 'backend-current',
        filename: 'current.pftrace',
      },
    });

    expect(controller.getState()).toMatchObject({
      open: true,
      selectionLocked: true,
      referenceTrace: {id: 'history-a'},
    });
    expect(controller.selectTrace({pane: 'second', traceId: 'history-b'})).toBe(
      false,
    );
  });

  it('restores a minimized pane without replacing the active trace role', () => {
    controller.selectTrace({pane: 'second', traceId: 'history-a'});
    controller.toggleMinimized('reference');
    expect(controller.getState().activeTraceSide).toBe('current');

    controller.toggleMinimized('reference');
    expect(controller.getState().activeTraceSide).toBe('reference');
  });

  it('drops stale catalog responses after the workspace scope resets', () => {
    const request = controller.beginCatalogLoad();
    controller.resetScope();

    expect(
      controller.completeCatalogLoad(request, [
        {id: 'stale', filename: 'stale.pftrace'},
      ]),
    ).toBe(false);
    expect(controller.getState().catalog).toEqual([]);
    expect(controller.getState().open).toBe(false);
  });
});
