// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * One in-memory catalog of what a backend partition has registered —
 * codebases and knowledge bases — shared by the input
 * bar chip, the context popover and the Settings panel. It is keyed by the
 * backend, the credential and the full tenant/workspace/user scope: a
 * different key clears every list at once, and an answer that arrives for an
 * older key (or after a newer refresh started) is dropped.
 */

import m from 'mithril';

import {
  listCodebases,
  listKnowledgeBases,
  type CodebaseSummary,
  type KnowledgeBaseSummary,
} from './codebase_api';
import {uiText as text} from './ui_language';

export interface CatalogIdentity {
  backendUrl: string;
  apiKey?: string;
  /** `analysisContextScopeKey`: backend + tenant + workspace + user. */
  scopeKey: string;
}

/** A non-reversible tag, so the credential separates partitions without appearing in a key. */
function credentialTag(apiKey: string | undefined): string {
  if (!apiKey) return '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < apiKey.length; index++) {
    hash ^= apiKey.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Backend, credential and scope in one key; the credential appears only as a tag. */
export function catalogIdentityKey(identity: CatalogIdentity): string {
  return [identity.backendUrl.replace(/\/+$/, ''), credentialTag(identity.apiKey), identity.scopeKey].join('\0');
}

export interface AnalysisCatalogState {
  key: string;
  status: 'empty' | 'loading' | 'ready' | 'error';
  featureEnabled: boolean;
  codebases: CodebaseSummary[];
  /** Every kind `/knowledge` lists, retired legacy Wiki records included. */
  knowledgeBases: KnowledgeBaseSummary[];
  /** Which lists the latest finished refresh actually read; a failed one keeps its previous rows. */
  loaded: {codebases: boolean; knowledgeBases: boolean};
  errors: string[];
}

const RETRY_DELAY_MS = 15_000;

function emptyState(key: string): AnalysisCatalogState {
  return {
    key, status: 'empty', featureEnabled: true, codebases: [], knowledgeBases: [],
    loaded: {codebases: false, knowledgeBases: false}, errors: [],
  };
}

function failure(result: PromiseSettledResult<unknown>, fallback: string): string[] {
  return result.status === 'rejected'
    ? [result.reason instanceof Error ? result.reason.message : fallback]
    : [];
}

export class AnalysisCatalog {
  private state = emptyState('');
  private epoch = 0;
  private retryAfter = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** The lists for this identity; a different identity starts from empty. */
  read(identity: CatalogIdentity): AnalysisCatalogState {
    this.bind(identity);
    return this.state;
  }

  /** Load once per identity, and again after a failure once the retry delay passed. */
  ensure(identity: CatalogIdentity): void {
    this.bind(identity);
    const due = this.state.status === 'empty' ||
      (this.state.status === 'error' && this.now() >= this.retryAfter);
    if (due) void this.refresh(identity);
  }

  /**
   * Read all lists again. A newer refresh supersedes this one (its answer is
   * dropped and the current state returned); another identity makes it
   * resolve undefined.
   */
  async refresh(identity: CatalogIdentity): Promise<AnalysisCatalogState | undefined> {
    this.bind(identity);
    const key = this.state.key;
    const epoch = ++this.epoch;
    this.state = {...this.state, status: 'loading'};
    const [codebases, knowledgeBases] = await Promise.allSettled([
      listCodebases(identity.backendUrl, identity.apiKey),
      listKnowledgeBases(identity.backendUrl, identity.apiKey),
    ]);
    if (key !== this.state.key) return undefined;
    if (epoch !== this.epoch) return this.state;
    const previous = this.state;
    const errors = [
      ...failure(codebases, text('源码列表加载失败', 'Failed to load codebases')),
      ...failure(knowledgeBases, text('知识库列表加载失败', 'Failed to load knowledge bases')),
    ];
    this.retryAfter = errors.length > 0 ? this.now() + RETRY_DELAY_MS : 0;
    this.state = {
      key,
      status: errors.length > 0 ? 'error' : 'ready',
      featureEnabled: codebases.status === 'fulfilled' ? codebases.value.featureEnabled : previous.featureEnabled,
      codebases: codebases.status === 'fulfilled' ? codebases.value.codebases : previous.codebases,
      knowledgeBases: knowledgeBases.status === 'fulfilled'
        ? knowledgeBases.value.filter(source => (source.lifecycleState ?? 'active') === 'active')
        : previous.knowledgeBases,
      loaded: {
        codebases: codebases.status === 'fulfilled',
        knowledgeBases: knowledgeBases.status === 'fulfilled',
      },
      errors,
    };
    m.redraw();
    return this.state;
  }

  private bind(identity: CatalogIdentity): void {
    const key = catalogIdentityKey(identity);
    if (key === this.state.key) return;
    this.epoch++;
    this.retryAfter = 0;
    this.state = emptyState(key);
  }
}

/** The page's one catalog. */
export const analysisCatalog = new AnalysisCatalog();
