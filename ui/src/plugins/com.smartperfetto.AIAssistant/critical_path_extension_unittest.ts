// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {THREAD_STATE_TRACK_KIND} from '../../public/track_kinds';
import {
  buildCriticalPathHandoffQuestion,
  renderCriticalPathDrawerBody,
  setupCriticalPathExtension,
} from './critical_path_extension';
import {
  clearPendingComposerDraft,
  peekPendingComposerDraft,
} from './assistant_command_bus';
import type {CriticalPathAnalysis} from './generated';

function enableOidcSession(): void {
  window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
  window.__SMARTPERFETTO_AUTH_SESSION__ = {
    success: true,
    authenticated: true,
    authMode: 'oidc',
    status: 'ready',
    user: {id: 'user-a', email: 'user-a@example.test'},
    tenant: {id: 'tenant-a', name: 'Tenant A'},
    workspace: {id: 'workspace-a', name: 'Workspace A', kind: 'personal'},
    csrfToken: 'csrf-a',
  };
}

function traceFixture(): any {
  return {
    traceInfo: {
      source: {type: 'URL', url: 'https://example.test/current.trace'},
    },
    selection: {
      selection: {
        kind: 'track_event',
        eventId: 7,
        trackUri: 'thread-state-track',
        ts: 100n,
        dur: 50n,
      },
    },
    tracks: {
      getTrack: () => ({tags: {utid: 9, kinds: [THREAD_STATE_TRACK_KIND]}}),
    },
  };
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('critical path extension lifecycle', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="ai-preset-questions"><button class="ai-selection-btn">Selection</button></div>';
    enableOidcSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
  });

  it('does not recreate the drawer when a response settles after disposal', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const connection = {
      getSnapshot: () => ({state: 'ready', traceId: 'backend-trace-a'}),
    } as any;
    const handle = setupCriticalPathExtension(traceFixture(), connection);

    const button = document.querySelector<HTMLButtonElement>(
      '.sp-critical-path-inline-btn',
    );
    expect(button).not.toBeNull();
    button!.click();
    await flushAsyncWork();
    expect(document.querySelector('.sp-critical-path-drawer')).not.toBeNull();

    handle.dispose();
    expect(document.querySelector('.sp-critical-path-drawer')).toBeNull();

    resolveFetch(
      new Response(
        JSON.stringify({
          success: true,
          analysis: {summary: 'stale result'},
        }),
        {status: 200, headers: {'Content-Type': 'application/json'}},
      ),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await flushAsyncWork();

    expect(document.querySelector('.sp-critical-path-drawer')).toBeNull();
  });
});

function analysisFixture(overrides: Partial<CriticalPathAnalysis> = {}): CriticalPathAnalysis {
  const segment = {
    startTs: 100, dur: 30_000_000, startOffsetMs: 0, durationMs: 30, utid: 41,
    processName: 'com.secret.app', threadName: 'SecretWorker', state: 'S',
    slices: ['secretSlice'], moduleIds: [], modules: ['Binder / IPC'], reasonItems: [], reasons: ['Sleeping'],
    children: [{
      startTs: 110, dur: 5_000_000, startOffsetMs: 0.01, durationMs: 5, utid: 52,
      processName: 'system_server', threadName: 'binder:1', state: 'Running',
      slices: [], moduleIds: [], modules: [], reasonItems: [], reasons: [], recursionDepth: 1,
    }],
  };
  return {
    available: true,
    task: {threadStateId: 7, utid: 9, startTs: 100, dur: 50_000_000, durationMs: 50,
      processName: 'com.secret.app', threadName: 'main', state: 'S'},
    totalMs: 50, blockingMs: 30, selfMs: 20, externalBlockingPercentage: 60,
    wakeupChain: [segment],
    moduleBreakdown: [], anomalies: [], summary: 'rule summary',
    recommendationIds: [], recommendations: [], warningCodes: [], warnings: [],
    rawRows: 3, truncated: true, chainSegmentCount: 250,
    longestSegment: {processName: 'com.secret.app', threadName: 'SecretWorker', durationMs: 30, moduleIds: []},
    slices: [{threadStateId: 7, startTs: 100, endTs: 50_000_100, durationMs: 50, state: 'S',
      kind: 'sleeping', cpu: null, blockedFunction: null, ioWait: null}],
    directWaker: {threadStateId: 90, utid: 41, tid: 1041, threadName: 'SecretWorker', processName: 'com.secret.app',
      state: 'Running', cpu: 2, irqContext: false, kind: 'thread', hintCodes: [], hints: []},
    semanticSources: {binder: 'present', monitor: 'empty', io: 'sql_error'},
    quantification: {
      counterfactual: {longestSegmentKey: 'k', longestSegmentDurMs: 30, bestCaseDurationMs: 20, maxSavingMs: 30,
        longestSegmentDurNs: 30_000_000, bestCaseDurationNs: 20_000_000, maxSavingNs: 30_000_000,
        noteCode: 'best_case_only', note: 'best case only'},
      frameImpacts: [{frameId: 12, expectedDeadlineDurMs: 16.6, jankType: 'App Deadline Missed',
        presentType: null, layerName: null, appUpid: 3, overlapMs: 8}],
      hypotheses: [{id: 'h-io-wait', params: {}, statement: 'IO wait on utid=41', strength: 'weak',
        verificationSql: 'SELECT ts FROM thread_state WHERE utid = 41 AND ts < 5', noteCodes: [], notes: ['io_wait']}],
      warnings: [],
    },
    ...overrides,
  };
}

