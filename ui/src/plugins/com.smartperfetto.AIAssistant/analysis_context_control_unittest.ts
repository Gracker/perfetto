// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it, vi} from 'vitest';

const api = vi.hoisted(() => ({listCodebases: vi.fn(), listKnowledgeBases: vi.fn(), listWiki: vi.fn()}));
vi.mock('./codebase_api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codebase_api')>(),
  listCodebases: api.listCodebases,
  listKnowledgeBases: api.listKnowledgeBases,
  listExternalKnowledgeSources: api.listWiki,
}));

import {
  AnalysisContextControl,
  analysisContextAllOff,
  analysisContextDestinationLines,
  analysisContextSummary,
  type AnalysisContextControlAttrs,
} from './analysis_context_control';
import {analysisCatalog, AnalysisCatalog} from './analysis_catalog';
import {analysisContextWithSourceMode} from './analysis_context';
import type {CodebaseSummary} from './codebase_api';
import {setUiLanguagePreference} from './ui_language';
import type {AnalysisContextSelection} from './types';

function codebase(overrides: Partial<CodebaseSummary> = {}): CodebaseSummary {
  return {codebaseId: 'cb-a', kind: 'app_source', displayName: 'Launcher', indexGeneration: 1,
    rootAvailable: true, eligibleForSendToProvider: true, ...overrides};
}

