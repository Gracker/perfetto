// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {Request, Response} from '@playwright/test';
import {z, type ZodType} from 'zod';

const TracePaneSchema = z.object({
  side: z.string(),
  traceSide: z.enum(['current', 'reference']),
  traceId: z.string().min(1),
  traceName: z.string().min(1),
  active: z.boolean(),
});

const AnalyzeRequestSchema = z
  .object({
    query: z.string().min(1),
    traceId: z.string().min(1),
    referenceTraceId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    options: z
      .object({
        analysisMode: z.string(),
        tracePairContext: z.object({
          layout: z.enum(['horizontal', 'vertical']),
          primarySide: z.string(),
          referenceSide: z.string(),
          workspaceOpen: z.boolean(),
          splitPercent: z.number(),
          panes: z.array(TracePaneSchema).length(2),
        }),
      })
      .passthrough(),
  })
  .passthrough();

const AnalyzeResponseSchema = z
  .object({
    success: z.literal(true),
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    requestId: z.string().min(1),
    runSequence: z.number().int().positive(),
  })
  .passthrough();

const UploadResponseSchema = z.object({
  success: z.literal(true),
  trace: z
    .object({
      id: z.string().min(1),
      filename: z.string().min(1),
      size: z.number().positive(),
      status: z.string().min(1),
    })
    .passthrough(),
});

const CancelResponseSchema = z.object({
  success: z.literal(true),
  sessionId: z.string().min(1),
  runId: z.string().min(1),
  status: z.string().min(1),
  outcome: z.enum(['cancelled', 'already_cancelled']),
});

const StatusObservabilitySchema = z.object({
  observability: z.object({
    runId: z.string().min(1),
  }),
});

export type AnalyzeRequest = Readonly<z.infer<typeof AnalyzeRequestSchema>>;
export type AnalyzeResponse = Readonly<z.infer<typeof AnalyzeResponseSchema>>;
export type UploadResponse = Readonly<z.infer<typeof UploadResponseSchema>>;
export type CancelResponse = Readonly<z.infer<typeof CancelResponseSchema>>;

export function parseAnalyzeRequest(request: Request): AnalyzeRequest {
  return AnalyzeRequestSchema.parse(request.postDataJSON());
}

export function parseAnalyzeResponse(
  response: Response,
): Promise<AnalyzeResponse> {
  return parseResponse(response, AnalyzeResponseSchema);
}

export function parseUploadResponse(
  response: Response,
): Promise<UploadResponse> {
  return parseResponse(response, UploadResponseSchema);
}

export function parseCancelResponse(
  response: Response,
): Promise<CancelResponse> {
  return parseResponse(response, CancelResponseSchema);
}

export function parseAnalyzePayload(payload: unknown): AnalyzeResponse {
  return AnalyzeResponseSchema.parse(payload);
}

export function statusRunId(payload: unknown): string {
  return StatusObservabilitySchema.parse(payload).observability.runId;
}

async function parseResponse<T>(
  response: Response,
  schema: ZodType<T>,
): Promise<T> {
  const payload: unknown = await response.json();
  return schema.parse(payload);
}
