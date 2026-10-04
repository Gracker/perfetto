// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const api = vi.hoisted(() => ({
  capability: vi.fn(), pick: vi.fn(), preview: vi.fn(), register: vi.fn(), reindex: vi.fn(),
  consent: vi.fn(), search: vi.fn(), remove: vi.fn(),
}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  getCodebaseDirectoryPickerCapability: api.capability,
  selectDirectory: api.pick,
  previewKnowledgeCollection: api.preview,
  registerKnowledgeCollection: api.register,
  reindexKnowledgeCollection: api.reindex,
  setKnowledgeBaseConsent: api.consent,
  searchKnowledgeCollection: api.search,
  deleteKnowledgeBase: api.remove,
}));

import {knowledgeBaseSelectable, type KnowledgeBaseSummary} from './codebase_api';
import {setSmartPerfettoWorkspaceId} from '../../core/smartperfetto_request_context';

/** Every request carries the request scope its operation pinned. */
const PINNED = expect.objectContaining({workspaceId: expect.any(String), tenantId: expect.any(String)});
import {KnowledgeBaseSection, type KnowledgeBaseSectionAttrs} from './knowledge_base_section';

const PICKED_ROOT = '/Users/someone/PRIVATE_ROOT_CANARY/docs';

function collectText(node: any): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return [node.text, node.children].map(collectText).join(' ');
}

function findButton(node: any, label: RegExp): any {
  if (!node) return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label);
      if (found) return found;
    }
    return undefined;
  }
  if (node.tag === 'button' && label.test(collectText(node))) return node;
  return findButton(node.children, label);
}

function collection(overrides: Partial<KnowledgeBaseSummary> = {}): KnowledgeBaseSummary {
  return {
    sourceId: 'kb-a', kind: 'document_collection', displayName: 'Handbook', rightsAcknowledged: true,
    sendToProvider: true, indexGeneration: 1, documentCount: 3, hasActiveIndex: true, ...overrides,
  };
}

function harness(sources: KnowledgeBaseSummary[] = []) {
  const section = new KnowledgeBaseSection() as any;
  const attrs: KnowledgeBaseSectionAttrs = {
    backendUrl: 'http://backend', scopeKey: 'scope', readOnly: false, sources, selectedIds: [],
    onChanged: vi.fn(async () => undefined), onAuthorizationChange: vi.fn(),
  };
  const view = () => section.view({attrs} as any);
  return {section, attrs, view};
}

beforeEach(() => {
  localStorage.clear();
  setSmartPerfettoWorkspaceId('workspace-a');
  for (const mock of Object.values(api)) mock.mockReset();
  api.capability.mockResolvedValue({available: true, platform: 'darwin', provider: 'macos'});
  vi.stubGlobal('window', {confirm: vi.fn(() => true)});
});

describe('knowledge base selectability', () => {
  it('requires an index, the rights acknowledgement and text consent', () => {
    expect(knowledgeBaseSelectable(collection())).toBe(true);
    expect(knowledgeBaseSelectable(collection({hasActiveIndex: false}))).toBe(false);
    expect(knowledgeBaseSelectable(collection({sendToProvider: false}))).toBe(false);
    expect(knowledgeBaseSelectable(collection({rightsAcknowledged: false}))).toBe(false);
    expect(knowledgeBaseSelectable(collection({lifecycleState: 'deleting'}))).toBe(false);
  });
});

