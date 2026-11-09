// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';

import {detectSourcePathSuggestion} from './source_path_suggestion';

describe('detectSourcePathSuggestion', () => {
  it('finds a folder named in a Chinese sentence', () => {
    expect(detectSourcePathSuggestion('源码地址是：/Users/me/code/app')).toBe('/Users/me/code/app');
  });

  it('finds home-relative and Windows folders', () => {
    expect(detectSourcePathSuggestion('source is at ~/work/app.')).toBe('~/work/app');
    expect(detectSourcePathSuggestion('代码在 C:\\work\\app')).toBe('C:\\work\\app');
  });

  it('accepts another absolute path only when the text talks about source', () => {
    expect(detectSourcePathSuggestion('the repo is /build/aosp')).toBe('/build/aosp');
    expect(detectSourcePathSuggestion('why is /build/aosp slow')).toBeUndefined();
  });

  it('ignores device paths from trace questions', () => {
    expect(detectSourcePathSuggestion('这段代码为什么读 /data/app/base.apk 和 /system/lib64/libc.so')).toBeUndefined();
  });

  it('ignores text without a path and very long pastes', () => {
    expect(detectSourcePathSuggestion('启动为什么慢')).toBeUndefined();
    expect(detectSourcePathSuggestion(`/Users/me/app ${'x'.repeat(5000)}`)).toBeUndefined();
  });
});
