// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {getDefaultSmartPerfettoBackendUrl} from '../../core/smartperfetto_backend_url';
import {
  getSmartPerfettoAuthSessionGeneration, handleSmartPerfettoAuthResponse, withSmartPerfettoAuth,
} from '../../core/smartperfetto_auth';
import {
  buildSmartPerfettoContextHeaders, buildSmartPerfettoWorkspaceApiUrl,
} from '../../core/smartperfetto_request_context';
import type {TraceReference} from './selection';

export interface Capabilities {
  enabled: boolean;
  chat: boolean;
  trace: boolean;
  code?: string;
  profile?: {id: string; model: string; origin: string; revision: string};
}

export type TurnEvent = {
  version: number; sessionId: string; clientTurnId: string; seq: number;
} & (
  | {type: 'turn_started'}
  | {type: 'answer_delta'; delta: string}
  | {type: 'tool_status'; tool: string}
  | ({type: 'trace_reference'} & TraceReference)
  | {type: 'turn_completed'; answer: string}
  | {type: 'turn_cancelled'}
  | {type: 'turn_failed'; code: string}
);

export function getChatScope() {
  const backend = getDefaultSmartPerfettoBackendUrl();
  const base = buildSmartPerfettoWorkspaceApiUrl(backend, 'perfetto-chat/v1');
  const headers = buildSmartPerfettoContextHeaders();
  const key = JSON.stringify([base, headers, getSmartPerfettoAuthSessionGeneration()]);
  return {backend, base, headers, key};
}

export class ChatClient {
  readonly scope = getChatScope();

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(this.scope.headers);
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
    const response = handleSmartPerfettoAuthResponse(await fetch(this.scope.base + path,
      withSmartPerfettoAuth({...init, headers, cache: 'no-store', redirect: 'error'})));
    if (!response.ok) {
      const reason = await response.json().catch(() => undefined) as {code?: string} | undefined;
      throw new Error(reason?.code ?? 'CONNECTION_FAILED');
    }
    return response;
  }

  async capabilities(): Promise<Capabilities> {
    return (await this.request('/capabilities', {signal: AbortSignal.timeout(5000)})).json();
  }

  async stream(
    sessionId: string,
    clientTurnId: string,
    body: object,
    signal: AbortSignal,
    onEvent: (event: TurnEvent) => void,
  ): Promise<void> {
    const response = await this.request(`/sessions/${sessionId}/turns`, {
      method: 'POST', body: JSON.stringify({...body, clientTurnId}), signal,
    });
    if (!response.body || !response.headers.get('Content-Type')?.startsWith('text/event-stream')) {
      throw new Error('CONNECTION_FAILED');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let seq = 0;
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) throw new Error('CONNECTION_INTERRUPTED');
        pending += decoder.decode(value, {stream: true});
        let boundary: number;
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const frame = pending.slice(0, boundary);
          pending = pending.slice(boundary + 2);
          if (!frame.startsWith('data: ') || frame.length > 192_000) {
            throw new Error('CONNECTION_INTERRUPTED');
          }
          const event = JSON.parse(frame.slice(6)) as TurnEvent;
          if (event.version !== 1 || event.sessionId !== sessionId ||
              event.clientTurnId !== clientTurnId || event.seq !== seq + 1) {
            throw new Error('CONNECTION_INTERRUPTED');
          }
          seq = event.seq;
          onEvent(event);
          if (event.type === 'turn_completed' || event.type === 'turn_cancelled' ||
              event.type === 'turn_failed') return;
        }
        if (pending.length > 192_000) throw new Error('CONNECTION_INTERRUPTED');
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
