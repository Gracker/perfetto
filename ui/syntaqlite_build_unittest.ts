// Copyright (C) 2026 The Android Open Source Project
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
import {syntaqlitePerfettoCompilerArgs} from './syntaqlite_build.mjs';

describe('syntaqlitePerfettoCompilerArgs', () => {
  it('maps the checkout path out of the compiled WebAssembly module', () => {
    const args = syntaqlitePerfettoCompilerArgs(
      '/private/tmp/perfetto-checkout',
      '/private/tmp/perfetto-checkout/syntaqlite_perfetto.c',
      '/tmp/out/syntaqlite-perfetto.wasm',
    );

    expect(args).toContain(
      '-ffile-prefix-map=/private/tmp/perfetto-checkout=.',
    );
  });
});
