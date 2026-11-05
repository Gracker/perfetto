// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import m from 'mithril';
import {AssistantWorkOverview} from './assistant_work_overview';
import {readAssistantWorkDetail, readAssistantWork, downloadAssistantWorkReport} from './assistant_work_client';
import * as downloadUtils from '../../base/download_utils';
import type {AssistantWorkItem} from './generated/data_contract.types';

let root: HTMLElement;
const config = {backendUrl: 'http://backend'};
const item: AssistantWorkItem = {surface: 'conversation', metadata: 'available',
  work: {sessionId: 'conversation-other', runId: 'other-run', phase: 'needs_input', hasResult: true}};
const response = (value: unknown) => new Response(JSON.stringify(value), {headers: {'content-type': 'application/json'}});
async function flush() {await new Promise(resolve => setTimeout(resolve, 0)); m.redraw.sync();}
function click(selector: string) {(root.querySelector(selector) as HTMLButtonElement).click();}
function detail() {return response({success: true, sessionId: item.work.sessionId, status: 'completed',
  history: [{role: 'assistant', content: 'Answer for other work'}], historyOmittedMessages: 0,
  traceContext: {kind: 'attached', traceId: 'attached'}, sourceSelection: {codeAwareMode: 'off', codebaseIds: [], knowledgeSourceIds: []}});}
function mount(canContinue = false) {
  const attrs = {config, canRead: true, authorityKey: 'owner-a', canContinue,
    isCurrent: vi.fn(() => true),
    onContinue: vi.fn(async (_id: string, _signal: AbortSignal) => undefined)};
  m.mount(root, {view: () => m(AssistantWorkOverview, attrs)}); return attrs;
}
beforeEach(() => {
  root = document.createElement('div'); document.body.appendChild(root);
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: false, backendUrl: 'http://backend'};
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});
afterEach(() => {
  m.mount(root, null); root.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  window.__SMARTPERFETTO_CONFIG__ = undefined; window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('Assistant work overview', () => {
  it('loads on demand and opens read-only details with continuation disabled during active work', async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => String(url).includes('/work?')
      ? response({success: true, filter: 'needs_input', items: [item]}) : detail());
    vi.stubGlobal('fetch', fetch); const attrs = mount(); expect(fetch).not.toHaveBeenCalled();
    click('[data-work-overview-toggle]'); await flush(); click('[data-work-open]'); await flush();
    expect(root.querySelector('.ai-work-drawer')?.textContent).toContain('Answer for other work');
    expect((root.querySelector('[data-work-continue]') as HTMLButtonElement).disabled).toBe(true);
    expect(attrs.onContinue).not.toHaveBeenCalled(); expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
    click('[data-work-close]'); await flush(); expect(root.querySelector('.ai-work-drawer')).toBeNull();
  });
  it('retains a cursor after an empty live-overlay page and distinguishes errors from empty', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ++calls === 1
      ? response({success: true, filter: 'needs_input', items: [], nextCursor: 'cursor'}) : new Response('', {status: 503})));
    mount(); click('[data-work-overview-toggle]'); await flush();
    expect(root.textContent).toMatch(/本页状态已变化|States on this page changed/);
    [...root.querySelectorAll('button')].find(button => /查看更多|Show more/.test(button.textContent ?? ''))!.click(); await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('503');
    expect(root.textContent).not.toMatch(/当前没有需要|No work currently/);
  });
  it('drops old-owner metadata and late detail data on an authority change', async () => {
    let resolveDetail!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => {resolveDetail = resolve;});
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/work?')
      ? response({success: true, filter: 'needs_input', items: [item]}) : pending));
    const attrs = mount(); click('[data-work-overview-toggle]'); await flush(); click('[data-work-open]'); await flush();
    attrs.authorityKey = 'owner-b'; m.redraw.sync(); resolveDetail(detail()); await flush();
    expect(root.textContent).not.toContain('Answer for other work');
    expect(root.querySelector('.ai-work-item')).toBeNull(); expect(root.querySelector('.ai-work-drawer')).toBeNull();
  });
  it('continues only on the explicit button without dispatching a model turn itself', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/work?')
      ? response({success: true, filter: 'needs_input', items: [item]}) : detail()));
    const attrs = mount(true); click('[data-work-overview-toggle]'); await flush(); click('[data-work-open]'); await flush();
    expect(attrs.onContinue).not.toHaveBeenCalled(); click('[data-work-continue]'); await flush();
    expect(attrs.onContinue).toHaveBeenCalledWith(item.work.sessionId, expect.any(AbortSignal));
    expect(root.querySelector('.ai-work-drawer')).toBeNull();
  });
  it.each(['owner', 'source'])('drops a late detail immediately after %s changes without a redraw', async () => {
    let resolveDetail!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => {resolveDetail = resolve;});
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => String(url).includes('/work?')
      ? response({success: true, filter: 'needs_input', items: [item]}) : pending));
    const attrs = mount(); click('[data-work-overview-toggle]'); await flush(); click('[data-work-open]'); await flush();
    attrs.isCurrent.mockReturnValue(false);
    // No authority-key change or redraw: an abort scheduled by the next frame cannot protect this delivery.
    resolveDetail(detail()); await flush();
    expect(root.textContent).not.toContain('Answer for other work');
  });
  it.each(['owner', 'source'])('does not download a blob delivered after %s changes without a redraw', async () => {
    let resolveBlob!: (value: Blob) => void;
    const pending = new Promise<Blob>(resolve => {resolveBlob = resolve;});
    const report = new Response(); vi.spyOn(report, 'blob').mockReturnValue(pending);
    vi.stubGlobal('fetch', vi.fn(async () => report));
    const download = vi.spyOn(downloadUtils, 'download').mockResolvedValue('saved');
    let current = true;
    const downloading = downloadAssistantWorkReport(config, '/api/reports/report-id', new AbortController().signal, () => current);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(report.blob).toHaveBeenCalled(); current = false;
    resolveBlob(new Blob(['PRIVATE_REPORT'])); await downloading;
    expect(download).not.toHaveBeenCalled();
  });
});