describe('KnowledgeBaseSection registration', () => {
  it('picks, previews, registers with the selection id, indexes, and forgets the folder path', async () => {
    const {section, attrs, view} = harness();
    api.pick.mockResolvedValue({selected: true, rootPath: PICKED_ROOT, directorySelectionId: 'pick-1',
      displayNameSuggestion: 'docs', expiresAt: 1});
    api.preview.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12, skipped: {}});
    api.register.mockResolvedValue(collection({hasActiveIndex: false}));
    api.reindex.mockResolvedValue({documentCount: 4, chunkCount: 12});

    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    expect(api.pick).toHaveBeenCalledWith('http://backend', 'knowledge', undefined, PINNED);
    expect(api.preview).toHaveBeenCalledWith('http://backend', {rootPath: PICKED_ROOT, directorySelectionId: 'pick-1'}, undefined, PINNED);
    const formText = collectText(view());
    expect(formText).toMatch(/4 documents|4 个文档/);
    expect(formText).not.toContain('PRIVATE_ROOT_CANARY');
    // Registration waits for the rights acknowledgement.
    expect(findButton(view(), /Add and index|添加并建立索引/).attrs.disabled).toBe(true);
    section.form.rightsAcknowledged = true;
    section.form.sendToProvider = true;
    await findButton(view(), /Add and index|添加并建立索引/).attrs.onclick();

    expect(api.register).toHaveBeenCalledWith('http://backend', expect.objectContaining({
      rootPath: PICKED_ROOT, directorySelectionId: 'pick-1', rightsAcknowledged: true, sendToProvider: true,
    }), undefined, PINNED);
    expect(api.reindex).toHaveBeenCalledWith('http://backend', 'kb-a', undefined, PINNED);
    expect(attrs.onChanged).toHaveBeenCalled();
    expect(section.form).toBeNull();
    expect(collectText(view())).not.toContain('PRIVATE_ROOT_CANARY');
  });

  it('keeps a cancelled pick side-effect free', async () => {
    const {section, view} = harness();
    api.pick.mockResolvedValue({selected: false, cancelled: true});
    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    expect(api.preview).not.toHaveBeenCalled();
    expect(section.form).toBeNull();
  });

  it('refreshes after registration and keeps a source whose indexing failed, with Rebuild and Delete', async () => {
    const {section, attrs, view} = harness();
    api.pick.mockResolvedValue({selected: true, rootPath: PICKED_ROOT, directorySelectionId: 'pick-1',
      displayNameSuggestion: 'docs', expiresAt: 1});
    api.preview.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12, skipped: {}});
    api.register.mockResolvedValue(collection({hasActiveIndex: false, displayName: 'Docs'}));
    api.reindex.mockRejectedValue(new Error('index store unavailable'));
    const order: string[] = [];
    (attrs.onChanged as any).mockImplementation(async () => { order.push('refresh'); });
    api.reindex.mockImplementation(async () => { order.push('index'); throw new Error('index store unavailable'); });

    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    section.form.rightsAcknowledged = true;
    await findButton(view(), /Add and index|添加并建立索引/).attrs.onclick();

    // The list is refreshed before indexing, and again after it failed.
    expect(order).toEqual(['refresh', 'index', 'refresh']);
    expect(collectText(view())).toMatch(/Added Docs, but indexing failed: index store unavailable/);
    expect(section.form).toBeNull();
    expect(section.busy).toBeNull();
    // The registered source, as the refreshed list shows it, can be rebuilt or deleted in place.
    const listed = harness([collection({hasActiveIndex: false, displayName: 'Docs'})]).view();
    expect(findButton(listed, /Rebuild index|重建索引/).attrs.disabled).toBe(false);
    expect(findButton(listed, /^\s*Delete\s*$|^\s*删除\s*$/).attrs.disabled).toBe(false);
  });

  it('offers the typed path at once when the backend has no local picker', async () => {
    const {section, view} = harness();
    api.capability.mockResolvedValue({available: false, platform: 'linux', reason: 'remote_request'});
    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    expect(api.pick).not.toHaveBeenCalled();
    expect(section.manualPath).toBe('');
  });
});

