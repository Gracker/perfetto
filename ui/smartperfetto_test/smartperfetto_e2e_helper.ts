// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {APIRequestContext, APIResponse} from '@playwright/test';
import {readFile, stat} from 'fs/promises';
import * as path from 'path';
import {z, type ZodType} from 'zod';

const helperDir = __dirname;
const defaultFixtureDir = path.resolve(helperDir, '../../../test-traces');

const TrimmedUrlSchema = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ''));

const EnvironmentSchema = z.object({
  backendUrl: TrimmedUrlSchema,
  fixtureDir: z
    .string()
    .trim()
    .min(1)
    .transform((value) => path.resolve(value)),
  workspaceId: z.string().trim().min(1),
  traceProcessorPortMin: z.coerce.number().int().min(1).max(65535),
  traceProcessorPortMax: z.coerce.number().int().min(1).max(65535),
});

const TraceIdSchema = z.string().trim().min(1).brand<'TraceId'>();
const AgentSessionIdSchema = z.string().trim().min(1).brand<'AgentSessionId'>();
const AgentRunIdSchema = z.string().trim().min(1).brand<'AgentRunId'>();

const WorkspaceTraceSchema = z
  .object({
    id: TraceIdSchema,
    filename: z.string().min(1),
    size: z.number().finite().nonnegative(),
    uploadedAt: z.string().min(1),
    status: z.string().min(1),
    port: z.number().int().positive().optional(),
  })
  .passthrough();

const UploadTraceResponseSchema = z.object({
  success: z.literal(true),
  trace: WorkspaceTraceSchema,
});

const ListTracesResponseSchema = z.object({
  traces: z.array(WorkspaceTraceSchema),
});

const DeleteTraceResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().min(1),
});

const AgentRunStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting_user',
  'completed',
  'failed',
  'cancelled',
  'quota_exceeded',
]);

