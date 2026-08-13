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

import path from 'node:path';
import fs from 'node:fs';
import {describe, expect, it} from 'vitest';
import {pluginPerfettoVersion} from './vite.config.mjs';

describe('pluginPerfettoVersion', () => {
  it('uses a checkout-independent virtual module id', () => {
    let rootDir = process.cwd();
    while (!fs.existsSync(path.join(rootDir, 'ui/vite.config.mjs'))) {
      const parent = path.dirname(rootDir);
      if (parent === rootDir) throw new Error('Perfetto checkout not found');
      rootDir = parent;
    }
    const importer = path.join(rootDir, 'ui/src/base/logging.ts');
    const plugin = pluginPerfettoVersion();
    const id = plugin.resolveId?.('../virtual/version', importer);

    expect(id).toBe('\0perfetto:version:ui/src/virtual/version');
  });
});
