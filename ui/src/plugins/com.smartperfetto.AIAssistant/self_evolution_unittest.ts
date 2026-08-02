// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  buildSelfEvolutionApiUrl,
  createSelfEvolutionApi,
  parseSelfEvolutionSseChunk,
  type SelfEvolutionProposal,
} from './self_evolution_api';
import {proposalActions} from './self_evolution_panel';

afterEach(() => {
  vi.unstubAllGlobals();
  window.__SMARTPERFETTO_CONFIG__ = undefined;
  window.__SMARTPERFETTO_AUTH_SESSION__ = undefined;
});

describe('self-evolution frontend contract', () => {
  it('builds the dedicated admin endpoint without duplicate slashes', () => {
    expect(
      buildSelfEvolutionApiUrl(
        'http://127.0.0.1:9000/',
        'operations/curation',
      ),
    ).toBe(
      'http://127.0.0.1:9000/api/admin/self-evolution/operations/curation',
    );
  });

  it('parses split SSE frames and preserves the partial remainder', () => {
    const first = parseSelfEvolutionSseChunk(
      '',
      [
        'id: 1',
        'event: started',
        'data: {"sequence":1,"type":"started","stage":"queued",',
      ].join('\n'),
    );
    expect(first.events).toEqual([]);

    const second = parseSelfEvolutionSseChunk(
      first.remainder,
      '"message":"curation_queued","createdAt":1}\n\n',
    );
    expect(second.remainder).toBe('');
    expect(second.events).toEqual([
      {
        sequence: 1,
        type: 'started',
        stage: 'queued',
        message: 'curation_queued',
        createdAt: 1,
      },
    ]);
  });

  it('uses the authenticated fetch path for mutation requests', async () => {
    window.__SMARTPERFETTO_CONFIG__ = {oidcEnabled: true};
    window.__SMARTPERFETTO_AUTH_SESSION__ = {
      success: true,
      authenticated: true,
      authMode: 'oidc',
      status: 'ready',
      user: {id: 'user-a', email: 'user@example.com'},
      tenant: {id: 'tenant-a', name: 'Tenant A'},
      workspace: {
        id: 'workspace-a',
        name: 'Personal Workspace',
        kind: 'personal',
      },
      csrfToken: 'csrf-token-a',
    };
    const fetchMock = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => ({
      ok: true,
      status: 200,
      json: async () => ({success: true, operationId: 'operation-a'}),
    } as Response));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      createSelfEvolutionApi('http://backend', 'secret-key').startCuration(),
    ).resolves.toEqual({success: true, operationId: 'operation-a'});

    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('include');
    const requestHeaders = new Headers(init?.headers);
    expect(requestHeaders.get('Authorization')).toBe('Bearer secret-key');
    expect(requestHeaders.get('X-CSRF-Token')).toBe('csrf-token-a');
  });

  it('derives only lifecycle-valid proposal actions', () => {
    expect(proposalActions(proposal('draft'))).toEqual(['gate', 'reject']);
    expect(proposalActions(proposal('gated'))).toEqual([
      'accept',
      'reject',
      'export',
    ]);
    expect(proposalActions(proposal('accepted'))).toEqual([
      'export',
      'apply',
    ]);
    expect(proposalActions(proposal('applied'))).toEqual([
      'export',
      'revert',
    ]);
    expect(proposalActions(proposal('rejected'))).toEqual([]);
  });
});

function proposal(
  status: SelfEvolutionProposal['status'],
): SelfEvolutionProposal {
  return {
    proposalId: 'proposal-test-0001',
    revision: 1,
    kind: 'skill_note',
    tier: 'T1',
    title: 'Test proposal',
    rationale: 'Test rationale',
    deltas: [],
    evidence: {
      labeledCount: 3,
      negativeCount: 3,
      distinctTraceCount: 1,
      distinctSessionCount: 3,
      statisticalVerdict: 'hypothesis_only',
    },
    pairedGateVerdict: 'not_run',
    expectedEffect: 'Improve evidence coverage',
    riskLevel: 'low',
    status,
    createdAt: '2026-07-29T00:00:00.000Z',
  };
}
