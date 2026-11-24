// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {App} from '../../public/app';
import type {Trace} from '../../public/trace';

export const CHAT_PAGE = '/perfetto_chat';

export async function openPerfettoChat(
  app: Pick<App, 'trace' | 'navigate'>,
  showTraceChat: (trace: Trace) => Promise<boolean>,
  tab: string,
): Promise<void> {
  const trace = app.trace;
  if (!trace) {
    app.navigate('#!' + CHAT_PAGE);
    return;
  }
  app.navigate('#!/viewer');
  const registered = await showTraceChat(trace);
  if (registered && app.trace?.traceInfo === trace.traceInfo) {
    trace.sidePanel.showTab(tab);
  }
}
