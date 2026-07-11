// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {defineConfig} from '@playwright/test';
import * as path from 'path';
import {z} from 'zod';

const uiRoot = __dirname;

const ConfigEnvironmentSchema = z.object({
  frontendUrl: z.string().url(),
  artifactDir: z.string().trim().min(1).optional(),
  chromeChannel: z.string().trim().min(1),
  backendApiKey: z.string().trim().min(1),
});

const configEnvironment = ConfigEnvironmentSchema.parse({
  frontendUrl:
    process.env.SMARTPERFETTO_E2E_FRONTEND_URL ?? 'http://127.0.0.1:10000',
  artifactDir: process.env.SMARTPERFETTO_E2E_ARTIFACT_DIR,
  chromeChannel: process.env.SMARTPERFETTO_E2E_CHROME_CHANNEL ?? 'chrome',
  backendApiKey:
    process.env.SMARTPERFETTO_E2E_BACKEND_API_KEY ??
    'smartperfetto-e2e-backend',
});

const artifactDir = configEnvironment.artifactDir
  ? path.resolve(configEnvironment.artifactDir)
  : path.resolve(uiRoot, '../../output/playwright/dual-trace-e2e');

export default defineConfig({
  testDir: './smartperfetto_test',
  outputDir: path.join(artifactDir, 'test-results'),
  timeout:
    process.env.SMARTPERFETTO_E2E_REAL_PROVIDER === '1'
      ? 15 * 60 * 1000
      : 10 * 60 * 1000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [
    ['line'],
    [
      'html',
      {
        outputFolder: path.join(artifactDir, 'html-report'),
        open: 'never',
      },
    ],
  ],
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: configEnvironment.frontendUrl,
    channel: configEnvironment.chromeChannel,
    headless: process.env.SMARTPERFETTO_E2E_HEADLESS !== '0',
    viewport: {width: 1920, height: 1080},
    actionTimeout: 30_000,
    navigationTimeout: 120_000,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      Authorization: `Bearer ${configEnvironment.backendApiKey}`,
      'x-api-key': configEnvironment.backendApiKey,
    },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
});
