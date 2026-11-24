// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Route} from '../../public/app';
import type {Trace} from '../../public/trace';
import {describe, expect, it, vi} from 'vitest';
import {openPerfettoChat} from './navigation';

function makeTrace() {
  const showTab = vi.fn();
  const trace = {traceInfo: {}, sidePanel: {showTab}} as unknown as Trace;
  return {trace, showTab};
}

describe('PerfettoChatViewer navigation', () => {
  it('uses one action for standalone chat and the active Viewer', async () => {
    const getCurrentRoute = vi.fn(() => ({args: {}} as Route));
    const app = {trace: undefined as Trace | undefined, navigate: vi.fn(), getCurrentRoute};
    const ensureTab = vi.fn(async (_trace: Trace) => true);
    await openPerfettoChat(app, ensureTab, 'chat');
    expect(app.navigate).toHaveBeenLastCalledWith('#!/perfetto_chat');
    expect(ensureTab).not.toHaveBeenCalled();

    const {trace, showTab} = makeTrace();
    app.trace = trace;
    await openPerfettoChat(app, ensureTab, 'chat');
    expect(app.navigate).toHaveBeenLastCalledWith('#!/viewer');
    expect(ensureTab).toHaveBeenCalledWith(trace);
    expect(showTab).toHaveBeenCalledWith('chat');

    app.trace = undefined;
    getCurrentRoute.mockReturnValue({args: {local_cache_key: 'previous-trace'}} as Route);
    await openPerfettoChat(app, ensureTab, 'chat');
    expect(app.navigate).toHaveBeenLastCalledWith('#!/perfetto_chat?local_cache_key=');
  });

  it('does not open a tab on an unloaded Trace when capability resolution arrives late', async () => {
    const {trace, showTab} = makeTrace();
    const app = {trace, navigate: vi.fn(), getCurrentRoute: vi.fn(() => ({args: {}} as Route))};
    const ensureTab = async () => {
      app.trace = makeTrace().trace;
      return true;
    };
    await openPerfettoChat(app, ensureTab, 'chat');
    expect(showTab).not.toHaveBeenCalled();
  });
});