describe('KnowledgeBaseSection typed path', () => {
  it('previews a typed backend path without a picker selection id', async () => {
    const {section, view} = harness();
    api.preview.mockResolvedValue({documentCount: 2, sectionCount: 2, chunkCount: 2, skipped: {}});
    findButton(view(), /Enter a backend path instead|改为输入后端路径/).attrs.onclick();
    section.manualPath = '/knowledge/handbook';
    await findButton(view(), /^\s*Preview\s*$|^\s*预览\s*$/).attrs.onclick();
    expect(api.preview).toHaveBeenCalledWith('http://backend', {rootPath: '/knowledge/handbook'}, undefined, PINNED);
    expect(section.form).toMatchObject({rootPath: '/knowledge/handbook', displayName: 'handbook'});
    expect(section.form.directorySelectionId).toBeUndefined();
  });
});

describe('KnowledgeBaseSection management', () => {
  it('restarts the session for a consent change but not for an index rebuild', async () => {
    const {attrs, view} = harness([collection()]);
    api.reindex.mockResolvedValue({documentCount: 3, chunkCount: 5});
    api.consent.mockResolvedValue(collection({sendToProvider: false}));

    await findButton(view(), /Rebuild index|重建索引/).attrs.onclick();
    expect(attrs.onAuthorizationChange).not.toHaveBeenCalled();
    await findButton(view(), /Revoke text|撤销正文授权/).attrs.onclick();
    expect(api.consent).toHaveBeenCalledWith('http://backend', 'kb-a', false, undefined, PINNED);
    expect(attrs.onAuthorizationChange).toHaveBeenCalledOnce();
  });

  it('asks before allowing text and leaves consent alone when declined', async () => {
    vi.stubGlobal('window', {confirm: vi.fn(() => false)});
    const {attrs, view} = harness([collection({sendToProvider: false})]);
    await findButton(view(), /Allow text|允许发送正文/).attrs.onclick();
    expect(api.consent).not.toHaveBeenCalled();
    expect(attrs.onAuthorizationChange).not.toHaveBeenCalled();
  });

  it('manages without selecting, marks the turn\'s choice, and tries a search', async () => {
    const {section, attrs, view} = harness([collection(), collection({sourceId: 'kb-b', hasActiveIndex: false})]);
    (attrs as any).selectedIds = ['kb-a'];
    const checkboxes: any[] = [];
    (function walk(node: any) {
      if (!node) return;
      if (Array.isArray(node)) return node.forEach(walk);
      if (node.tag === 'input' && node.attrs?.type === 'checkbox') checkboxes.push(node);
      walk(node.children);
    })(view());
    // Which knowledge a turn uses is chosen beside the input box.
    expect(checkboxes).toEqual([]);
    expect(collectText(view())).toMatch(/Used this turn/);

    api.search.mockResolvedValue([{chunkId: 'c1', relativePath: 'guide/a.md', title: 'Guide', heading: 'Intro',
      startLine: 3, endLine: 9, snippet: 'binder transactions'}]);
    findButton(view(), /Try a search|试搜索/).attrs.onclick();
    section.searchQuery = 'binder';
    await findButton(view(), /^\s*Search\s*$|^\s*搜索\s*$/).attrs.onclick();
    expect(api.search).toHaveBeenCalledWith('http://backend', 'kb-a', 'binder', undefined, PINNED);
    expect(collectText(view())).toMatch(/guide\/a\.md:L3-L9/);
  });
});

