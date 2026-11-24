// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import m from 'mithril';
import type {Trace} from '../../public/trace';
import {getCurrentAsset} from './attachment';
import {ChatClient, getChatScope, type Capabilities} from './client';
import {captureSelection, type ChatSelection, type Focus, type TraceReference} from './selection';

export interface Message {
  id: string;
  text: string;
  selection?: ChatSelection;
  answer: string;
  references: TraceReference[];
  status: 'running' | 'complete' | 'stopped' | 'failed';
  code?: string;
  tool?: string;
}

const errorCode = (error: unknown) =>
  error instanceof Error ? error.message : 'CONNECTION_INTERRUPTED';

export class Conversation {
  client = new ChatClient();
  capabilities?: Capabilities;
  messages: Message[] = [];
  draft = '';
  focus: Focus = 'selection';
  traceId?: string;
  error?: string;
  consenting = false;
  pending = false;
  stopping = false;
  private session?: string;
  private request?: AbortController;
  private uploadId = crypto.randomUUID();
  private disposed = false;

  constructor(readonly trace?: Trace, capabilities?: Capabilities) {
    this.capabilities = capabilities;
  }

  private refreshScope(): boolean {
    if (this.disposed) return false;
    if (this.client.scope.key === getChatScope().key) return true;
    this.reset();
    this.draft = '';
    this.client = new ChatClient();
    this.uploadId = crypto.randomUUID();
    this.capabilities = undefined;
    void this.loadCapabilities();
    return false;
  }

  checkScope(): void {
    this.refreshScope();
  }

  async loadCapabilities(): Promise<void> {
    const client = this.client;
    try {
      const result = await client.capabilities();
      if (!this.disposed && client === this.client) this.capabilities = result;
    } catch {
      if (!this.disposed && client === this.client) this.error = 'CONNECTION_FAILED';
    } finally {
      m.redraw();
    }
  }

  private async open(traceId?: string, signal?: AbortSignal): Promise<string> {
    if (!this.capabilities?.profile) throw new Error('MODEL_NOT_CONFIGURED');
    const response = await this.client.request('/sessions', {
      method: 'POST', signal,
      body: JSON.stringify({profileId: this.capabilities.profile.id,
        profileRevision: this.capabilities.profile.revision, traceId,
        consentOrigin: traceId ? this.capabilities.profile.origin : undefined}),
    });
    const {sessionId} = await response.json() as {sessionId: string};
    return sessionId;
  }

  private recoverSession(code: string, originalText?: string): boolean {
    if (code !== 'SESSION_CONFIGURATION_CHANGED' && code !== 'SESSION_UNAVAILABLE') {
      return false;
    }
    this.reset();
    this.draft ||= originalText ?? '';
    this.error = code;
    this.capabilities = undefined;
    void this.loadCapabilities();
    return true;
  }

  private close(session: string, client = this.client): void {
    void client.request(`/sessions/${session}`, {
      method: 'DELETE', signal: AbortSignal.timeout(3000), keepalive: true,
    }).catch(() => {});
  }

  reset(keepTrace = false): void {
    this.request?.abort();
    this.request = undefined;
    if (this.session) this.close(this.session);
    this.session = undefined;
    if (!keepTrace) this.traceId = undefined;
    this.messages = [];
    this.pending = false;
    this.stopping = false;
    this.consenting = false;
    this.error = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  cancelAttachment(): void {
    this.request?.abort();
    this.request = undefined;
    this.consenting = false;
    this.pending = false;
  }

  async attach(): Promise<void> {
    if (!this.trace || !this.refreshScope() || this.pending || !this.capabilities?.trace) return;
    const controller = new AbortController();
    this.request = controller;
    this.pending = true;
    this.error = undefined;
    const client = this.client;
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60_000)]);
      const id = await getCurrentAsset(this.trace, client, this.uploadId, signal);
      if (this.request !== controller || !this.refreshScope()) return;
      const session = await this.open(id, signal);
      if (this.request !== controller || !this.refreshScope()) {
        this.close(session, client);
        return;
      }
      if (this.session) this.close(this.session);
      this.session = session;
      this.traceId = id;
      this.messages = [];
      this.consenting = false;
    } catch (error) {
      if (this.request === controller) {
        const code = errorCode(error);
        if (!this.recoverSession(code)) this.error = code;
      }
    } finally {
      if (this.request === controller) {
        this.request = undefined;
        this.pending = false;
      }
      m.redraw();
    }
  }

  async send(): Promise<void> {
    const text = this.draft.trim();
    if (!this.refreshScope() || !text || this.pending || !this.capabilities?.chat) return;
    const controller = new AbortController();
    this.request = controller;
    const client = this.client;
    this.pending = true;
    this.error = undefined;
    const selection = this.trace && this.traceId ? captureSelection(this.trace, this.traceId, this.focus) : undefined;
    const item: Message = {id: crypto.randomUUID(), text, selection, answer: '', references: [], status: 'running'};
    try {
      const session = this.session ?? await this.open(this.traceId, controller.signal);
      if (this.request !== controller || !this.refreshScope()) {
        this.close(session, client);
        return;
      }
      this.session = session;
      this.draft = '';
      this.messages.push(item);
      if (this.messages.length > 60) this.messages.shift();
      m.redraw();
      await client.stream(session, item.id, {text, selection},
        AbortSignal.any([controller.signal, AbortSignal.timeout(190_000)]), event => {
          if (this.request !== controller || !this.refreshScope()) return;
          switch (event.type) {
            case 'turn_started': break;
            case 'answer_delta': item.answer += event.delta; break;
            case 'tool_status': item.tool = event.tool; break;
            case 'trace_reference': if (this.traceId === event.traceId) item.references.push(event); break;
            case 'turn_completed': item.answer = event.answer; item.status = 'complete'; break;
            case 'turn_cancelled': item.status = 'stopped'; break;
            case 'turn_failed': item.code = event.code; item.status = 'failed'; break;
          }
          m.redraw();
        });
      if (this.request === controller && item.code) this.recoverSession(item.code, text);
    } catch (error) {
      if (this.request === controller) {
        const code = errorCode(error);
        if (this.recoverSession(code, text)) return;
        if (this.messages.includes(item)) {
          item.status = 'failed';
          item.code = code;
        } else {
          this.error = code;
        }
      }
    } finally {
      if (this.request === controller) {
        this.request = undefined;
        this.pending = false;
        this.stopping = false;
      }
      m.redraw();
    }
  }

  async stop(): Promise<void> {
    const session = this.session;
    const item = this.messages.at(-1);
    if (!session || item?.status !== 'running' || this.stopping || !this.refreshScope()) return;
    this.stopping = true;
    const current = this.request;
    try {
      await this.client.request(`/sessions/${session}/turns/${item.id}/cancel`, {
        method: 'POST', signal: AbortSignal.timeout(3000),
      });
    } catch {
      if (current === this.request) {
        this.stopping = false;
        this.error = 'CONNECTION_INTERRUPTED';
      }
    } finally {
      m.redraw();
    }
  }
}