describe('critical path drawer contract', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div class="ai-preset-questions"><button class="ai-selection-btn">Selection</button></div>';
    enableOidcSession();
    clearPendingComposerDraft();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    window.__SMARTPERFETTO_CONFIG__ = undefined;
    window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
    clearPendingComposerDraft();
  });

  it('renders the waker, sources, recursion, states, best case, frames and hypotheses', () => {
    const html = renderCriticalPathDrawerBody(analysisFixture(), null);
    const root = document.createElement('div');
    root.innerHTML = html;

    expect(root.querySelector('.sp-critical-path-waker')?.textContent).toContain('SecretWorker');
    expect(root.querySelector('.sp-critical-path-sources .sql_error')).not.toBeNull();
    expect(root.querySelectorAll('.sp-critical-path-chain-row.depth-1')).toHaveLength(1);
    expect(root.textContent).toContain('250');
    expect(root.textContent).toContain('best case only');
    expect(root.textContent).toContain('App Deadline Missed');
    expect(root.querySelector('.sp-critical-path-hypothesis pre')?.textContent)
      .toBe('SELECT ts FROM thread_state WHERE utid = 41 AND ts < 5');
    expect(root.querySelector('.sp-critical-path-copy')).not.toBeNull();
    expect(root.querySelector('.sp-critical-path-handoff')).not.toBeNull();
  });

  it('explains an unavailable result by its reason', () => {
    const root = document.createElement('div');
    root.innerHTML = renderCriticalPathDrawerBody(
      analysisFixture({available: false, unavailableReason: 'no_critical_path_stack', wakeupChain: []}), null);

    expect(root.textContent).toMatch(/sched_waking/);
  });

  it('hands off ids and numbers only, never trace-derived names', () => {
    const question = buildCriticalPathHandoffQuestion(analysisFixture());

    expect(question).toContain('thread_state_id=7');
    expect(question).toContain('50.00');
    expect(question).toContain('60.00');
    expect(question).toContain('250');
    for (const name of ['com.secret.app', 'SecretWorker', 'secretSlice', 'main', 'binder:1']) {
      expect(question).not.toContain(name);
    }
  });

  it('calls the workspace route without limits of its own and hands the question to the composer', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true, analysis: analysisFixture(), presentationAnalysis: analysisFixture(),
    }), {status: 200, headers: {'Content-Type': 'application/json'}}));
    vi.stubGlobal('fetch', fetchMock);
    const connection = {getSnapshot: () => ({state: 'ready', traceId: 'backend-trace-a'})} as any;
    const handle = setupCriticalPathExtension(traceFixture(), connection);

    document.querySelector<HTMLButtonElement>('.sp-critical-path-inline-btn')!.click();
    for (let i = 0; i < 5; i++) await flushAsyncWork();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/workspaces/workspace-a/critical-path/backend-trace-a/analyze');
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({threadStateId: 7, includeAi: true});
    expect(body).not.toHaveProperty('maxSegments');
    expect(body).not.toHaveProperty('recursionDepth');

    document.querySelector<HTMLButtonElement>('.sp-critical-path-handoff')!.click();
    // No panel is mounted here, so the draft waits for one, bound to the trace.
    expect(peekPendingComposerDraft()).toEqual({
      traceId: 'backend-trace-a',
      text: buildCriticalPathHandoffQuestion(analysisFixture()),
    });
    expect(document.querySelector('.sp-critical-path-drawer.active')).toBeNull();
    // Handing off sends nothing: the only request is the analysis itself.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    handle.dispose();
  });
});