function collectText(node: any): string {
  if (node === null || node === undefined || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return [node.text, node.children].map(collectText).join(' ');
}

function findAll(node: any, predicate: (candidate: any) => boolean, found: any[] = []): any[] {
  if (!node) return found;
  if (Array.isArray(node)) {
    node.forEach(child => findAll(child, predicate, found));
    return found;
  }
  if (predicate(node)) found.push(node);
  return findAll(node.children, predicate, found);
}

beforeEach(() => {
  api.listWiki.mockReset().mockResolvedValue([]);
  api.listCodebases.mockReset().mockResolvedValue({featureEnabled: true, codebases: [
    codebase(), codebase({codebaseId: 'cb-b', displayName: 'Locked', eligibleForSendToProvider: false}),
    codebase({codebaseId: 'cb-c', displayName: 'Gone', rootAvailable: false, unavailableReason: 'root_missing'}),
  ]});
  api.listKnowledgeBases.mockReset().mockResolvedValue([
    {sourceId: 'kb-a', kind: 'document_collection', displayName: 'Handbook', rightsAcknowledged: true,
      sendToProvider: true, indexGeneration: 1, documentCount: 3, hasActiveIndex: true},
    {sourceId: 'kb-b', kind: 'document_collection', displayName: 'Unindexed', rightsAcknowledged: true,
      sendToProvider: true, indexGeneration: 0, documentCount: 3, hasActiveIndex: false},
  ]);
});

describe('analysis context selection helpers', () => {
  const selection: AnalysisContextSelection = {
    codeAwareMode: 'metadata_only', codebaseIds: ['cb-a', 'cb-b'], knowledgeSourceIds: ['kb-a'], sourceDepth: 'locate',
  };

  it('keeps only text-allowed codebases when switching to sending text', () => {
    const codebases = [codebase(), codebase({codebaseId: 'cb-b', eligibleForSendToProvider: false})];
    expect(analysisContextWithSourceMode(selection, 'provider_send', codebases).codebaseIds).toEqual(['cb-a']);
    expect(analysisContextWithSourceMode(selection, 'off', codebases)).toMatchObject({
      codeAwareMode: 'off', codebaseIds: ['cb-a', 'cb-b'], knowledgeSourceIds: ['kb-a'], sourceDepth: 'locate'});
  });

  it('turns all off by also clearing knowledge, which the source mode does not cover', () => {
    expect(analysisContextAllOff(selection)).toEqual({
      codeAwareMode: 'off', codebaseIds: ['cb-a', 'cb-b'], knowledgeSourceIds: [], sourceDepth: 'locate'});
  });

  it('names where each kind of material goes', () => {
    expect(analysisContextDestinationLines(selection, 'Acme AI')).toEqual([
      'Only source positions (files, symbols, lines) go to Acme AI; no source text.',
      'Matching knowledge passages are sent to Acme AI.',
    ]);
    expect(analysisContextDestinationLines({...selection, codeAwareMode: 'provider_send'}, undefined)[0])
      .toBe('Relevant source text passages are sent to the configured AI service.');
    // Source off does not hide that knowledge text is still sent.
    expect(analysisContextDestinationLines({...selection, codeAwareMode: 'off'}, 'Acme AI'))
      .toEqual(['Matching knowledge passages are sent to Acme AI.']);
    expect(analysisContextDestinationLines(analysisContextAllOff(selection), 'Acme AI'))
      .toEqual(['This turn uses no source or knowledge.']);
  });

  it('spaces a provider name in Chinese lines but not the fallback phrase', () => {
    setUiLanguagePreference('zh-CN');
    try {
      expect(analysisContextDestinationLines({...selection, codeAwareMode: 'provider_send'}, undefined)).toEqual([
        '相关源码正文片段会发送给当前配置的 AI 服务。',
        '命中的知识库正文片段会发送给当前配置的 AI 服务。',
      ]);
      expect(analysisContextDestinationLines(selection, 'Acme AI')).toEqual([
        '源码只发送位置（文件、符号、行号）给 Acme AI，不发送正文。',
        '命中的知识库正文片段会发送给 Acme AI。',
      ]);
    } finally {
      setUiLanguagePreference('auto');
    }
  });

  it('summarizes the submitted context with names, mode, depth and knowledge count', () => {
    expect(analysisContextSummary(undefined)).toBe('Context: off');
    expect(analysisContextSummary({codeAwareMode: 'provider_send', codebaseLabels: ['Launcher'],
      knowledgeSourceCount: 2, sourceDepth: 'mechanism'}))
      .toBe('Source Launcher (text) · Full analysis · 2 knowledge base(s)');
    expect(analysisContextSummary({codeAwareMode: 'metadata_only', codebaseLabels: ['a', 'b', 'c'],
      knowledgeSourceCount: 0, sourceDepth: 'auto'})).toBe('Source 3 codebases (locate)');
  });
});

describe('AnalysisContextControl popover', () => {
  async function opened(overrides: Partial<AnalysisContextControlAttrs> = {}) {
    const control = new AnalysisContextControl() as any;
    const attrs: AnalysisContextControlAttrs = {
      backendUrl: 'http://backend', scopeKey: 'tenant\0workspace-a\0user', disabled: false, providerName: 'Acme AI',
      selection: {codeAwareMode: 'provider_send', codebaseIds: ['cb-a'], knowledgeSourceIds: [], sourceDepth: 'auto'},
      onChange: vi.fn(), onManage: vi.fn(), ...overrides,
    };
    const trigger = findAll(control.view({attrs}), node => node.tag === 'button')[0];
    trigger.attrs.onclick({preventDefault() {}, stopPropagation() {}});
    await vi.waitFor(() => expect(analysisCatalog.read(attrs).status).toBe('ready'));
    return {control, attrs, view: () => control.view({attrs})};
  }

  it('lists codebases with their status and blocks the ones the mode cannot use', async () => {
    const {view} = await opened();
    const tree = view();
    const text = collectText(tree);
    expect(text).toMatch(/Text not allowed; locate only/);
    expect(text).toMatch(/missing or was moved/);
    const boxes = findAll(tree, node => node.tag === 'input' && node.attrs?.type === 'checkbox');
    // cb-a, cb-b (no text consent), cb-c (root gone), kb-a, kb-b (not indexed)
    expect(boxes.map(box => box.attrs.disabled)).toEqual([false, true, true, false, true]);
    expect(text).toContain('Relevant source text passages are sent to Acme AI.');
  });

  it('changes depth without touching the selection and turns all off in one step', async () => {
    const {attrs, view} = await opened();
    const radios = findAll(view(), node => node.tag === 'input' && node.attrs?.type === 'radio');
    // three source modes, then three depths
    radios[5].attrs.onchange();
    expect(attrs.onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      codeAwareMode: 'provider_send', codebaseIds: ['cb-a'], sourceDepth: 'mechanism'}));
    const allOff = findAll(view(), node => node.tag === 'button' && /Turn all off/.test(collectText(node)))[0];
    allOff.attrs.onclick();
    expect(attrs.onChange).toHaveBeenLastCalledWith(expect.objectContaining({codeAwareMode: 'off', knowledgeSourceIds: []}));
  });

  it('names the whole context on the trigger, which may show only its icon', async () => {
    const {view} = await opened({selection: {codeAwareMode: 'provider_send', codebaseIds: ['cb-a'],
      knowledgeSourceIds: [], sourceDepth: 'auto'}});
    const trigger = findAll(view(), node => node.tag === 'button')[0];
    const summary = 'Source Launcher (text)';
    expect(trigger.attrs['aria-label']).toBe(`Source and knowledge used by this turn: ${summary}`);
    expect(trigger.attrs.title).toBe(trigger.attrs['aria-label']);
    const classes = (node: any) => String(node.attrs.className ?? node.attrs.class ?? '').split(/\s+/);
    expect(classes(trigger)).toContain('active');
    const off = new AnalysisContextControl() as any;
    const offTrigger = findAll(off.view({attrs: {backendUrl: 'http://backend', scopeKey: 'tenant\0workspace-a\0user',
      disabled: false, selection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: [], sourceDepth: 'auto'},
      onChange: vi.fn(), onManage: vi.fn()}}), node => node.tag === 'button')[0];
    expect(offTrigger.attrs['aria-label']).toBe('Source and knowledge used by this turn: Context: off');
    expect(classes(offTrigger)).not.toContain('active');
  });

  it('closes on Esc, returns focus to the trigger and stops listening', async () => {
    const {control, view} = await opened();
    const host = document.createElement('div');
    const trigger = document.createElement('button');
    const radio = document.createElement('input');
    host.append(trigger, radio);
    document.body.append(host);
    control.trigger = trigger;
    radio.focus();
    const listeners = {click: control.outsideClick, keydown: control.escapeKey};
    const removed = vi.spyOn(document, 'removeEventListener');
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter'}));
      expect(findAll(view(), node => node.attrs?.role === 'dialog')).toHaveLength(1);
      document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape'}));
      expect(findAll(view(), node => node.attrs?.role === 'dialog')).toHaveLength(0);
      expect(document.activeElement).toBe(trigger);
      expect(removed).toHaveBeenCalledWith('click', listeners.click, true);
      expect(removed).toHaveBeenCalledWith('keydown', listeners.keydown);
      expect(control.escapeKey).toBeNull();
    } finally {
      removed.mockRestore();
      host.remove();
    }
  });

  it('is read-only while a run is active and still offers Manage', async () => {
    const {attrs, view} = await opened({disabled: true});
    const inputs = findAll(view(), node => node.tag === 'input');
    expect(inputs.every(input => input.attrs.disabled === true)).toBe(true);
    const manage = findAll(view(), node => node.tag === 'button' && /Manage/.test(collectText(node)))[0];
    manage.attrs.onclick();
    expect(attrs.onManage).toHaveBeenCalledOnce();
    expect(attrs.onChange).not.toHaveBeenCalled();
  });
});

