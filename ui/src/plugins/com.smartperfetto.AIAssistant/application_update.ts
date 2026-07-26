// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type ApplicationUpdateState =
  | 'disabled'
  | 'unknown'
  | 'checking'
  | 'up_to_date'
  | 'update_available'
  | 'ahead'
  | 'unsupported_channel'
  | 'error';

export interface ApplicationUpdateStatus {
  schemaVersion: 1;
  state: ApplicationUpdateState;
  checkedAt?: string;
  stale?: boolean;
  current: {
    distribution: 'source' | 'docker' | 'portable' | 'npm';
    channel: 'stable' | 'nightly';
    version: string;
    commit?: string;
    target: {os: string; arch: string; id?: string};
    signingMode: string;
  };
  latest?: {
    version: string;
    commit?: string;
    publishedAt?: string;
    releaseUrl: string;
    asset?: {name: string; url: string; sha256?: string};
  };
  action?:
    | {kind: 'npm'; command: string; url: string}
    | {kind: 'docker'; command: string; url: string; imageTag: string}
    | {kind: 'portable'; url: string; sha256?: string}
    | {kind: 'source'; command: string; url: string};
  lastError?: {code: string; message: string; at: string};
}

const STATES = new Set<ApplicationUpdateState>([
  'disabled',
  'unknown',
  'checking',
  'up_to_date',
  'update_available',
  'ahead',
  'unsupported_channel',
  'error',
]);
const DISTRIBUTIONS = new Set([
  'source',
  'docker',
  'portable',
  'npm',
]);
const CHANNELS = new Set(['stable', 'nightly']);
const APPROVED_UPDATE_HOSTS = new Set([
  'github.com',
  'hub.docker.com',
  'www.npmjs.com',
]);
const STABLE_SEMVER = /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/;
const FULL_GIT_COMMIT = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function approvedHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      APPROVED_UPDATE_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

function optionalTimestamp(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === 'string' && Number.isFinite(Date.parse(value)))
  );
}

function validLatest(value: unknown): boolean {
  const latest = record(value);
  if (
    !latest ||
    typeof latest.version !== 'string' ||
    !STABLE_SEMVER.test(latest.version) ||
    !approvedHttpsUrl(latest.releaseUrl) ||
    !optionalTimestamp(latest.publishedAt) ||
    (latest.commit !== undefined &&
      (typeof latest.commit !== 'string' ||
        !FULL_GIT_COMMIT.test(latest.commit)))
  ) {
    return false;
  }
  if (latest.asset === undefined) return true;
  const asset = record(latest.asset);
  return Boolean(
    asset &&
      typeof asset.name === 'string' &&
      asset.name.length > 0 &&
      asset.name.length <= 255 &&
      !asset.name.includes('/') &&
      !asset.name.includes('\\') &&
      approvedHttpsUrl(asset.url) &&
      (asset.sha256 === undefined ||
        (typeof asset.sha256 === 'string' && SHA256.test(asset.sha256))),
  );
}

function validCommand(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 2048 &&
    !/[\r\n\0]/.test(value)
  );
}

function validAction(value: unknown, distribution: string): boolean {
  const action = record(value);
  if (!action || typeof action.kind !== 'string') return false;
  switch (action.kind) {
    case 'npm':
      return (
        distribution === 'npm' &&
        validCommand(action.command) &&
        approvedHttpsUrl(action.url)
      );
    case 'docker':
      return (
        distribution === 'docker' &&
        validCommand(action.command) &&
        typeof action.imageTag === 'string' &&
        action.imageTag.length > 0 &&
        action.imageTag.length <= 128 &&
        approvedHttpsUrl(action.url)
      );
    case 'portable':
      return (
        distribution === 'portable' &&
        approvedHttpsUrl(action.url) &&
        (action.sha256 === undefined ||
          (typeof action.sha256 === 'string' && SHA256.test(action.sha256)))
      );
    case 'source':
      return (
        distribution === 'source' &&
        validCommand(action.command) &&
        approvedHttpsUrl(action.url)
      );
    default:
      return false;
  }
}

export function parseApplicationUpdateStatus(
  value: unknown,
): ApplicationUpdateStatus | undefined {
  const root = record(value);
  const current = record(root?.current);
  const target = record(current?.target);
  if (
    root?.schemaVersion !== 1 ||
    typeof root.state !== 'string' ||
    !STATES.has(root.state as ApplicationUpdateState) ||
    typeof current?.distribution !== 'string' ||
    !DISTRIBUTIONS.has(current.distribution) ||
    typeof current.channel !== 'string' ||
    !CHANNELS.has(current.channel) ||
    typeof current.version !== 'string' ||
    !STABLE_SEMVER.test(current.version) ||
    typeof current.signingMode !== 'string' ||
    typeof target?.os !== 'string' ||
    typeof target.arch !== 'string' ||
    !optionalTimestamp(root.checkedAt) ||
    (root.latest !== undefined && !validLatest(root.latest)) ||
    (root.action !== undefined &&
      !validAction(root.action, current.distribution)) ||
    (root.state === 'update_available' &&
      (root.latest === undefined || root.action === undefined))
  ) {
    return undefined;
  }
  return value as ApplicationUpdateStatus;
}

export function applicationUpdateDismissKey(
  backendUrl: string,
  status: ApplicationUpdateStatus,
): string | undefined {
  if (status.state !== 'update_available' || !status.latest?.version) {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(backendUrl).origin;
  } catch {
    return undefined;
  }
  return [
    'smartperfetto-application-update-dismissed',
    encodeURIComponent(origin),
    status.current.distribution,
    status.current.channel,
    status.latest.version,
  ].join(':');
}

export function applicationUpgradeInstruction(
  status: ApplicationUpdateStatus,
): {command?: string; url?: string; sha256?: string} {
  const action = status.action;
  if (!action) return {};
  if (action.kind === 'portable') {
    return {url: action.url, ...(action.sha256 ? {sha256: action.sha256} : {})};
  }
  return {command: action.command, url: action.url};
}
