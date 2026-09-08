// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Replays real captured analyses through the real handlers.
 *
 * The unit tests around the process view assert one behaviour at a time with
 * hand-written steps. That leaves the question this suite answers: what does a
 * reader actually see after a full run? The fixture is the verbatim
 * `conversation_step` sequence from two real analyses — one through the OpenAI
 * Agents SDK, one through the Claude Agent SDK — so a regression that only
 * shows up on live data has somewhere to fail.
 */

import {describe, expect, it} from 'vitest';

import {handleSSEEvent, type SSEHandlerContext} from './sse_event_handlers';
import {orderMessagesForDisplay} from './message_order';
import type {Message} from './types';
import {createStreamingFlowState} from './types';
import realEvents from './testdata/real_process_view_events.json';

interface CapturedRun {
  note: string;
  stepCount: number;
  events: Array<{event: string; data: Record<string, unknown>}>;
}

const RUNS: Record<string, CapturedRun> = realEvents as never;

function replay(run: CapturedRun): string {
  const messages: Message[] = [];
  const flowMessages: Message[] = [];
  let idCounter = 0;

  const ctx = {
    messages,
    flowMessages,
    addMessage: (msg: Message) => {
      (msg.flowTag === 'streaming_flow' ? flowMessages : messages).push(msg);
    },
    updateMessage: (messageId: string, updates: Partial<Message>) => {
      for (const list of [messages, flowMessages]) {
        const index = list.findIndex((msg) => msg.id === messageId);
        if (index !== -1) {
          list[index] = {...list[index], ...updates};
          return;
        }
      }
    },
    generateId: () => `replay-${++idCounter}`,
    getMessages: () => [...messages, ...flowMessages],
    removeLastMessageIf: () => undefined,
    streamingFlow: createStreamingFlowState(),
    streamingAnswer: {status: 'idle', content: '', pending: ''},
  } as unknown as SSEHandlerContext & {flowMessages: Message[]};

  for (const event of run.events) {
    handleSSEEvent(event.event, {data: event.data}, ctx);
  }
  handleSSEEvent('end', {}, ctx);

  expect(flowMessages).toHaveLength(1);
  return flowMessages[0].content;
}

/**
 * Lay the round out the way the panel does, using the real ordering function.
 *
 * The question a reader asks is not "what number does `phase()` return" but
 * "where does the process view appear". This renders the answer to that.
 */
function renderOrderedTranscript(processView: string): string {
  const round: Message[] = [
    {id: 'u1', role: 'user', content: '分析滑动性能问题的根因', timestamp: 1},
    {
      id: 'flow',
      role: 'assistant',
      content: processView,
      timestamp: 2,
      flowTag: 'streaming_flow',
    },
    {
      id: 'ans',
      role: 'assistant',
      content: '## 综合结论\n\n主线程在自定义滑动动画内同步执行重负载，是唯一主导根因。',
      timestamp: 3,
      flowTag: 'answer_stream',
    },
  ];
  return orderMessagesForDisplay(round)
    .map((msg) => {
      const label = msg.role === 'user'
        ? '用户提问'
        : msg.flowTag === 'answer_stream'
          ? '回答'
          : '分析过程';
      return `--- ${label} (${msg.flowTag ?? msg.role}) ---\n\n${msg.content}`;
    })
    .join('\n\n');
}

