// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const apiMocks = vi.hoisted(() => ({register: vi.fn()}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  registerCodebase: apiMocks.register,
}));

beforeEach(() => {
  apiMocks.register.mockReset();
});

import type {CodebaseFormAttrs} from './codebase_form';
import {
  buildCodebaseSelectionImpact,
  codebaseFieldRequirements,
  CodebaseForm,
} from './codebase_form';
import type {CodebaseSummary} from './codebase_api';

function collectText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return collectText(node.children);
}

function findNode(node: any, predicate: (candidate: any) => boolean): any {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  return findNode(node.children, predicate);
}

function formHarness(): {
  form: any;
  attrs: CodebaseFormAttrs;
  view: () => any;
} {
  const attrs: CodebaseFormAttrs = {
    backendUrl: 'http://backend',
    apiKey: 'key',
    scopeKey: 'scope-a',
    onRegistered: vi.fn(),
    onCancel: vi.fn(),
  };
  const form = new CodebaseForm() as any;
  form.mounted = true;
  form.backendUrl = attrs.backendUrl;
  form.apiKey = attrs.apiKey;
  form.scopeKey = attrs.scopeKey;
  form.directoryPickerCapability = {
    available: true,
    platform: 'darwin',
    provider: 'macos',
  };
  return {
    form,
    attrs,
    view: () => form.view({attrs} as any),
  };
}

describe('codebase registration field requirements', () => {
  it('matches each source ingester contract', () => {
    expect(codebaseFieldRequirements('app_source')).toEqual({
      vendor: false,
      licenseTag: false,
      pathFilters: false,
    });
    expect(codebaseFieldRequirements('aosp')).toEqual({
      vendor: false,
      licenseTag: true,
      pathFilters: false,
    });
    expect(codebaseFieldRequirements('kernel_source')).toEqual({
      vendor: true,
      licenseTag: false,
      pathFilters: true,
    });
    expect(codebaseFieldRequirements('oem_sdk')).toEqual({
      vendor: true,
      licenseTag: true,
      pathFilters: false,
    });
  });
});

