// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from 'vitest';
import {
  applicationUpdateDismissKey,
  applicationUpgradeInstruction,
  parseApplicationUpdateStatus,
  type ApplicationUpdateStatus,
} from './application_update';

const status: ApplicationUpdateStatus = {
  schemaVersion: 1,
  state: 'update_available',
  current: {
    distribution: 'docker',
    channel: 'stable',
    version: '1.2.2',
    target: {os: 'linux', arch: 'x64'},
    signingMode: 'container',
  },
  latest: {
    version: '1.3.0',
    releaseUrl: 'https://github.com/Gracker/SmartPerfetto/releases/tag/v1.3.0',
  },
  action: {
    kind: 'docker',
    imageTag: '1.3.0',
    command: 'SMARTPERFETTO_DOCKER_TAG=1.3.0 docker compose up -d',
    url: 'https://hub.docker.com/r/w553000664/smartperfetto/tags?name=1.3.0',
  },
};

describe('application update projection', () => {
  it('accepts the versioned backend contract and rejects partial payloads', () => {
    expect(parseApplicationUpdateStatus(status)).toEqual(status);
    expect(parseApplicationUpdateStatus({schemaVersion: 1, state: 'error'}))
      .toBeUndefined();
    expect(parseApplicationUpdateStatus({
      ...status,
      action: {
        ...status.action,
        url: 'javascript:alert(1)',
      },
    })).toBeUndefined();
    expect(parseApplicationUpdateStatus({
      ...status,
      action: {
        ...status.action,
        command: 'docker compose pull\nrm -rf data',
      },
    })).toBeUndefined();
    expect(parseApplicationUpdateStatus({
      ...status,
      latest: {
        ...status.latest,
        releaseUrl: 'https://example.com/untrusted',
      },
    })).toBeUndefined();
  });

  it('scopes dismissals by backend, distribution, channel, and version', () => {
    expect(applicationUpdateDismissKey('http://localhost:3001/api/', status))
      .toContain(
        'http%3A%2F%2Flocalhost%3A3001:docker:stable:1.3.0',
      );
  });

  it('projects only the backend-authored upgrade action', () => {
    expect(applicationUpgradeInstruction(status)).toEqual({
      command: status.action?.kind === 'docker'
        ? status.action.command
        : undefined,
      url: status.action?.url,
    });
  });
});