describe('KnowledgeBaseSection operations pinned to their scope', () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return {promise, resolve};
  }

  it('sends nothing more and writes no form when the scope switches while the picker is open', async () => {
    const {section, view} = harness();
    const picker = deferred<unknown>();
    api.pick.mockReturnValue(picker.promise);
    const choosing = findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    await vi.waitFor(() => expect(api.pick).toHaveBeenCalled());
    expect(api.pick).toHaveBeenCalledWith('http://backend', 'knowledge', undefined,
      expect.objectContaining({workspaceId: 'workspace-a'}));
    setSmartPerfettoWorkspaceId('workspace-b');
    picker.resolve({selected: true, rootPath: PICKED_ROOT, directorySelectionId: 'pick-1',
      displayNameSuggestion: 'docs', expiresAt: 1});
    await choosing;
    // The folder picked for workspace A is never previewed under workspace B.
    expect(api.preview).not.toHaveBeenCalled();
    expect(section.form).toBeNull();
  });

  it('does not index a registration whose scope switched during the list refresh', async () => {
    const {section, attrs, view} = harness();
    api.pick.mockResolvedValue({selected: true, rootPath: PICKED_ROOT, directorySelectionId: 'pick-1',
      displayNameSuggestion: 'docs', expiresAt: 1});
    api.preview.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12, skipped: {}});
    api.register.mockResolvedValue(collection({hasActiveIndex: false}));
    // Answered if ever asked, so a missed guard fails an assertion rather than throwing.
    api.reindex.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12});
    (attrs.onChanged as any).mockImplementation(async () => { setSmartPerfettoWorkspaceId('workspace-b'); });
    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    section.form.rightsAcknowledged = true;
    await findButton(view(), /Add and index|添加并建立索引/).attrs.onclick();
    expect(api.register).toHaveBeenCalledWith('http://backend', expect.anything(), undefined,
      expect.objectContaining({workspaceId: 'workspace-a'}));
    expect(api.reindex).not.toHaveBeenCalled();
  });

  it('does not start indexing after the view is removed', async () => {
    const {section, attrs, view} = harness();
    api.pick.mockResolvedValue({selected: true, rootPath: PICKED_ROOT, directorySelectionId: 'pick-1',
      displayNameSuggestion: 'docs', expiresAt: 1});
    api.preview.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12, skipped: {}});
    api.register.mockResolvedValue(collection({hasActiveIndex: false}));
    // Answered if ever asked, so a missed guard fails an assertion rather than throwing.
    api.reindex.mockResolvedValue({documentCount: 4, sectionCount: 9, chunkCount: 12});
    (attrs.onChanged as any).mockImplementation(async () => { section.onremove(); });
    await findButton(view(), /Add a folder|选择文件夹添加/).attrs.onclick();
    section.form.rightsAcknowledged = true;
    await findButton(view(), /Add and index|添加并建立索引/).attrs.onclick();
    expect(api.register).toHaveBeenCalledOnce();
    expect(api.reindex).not.toHaveBeenCalled();
  });

  it('writes and refreshes nothing for a rebuild answered after the view was removed', async () => {
    const {section, attrs, view} = harness([collection()]);
    const rebuilding = deferred<unknown>();
    api.reindex.mockReturnValue(rebuilding.promise);
    const pending = findButton(view(), /Rebuild index|重建索引/).attrs.onclick();
    await vi.waitFor(() => expect(api.reindex).toHaveBeenCalled());
    section.onremove();
    rebuilding.resolve({documentCount: 4, sectionCount: 9, chunkCount: 12});
    await pending;
    expect(section.success).toBeNull();
    expect(attrs.onChanged).not.toHaveBeenCalled();
  });

  it('writes nothing for a search answered after the identity changed', async () => {
    const {section, attrs, view} = harness([collection()]);
    const searching = deferred<unknown>();
    api.search.mockReturnValue(searching.promise);
    findButton(view(), /Try a search|试搜索/).attrs.onclick();
    section.searchQuery = 'binder';
    const pending = findButton(view(), /^\s*Search\s*$|^\s*搜索\s*$/).attrs.onclick();
    await vi.waitFor(() => expect(api.search).toHaveBeenCalled());
    section.onbeforeupdate({attrs: {...attrs, scopeKey: 'other-scope'}});
    searching.resolve([{chunkId: 'c', relativePath: 'a.md', title: 'A', heading: '', startLine: 1, endLine: 2, snippet: 'x'}]);
    await pending;
    expect(section.searchHits).toBeNull();
    expect(section.busy).toBeNull();
  });
});