describe('CodebaseForm', () => {
  it('builds a deterministic replacement impact without inventing file counts', () => {
    const registered: CodebaseSummary = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      displayName: 'App',
      indexGeneration: 3,
      activeGeneration: 'generation-3',
      activeIndexState: 'active',
      selectionPolicyRevision: 7,
      grantRevision: 4,
      eligibleForSendToProvider: true,
      providerGrantScopeCurrent: true,
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    };

    const impact = buildCodebaseSelectionImpact(
      registered,
      'lib\nsrc\nlib',
      '**/fixtures/**\n**/generated/**',
    );

    expect(impact).toEqual({
      changed: true,
      previous: {
        pathFilters: ['src'],
        excludeGlobs: ['**/generated/**'],
      },
      replacement: {
        pathFilters: ['lib', 'src'],
        excludeGlobs: ['**/fixtures/**', '**/generated/**'],
      },
      selectionPolicyRevision: {current: 7, next: 8},
      invalidatesActiveIndex: true,
      providerGrantMayMismatch: true,
    });
    expect(JSON.stringify(impact)).not.toMatch(/fileCount|acceptedFile|rootPath/);
  });

  it('renders registered selection editing without asking for the undisclosed root', () => {
    const {form, attrs} = formHarness();
    const editing: CodebaseSummary = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      displayName: 'App',
      indexGeneration: 2,
      activeGeneration: 'generation-2',
      activeIndexState: 'active',
      selectionPolicyRevision: 3,
      grantRevision: 1,
      eligibleForSendToProvider: true,
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    };
    const editAttrs = {
      ...attrs,
      codebase: editing,
      onUpdated: vi.fn(),
    };
    form.onbeforeupdate({attrs: editAttrs} as any);
    form.pathFilters = 'src\nlib';

    const rendered = form.view({attrs: editAttrs} as any);
    const renderedText = collectText(rendered);

    expect(renderedText).toMatch(/src.*lib/s);
    expect(renderedText).toMatch(/revision.*3.*4|修订.*3.*4/is);
    expect(renderedText).toMatch(/reindex|重建/i);
    expect(renderedText).toMatch(/provider.*authoriz|provider.*授权/i);
    expect(renderedText).not.toMatch(/Source folder|源码文件夹|Accepted files|可接受文件/);
    expect(findNode(
      rendered,
      node => node.tag === 'button' && /Save selection|保存范围/.test(collectText(node)),
    )?.attrs.disabled).toBe(false);
  });

  it('keeps no-change edits and cancellation side-effect free', () => {
    const {form, attrs} = formHarness();
    const editing: CodebaseSummary = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      displayName: 'App',
      indexGeneration: 2,
      selectionPolicyRevision: 2,
      pathFilters: ['src'],
      excludeGlobs: ['**/generated/**'],
    };
    const onUpdated = vi.fn();
    const onCancel = vi.fn();
    const editAttrs = {...attrs, codebase: editing, onUpdated, onCancel};
    form.onbeforeupdate({attrs: editAttrs} as any);

    const rendered = form.view({attrs: editAttrs} as any);
    const save = findNode(
      rendered,
      node => node.tag === 'button' && /Save selection|保存范围/.test(collectText(node)),
    );
    const cancel = findNode(
      rendered,
      node => node.tag === 'button' && /Cancel|取消/.test(collectText(node)),
    );

    expect(save.attrs.disabled).toBe(true);
    cancel.attrs.onclick();
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('makes folder selection primary and removes redundant commit input', () => {
    const {view} = formHarness();
    const rendered = view();
    const chooseButton = findNode(
      rendered,
      node => node.tag === 'button' && collectText(node).includes('Choose folder'),
    );

    expect(chooseButton).toBeDefined();
    expect(chooseButton.attrs.disabled).toBe(false);
    expect(findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-root-path',
    )?.attrs['aria-required']).toBe('true');
    expect(collectText(rendered)).toContain('Display name (Optional)');
    expect(collectText(rendered)).not.toContain('Commit');
    expect(findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-vendor',
    )).toBeUndefined();
  });

  it('shows conditional required metadata and blocks incomplete kernel registration', () => {
    const {form, view} = formHarness();
    form.kind = 'kernel_source';
    form.rootPath = '/source/kernel';
    let rendered = view();

    expect(findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-vendor',
    )?.attrs.required).toBe(true);
    expect(findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-path-filters',
    )?.attrs.required).toBe(true);
    expect(findNode(
      rendered,
      node => node.tag === 'button' && collectText(node) === 'Add and use for analysis',
    )?.attrs.disabled).toBe(true);

    form.vendor = 'qualcomm';
    form.pathFilters = 'kernel/, drivers/';
    rendered = view();
    expect(findNode(
      rendered,
      node => node.tag === 'button' && collectText(node) === 'Add and use for analysis',
    )?.attrs.disabled).toBe(false);
  });

  it('clears picker authorization when the path or backend binding changes', () => {
    const {form, attrs, view} = formHarness();
    form.rootPath = '/selected/source';
    form.directorySelectionId = 'selection-a';
    form.displayName = 'source';
    form.displayNameWasSuggested = true;
    const rendered = view();
    const pathInput = findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-root-path',
    );

    pathInput.attrs.oninput({target: {value: '/manual/source'}});
    expect(form.directorySelectionId).toBeNull();
    expect(form.rootPath).toBe('/manual/source');
    expect(form.displayName).toBe('');
    expect(form.displayNameWasSuggested).toBe(false);

    form.directorySelectionId = 'selection-b';
    form.onbeforeupdate({
      attrs: {...attrs, scopeKey: 'scope-b'},
    } as any);
    expect(form.directorySelectionId).toBeNull();
    expect(form.rootPath).toBe('');
    expect(form.displayName).toBe('');
  });

  it('clears stale preview results when a suggested scope is applied', () => {
    const {form} = formHarness();
    form.preview = {
      blocked: false,
      acceptedFileCount: 10,
      skippedFileCount: 0,
      acceptedFiles: [],
      skippedFiles: [],
    };

    form.applySuggestedPathFilters('frameworks/base');

    expect(form.pathFilters).toBe('frameworks/base');
    expect(form.preview).toBeNull();
    expect(form.scopeApplicationNotice).toMatch(/frameworks\/base/);
    expect(collectText(form.view({attrs: formHarness().attrs} as any))).toMatch(/Preview again|重新预览/);

    const rendered = form.view({attrs: formHarness().attrs} as any);
    const pathFilters = findNode(
      rendered,
      node => node.attrs?.id === 'smartperfetto-codebase-path-filters',
    );
    pathFilters.attrs.oninput({target: {value: 'frameworks/native'}});
    expect(form.scopeApplicationNotice).toBeNull();
  });

  it('keeps enumeration results visible when optional manifest metadata is unavailable', () => {
    const {form, view} = formHarness();
    form.preview = {
      blocked: false,
      complete: true,
      acceptedFileCount: 12,
      skippedFileCount: 0,
      manifestUnavailableReason: 'source_metadata_too_large',
      acceptedFiles: [],
      skippedFiles: [],
    };

    const renderedText = collectText(view());

    expect(renderedText).toMatch(/12/);
    expect(renderedText).toMatch(/manifest.*unavailable|manifest.*不可用/i);
    expect(renderedText).toMatch(/source_metadata_too_large/);
  });
});


