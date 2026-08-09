// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {beforeEach, describe, expect, it} from 'vitest';

import {setSmartPerfettoWorkspaceId} from '../../core/smartperfetto_request_context';
import {
  appendConversationMessage,
  loadConversationStore,
} from './conversation_store';

beforeEach(() => {
  localStorage.clear();
  setSmartPerfettoWorkspaceId('default-workspace');
});

describe('conversation store private message persistence', () => {
  it('keeps raw private query content in memory only', () => {
    const backendUrl = 'http://localhost:9000';
    const privateCanary = 'conversation-private-canary-must-not-persist';

    const inMemory = appendConversationMessage(backendUrl, {
      id: 'private-message',
      role: 'user',
      content: privateCanary,
      timestamp: Date.now(),
      privateContent: true,
    });

    const persisted = loadConversationStore(backendUrl);
    const allStorage = Array.from({length: localStorage.length}, (_, index) => (
      localStorage.getItem(localStorage.key(index) || '') || ''
    )).join('\n');
    expect(inMemory.messages[0].content).toBe(privateCanary);
    expect(allStorage).not.toContain(privateCanary);
    expect(persisted.messages[0].content).toContain('PRIVATE_QUERY_REFERENCE');
  });
});
