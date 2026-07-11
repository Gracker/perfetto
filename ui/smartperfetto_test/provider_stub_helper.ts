// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {APIRequestContext} from '@playwright/test';
import {z} from 'zod';
import {
  parseJsonResponse,
  SmartPerfettoE2eError,
} from './smartperfetto_e2e_helper';

const TrimmedUrlSchema = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ''));

const ProviderEnvironmentSchema = z.object({
  providerUrl: TrimmedUrlSchema.optional(),
  stubStateUrl: z.string().url().optional(),
});

const ProviderRequestSchema = z
  .object({
    id: z.string().min(1),
    path: z.string().min(1),
    model: z.string().min(1),
    stream: z.boolean(),
    toolCount: z.number().int().nonnegative(),
  })
  .passthrough();

const ProviderStateSchema = z
  .object({
    opened: z.number().int().nonnegative(),
    closed: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    requests: z.array(ProviderRequestSchema),
  })
  .passthrough();

export type ProviderState = Readonly<z.infer<typeof ProviderStateSchema>>;

export async function providerState(
  request: APIRequestContext,
): Promise<ProviderState> {
  const environment = ProviderEnvironmentSchema.parse({
    providerUrl: process.env.SMARTPERFETTO_E2E_PROVIDER_URL,
    stubStateUrl: process.env.SMARTPERFETTO_E2E_STUB_STATE_URL,
  });
  const stateUrl =
    environment.stubStateUrl ??
    (environment.providerUrl
      ? `${environment.providerUrl}/__state`
      : undefined);
  if (!stateUrl) {
    throw new SmartPerfettoE2eError(
      'configuration',
      'Provider stub URL is required to inspect E2E connection state.',
    );
  }
  const response = await request.get(stateUrl);
  return parseJsonResponse(response, ProviderStateSchema);
}