const AgentStatusSchema = z
  .object({
    success: z.literal(true),
    sessionId: AgentSessionIdSchema,
    status: AgentRunStatusSchema,
    traceId: TraceIdSchema,
    query: z.string(),
    createdAt: z.number().finite(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  })
  .passthrough();

const CancelAgentResponseSchema = z
  .object({
    success: z.literal(true),
    sessionId: AgentSessionIdSchema,
    runId: AgentRunIdSchema,
    status: AgentRunStatusSchema,
    outcome: z.enum(['cancelled', 'already_cancelled']),
  })
  .passthrough();

export type WorkspaceTrace = Readonly<z.infer<typeof WorkspaceTraceSchema>>;
export type AgentStatus = Readonly<z.infer<typeof AgentStatusSchema>>;
export type CancelAgentResult = Readonly<
  z.infer<typeof CancelAgentResponseSchema>
>;

export interface DualTraceFixturePaths {
  readonly light: string;
  readonly heavy: string;
}

export interface TraceProcessorPortRange {
  readonly min: number;
  readonly max: number;
}

type SmartPerfettoE2eErrorCode = 'configuration' | 'http' | 'payload';

export class SmartPerfettoE2eError extends Error {
  constructor(
    readonly code: SmartPerfettoE2eErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SmartPerfettoE2eError';
  }
}

export function getDualTraceFixturePaths(): DualTraceFixturePaths {
  const fixtureDir = getEnvironment().fixtureDir;
  return {
    light: path.join(fixtureDir, 'launch_light.pftrace'),
    heavy: path.join(fixtureDir, 'lacunh_heavy.pftrace'),
  };
}

export function getTraceProcessorPortRange(): TraceProcessorPortRange {
  const environment = getEnvironment();
  return {
    min: environment.traceProcessorPortMin,
    max: environment.traceProcessorPortMax,
  };
}

export async function uploadTrace(
  request: APIRequestContext,
  absolutePath: string,
): Promise<WorkspaceTrace> {
  if (!path.isAbsolute(absolutePath)) {
    throw new SmartPerfettoE2eError(
      'configuration',
      `Trace fixture path must be absolute: ${absolutePath}`,
    );
  }
  const traceStats = await stat(absolutePath);
  if (!traceStats.isFile()) {
    throw new SmartPerfettoE2eError(
      'configuration',
      `Trace fixture is not a file: ${absolutePath}`,
    );
  }

  const response = await request.post(workspaceResourceUrl('traces/upload'), {
    multipart: {
      file: {
        name: path.basename(absolutePath),
        mimeType: 'application/octet-stream',
        buffer: await readFile(absolutePath),
      },
    },
  });
  return (await parseJsonResponse(response, UploadTraceResponseSchema)).trace;
}

export async function listTraces(
  request: APIRequestContext,
): Promise<ReadonlyArray<WorkspaceTrace>> {
  const response = await request.get(workspaceResourceUrl('traces'));
  return (await parseJsonResponse(response, ListTracesResponseSchema)).traces;
}

export async function deleteTrace(
  request: APIRequestContext,
  traceId: string,
): Promise<void> {
  const parsedTraceId = TraceIdSchema.parse(traceId);
  const response = await request.delete(
    workspaceResourceUrl(`traces/${encodeURIComponent(parsedTraceId)}`),
  );
  await parseJsonResponse(response, DeleteTraceResponseSchema);
}

export async function agentStatus(
  request: APIRequestContext,
  sessionId: string,
): Promise<AgentStatus> {
  const parsedSessionId = AgentSessionIdSchema.parse(sessionId);
  const response = await request.get(
    workspaceResourceUrl(`agent/${encodeURIComponent(parsedSessionId)}/status`),
    {maxRetries: 1},
  );
  return parseJsonResponse(response, AgentStatusSchema);
}

export async function cancelAgent(
  request: APIRequestContext,
  sessionId: string,
  runId: string,
): Promise<CancelAgentResult> {
  const parsedSessionId = AgentSessionIdSchema.parse(sessionId);
  const parsedRunId = AgentRunIdSchema.parse(runId);
  const response = await request.post(
    workspaceResourceUrl(`agent/${encodeURIComponent(parsedSessionId)}/cancel`),
    {data: {runId: parsedRunId}},
  );
  return parseJsonResponse(response, CancelAgentResponseSchema);
}

function getEnvironment(): z.infer<typeof EnvironmentSchema> {
  return EnvironmentSchema.parse({
    backendUrl:
      process.env.SMARTPERFETTO_E2E_BACKEND_URL ?? 'http://127.0.0.1:3000',
    fixtureDir: process.env.SMARTPERFETTO_E2E_FIXTURE_DIR ?? defaultFixtureDir,
    workspaceId:
      process.env.SMARTPERFETTO_E2E_WORKSPACE_ID ?? 'default-workspace',
    traceProcessorPortMin: process.env.SMARTPERFETTO_E2E_TP_PORT_MIN ?? '9100',
    traceProcessorPortMax: process.env.SMARTPERFETTO_E2E_TP_PORT_MAX ?? '9900',
  });
}

function workspaceResourceUrl(resourcePath: string): string {
  const environment = getEnvironment();
  const workspaceId = encodeURIComponent(environment.workspaceId);
  return new URL(
    `/api/workspaces/${workspaceId}/${resourcePath}`,
    `${environment.backendUrl}/`,
  ).toString();
}

export async function parseJsonResponse<T>(
  response: APIResponse,
  schema: ZodType<T>,
): Promise<T> {
  const responseBody = await response.text();
  if (!response.ok()) {
    throw new SmartPerfettoE2eError(
      'http',
      `SmartPerfetto E2E request failed: ${response.status()} ${response.url()}\n${responseBody.slice(0, 2000)}`,
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(responseBody);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new SmartPerfettoE2eError(
        'payload',
        `Invalid JSON from ${response.url()}: ${error.message}`,
      );
    }
    throw error;
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SmartPerfettoE2eError(
      'payload',
      `Invalid response from ${response.url()}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
