// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';

import type {CodebaseFormAttrs} from './codebase_form';
import {
  codebaseFieldRequirements,
  CodebaseForm,
} from './codebase_form';

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
      node => node.tag === 'button' && collectText(node) === 'Register',
    )?.attrs.disabled).toBe(true);

    form.vendor = 'qualcomm';
    form.pathFilters = 'kernel/, drivers/';
    rendered = view();
    expect(findNode(
      rendered,
      node => node.tag === 'button' && collectText(node) === 'Register',
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
