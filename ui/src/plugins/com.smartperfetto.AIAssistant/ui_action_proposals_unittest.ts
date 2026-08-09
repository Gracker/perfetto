// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024 The Android Open Source Project
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, vi} from 'vitest';
import type {Trace} from '../../public/trace';
import type {Message, UiActionProposalV1} from './types';
import {
  buildPinnedResultForUiAction,
  executeUiNavigationProposal,
  findUiActionEvidenceMessage,
  isUiActionProposalCollected,
  uiActionProposalDisplayTitle,
  uiActionProposalIcon,
} from './ui_action_proposals';

function traceFixture(): Trace {
  return {
    traceInfo: {
      start: BigInt(1_000_000_000),
      end: BigInt(3_000_000_000),
    },
    scrollTo: vi.fn(),
  } as unknown as Trace;
}

const rangeProposal: UiActionProposalV1 = {
  schemaVersion: 1,
  id: 'ui-range',
  kind: 'navigate_range',
  title: '查看区间',
  reason: '来自证据表',
  source: {evidenceRefId: 'ev-1'},
  payload: {
    startNs: '1200000000',
    endNs: '1300000000',
    traceId: 'trace-1',
  },
  requiresConfirmation: true,
};

function tableMessage(): Message {
  return {
    id: 'msg-table',
    role: 'assistant',
    content: '',
    timestamp: 1,
    sqlResult: {
      columns: ['ts', 'dur'],
      rows: [[1, 2]],
      rowCount: 1,
      query: '',
      sourceContext: {
        ref: 'table:1',
        title: '掉帧表',
        source: 'scrolling_analysis#jank_frames',
        reason: '证据',
        meaning: '表格',
        kind: 'table',
        evidenceRefId: 'ev-1',
      },
    },
  };
}

describe('ui action proposals', () => {
  it('executes range navigation through the trace scroll API', () => {
    const trace = traceFixture();

    const result = executeUiNavigationProposal(rangeProposal, trace, 'trace-1');

    expect(result).toEqual({ok: true});
    expect(trace.scrollTo).toHaveBeenCalledWith({
      time: {
        start: BigInt(1195000000),
        end: BigInt(1305000000),
        behavior: 'focus',
      },
    });
  });

  it('focuses point navigation so the jump is visibly centered and zoomed', () => {
    const trace = traceFixture();
    const proposal: UiActionProposalV1 = {
      schemaVersion: 1,
      id: 'ui-point',
      kind: 'navigate_timeline',
      title: '跳到时间点',
      reason: '来自证据表',
      source: {evidenceRefId: 'ev-1'},
      payload: {ts: '1200000000', traceId: 'trace-1'},
      requiresConfirmation: true,
    };

    const result = executeUiNavigationProposal(proposal, trace, 'trace-1');

    expect(result).toEqual({ok: true});
    expect(trace.scrollTo).toHaveBeenCalledWith({
      time: {
        start: BigInt(1195000000),
        end: BigInt(1205000000),
        behavior: 'focus',
      },
    });
  });

  it('rejects navigation outside trace bounds', () => {
    const trace = traceFixture();
    const result = executeUiNavigationProposal({
      ...rangeProposal,
      payload: {startNs: '1', endNs: '2'},
    }, trace, 'trace-1');

    expect(result).toEqual(expect.objectContaining({ok: false}));
    expect(trace.scrollTo).not.toHaveBeenCalled();
  });

  it('rejects stale navigation proposals generated for another trace', () => {
    const trace = traceFixture();

    const result = executeUiNavigationProposal(rangeProposal, trace, 'trace-2');

    expect(result).toEqual({
      ok: false,
      error: 'proposal was generated for trace trace-1, but current trace is trace-2',
    });
    expect(trace.scrollTo).not.toHaveBeenCalled();
  });

  it('finds evidence table messages and builds pin payloads', () => {
    const message = tableMessage();
    const pinProposal: UiActionProposalV1 = {
      schemaVersion: 1,
      id: 'ui-pin',
      kind: 'pin_evidence',
      title: '固定证据 掉帧表',
      reason: '用于后续追问',
      source: {evidenceRefId: 'ev-1'},
      payload: {evidenceRefId: 'ev-1'},
      requiresConfirmation: true,
    };

    const found = findUiActionEvidenceMessage(pinProposal, [message]);
    const pinned = found
      ? buildPinnedResultForUiAction(pinProposal, found, pinProposal.id)
      : undefined;

    expect(found?.id).toBe('msg-table');
    expect(pinned).toEqual(expect.objectContaining({
      id: 'ui-pin',
      query: '掉帧表',
      columns: ['ts', 'dur'],
      rows: [[1, 2]],
    }));
    expect(pinned?.evidence).toBeUndefined();
    expect(isUiActionProposalCollected(pinProposal, pinned ? [pinned] : []))
      .toBe(true);
    expect(uiActionProposalDisplayTitle(pinProposal, '收藏证据'))
      .toBe('收藏证据 掉帧表');
    expect(uiActionProposalDisplayTitle(pinProposal, '已收藏'))
      .toBe('已收藏 掉帧表');
    expect(uiActionProposalIcon('pin_evidence')).toBe('bookmark_add');
  });

  it('builds a saved evidence snapshot when the source has no table', () => {
    const proposal: UiActionProposalV1 = {
      schemaVersion: 1,
      id: 'ui-pin-summary',
      kind: 'pin_evidence',
      title: '收藏证据 洞见摘要',
      reason: '保留本轮证据摘要',
      source: {evidenceRefId: 'ev-summary'},
      payload: {evidenceRefId: 'ev-summary'},
      requiresConfirmation: true,
    };
    const message: Message = {
      id: 'msg-summary',
      role: 'assistant',
      content: '启动耗时主要集中在主线程同步初始化。',
      timestamp: 1,
      sourceContext: {
        ref: 'summary:1',
        title: '洞见摘要',
        source: 'startup_analysis#summary',
        reason: '综合已核验的启动证据',
        meaning: '本轮启动分析摘要',
        kind: 'summary',
        evidenceRefId: 'ev-summary',
      },
    };

    const pinned = buildPinnedResultForUiAction(
      proposal,
      message,
      proposal.id,
    );

    expect(pinned).toEqual(expect.objectContaining({
      id: proposal.id,
      query: '洞见摘要',
      columns: [],
      rows: [],
      evidence: {
        content: '启动耗时主要集中在主线程同步初始化。',
        source: 'startup_analysis#summary',
        evidenceRefId: 'ev-summary',
        truncated: false,
      },
    }));
    expect(isUiActionProposalCollected(proposal, [pinned])).toBe(true);
  });
});
