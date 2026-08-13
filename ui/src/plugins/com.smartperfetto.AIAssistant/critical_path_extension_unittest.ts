// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {THREAD_STATE_TRACK_KIND} from '../../public/track_kinds';
import {setupCriticalPathExtension} from './critical_path_extension';

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
