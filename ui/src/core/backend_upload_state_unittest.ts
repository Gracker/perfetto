// Copyright (C) 2024-2026 Gracker (Chris)
// SPDX-License-Identifier: Apache-2.0

import {describe, expect, it} from 'vitest';
import {
  getBackendUploadIdentityKey,
  invalidateBackendUploaderCredentials,
  setDefaultBackendCredential,
  setDefaultBackendUrl,
} from './backend_uploader';
import {
  backendUploadSnapshotMatchesIdentity,
  getBackendUploadState,
  invalidateBackendUploadState,
  isBackendUploadOperationCurrent,
  setBackendUploadState,
} from './backend_upload_state';
import {
  getSmartPerfettoRequestContext,
  setSmartPerfettoWorkspaceId,
} from './smartperfetto_request_context';

describe('backend upload identity', () => {
  it('invalidates a ready trace and in-flight result when backend URL changes', () => {
    setDefaultBackendUrl('http://backend-a.test/');
    const sourceKey = 'source-trace-a';
    const oldIdentity = getBackendUploadIdentityKey(undefined, sourceKey);
    setBackendUploadState({
      backendIdentityKey: oldIdentity,
      uploadToken: 'old-operation',
      sourceKey,
      traceId: 'old-trace-id',
      state: 'ready',
    });

    setDefaultBackendUrl('http://backend-b.test');
    const newIdentity = getBackendUploadIdentityKey(undefined, sourceKey);
    expect(newIdentity).not.toBe(oldIdentity);
    expect(backendUploadSnapshotMatchesIdentity(getBackendUploadState(), newIdentity, sourceKey)).toBe(false);

    invalidateBackendUploadState(newIdentity, sourceKey);
    expect(getBackendUploadState()).toEqual(expect.objectContaining({
      backendIdentityKey: newIdentity,
      state: 'idle',
    }));
    expect(getBackendUploadState().traceId).toBeUndefined();
    expect(isBackendUploadOperationCurrent('old-operation', oldIdentity, sourceKey)).toBe(false);

    setBackendUploadState({
      backendIdentityKey: newIdentity,
      uploadToken: 'new-operation',
      sourceKey,
      traceId: 'new-trace-id',
      state: 'ready',
    });
    expect(backendUploadSnapshotMatchesIdentity(getBackendUploadState(), newIdentity, sourceKey)).toBe(true);
    expect(getBackendUploadState().traceId).toBe('new-trace-id');
  });

  it('changes identity on credential rotation without retaining the credential', () => {
    setDefaultBackendUrl('http://backend-credentials.test');
    const before = getBackendUploadIdentityKey();
    invalidateBackendUploaderCredentials();
    const after = getBackendUploadIdentityKey();

    expect(after).not.toBe(before);
    expect(after).not.toContain('secret');
  });

  it('rotates upload identity when the configured credential changes', () => {
    setDefaultBackendUrl('http://backend-credentials-rotation.test');
    setDefaultBackendCredential('first-secret');
    const first = getBackendUploadIdentityKey();
    setDefaultBackendCredential('second-secret');
    const second = getBackendUploadIdentityKey();

    expect(second).not.toBe(first);
    expect(second).not.toContain('first-secret');
    expect(second).not.toContain('second-secret');
    setDefaultBackendCredential();
  });

  it('partitions upload identity by workspace and trace source', () => {
    const context = getSmartPerfettoRequestContext();
    setDefaultBackendUrl('http://backend-scope.test');
    setSmartPerfettoWorkspaceId('workspace-upload-a', context.tenantId, context.userId);
    const workspaceA = getBackendUploadIdentityKey(undefined, 'source-a');
    const otherSource = getBackendUploadIdentityKey(undefined, 'source-b');

    setSmartPerfettoWorkspaceId('workspace-upload-b', context.tenantId, context.userId);
    const workspaceB = getBackendUploadIdentityKey(undefined, 'source-a');

    expect(otherSource).not.toBe(workspaceA);
    expect(workspaceB).not.toBe(workspaceA);
    expect(workspaceA).not.toContain('source-a');
    setSmartPerfettoWorkspaceId(context.workspaceId, context.tenantId, context.userId);
  });
});