describe('Assistant work result identity', () => {
  it('rejects a result snapshot from a different run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({success: true, snapshot: {
      id: 'snapshot', sessionId: 'analysis', runId: 'wrong-run', summary: {conclusion: 'wrong'}}})));
    await expect(readAssistantWorkDetail(config, {surface: 'analysis', metadata: 'available',
      work: {sessionId: 'analysis', runId: 'selected', phase: 'ready', hasResult: true}, result: {kind: 'snapshot', id: 'snapshot'}},
    new AbortController().signal)).rejects.toThrow('identity changed');
  });
  it('labels fallback data as history unless completion identifies the selected run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({success: true, sessionId: 'analysis', turn: {
      turnId: 'independent-turn-id', result: {message: 'history answer', completion: {runId: 'older-run'}}}})));
    expect(await readAssistantWorkDetail(config, {surface: 'analysis', metadata: 'available',
      work: {sessionId: 'analysis', runId: 'selected', phase: 'finished', hasResult: false}}, new AbortController().signal))
      .toMatchObject({kind: 'analysis', exactRun: false, body: 'history answer'});
  });
  it('rejects snapshots without bound run IDs even when called directly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({success: true, snapshot: {
      id: 'snapshot', sessionId: 'analysis', summary: {conclusion: 'unbound'}}})));
    await expect(readAssistantWorkDetail(config, {surface: 'analysis', metadata: 'unavailable',
      work: {sessionId: 'analysis', phase: 'unknown', hasResult: false}, result: {kind: 'snapshot', id: 'snapshot'}},
    new AbortController().signal)).rejects.toThrow('identity changed');
  });
  it('never calls an unbound historical result an exact run match', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({success: true, sessionId: 'ambiguous', turn: {
      turnId: 'old-turn', result: {message: 'Historical body'}}})));
    expect(await readAssistantWorkDetail(config, {surface: 'analysis', metadata: 'unavailable',
      metadataReason: 'latest_run_ambiguous', work: {sessionId: 'ambiguous', phase: 'unknown', hasResult: false}},
    new AbortController().signal)).toMatchObject({kind: 'analysis', exactRun: false});
  });
  it('rejects malformed catalog phases instead of inventing progress', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({success: true, filter: 'recent', items: [{...item,
      work: {...item.work, phase: 'verified'}}]})));
    await expect(readAssistantWork(config, 'recent', new AbortController().signal)).rejects.toThrow('Invalid work catalog item');
  });
});