describe('shared catalog scope', () => {
  const identity = (workspace: string) => ({backendUrl: 'http://backend', scopeKey: `tenant\0${workspace}\0user`});

  it('clears on a workspace switch on the same backend and drops the old workspace\'s late answer', async () => {
    const catalog = new AnalysisCatalog();
    let resolveOld!: (value: unknown) => void;
    api.listCodebases
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-new', displayName: 'New'})]});
    const old = catalog.refresh(identity('workspace-a'));
    // The workspace changes while workspace A's list is still loading.
    expect(catalog.read(identity('workspace-b')).codebases).toEqual([]);
    await catalog.refresh(identity('workspace-b'));
    resolveOld({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-old', displayName: 'Old'})]});
    expect(await old).toBeUndefined();
    expect(catalog.read(identity('workspace-b')).codebases.map(item => item.codebaseId)).toEqual(['cb-new']);
    // Back on workspace A, nothing of B leaks in and A starts from empty.
    expect(catalog.read(identity('workspace-a')).codebases).toEqual([]);
  });

  it('drops an older refresh of the same identity when a newer one already answered', async () => {
    const catalog = new AnalysisCatalog();
    let resolveFirst!: (value: unknown) => void;
    api.listCodebases
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-fresh'})]});
    const first = catalog.refresh(identity('workspace-a'));
    await catalog.refresh(identity('workspace-a'));
    resolveFirst({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-stale'})]});
    await first;
    expect(catalog.read(identity('workspace-a')).codebases.map(item => item.codebaseId)).toEqual(['cb-fresh']);
  });

  it('keys the credential by a tag, never the secret itself', () => {
    const catalog = new AnalysisCatalog();
    const withKey = {...identity('workspace-a'), apiKey: 'SECRET_CANARY_TOKEN'};
    const key = catalog.read(withKey).key;
    expect(key).not.toContain('SECRET_CANARY_TOKEN');
    expect(key).not.toBe(catalog.read({...withKey, apiKey: 'other-token'}).key);
  });

  it('shows the new workspace\'s names in the popover after a switch, never the old ones', async () => {
    const control = new AnalysisContextControl() as any;
    const attrs = (workspace: string): AnalysisContextControlAttrs => ({
      ...identity(workspace), disabled: false,
      selection: {codeAwareMode: 'metadata_only', codebaseIds: ['cb-a'], knowledgeSourceIds: []},
      onChange: vi.fn(), onManage: vi.fn(),
    });
    let resolveOld!: (value: unknown) => void;
    api.listCodebases
      .mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-a', displayName: 'Workspace B app'})]});
    const trigger = findAll(control.view({attrs: attrs('ws-old')}), node => node.tag === 'button')[0];
    trigger.attrs.onclick({preventDefault() {}, stopPropagation() {}});
    await analysisCatalog.refresh(attrs('ws-new'));
    resolveOld({featureEnabled: true, codebases: [codebase({codebaseId: 'cb-a', displayName: 'Workspace A app'})]});
    await vi.waitFor(() => expect(collectText(control.view({attrs: attrs('ws-new')}))).toContain('Workspace B app'));
    expect(collectText(control.view({attrs: attrs('ws-new')}))).not.toContain('Workspace A app');
    control.onremove();
  });
});

