// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {PerfettoPlugin} from '../../public/plugin';
import {Trace} from '../../public/trace';
import {AIPanel} from './ai_panel';

export default class implements PerfettoPlugin {
  static readonly id = 'com.smartperfetto.AIAssistant';
  async onTraceLoad(ctx: Trace): Promise<void> {
    // Register the AI Assistant tab
    ctx.tabs.registerTab({
      uri: 'ai-assistant',
      content: {
        render: () => m(AIPanel, {engine: ctx.engine, trace: ctx}),
        getTitle: () => 'AI Assistant',
      },
    });

    // Register sidebar menu item
    ctx.sidebar.addMenuItem({
      section: 'current_trace',
      sortOrder: 10,
      text: 'AI Assistant',
      icon: 'terminal',
      commandId: 'com.smartperfetto.AIAssistant.OpenPanel',
    });

    // Register commands
    ctx.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.OpenPanel',
      name: 'Open AI Assistant',
      callback: () => {
        // Navigate to AI Assistant tab
        ctx.tabs.showTab('ai-assistant');
      },
    });

    ctx.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.ClearChat',
      name: 'Clear AI Chat',
      callback: () => {
        // Trigger clear chat event
        window.dispatchEvent(new CustomEvent('ai-assistant:clear-chat'));
      },
    });

    ctx.commands.registerCommand({
      id: 'com.smartperfetto.AIAssistant.Settings',
      name: 'AI Assistant Settings',
      callback: () => {
        // Trigger settings event
        window.dispatchEvent(new CustomEvent('ai-assistant:open-settings'));
      },
    });
  }
}
