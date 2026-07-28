// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {formatRootAuthorization} from './codebase_audit_view';

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
});
