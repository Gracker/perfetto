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

import type {CodeExcerpt} from './codebase_api';

type CachedExcerpt = CodeExcerpt & {
  indexGeneration?: number;
};

function excerptKey(codebaseId: string, chunkId: string): string {
  return `${codebaseId}:${chunkId}`;
}

export class CodebaseExcerptCache {
  private readonly cache = new Map<string, CachedExcerpt>();

  put(excerpt: CachedExcerpt): void {
    this.cache.set(excerptKey(excerpt.codebaseId, excerpt.chunkId), excerpt);
  }

  get(codebaseId: string, chunkId: string): CachedExcerpt | undefined {
    return this.cache.get(excerptKey(codebaseId, chunkId));
  }

  get size(): number {
    return this.cache.size;
  }

  clearForSessionSwitch(): void {
    this.cache.clear();
  }

  clearForTraceSwitch(): void {
    this.cache.clear();
  }

  clearForPanelUnmount(): void {
    this.cache.clear();
  }

  clearForPermissionRevoked(): void {
    this.cache.clear();
  }

  clearForCodebaseReindex(codebaseId: string, nextGeneration?: number): void {
    for (const [key, excerpt] of this.cache) {
      if (excerpt.codebaseId !== codebaseId) continue;
      if (
        nextGeneration === undefined ||
        excerpt.indexGeneration === undefined ||
        excerpt.indexGeneration < nextGeneration
      ) {
        this.cache.delete(key);
      }
    }
  }

  clearForCodebaseDelete(codebaseId: string): void {
    for (const [key, excerpt] of this.cache) {
      if (excerpt.codebaseId === codebaseId) this.cache.delete(key);
    }
  }
}

export const codebaseExcerptCache = new CodebaseExcerptCache();
