// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import type {TraceInfo} from '../../public/trace_info';
import {ChatClient, type Capabilities} from './client';
import {Conversation} from './conversation';
import {CHAT_PAGE, openPerfettoChat} from './navigation';
import {ChatPanel, title} from './panel';

const id = 'com.smartperfetto.PerfettoChat';
const tab = id + '#Chat';
let capabilityQuery: {key: string; promise: Promise<Capabilities | undefined>} | undefined;

function capabilities(): Promise<Capabilities | undefined> {
  const client = new ChatClient();
  if (capabilityQuery?.key === client.scope.key) return capabilityQuery.promise;
  const promise = client.capabilities().catch(() => undefined).finally(() => {
    if (capabilityQuery?.promise === promise) capabilityQuery = undefined;
  });
  capabilityQuery = {key: client.scope.key, promise};
  return promise;
}

const pendingTabs = new WeakMap<TraceInfo, Promise<boolean>>();

function ensureTraceChatTab(trace: Trace): Promise<boolean> {
  const pending = pendingTabs.get(trace.traceInfo);
  if (pending) return pending;
  let disposed = false;
  trace.trash.defer(() => { disposed = true; });
  const register = capabilities().then(result => {
    if (!result?.enabled || disposed) return false;
    const conversation = new Conversation(trace, result);
    trace.trash.defer(() => conversation.dispose());
    trace.trash.use(trace.sidePanel.registerTab({
      uri: tab,
      title: title(),
      icon: 'chat',
      render: () => m(ChatPanel, {conversation}),
    }));
    m.redraw();
    return true;
  });
  pendingTabs.set(trace.traceInfo, register);
  return register;
}

class ReturnToViewer implements m.ClassComponent<{app: App}> {
  oncreate({attrs: {app}}: m.VnodeDOM<{app: App}>): void {
    void openPerfettoChat(app, ensureTraceChatTab, tab);
  }

  view() {
    return null;
  }
}

class StandalonePage implements m.ClassComponent {
  private readonly conversation = new Conversation();
  constructor() {
    void this.conversation.loadCapabilities();
  }
  onremove(): void {
    this.conversation.dispose();
  }
  view() {
    return m('.pf-perfetto-chat-page', m(ChatPanel, {conversation: this.conversation}));
  }
}

export default class implements PerfettoPlugin {
  static readonly id = id;

  static onActivate(app: App): void {
    app.pages.registerPage({
      route: CHAT_PAGE,
      render: () => app.trace ? m(ReturnToViewer, {app}) : m(StandalonePage),
    });
    void capabilities().then(result => {
      if (!result?.enabled) return;
      app.sidebar.addMenuItem({
        section: 'trace_files',
        text: title,
        icon: 'chat',
        action: () => openPerfettoChat(app, ensureTraceChatTab, tab),
      });
      m.redraw();
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    // Availability is read without delaying timeline load.
    void ensureTraceChatTab(trace).then(registered => {
      if (!registered) return;
      trace.commands.registerCommand({
        id: id + '#Show',
        name: title(),
        callback: () => openPerfettoChat(trace, ensureTraceChatTab, tab),
      });
    });
  }
}
