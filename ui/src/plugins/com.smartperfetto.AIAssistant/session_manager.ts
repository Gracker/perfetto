// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

// Copyright (C) 2024 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Session management for the AI Assistant plugin.
 *
 * This module handles:
 * - Settings persistence (backend connection/auth configuration)
 * - Session storage (conversation history per trace)
 * - Migration from legacy storage formats
 * - Pinned results management
 * - Session lifecycle (create, update, delete, cleanup)
 */

import {
  AISettings,
  AISession,
  SessionsStorage,
  Message,
  PinnedResult,
  LatestAnalysisSnapshot,
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  HISTORY_KEY,
  SESSIONS_KEY,
  PENDING_BACKEND_TRACE_KEY,
} from './types';
import {NavigationBookmark} from './navigation_bookmark_bar';
import {
  buildSmartPerfettoStorageKey,
  getSmartPerfettoWindowId,
} from '../../core/smartperfetto_request_context';
import {
  getDefaultSmartPerfettoBackendUrl,
  isDefaultSmartPerfettoBackendUrl,
} from '../../core/smartperfetto_backend_url';

export {getSmartPerfettoWindowId};

const PINNED_RESULTS_KEY = 'smartperfetto-pinned-results';
const ANALYSIS_MODE_KEY = 'ai-analysis-mode';
type AnalysisMode = 'fast' | 'full' | 'auto';

/**
 * Generates a unique ID for messages and sessions.
 */
export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

interface SessionsStorageEnvelope extends SessionsStorage {
  _meta?: {
    mtimeMs: number;
    revision: number;
  };
}

export function getPendingBackendTraceStorageKey(
  windowId = getSmartPerfettoWindowId(),
): string {
  return buildSmartPerfettoStorageKey(
    PENDING_BACKEND_TRACE_KEY,
    'window',
    {windowId},
  );
}

export function getSettingsStorageKey(): string {
  return buildSmartPerfettoStorageKey(SETTINGS_KEY, 'user');
}

export function getHistoryStorageKey(): string {
  return buildSmartPerfettoStorageKey(HISTORY_KEY, 'workspace');
}

export function getSessionsStorageKey(): string {
  return buildSmartPerfettoStorageKey(SESSIONS_KEY, 'workspace');
}

export function getPinnedResultsStorageKey(): string {
  return buildSmartPerfettoStorageKey(PINNED_RESULTS_KEY, 'workspace');
}

export function getAnalysisModeStorageKey(): string {
  return buildSmartPerfettoStorageKey(ANALYSIS_MODE_KEY, 'workspace');
}

/**
 * Session Manager class for handling AI session persistence.
 *
 * Manages the lifecycle of AI conversation sessions, including:
 * - Creating new sessions per trace
 * - Saving and loading session state
 * - Migration from legacy storage formats
 * - Cleanup of old sessions
 */
export class SessionManager {
  private sessionsStorageMtimeMs = 0;
  private sessionsStorageRevision = 0;

