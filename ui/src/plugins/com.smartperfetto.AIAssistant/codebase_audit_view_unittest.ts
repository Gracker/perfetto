// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {CodebaseAuditView, formatRootAuthorization} from './codebase_audit_view';

function collectText(node: any): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(collectText).join(' ');
  return collectText(node.children);
}

describe('codebase audit path authorization', () => {
  it('makes persistent native-picker authorization visible', () => {
    expect(formatRootAuthorization('native_picker')).toMatch(
      /系统文件夹选择|System folder selection/,
    );
    expect(formatRootAuthorization('configured_allowlist')).toMatch(
      /配置的 allowlist|Configured allowlist/,
    );
    expect(formatRootAuthorization(undefined)).toMatch(
      /配置的 allowlist|Configured allowlist/,
    );
  });

  it('renders active coverage and maintenance state in the audit surface', () => {
    const view = new CodebaseAuditView() as any;
    view.loading = false;
    view.audit = {
      codebaseId: 'codebase-a',
      kind: 'app_source',
      indexGeneration: 2,
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
  });
});
