// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  isConversationNotFoundError,
  startConversationTurn,
  type ConversationClientConfig,
  type ConversationRunReceipt,
  type StartConversationInput,
} from './conversation_client';

type ConversationStartInput = Omit<
  StartConversationInput,
  'sessionId' | 'signal'
>;

export class ConversationStartInvalidatedError extends Error {
  constructor() {
    super('Conversation start was invalidated');
    this.name = 'ConversationStartInvalidatedError';
  }
}

/**
 * Serializes only the short HTTP start handshake. Model runs remain concurrent
 * with the UI, so a later turn can steer/cancel the active run after it has a
 * stable backend session identity. The handshake deliberately cannot share
 * the streaming lifecycle's AbortSignal: once the backend starts a run, the
 * receipt must reach the caller so an invalidated request can cancel it.
 */
export class ConversationStartQueue {
  private tail: Promise<void> = Promise.resolve();
  private generation = 0;

  constructor(
    private readonly readSessionId: () => string | undefined,
    private readonly writeSessionId: (sessionId: string | undefined) => void,
    private readonly start: typeof startConversationTurn = startConversationTurn,
  ) {}

  enqueue(
    config: ConversationClientConfig,
    input: ConversationStartInput,
  ): Promise<ConversationRunReceipt> {
    const generation = this.generation;
    const operation = this.tail.then(async () => {
      if (generation !== this.generation) {
        throw new ConversationStartInvalidatedError();
      }
      const sessionId = this.readSessionId();
      let receipt: ConversationRunReceipt;
      try {
        receipt = await this.start(config, {
          ...input,
          ...(sessionId ? {sessionId} : {}),
        });
      } catch (error) {
        if (!sessionId || !isConversationNotFoundError(error)) throw error;
        receipt = await this.start(config, input);
      }
      if (generation === this.generation) {
        this.writeSessionId(receipt.sessionId);
      }
      return receipt;
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  reset(options: {persist?: boolean} = {}): void {
    this.generation += 1;
    if (options.persist !== false) this.writeSessionId(undefined);
  }
}