  /**
   * Load AI settings from localStorage.
   */
  loadSettings(): AISettings {
    try {
      const stored =
        localStorage.getItem(getSettingsStorageKey()) ||
        localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        // Merge stored settings with defaults to handle new properties
        const storedSettings = JSON.parse(stored);
        const merged = {...DEFAULT_SETTINGS, backendUrl: getDefaultSmartPerfettoBackendUrl(), ...storedSettings};
        // Keep user's explicit backend URL, otherwise auto-detect for remote access
        return this.applySmartBackendUrl(merged, storedSettings.backendUrl);
      }
    } catch {
      // Use default settings on error
    }
    return {...DEFAULT_SETTINGS, backendUrl: getDefaultSmartPerfettoBackendUrl()};
  }

  /**
   * When the user hasn't explicitly set a custom backend URL, derive it from
   * runtime config plus the page origin. So remote access via
   * http://<ip>:10000 automatically connects to the configured backend port.
   */
  private applySmartBackendUrl(settings: AISettings, storedBackendUrl?: string): AISettings {
    if (storedBackendUrl && !isDefaultSmartPerfettoBackendUrl(storedBackendUrl)) {
      return settings; // User set a truly custom backend URL — respect it
    }
    return {...settings, backendUrl: getDefaultSmartPerfettoBackendUrl()};
  }

  /**
   * Save AI settings to localStorage.
   */
  saveSettings(settings: AISettings): void {
    try {
      localStorage.setItem(getSettingsStorageKey(), JSON.stringify(settings));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Load legacy history format (for backward compatibility).
   * Returns the parsed data or null if not found/invalid.
   */
  loadLegacyHistory(): {
    messages: Message[];
    backendTraceId?: string;
    traceFingerprint?: string;
  } | null {
    try {
      const stored =
        localStorage.getItem(getHistoryStorageKey()) ||
        localStorage.getItem(HISTORY_KEY);
      if (!stored) return null;

      const parsed = JSON.parse(stored);
      const messages = Array.isArray(parsed) ? parsed : (parsed.messages || []);
      return {
        messages,
        backendTraceId: parsed.backendTraceId,
        traceFingerprint: parsed.traceFingerprint,
      };
    } catch {
      return null;
    }
  }

  /**
   * Save history in legacy format (for backward compatibility).
   */
  saveHistory(
    messages: Message[],
    backendTraceId: string | null,
    traceFingerprint: string | null
  ): void {
    try {
      const data = {
        messages,
        backendTraceId,
        traceFingerprint,
      };
      localStorage.setItem(getHistoryStorageKey(), JSON.stringify(data));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Save pinned results to localStorage.
   */
  savePinnedResults(pinnedResults: PinnedResult[]): void {
    try {
      localStorage.setItem(
        getPinnedResultsStorageKey(),
        JSON.stringify(pinnedResults),
      );
    } catch {
      // Ignore errors
    }
  }

  loadAnalysisMode(): AnalysisMode {
    try {
      const stored =
        localStorage.getItem(getAnalysisModeStorageKey()) ||
        localStorage.getItem(ANALYSIS_MODE_KEY);
      if (stored === 'fast' || stored === 'full' || stored === 'auto') {
        return stored;
      }
    } catch {
      // Ignore storage errors.
    }
    return 'auto';
  }

  saveAnalysisMode(mode: AnalysisMode): void {
    try {
      localStorage.setItem(getAnalysisModeStorageKey(), mode);
    } catch {
      // Ignore errors
    }
  }

  /**
   * Load all Sessions storage from localStorage.
   */
  loadSessionsStorage(): SessionsStorage {
    const parsed = this.parseSessionsStorage(
      localStorage.getItem(getSessionsStorageKey()) ||
        localStorage.getItem(SESSIONS_KEY),
    );
    this.sessionsStorageMtimeMs = parsed.mtimeMs;
    this.sessionsStorageRevision = parsed.revision;
    return parsed.storage;
  }

  private parseSessionsStorage(raw: string | null): {
    storage: SessionsStorage;
    mtimeMs: number;
    revision: number;
  } {
    try {
      if (!raw) return {storage: {byTrace: {}}, mtimeMs: 0, revision: 0};
      const parsed = JSON.parse(raw) as SessionsStorageEnvelope | null;
      const byTrace = parsed && typeof parsed.byTrace === 'object' && parsed.byTrace
        ? parsed.byTrace
        : {};
      const meta = parsed && typeof parsed === 'object' ? parsed._meta : undefined;
      return {
        storage: {byTrace},
        mtimeMs: Number(meta?.mtimeMs) || 0,
        revision: Number(meta?.revision) || 0,
      };
    } catch {
      // Ignore errors
    }
    return {storage: {byTrace: {}}, mtimeMs: 0, revision: 0};
  }

  /**
   * F4: Trim sqlResult.rows in messages before serialization to reduce localStorage pressure.
   * P2-9: Also strip expandableData, chartData, and metricData to prevent localStorage bloat.
   * Returns a lightweight copy — the original messages in memory are untouched.
   */
  private trimStorageMessages(messages: Message[]): Message[] {
    const MAX_ROWS_PERSISTED = 50;
    return messages.map(msg => {
      // P2-9: Strip large data fields that are not essential for session restore
      const trimmed: Message = {
        ...msg,
        chartData: undefined,
        metricData: undefined,
      };

      if (trimmed.sqlResult) {
        trimmed.sqlResult = {
          ...trimmed.sqlResult,
          expandableData: undefined,  // P2-9: expandableData can be very large
        };
        if (trimmed.sqlResult.rows && trimmed.sqlResult.rows.length > MAX_ROWS_PERSISTED) {
          trimmed.sqlResult = {
            ...trimmed.sqlResult,
            rows: trimmed.sqlResult.rows.slice(0, MAX_ROWS_PERSISTED),
            rowCount: trimmed.sqlResult.rowCount, // preserve original count
          };
        }
      }

      return trimmed;
    });
  }

  private mergeSessionsStorage(base: SessionsStorage, incoming: SessionsStorage): SessionsStorage {
    const merged: SessionsStorage = {byTrace: {}};
    for (const fingerprint in base.byTrace) {
      merged.byTrace[fingerprint] = [...base.byTrace[fingerprint]];
    }

    for (const fingerprint in incoming.byTrace) {
      if (!merged.byTrace[fingerprint]) {
        merged.byTrace[fingerprint] = [];
      }

      for (const session of incoming.byTrace[fingerprint]) {
        const index = merged.byTrace[fingerprint].findIndex(
          existing => existing.sessionId === session.sessionId,
        );
        if (index === -1) {
          merged.byTrace[fingerprint].push(session);
        } else {
          merged.byTrace[fingerprint][index] = session;
        }
      }
    }

    return merged;
  }

  private buildSessionsEnvelope(
    storage: SessionsStorage,
    revisionBase: number,
  ): SessionsStorageEnvelope {
    return {
      ...storage,
      _meta: {
        mtimeMs: Date.now(),
        revision: revisionBase + 1,
      },
    };
  }

  /**
   * Save all Sessions storage to localStorage.
   * Includes size protection to avoid exceeding browser storage limits.
   */
  saveSessionsStorage(storage: SessionsStorage): void {
    try {
      const storageKey = getSessionsStorageKey();
      const current = this.parseSessionsStorage(localStorage.getItem(storageKey));
      const hasConcurrentWrite =
        current.revision > this.sessionsStorageRevision ||
        current.mtimeMs > this.sessionsStorageMtimeMs;
      const storageToSave = hasConcurrentWrite
        ? this.mergeSessionsStorage(current.storage, storage)
        : storage;
      const revisionBase = Math.max(current.revision, this.sessionsStorageRevision);

      // F4: Create a trimmed copy to reduce storage size
      const trimmedStorage: SessionsStorage = { byTrace: {} };
      for (const fingerprint in storageToSave.byTrace) {
        trimmedStorage.byTrace[fingerprint] = storageToSave.byTrace[fingerprint].map(session => ({
          ...session,
          messages: this.trimStorageMessages(session.messages),
        }));
      }
      let envelope = this.buildSessionsEnvelope(trimmedStorage, revisionBase);
      const serialize = (): string => JSON.stringify(envelope);
      const persist = (serialized: string): void => {
        localStorage.setItem(storageKey, serialized);
        this.sessionsStorageMtimeMs = envelope._meta?.mtimeMs || 0;
        this.sessionsStorageRevision = envelope._meta?.revision || 0;
      };

      let serialized = serialize();
      const sizeBytes = new Blob([serialized]).size;
      const MAX_STORAGE_BYTES = 4 * 1024 * 1024; // 4MB safety limit

      if (sizeBytes > MAX_STORAGE_BYTES) {
        console.warn(
          `[SessionManager] Storage size ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_STORAGE_BYTES / 1024 / 1024}MB limit, trimming old sessions`
        );
        // Collect all sessions across traces with their fingerprints
        const allSessions: Array<{fingerprint: string; sessionId: string; lastActiveAt: number}> = [];
        for (const fingerprint in trimmedStorage.byTrace) {
          trimmedStorage.byTrace[fingerprint].forEach((session) => {
            allSessions.push({fingerprint, sessionId: session.sessionId, lastActiveAt: session.lastActiveAt});
          });
        }
        // Sort oldest first
        allSessions.sort((a, b) => a.lastActiveAt - b.lastActiveAt);

        // Remove oldest sessions one at a time until under limit
        for (const entry of allSessions) {
          const sessions = trimmedStorage.byTrace[entry.fingerprint];
          if (!sessions) continue;
          const sessionIdx = sessions.findIndex(
            s => s.sessionId === entry.sessionId
          );
          if (sessionIdx !== -1) {
            sessions.splice(sessionIdx, 1);
            if (sessions.length === 0) {
              delete trimmedStorage.byTrace[entry.fingerprint];
            }
          }
          envelope = this.buildSessionsEnvelope(trimmedStorage, revisionBase);
          const evictedSerialized = serialize();
          if (new Blob([evictedSerialized]).size <= MAX_STORAGE_BYTES) {
            persist(evictedSerialized);
            return;
          }
        }
        // If still too large after trimming all, save what we have
        envelope = this.buildSessionsEnvelope(trimmedStorage, revisionBase);
        persist(serialize());
      } else {
        persist(serialized);
      }
    } catch (e) {
      console.warn('[SessionManager] Failed to save sessions storage:', e);
    }
  }

  /**
   * Get all sessions for a specific trace fingerprint.
   */
  getSessionsForTrace(fingerprint: string): AISession[] {
    const storage = this.loadSessionsStorage();
    return storage.byTrace[fingerprint] || [];
  }

  /**
   * Create a new session for a trace.
   */
  createSession(
    fingerprint: string,
    traceName: string,
    backendTraceId?: string
  ): AISession {
    const session: AISession = {
      sessionId: generateId(),
      traceFingerprint: fingerprint,
      traceName: traceName,
      backendTraceId,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      messages: [],
      pinnedResults: [],
      bookmarks: [],
    };

    // Save to storage
    const storage = this.loadSessionsStorage();
    if (!storage.byTrace[fingerprint]) {
      storage.byTrace[fingerprint] = [];
    }
    storage.byTrace[fingerprint].push(session);
    this.saveSessionsStorage(storage);

    console.log('[SessionManager] Created new session:', session.sessionId);
    return session;
  }

  /**
   * Update an existing session.
   */
  updateSession(
    fingerprint: string,
    sessionId: string,
    updates: {
      messages?: Message[];
      pinnedResults?: PinnedResult[];
      bookmarks?: NavigationBookmark[];
      backendTraceId?: string;
      agentSessionId?: string;
      agentRunId?: string;
      agentRequestId?: string;
      agentRunSequence?: number;
      latestAnalysisSnapshot?: LatestAnalysisSnapshot;
      summary?: string;
      type?: AISession['type'];
      referenceTraceFingerprint?: string;
      referenceBackendTraceId?: string;
      referenceTraceName?: string;
      tracePairLayout?: AISession['tracePairLayout'];
      tracePairSplitPercent?: number;
      tracePairActiveTraceSide?: AISession['tracePairActiveTraceSide'];
    }
  ): boolean {
    const storage = this.loadSessionsStorage();
    const sessions = storage.byTrace[fingerprint];
    if (!sessions) return false;

    const sessionIndex = sessions.findIndex(s => s.sessionId === sessionId);
    if (sessionIndex === -1) return false;

    // Update session data
    sessions[sessionIndex] = {
      ...sessions[sessionIndex],
      ...updates,
      lastActiveAt: Date.now(),
    };

    this.saveSessionsStorage(storage);
    console.log('[SessionManager] Updated session:', sessionId);
    return true;
  }

  /**
   * Load a session by ID.
   * Returns the session if found, null otherwise.
   */
  loadSession(sessionId: string): AISession | null {
    const storage = this.loadSessionsStorage();

    // Search all traces for the session
    for (const fingerprint in storage.byTrace) {
      const sessions = storage.byTrace[fingerprint];
      const session = sessions.find(s => s.sessionId === sessionId);
      if (session) {
        return session;
      }
    }

    return null;
  }

  /**
   * Delete a session by ID.
   * Returns true if deleted, false if not found.
   */
  deleteSession(sessionId: string): boolean {
    const storage = this.loadSessionsStorage();

    for (const fingerprint in storage.byTrace) {
      const sessions = storage.byTrace[fingerprint];
      const index = sessions.findIndex(s => s.sessionId === sessionId);
      if (index !== -1) {
        sessions.splice(index, 1);
        this.saveSessionsStorage(storage);
        console.log('[SessionManager] Deleted session:', sessionId);
        return true;
      }
    }

    return false;
  }

  /**
   * Migrate old HISTORY_KEY data to new Session format.
   * Only called on first load for backward compatibility.
   *
   * @param currentFingerprint - Current trace fingerprint
   * @param traceName - Current trace name
   * @returns true if migration was performed, false otherwise
   */
  migrateOldHistoryToSession(
    currentFingerprint: string,
    traceName: string
  ): boolean {
    try {
      const legacyData = this.loadLegacyHistory();
      if (!legacyData) return false;

      const { messages, backendTraceId, traceFingerprint } = legacyData;
      const fingerprint = traceFingerprint || currentFingerprint;

      // If no messages or no fingerprint, don't migrate
      if (messages.length === 0 || !fingerprint) return false;

      // Check if there are already sessions for this trace
      const existingSessions = this.getSessionsForTrace(fingerprint);
      if (existingSessions.length > 0) {
        // Already have sessions, no need to migrate
        return false;
      }

      // Create migrated session
      console.log('[SessionManager] Migrating old history to new session format');
      const session: AISession = {
        sessionId: generateId(),
        traceFingerprint: fingerprint,
        traceName: traceName,
        backendTraceId,
        createdAt: messages[0]?.timestamp || Date.now(),
        lastActiveAt: messages[messages.length - 1]?.timestamp || Date.now(),
        messages: messages,
      };

      // Save to new format
      const storage = this.loadSessionsStorage();
      if (!storage.byTrace[fingerprint]) {
        storage.byTrace[fingerprint] = [];
      }
      storage.byTrace[fingerprint].push(session);
      this.saveSessionsStorage(storage);

      console.log('[SessionManager] Migration complete, session:', session.sessionId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store pending backend trace ID for recovery after reload.
   */
  storePendingBackendTrace(traceId: string, port?: number, leaseId?: string): void {
    try {
      sessionStorage.setItem(
        getPendingBackendTraceStorageKey(),
        JSON.stringify({
          traceId,
          port,
          leaseId,
          timestamp: Date.now(),
        })
      );
      localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
    } catch {
      console.log('[SessionManager] Failed to store pending trace');
    }
  }

  /**
   * Recover pending backend trace ID if port or lease matches and not too old.
   * Returns the traceId if valid, null otherwise.
   * Clears the pending data after recovery.
   */
  recoverPendingBackendTrace(currentPort?: number, currentLeaseId?: string): string | null {
    try {
      const scopedKey = getPendingBackendTraceStorageKey();
      const legacyWindowKey = `${PENDING_BACKEND_TRACE_KEY}:${getSmartPerfettoWindowId()}`;
      let stored = sessionStorage.getItem(scopedKey);
      let legacyStorage = false;
      if (!stored) {
        stored = sessionStorage.getItem(legacyWindowKey);
        legacyStorage = Boolean(stored);
      }
      if (!stored) {
        stored = localStorage.getItem(PENDING_BACKEND_TRACE_KEY);
        legacyStorage = Boolean(stored);
      }
      if (!stored) return null;

      const data = JSON.parse(stored);
      const clearPending = () => {
        sessionStorage.removeItem(scopedKey);
        sessionStorage.removeItem(legacyWindowKey);
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
      };

      const isRecent = (Date.now() - data.timestamp) < 60000;
      const portMatches = currentPort !== undefined && data.port === currentPort;
      const leaseMatches = currentLeaseId !== undefined && data.leaseId === currentLeaseId;

      // Check if the stored data matches current target and is recent (within 60 seconds)
      if ((portMatches || leaseMatches) && isRecent) {
        // Clear the pending data after recovery
        clearPending();
        console.log('[SessionManager] Recovered and cleared pending backend trace');
        return data.traceId;
      }

      // If too old or port mismatch, clear it
      if ((Date.now() - data.timestamp) > 60000 || legacyStorage) {
        clearPending();
        console.log('[SessionManager] Cleared stale pending backend trace');
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Cleanup old sessions (older than specified days).
   * Default: 30 days.
   */
  cleanupOldSessions(maxAgeDays: number = 30): number {
    const storage = this.loadSessionsStorage();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    let deletedCount = 0;

    for (const fingerprint in storage.byTrace) {
      const sessions = storage.byTrace[fingerprint];
      const originalLength = sessions.length;

      // Filter out old sessions
      storage.byTrace[fingerprint] = sessions.filter(
        s => (now - s.lastActiveAt) < maxAgeMs
      );

      deletedCount += originalLength - storage.byTrace[fingerprint].length;

      // Remove empty fingerprint entries
      if (storage.byTrace[fingerprint].length === 0) {
        delete storage.byTrace[fingerprint];
      }
    }

    if (deletedCount > 0) {
      this.saveSessionsStorage(storage);
      console.log(`[SessionManager] Cleaned up ${deletedCount} old sessions`);
    }

    return deletedCount;
  }

  /**
   * Get session summary for display (first user message or auto-generated).
   */
  getSessionSummary(session: AISession): string {
    if (session.summary) return session.summary;

    const userMessages = session.messages.filter(m => m.role === 'user');
    if (userMessages.length > 0) {
      const firstMessage = userMessages[0].content;
      return firstMessage.length > 30 ? firstMessage.slice(0, 30) + '...' : firstMessage;
    }

    return '新对话';
  }
}

/**
 * Default singleton instance for convenient access.
 */
export const sessionManager = new SessionManager();
