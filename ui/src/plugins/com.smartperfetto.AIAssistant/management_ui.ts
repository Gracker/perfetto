// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Shared pieces of the Settings management views (codebases, knowledge
 * bases, the consent review): one style table, one error-message rule, and
 * one way to run a backend mutation whose result is dropped once the view's
 * identity (backend, credential, scope, mount) changed.
 */

export const MANAGEMENT_STYLES = {
  shell: {
    padding: '18px',
    minHeight: '420px',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
  },
  title: {
    margin: 0,
    color: 'var(--chat-text)',
    fontSize: '15px',
    fontWeight: 700,
  },
  subtitle: {
    color: 'var(--chat-text-secondary)',
    fontSize: '12px',
    marginTop: '4px',
  },
  button: {
    minHeight: '40px',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '8px 11px',
    cursor: 'pointer',
    fontSize: '12px',
  },
  primary: {
    background: 'var(--chat-primary)',
    borderColor: 'var(--chat-primary)',
    color: 'white',
  },
  list: {
    display: 'grid',
    gap: '10px',
  },
  card: {
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg)',
    padding: '12px',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: '12px',
  },
  name: {
    color: 'var(--chat-text)',
    fontSize: '13px',
    fontWeight: 700,
  },
  meta: {
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
    fontFamily: 'monospace',
    overflowWrap: 'anywhere',
  },
  chips: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '8px',
  },
  chip: {
    border: '1px solid var(--chat-border)',
    borderRadius: '999px',
    padding: '2px 7px',
    color: 'var(--chat-text-secondary)',
    fontSize: '11px',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
    marginTop: '10px',
  },
  /** An inline review block (consent disclosure) inside a card. */
  context: {
    border: '1px solid var(--chat-border)',
    borderRadius: '10px',
    background: 'var(--chat-bg-secondary)',
    padding: '12px',
    marginBottom: '14px',
  },
  check: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '8px',
    color: 'var(--chat-text)',
    cursor: 'pointer',
  },
  empty: {
    border: '1px dashed var(--chat-border)',
    borderRadius: '8px',
    padding: '22px',
    textAlign: 'center',
    color: 'var(--chat-text-secondary)',
  },
  error: {
    color: 'var(--chat-error)',
    fontSize: '12px',
    marginBottom: '10px',
  },
  success: {
    color: 'var(--chat-success)',
    fontSize: '12px',
    marginBottom: '10px',
  },
  input: {
    width: '100%',
    minHeight: '40px',
    boxSizing: 'border-box',
    border: '1px solid var(--chat-border)',
    borderRadius: '8px',
    background: 'var(--chat-bg-secondary)',
    color: 'var(--chat-text)',
    padding: '9px 10px',
    fontSize: '13px',
    fontFamily: 'inherit',
  },
  /** A sub-form under a header or card, separated by a divider. */
  divided: {
    borderTop: '1px solid var(--chat-border)',
    marginTop: '10px',
    paddingTop: '10px',
  },
} as const;

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export type CurrentResult<T> = {ok: true; value: T} | {ok: false; error: unknown};

/**
 * Run `action` and report its outcome only while `isCurrent()` still holds;
 * a result for a superseded identity resolves undefined and must be ignored.
 */
export async function runWhileCurrent<T>(
  isCurrent: () => boolean,
  action: () => Promise<T>,
): Promise<CurrentResult<T> | undefined> {
  try {
    const value = await action();
    return isCurrent() ? {ok: true, value} : undefined;
  } catch (error) {
    return isCurrent() ? {ok: false, error} : undefined;
  }
}
