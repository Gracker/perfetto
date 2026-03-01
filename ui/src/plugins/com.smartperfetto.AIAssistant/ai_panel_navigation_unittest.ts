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

import {describe, it, expect, jest} from '@jest/globals';

import {AIPanel} from './ai_panel';

describe('AIPanel /goto navigation', () => {
  it('returns an error when jumpToTimestamp is called without trace context', () => {
    const panel = new AIPanel() as any;
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = panel.jumpToTimestamp(123n);

    expect(result).toEqual({
      ok: false,
      error: 'trace context is not available',
    });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('scrolls timeline window when jumpToTimestamp succeeds', () => {
    const panel = new AIPanel() as any;
    const scrollTo = jest.fn();
    panel.trace = {
      scrollTo,
      traceInfo: {
        start: 0n,
        end: 10000000n,
      },
    };

    const result = panel.jumpToTimestamp(1n);

    expect(result).toEqual({ok: true});
    expect(scrollTo).toHaveBeenCalledTimes(1);
    const arg = scrollTo.mock.calls[0][0];
    expect(arg.time.start).toBe(0n);
    expect(arg.time.end).toBe(5000001n);
  });

  it('returns failure when timestamp is outside trace range', () => {
    const panel = new AIPanel() as any;
    const scrollTo = jest.fn();
    panel.trace = {
      scrollTo,
      traceInfo: {
        start: 100n,
        end: 200n,
      },
    };

    const result = panel.jumpToTimestamp(300n);

    expect(result.ok).toBe(false);
    expect((result as any).error).toContain('outside trace range');
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('reports failure message when goto navigation fails', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = jest.fn(() => 'msg-id');
    panel.addMessage = jest.fn();
    panel.jumpToTimestamp = jest.fn(() => ({ok: false, error: 'boom'}));

    await panel.handleGotoCommand('123ns');

    expect(panel.jumpToTimestamp).toHaveBeenCalledWith(123n);
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.role).toBe('assistant');
    expect(message.content).toContain('Failed to navigate to timestamp 123ns');
    expect(message.content).toContain('boom');
  });

  it('reports success message when goto navigation succeeds', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = jest.fn(() => 'msg-id');
    panel.addMessage = jest.fn();
    panel.jumpToTimestamp = jest.fn(() => ({ok: true}));

    await panel.handleGotoCommand('456');

    expect(panel.jumpToTimestamp).toHaveBeenCalledWith(456n);
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.role).toBe('assistant');
    expect(message.content).toBe('Navigated to timestamp 456ns.');
  });

  it('rejects invalid goto timestamp input', async () => {
    const panel = new AIPanel() as any;
    panel.generateId = jest.fn(() => 'msg-id');
    panel.addMessage = jest.fn();
    panel.jumpToTimestamp = jest.fn();

    await panel.handleGotoCommand('abc');

    expect(panel.jumpToTimestamp).not.toHaveBeenCalled();
    expect(panel.addMessage).toHaveBeenCalledTimes(1);
    const message = panel.addMessage.mock.calls[0][0];
    expect(message.content).toBe('Invalid timestamp: abc');
  });
});
