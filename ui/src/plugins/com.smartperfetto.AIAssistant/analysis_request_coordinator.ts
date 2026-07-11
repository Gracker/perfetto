// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

export type AnalysisRequestDisposition = 'active' | 'cancelled' | 'stale';

export interface AnalysisRequestToken {
  readonly generation: number;
}

interface ActiveAnalysisRequest {
  token: AnalysisRequestToken;
  cancelRequested: boolean;
}

export class AnalysisRequestCoordinator {
  private nextGeneration = 0;
  private activeRequest: ActiveAnalysisRequest | null = null;

  begin(): AnalysisRequestToken {
    const token = {generation: ++this.nextGeneration};
    this.activeRequest = {token, cancelRequested: false};
    return token;
  }

  requestCancel(): boolean {
    if (!this.activeRequest) return false;
    this.activeRequest.cancelRequested = true;
    return true;
  }

  disposition(token: AnalysisRequestToken): AnalysisRequestDisposition {
    if (this.activeRequest?.token.generation !== token.generation) {
      return 'stale';
    }
    return this.activeRequest.cancelRequested ? 'cancelled' : 'active';
  }

  finish(token: AnalysisRequestToken): void {
    if (this.activeRequest?.token.generation === token.generation) {
      this.activeRequest = null;
    }
  }
}
