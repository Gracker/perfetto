// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)

import {smartPerfettoFetch} from '../../core/smartperfetto_auth';
import {buildSmartPerfettoContextHeaders, buildSmartPerfettoWorkspaceApiUrl} from '../../core/smartperfetto_request_context';
import {buildAssistantApiV1Url} from './assistant_api_v1';
import {getConversation, isAssistantWorkSummary, type ConversationClientConfig, type ConversationSnapshot} from './conversation_client';
import type {AssistantWorkCatalogResponse, AssistantWorkItem} from './generated/data_contract.types';
import {resolveReportDownloadTarget, suggestedReportFilename} from './report_download';
import {download} from '../../base/download_utils';

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function headers(config: ConversationClientConfig): Record<string, string> {
  const result = buildSmartPerfettoContextHeaders({'Content-Type': 'application/json'});
  const key = config.apiKey?.trim();
  return key ? {...result, 'x-api-key': key, Authorization: `Bearer ${key}`} : result;
}
async function read(config: ConversationClientConfig, url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await smartPerfettoFetch(url, {headers: headers(config), signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = object(await response.json());
  if (body?.success !== true) throw new Error('Work response unavailable');
  return body;
}

export async function readAssistantWork(config: ConversationClientConfig, filter: 'recent' | 'needs_input',
  signal: AbortSignal, cursor?: string): Promise<AssistantWorkCatalogResponse> {
  const url = new URL(buildAssistantApiV1Url(config.backendUrl, '/work'));
  url.searchParams.set('filter', filter); url.searchParams.set('limit', '20');
  if (cursor) url.searchParams.set('cursor', cursor);
  const body = await read(config, url.toString(), signal);
  if (body.filter !== filter || !Array.isArray(body.items) || body.items.length > 50 ||
    (body.nextCursor !== undefined && (typeof body.nextCursor !== 'string' || body.nextCursor.length > 1024))) {
    throw new Error('Invalid work catalog response');
  }
  for (const value of body.items) {
    const item = object(value); const work = object(item?.work);
    if (!item || !['conversation', 'analysis'].includes(String(item.surface)) ||
      !['available', 'unavailable'].includes(String(item.metadata)) || !work ||
      typeof work.sessionId !== 'string' || !work.sessionId ||
      !isAssistantWorkSummary(work, work.sessionId) ||
      (work.runId !== undefined && (typeof work.runId !== 'string' || !work.runId)) ||
      (item.metadataReason !== undefined && item.metadataReason !== 'latest_run_ambiguous') ||
      (!work.runId && (item.result !== undefined || item.reportId !== undefined)) ||
      (item.reportId !== undefined && typeof item.reportId !== 'string') ||
      (item.result !== undefined && (object(item.result)?.kind !== 'snapshot' || typeof object(item.result)?.id !== 'string'))) {
      throw new Error('Invalid work catalog item');
    }
  }
  return body as unknown as AssistantWorkCatalogResponse;
}

export type AssistantWorkDetail =
  | {kind: 'conversation'; conversation: ConversationSnapshot}
  | {kind: 'analysis'; body: string; record: Record<string, unknown>; exactRun: boolean; reportUrl?: string};

export async function readAssistantWorkDetail(config: ConversationClientConfig, item: AssistantWorkItem,
  signal: AbortSignal): Promise<AssistantWorkDetail> {
  if (item.surface === 'conversation') return {kind: 'conversation',
    conversation: await getConversation(config, item.work.sessionId, signal)};
  if (item.result) {
    const body = await read(config, buildSmartPerfettoWorkspaceApiUrl(config.backendUrl,
      'analysis-results', `/${encodeURIComponent(item.result.id)}`), signal);
    const snapshot = object(body.snapshot); const summary = object(snapshot?.summary);
    if (!item.work.runId || !snapshot || typeof snapshot.runId !== 'string' || !snapshot.runId ||
      snapshot.id !== item.result.id || snapshot.sessionId !== item.work.sessionId ||
      snapshot.runId !== item.work.runId || !summary) throw new Error('Analysis result identity changed');
    return {kind: 'analysis', record: snapshot, exactRun: true,
      body: typeof summary.conclusion === 'string' ? summary.conclusion
        : typeof summary.headline === 'string' ? summary.headline : '',
      ...(typeof snapshot.reportId === 'string' ? {reportUrl: `/api/reports/${encodeURIComponent(snapshot.reportId)}`} : {})};
  }
  const body = await read(config, buildAssistantApiV1Url(config.backendUrl,
    `/${encodeURIComponent(item.work.sessionId)}/turns/latest`), signal);
  const turn = object(body.turn); const result = object(turn?.result);
  if (body.sessionId !== item.work.sessionId || !turn) throw new Error('Analysis history identity changed');
  return {kind: 'analysis', record: turn, exactRun: Boolean(item.work.runId && object(result?.completion)?.runId === item.work.runId),
    body: typeof result?.conclusion === 'string' ? result.conclusion
      : typeof result?.message === 'string' ? result.message : '',
    ...(typeof result?.reportUrl === 'string' ? {reportUrl: result.reportUrl} : {})};
}

export async function downloadAssistantWorkReport(config: ConversationClientConfig, reportUrl: string,
  signal: AbortSignal, isCurrent: () => boolean): Promise<void> {
  if (signal.aborted || !isCurrent()) return;
  const target = resolveReportDownloadTarget(reportUrl, config.backendUrl);
  const response = await smartPerfettoFetch(target.exportUrl, {headers: headers(config), signal});
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  if (signal.aborted || !isCurrent()) return;
  await download({content: blob, mimeType: 'text/html',
    fileName: suggestedReportFilename(response.headers.get('Content-Disposition'), target.reportId)});
}
