// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const apiMocks = vi.hoisted(() => ({register: vi.fn(), previewSelection: vi.fn(), updateSelection: vi.fn(),
  authorizeContent: vi.fn(), getCodebase: vi.fn()}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  registerCodebase: apiMocks.register,
  authorizeCodebaseContent: apiMocks.authorizeContent,
  getCodebase: apiMocks.getCodebase,
  previewCodebaseSelection: apiMocks.previewSelection,
  updateCodebaseSelection: apiMocks.updateSelection,
}));

beforeEach(() => {
  apiMocks.register.mockReset();
  apiMocks.previewSelection.mockReset();
  apiMocks.updateSelection.mockReset();
  apiMocks.authorizeContent.mockReset();
  apiMocks.getCodebase.mockReset();
});

import type {CodebaseFormAttrs} from './codebase_form';
import {
  buildCodebaseSelectionImpact,
  codebaseFieldRequirements,
  CodebaseForm,
} from './codebase_form';
import {CodebaseApiError, type CodebaseSummary} from './codebase_api';
import {ContentDisclosureReview} from './content_disclosure_review';

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
      providerGrantAffected: true,
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
    // The grant narrows when the new scope is provably inside it, and is revoked otherwise.
    expect(renderedText).toMatch(/grant narrows to it; otherwise saving revokes text sending|授权随之收窄到新范围；否则保存会撤销/);
    expect(renderedText).not.toMatch(/Authorize current scope|授权当前范围|may not match|可能与新范围不一致/);
    expect(renderedText).not.toMatch(/Source folder|源码文件夹|Accepted files|可接受文件/);
    expect(renderedText).not.toMatch(/does not rescan|不会重新扫描/);
    // A changed selection is saved only after it was previewed.
    expect(findNode(
      rendered,
      node => node.tag === 'button' && /Save selection|保存范围/.test(collectText(node)),
    )?.attrs.disabled).toBe(true);
    expect(findNode(
      rendered,
      node => node.tag === 'button' && /Preview scope|预览范围/.test(collectText(node)),
    )?.attrs.disabled).toBe(false);
  });

  it('keeps no-change edits and cancellation side-effect free', () => {
    const {form, attrs} = formHarness();
    const editing: CodebaseSummary = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      displayName: 'App',
      indexGeneration: 2,
      activeGeneration: 'generation-2',
      activeIndexState: 'active',
      eligibleForSendToProvider: true,
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
    // Nothing would change, so nothing about what saving does is shown.
    const renderedText = collectText(rendered);
    expect(renderedText).toMatch(/no selection changes|没有范围变化/);
    expect(renderedText).not.toMatch(/revision|修订|reindex|重建|grant|授权/i);
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

  it('discloses source transmission, retained quotations, and extra analysis time', () => {
    const rendered = collectText(formHarness().view());
    expect(rendered).toContain('configured AI service');
    expect(rendered).toContain('internal company service');
    expect(rendered).toContain('local history and exported reports');
    expect(rendered).toContain('configuration and policy');
    expect(rendered).toContain('increase analysis time');
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

  const unconsented: CodebaseSummary = {
    ...registered, eligibleForSendToProvider: false,
    contentDisclosure: {token: 'disclosure-of-new-source', includePrefixes: [], excludeGlobs: ['private/**'],
      extensions: ['.kt', '.java']},
  };

  it.each([
    ['off', true], ['provider_send', true], ['metadata_only', true], ['provider_send', false],
  ] as const)('never asks registration for body consent (%s / use=%s)', async (mode, use) => {
    const {form, attrs} = formHarness();
    attrs.codeAwareMode = mode;
    form.rootPath = '/source/app';
    form.excludeGlobs = 'private/**, **/secrets/**';
    apiMocks.register.mockResolvedValue({codebase: unconsented});
    await form.register(attrs, use);
    expect(apiMocks.register).toHaveBeenCalledWith('http://backend', expect.objectContaining({
      sendToProvider: false,
      excludeGlobs: ['private/**', '**/secrets/**'],
    }), 'key');
  });

  it.each([['metadata_only', true], ['provider_send', false]] as const)(
    'completes at once when no source text is wanted (%s / use=%s)', async (mode, use) => {
      const {form, attrs} = formHarness();
      attrs.codeAwareMode = mode;
      form.rootPath = '/source/app';
      apiMocks.register.mockResolvedValue({codebase: unconsented});
      await form.register(attrs, use);
      expect(attrs.onRegistered).toHaveBeenCalledWith(unconsented, use);
      expect(form.pendingGrant).toBeNull();
    });

  async function addAndUse() {
    const {form, attrs} = formHarness();
    attrs.codeAwareMode = 'off';
    form.rootPath = '/source/app';
    apiMocks.register.mockResolvedValue({codebase: unconsented});
    await form.register(attrs, true);
    const reviewVnode = findNode(form.view({attrs} as any),
      node => node.attrs?.codebase?.codebaseId === 'new-source' && typeof node.attrs?.onGranted === 'function');
    // Registration alone selects nothing for text: the disclosure review comes first.
    expect(attrs.onRegistered).not.toHaveBeenCalled();
    expect(reviewVnode).toBeDefined();
    const review = new ContentDisclosureReview() as any;
    review.oninit({attrs: reviewVnode.attrs});
    const button = (label: RegExp) => findNode(review.view({attrs: reviewVnode.attrs}),
      (node: any) => node.tag === 'button' && label.test(collectText(node)));
    return {form, attrs, review, reviewVnode, button};
  }

  it('shows the returned disclosure and grants only that snapshot\'s token before selecting text', async () => {
    const {attrs, review, reviewVnode, button} = await addAndUse();
    // Nothing is selected for analysis until the disclosure is confirmed.
    expect(attrs.onRegistered).not.toHaveBeenCalled();
    const shown = collectText(review.view({attrs: reviewVnode.attrs}));
    expect(shown).toMatch(/private\/\*\*/);
    expect(shown).toMatch(/\.kt, \.java/);
    const granted = {...unconsented, eligibleForSendToProvider: true};
    apiMocks.authorizeContent.mockResolvedValue(granted);
    await button(/^\s*Allow\s*$|确认允许/).attrs.onclick();
    expect(apiMocks.authorizeContent).toHaveBeenCalledWith('http://backend', 'new-source', 'disclosure-of-new-source', 'key');
    expect(attrs.onRegistered).toHaveBeenCalledWith(granted, true);
  });

  it('adds without using it when the disclosure is declined', async () => {
    const {attrs, button} = await addAndUse();
    button(/Cancel|取消/).attrs.onclick();
    expect(apiMocks.authorizeContent).not.toHaveBeenCalled();
    expect(attrs.onRegistered).toHaveBeenCalledWith(unconsented, false);
  });

  it('re-shows a changed disclosure after a stale refusal and never selects text on its own', async () => {
    const {attrs, review, reviewVnode, button} = await addAndUse();
    apiMocks.authorizeContent.mockRejectedValueOnce(
      new CodebaseApiError('stale', 'CODEBASE_CONSENT_DISCLOSURE_STALE', undefined, 409));
    apiMocks.getCodebase.mockResolvedValue({...unconsented, contentDisclosure: {
      token: 'disclosure-fresh', includePrefixes: ['app'], excludeGlobs: [], extensions: ['.kt']}});
    await button(/^\s*Allow\s*$|确认允许/).attrs.onclick();
    expect(apiMocks.authorizeContent).toHaveBeenCalledOnce();
    expect(attrs.onRegistered).not.toHaveBeenCalled();
    expect(collectText(review.view({attrs: reviewVnode.attrs}))).toMatch(/updated; confirm again/);
    apiMocks.authorizeContent.mockResolvedValue({...unconsented, eligibleForSendToProvider: true});
    await button(/^\s*Allow\s*$|确认允许/).attrs.onclick();
    expect(apiMocks.authorizeContent).toHaveBeenLastCalledWith('http://backend', 'new-source', 'disclosure-fresh', 'key');
    expect(attrs.onRegistered).toHaveBeenCalledWith(expect.objectContaining({eligibleForSendToProvider: true}), true);
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

describe('CodebaseForm selection preview', () => {
  const editing: CodebaseSummary = {
    codebaseId: 'codebase-a', kind: 'app_source', displayName: 'App', indexGeneration: 2,
    selectionPolicyRevision: 3, pathFilters: ['src'], excludeGlobs: [],
  };
  function editor() {
    const {form, attrs} = formHarness();
    const onUpdated = vi.fn();
    const editAttrs = {...attrs, codebase: editing, onUpdated};
    form.onbeforeupdate({attrs: editAttrs} as any);
    const button = (label: RegExp) => findNode(form.view({attrs: editAttrs} as any),
      node => node.tag === 'button' && label.test(collectText(node)));
    return {form, editAttrs, onUpdated, save: () => button(/Save selection|保存范围/),
      text: () => collectText(form.view({attrs: editAttrs} as any))};
  }
  const result = (status: 'complete' | 'partial' | 'unavailable', count?: number, extra: object = {}) => ({
    status, selectionPolicyRevision: 3,
    ...(count === undefined ? {} : {preview: {acceptedFileCount: count}}), ...extra,
  });

  it('ignores a preview answered for an earlier edit, and an edit voids a finished preview', async () => {
    const {form, editAttrs, save, text} = editor();
    let resolve!: (value: unknown) => void;
    apiMocks.previewSelection.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    form.pathFilters = 'src\nlib';
    const pending = form.previewSelection(editAttrs);
    form.pathFilters = 'src\napp';
    resolve(result('complete', 9));
    await pending;
    expect(text()).not.toMatch(/9/);
    expect(save().attrs.disabled).toBe(true);

    apiMocks.previewSelection.mockResolvedValueOnce(result('complete', 7));
    await form.previewSelection(editAttrs);
    expect(text()).toMatch(/7/);
    expect(save().attrs.disabled).toBe(false);
    form.excludeGlobs = '**/test/**';
    expect(text()).not.toMatch(/contains 7|包含 7/);
    expect(save().attrs.disabled).toBe(true);
  });

  it('does not let a late answer for an earlier edit replace the current preview', async () => {
    const {form, editAttrs, save, text} = editor();
    let resolveFirst!: (value: unknown) => void;
    apiMocks.previewSelection
      .mockImplementationOnce(() => new Promise(done => { resolveFirst = done; }))
      .mockResolvedValueOnce(result('complete', 5));
    form.pathFilters = 'lib';
    const first = form.previewSelection(editAttrs);
    form.pathFilters = 'app';
    await form.previewSelection(editAttrs);
    resolveFirst(result('complete', 99));
    await first;
    expect(text()).toMatch(/contains 5|包含 5/);
    expect(text()).not.toMatch(/99/);
    expect(save().attrs.disabled).toBe(false);
  });

  it('saves exactly the previewed snapshot at the previewed revision', async () => {
    const {form, editAttrs, onUpdated, save} = editor();
    apiMocks.previewSelection.mockResolvedValueOnce(result('partial', 40, {selectionPolicyRevision: 5}));
    apiMocks.updateSelection.mockResolvedValueOnce({...editing, selectionPolicyRevision: 6});
    form.pathFilters = 'lib\nsrc';
    await form.previewSelection(editAttrs);
    await save().attrs.onclick();
    expect(apiMocks.updateSelection).toHaveBeenCalledWith('http://backend', 'codebase-a',
      {pathFilters: ['lib', 'src'], excludeGlobs: [], expectedSelectionPolicyRevision: 5}, 'key');
    expect(onUpdated).toHaveBeenCalledOnce();
  });

  it('reads complete as exact, partial as a lower bound and unavailable as not zero', async () => {
    const {form, editAttrs, save, text} = editor();
    form.pathFilters = 'none';
    apiMocks.previewSelection.mockResolvedValueOnce(result('complete', 0));
    await form.previewSelection(editAttrs);
    expect(text()).toMatch(/cannot be saved|不能保存/);
    expect(save().attrs.disabled).toBe(true);

    form.pathFilters = 'big';
    apiMocks.previewSelection.mockResolvedValueOnce(result('partial', 120));
    await form.previewSelection(editAttrs);
    expect(text()).toMatch(/At least 120|至少 120/);

    form.pathFilters = 'gone';
    apiMocks.previewSelection.mockResolvedValueOnce(result('unavailable', undefined, {unavailableReason: 'root_missing'}));
    await form.previewSelection(editAttrs);
    expect(text()).toMatch(/does not mean zero files|不表示零个文件/);
    expect(save().attrs.disabled).toBe(false);
  });

  it.each([
    ['CODEBASE_SELECTION_STALE', /Preview again|重新预览/, true],
    ['CODEBASE_SELECTION_EMPTY_MATCH', /nothing was saved|未保存/, false],
    ['CODEBASE_SELECTION_UNCHANGED', /unchanged|没有变化/, false],
  ])('handles %s without reporting an update', async (code, message, clearsPreview) => {
    const {form, editAttrs, onUpdated, save, text} = editor();
    form.pathFilters = 'lib';
    apiMocks.previewSelection.mockResolvedValueOnce(result('complete', 3));
    apiMocks.updateSelection.mockRejectedValueOnce(new CodebaseApiError('refused', code, undefined, 409));
    await form.previewSelection(editAttrs);
    await save().attrs.onclick();
    expect(onUpdated).not.toHaveBeenCalled();
    expect(text()).toMatch(message);
    expect(save().attrs.disabled).toBe(clearsPreview);
  });
});
