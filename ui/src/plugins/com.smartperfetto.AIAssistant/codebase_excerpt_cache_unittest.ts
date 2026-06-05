// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

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

import {describe, expect, it} from 'vitest';

import {CodebaseExcerptCache} from './codebase_excerpt_cache';

function putSample(cache: CodebaseExcerptCache, codebaseId = 'cb_a', chunkId = 'chunk_a') {
  cache.put({
    codebaseId,
    chunkId,
    text: 'fun main() {}',
    truncated: false,
    indexGeneration: 1,
  });
}

describe('CodebaseExcerptCache', () => {
  it('clears excerpts on session, trace, panel, and permission events', () => {
    const cache = new CodebaseExcerptCache();
    putSample(cache);
    cache.clearForSessionSwitch();
    expect(cache.size).toBe(0);

    putSample(cache);
    cache.clearForTraceSwitch();
    expect(cache.size).toBe(0);

    putSample(cache);
    cache.clearForPanelUnmount();
    expect(cache.size).toBe(0);

    putSample(cache);
    cache.clearForPermissionRevoked();
    expect(cache.size).toBe(0);
  });

  it('clears only affected codebase excerpts on reindex and delete', () => {
    const cache = new CodebaseExcerptCache();
    putSample(cache, 'cb_a', 'chunk_a');
    putSample(cache, 'cb_b', 'chunk_b');

    cache.clearForCodebaseReindex('cb_a', 2);
    expect(cache.get('cb_a', 'chunk_a')).toBeUndefined();
    expect(cache.get('cb_b', 'chunk_b')).toBeDefined();

    cache.clearForCodebaseDelete('cb_b');
    expect(cache.size).toBe(0);
  });
});