describe('explicit registration consent', () => {
  const registered: CodebaseSummary = {
    codebaseId: 'new-source', kind: 'app_source', displayName: 'App',
    rootAvailable: true, indexGeneration: 0, eligibleForSendToProvider: true,
  };

  it.each([
    ['off', true, true],
    ['provider_send', true, true],
    ['metadata_only', true, false],
    ['provider_send', false, false],
  ] as const)('binds %s / use=%s to explicit body consent', async (mode, use, consent) => {
    const {form, attrs} = formHarness();
    attrs.codeAwareMode = mode;
    form.rootPath = '/source/app';
    form.excludeGlobs = 'private/**, **/secrets/**';
    apiMocks.register.mockResolvedValue({codebase: registered});
    await form.register(attrs, use);
    expect(apiMocks.register).toHaveBeenCalledWith('http://backend', expect.objectContaining({
      sendToProvider: consent,
      excludeGlobs: ['private/**', '**/secrets/**'],
    }), 'key');
    expect(attrs.onRegistered).toHaveBeenCalledWith(registered, use);
  });

  it('keeps source kind and metadata in advanced settings and exclusions in the main flow', () => {
    const {attrs, view} = formHarness();
    attrs.codeAwareMode = 'metadata_only';
    const rendered = view();
    const advanced = findNode(rendered, node => node.tag === 'details');
    expect(findNode(advanced, node => node.attrs?.id === 'smartperfetto-codebase-kind')).toBeDefined();
    expect(findNode(advanced, node => node.attrs?.id === 'smartperfetto-codebase-exclude-globs')).toBeUndefined();
    expect(collectText(rendered)).toContain('without granting source-text access');
    expect(collectText(rendered)).toContain('Add for locate-only analysis');
    expect(collectText(rendered)).not.toContain('Index path scope');
  });

  it('does not register twice after success even if the consumer cannot refresh', async () => {
    const {form, attrs} = formHarness();
    form.rootPath = '/source/app';
    apiMocks.register.mockResolvedValue({codebase: registered});
    attrs.onRegistered = vi.fn(() => { throw new Error('refresh failed'); });
    await form.register(attrs, true);
    await form.register(attrs, true);
    expect(apiMocks.register).toHaveBeenCalledOnce();
    expect(form.registeredCodebase).toEqual(registered);
  });

  it('keeps the completion callback bound to the original click and ignores backend changes', async () => {
    const {form, attrs} = formHarness();
    form.rootPath = '/source/app';
    let resolve!: (value: unknown) => void;
    apiMocks.register.mockImplementation(() => new Promise(done => { resolve = done; }));
    const pending = form.register(attrs, true);
    const replaced = {...attrs, scopeKey: 'different-workspace', onRegistered: vi.fn()};
    form.onbeforeupdate({attrs: replaced});
    resolve({codebase: registered});
    await pending;
    expect(attrs.onRegistered).not.toHaveBeenCalled();
    expect(replaced.onRegistered).not.toHaveBeenCalled();
    expect(form.registeredCodebase).toBeNull();
  });

  it('prevents programmatic registration when the form becomes read-only', async () => {
    const {form, attrs} = formHarness();
    attrs.readOnly = true;
    form.rootPath = '/source/app';
    await form.register(attrs, true);
    expect(apiMocks.register).not.toHaveBeenCalled();
  });
});