describe.each(Object.entries(RUNS))('process view on a real run: %s', (_name, run) => {
  const rendered = replay(run);
  const bulletLines = rendered
    .split('\n')
    .filter((line) => line.trimStart().startsWith('- '));

  it('renders every captured step', () => {
    expect(run.stepCount).toBeGreaterThan(30);
    expect(bulletLines.length).toBeGreaterThanOrEqual(
      Math.min(run.stepCount, 60),
    );
  });

  it('never shows a serialized payload', () => {
    // The defect this whole surface was rebuilt for: a third of the lines used
    // to be truncated JSON from the tool-result transport field.
    for (const line of bulletLines) {
      expect(line).not.toContain('{"');
      expect(line).not.toContain('[{');
      expect(line).not.toContain('\\"');
    }
  });

  it('gives every line readable text after its marker', () => {
    for (const line of bulletLines) {
      const text = line
        .replace(/^\s*- /, '')
        .replace(/^\*\*|\*\*$/g, '')
        .replace(/^[▸🔧→⚠💭·]\s*/u, '')
        .replace(/^`[0-9:]+`\s*/, '')
        .trim();
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('keeps the steps in the order they happened', () => {
    const ordinals = run.events.map((e) => Number(e.data.ordinal));
    const firstText = String(
      (run.events[0].data.content as {text: string}).text,
    ).slice(0, 20);
    const lastText = String(
      (run.events[run.events.length - 1].data.content as {text: string}).text,
    ).slice(0, 20);
    expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));
    expect(rendered.indexOf(firstText)).toBeLessThan(rendered.indexOf(lastText));
  });

  it('shows plan phase boundaries as emphasized markers, not containers', () => {
    const phaseLines = bulletLines.filter((line) => line.includes('▸'));
    // Both captured runs crossed at least one automatic phase transition.
    expect(phaseLines.length).toBeGreaterThan(0);
    for (const line of phaseLines) {
      expect(line.startsWith('- ▸ **')).toBe(true);
    }
    expect(bulletLines.some((line) => line.startsWith('  - '))).toBe(false);
  });

  it('renders a legible process (dump with SMARTPERFETTO_DUMP_PROCESS_VIEW=<dir>)', () => {
    const dumpDir = process.env.SMARTPERFETTO_DUMP_PROCESS_VIEW;
    if (dumpDir) {
      // Writing the rendered view out is how a human checks what a reader
      // actually sees, without needing the whole UI running. The transcript
      // variant additionally runs the real display ordering, so the position
      // of the process view relative to the answer is observable rather than
      // argued about.
      const fs = require('fs') as typeof import('fs');
      fs.mkdirSync(dumpDir, {recursive: true});
      fs.writeFileSync(`${dumpDir}/${_name}.md`, rendered, 'utf8');
      fs.writeFileSync(
        `${dumpDir}/${_name}.transcript.md`,
        renderOrderedTranscript(rendered),
        'utf8',
      );
    }
    expect(rendered.length).toBeGreaterThan(200);
  });

  it('places the process view after the answer within the round', () => {
    // The real display ordering, not an argument about phase numbers.
    const transcript = renderOrderedTranscript(rendered);
    const question = transcript.indexOf('--- 用户提问');
    const answer = transcript.indexOf('--- 回答');
    const process = transcript.indexOf('--- 分析过程');
    expect(question).toBeGreaterThanOrEqual(0);
    expect(question).toBeLessThan(answer);
    expect(answer).toBeLessThan(process);
  });

  it('is headed as the analysis process in the active language', () => {
    expect(rendered).toContain('🧭');
    expect(rendered).toMatch(/### 🧭 (分析过程|Analysis process)/);
    // It is the process, not the model's private reasoning.
    expect(rendered).not.toContain('思考过程');
  });
});

describe('process view on a real run: failures stay visible', () => {
  it('marks the Claude run failed tool calls as errors', () => {
    // That run hit tool-budget exhaustion, two failed AOSP lookups and a
    // rejected plan-phase advance. Those were unreadable JSON before.
    const rendered = replay(RUNS.claudeScrolling);
    const errorLines = rendered
      .split('\n')
      .filter((line) => line.includes('⚠'));
    expect(errorLines.length).toBeGreaterThanOrEqual(3);
    expect(rendered).toContain('失败');
  });
});

describe('process view source-labelled conversation replay', () => {
  it.each([
    ['horizontal', '左侧/基线 Trace', '右侧/对比 Trace'],
    ['vertical', '上方/基线 Trace', '下方/对比 Trace'],
    ['no pane', '基线 Trace', '对比 Trace'],
  ])('preserves backend source text without duplicating labels: %s', (_layout, baseline, comparison) => {
    const events = [baseline, comparison].map((label, index) => ({
      event: 'conversation_step',
      data: {
        eventId: `conversation-data-${index}`,
        ordinal: index + 1,
        phase: 'result',
        role: 'system',
        source: {eventType: 'data'},
        content: {text: `${label}：已获得掉帧帧列表`},
      },
    }));
    const rendered = replay({
      note: 'Separate backend data steps followed by SSE replay',
      stepCount: 2,
      events: [...events, ...events],
    });
    const lines = rendered.split('\n').filter((line) => line.startsWith('- '));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(`${baseline}：已获得掉帧帧列表`);
    expect(lines[1]).toContain(`${comparison}：已获得掉帧帧列表`);
    expect(rendered.split(baseline)).toHaveLength(2);
    expect(rendered.split(comparison)).toHaveLength(2);
  });
});
