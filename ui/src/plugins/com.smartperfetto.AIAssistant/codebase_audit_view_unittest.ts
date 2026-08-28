// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {CodebaseAuditView} from './codebase_audit_view';

function collectText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return collectText(node.children);
}

describe('codebase audit safe management state', () => {
  it('renders active coverage and maintenance state in the audit surface', () => {
    const view = new CodebaseAuditView() as any;
    view.loading = false;
    view.audit = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      indexGeneration: 2,
      activeIndexState: 'active',
      selectionPolicyRevision: 3,
      grantRevision: 2,
      chunkCount: 1,
      blockedFileCount: 0,
      redactionHitCount: 0,
      activeIndexCoverage: {
        selectionPolicyRevision: 2,
        enumerationBackend: 'node-walk',
        backendFidelity: 'degraded',
        enumerationComplete: true,
        deterministic: true,
        filesEnumerated: 2,
        filesSelected: 1,
        bytesSelected: 10,
        chunksIndexed: 1,
        truncated: true,
        complete: false,
        truncationReason: 'file_budget',
      },
      maintenanceWarning: 'inactive_chunk_cleanup_failed',
      reindexRequired: 'selection_scope_narrowed',
    };

    const rendered = view.view({attrs: {
      backendUrl: 'http://backend',
      scopeKey: 'scope',
      codebase: {
        codebaseId: 'codebase-a',
        kind: 'app_source',
        displayName: 'App',
        indexGeneration: 2,
      },
    }} as any);
    const text = collectText(rendered);

    expect(text).toMatch(/1\s*\/\s*2/);
    expect(text).toContain('file_budget');
    expect(text).toContain('inactive_chunk_cleanup_failed');
    expect(text).toContain('selection_scope_narrowed');
    expect(text).toMatch(/Selection revision|选择修订/);
    expect(text).toMatch(/Grant revision|授权修订/);
    expect(text).not.toMatch(/Path authorization|路径授权|allowlist|folder selection/i);
    expect(JSON.stringify(rendered)).not.toContain('rootAuthorization');
  });
});
