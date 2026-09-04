// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Telling a busy session apart from a rejected request.
 *
 * `POST /analyze` and `POST /sessions/:id/runs` both answer 409 for two
 * unrelated situations: the request does not fit this backend's configuration,
 * and the session is momentarily busy. Only the code separates them.
 *
 * The busy case is not an edge: a cancelled run keeps session ownership until
 * its outer execution settles, so the cancel endpoint reports `cancelled`
 * before the session will accept a new run — measured at roughly 2.4s after a
 * mid-run stop. That is exactly the window a user types into after pressing
 * stop-and-redirect, and surfacing it as a failure reads as "my correction was
 * rejected".
 */

/**
 * The one conflict that clears on its own.
 *
 * Measured on a mid-run stop: the settle window answers
 * `CANCELLATION_IN_PROGRESS` for ~2.4s and then accepts the new run.
 * `RUN_ALREADY_ACTIVE` is deliberately not here — the backend also returns it
 * for a session parked in `awaiting_user`, which needs the respond flow and
 * will never clear by waiting, and the composer is disabled while a run is
 * genuinely active. Waiting on it would spend the budget for nothing.
 */
const TRANSIENT_RUN_CONFLICT_CODES: ReadonlySet<string> = new Set([
  'CANCELLATION_IN_PROGRESS',
]);

/**
 * Upper bound on waiting for a settling session.
 *
 * Generous against the measured window so a slow unwind still succeeds, and
 * short enough that a genuinely stuck run surfaces rather than hanging.
 */
export const RUN_CONFLICT_WAIT_MS = 8_000;

/** Poll spacing while waiting. */
export const RUN_CONFLICT_RETRY_INTERVAL_MS = 400;

/**
 * True when a response means "try again shortly", not "this request is wrong".
 *
 * Anything other than a 409 carrying a known busy code is left alone, so a
 * code-aware context conflict still reaches its own fallback and an unknown
 * conflict still surfaces.
 */
export function isTransientRunConflict(
  status: number,
  payload: unknown,
): boolean {
  if (status !== 409) return false;
  const code = (payload as {code?: unknown} | null | undefined)?.code;
  return typeof code === 'string' && TRANSIENT_RUN_CONFLICT_CODES.has(code);
}
