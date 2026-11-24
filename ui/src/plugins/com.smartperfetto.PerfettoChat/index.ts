// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {ChatClient, type Capabilities} from './client';
import {Conversation} from './conversation';
import {ChatPanel, title} from './panel';

const id = 'com.smartperfetto.PerfettoChat';
const page = '/perfetto_chat';
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
      route: page,
      render: () => m(StandalonePage),
    });
    void capabilities().then(result => {
      if (!result?.enabled) return;
      app.sidebar.addMenuItem({
        section: 'trace_files',
        text: title,
        icon: 'chat',
        href: '#!' + page,
      });
      m.redraw();
    });
  }

  async onTraceLoad(trace: Trace): Promise<void> {
    // Registration is scoped to trace disposal, and never blocks Viewer load.
    let disposed = false;
    trace.trash.defer(() => { disposed = true; });
    void capabilities().then(result => {
      if (!result?.enabled || disposed) return;
      const conversation = new Conversation(trace, result);
      trace.trash.defer(() => conversation.dispose());
      trace.trash.use(trace.sidePanel.registerTab({
        uri: tab,
        title: title(),
        icon: 'chat',
        render: () => m(ChatPanel, {conversation}),
      }));
      trace.commands.registerCommand({
        id: id + '#Show',
        name: title(),
        callback: () => trace.sidePanel.showTab(tab),
      });
      trace.sidebar.addMenuItem({
        section: 'current_trace',
        text: title,
        icon: 'chat',
        action: () => trace.sidePanel.showTab(tab),
      });
      m.redraw();
    });
  }
}
