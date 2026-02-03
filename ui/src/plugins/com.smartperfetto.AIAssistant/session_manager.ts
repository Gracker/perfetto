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
 * - Settings persistence (AI provider configuration)
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
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  HISTORY_KEY,
  SESSIONS_KEY,
  PENDING_BACKEND_TRACE_KEY,
} from './types';
import {NavigationBookmark} from './navigation_bookmark_bar';

/**
 * Generates a unique ID for messages and sessions.
 */
export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
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
  /**
   * Load AI settings from localStorage.
   */
  loadSettings(): AISettings {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY);
      if (stored) {
        // Merge stored settings with defaults to handle new properties
        const storedSettings = JSON.parse(stored);
        return {...DEFAULT_SETTINGS, ...storedSettings};
      }
    } catch {
      // Use default settings on error
    }
    return {...DEFAULT_SETTINGS};
  }

  /**
   * Save AI settings to localStorage.
   */
  saveSettings(settings: AISettings): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
      const stored = localStorage.getItem(HISTORY_KEY);
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
      localStorage.setItem(HISTORY_KEY, JSON.stringify(data));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Save pinned results to localStorage.
   */
  savePinnedResults(pinnedResults: PinnedResult[]): void {
    try {
      localStorage.setItem('smartperfetto-pinned-results', JSON.stringify(pinnedResults));
    } catch {
      // Ignore errors
    }
  }

  /**
   * Load all Sessions storage from localStorage.
   */
  loadSessionsStorage(): SessionsStorage {
    try {
      const stored = localStorage.getItem(SESSIONS_KEY);
      if (stored) {
        return JSON.parse(stored);
      }
    } catch {
      // Ignore errors
    }
    return { byTrace: {} };
  }

  /**
   * Save all Sessions storage to localStorage.
   */
  saveSessionsStorage(storage: SessionsStorage): void {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(storage));
    } catch {
      // Ignore errors
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
      summary?: string;
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
  storePendingBackendTrace(traceId: string, port: number): void {
    try {
      localStorage.setItem(
        PENDING_BACKEND_TRACE_KEY,
        JSON.stringify({
          traceId,
          port,
          timestamp: Date.now(),
        })
      );
    } catch {
      console.log('[SessionManager] Failed to store pending trace');
    }
  }

  /**
   * Recover pending backend trace ID if port matches and not too old.
   * Returns the traceId if valid, null otherwise.
   * Clears the pending data after recovery.
   */
  recoverPendingBackendTrace(currentPort: number): string | null {
    try {
      const stored = localStorage.getItem(PENDING_BACKEND_TRACE_KEY);
      if (!stored) return null;

      const data = JSON.parse(stored);

      // Check if the stored data matches current port and is recent (within 60 seconds)
      if (data.port === currentPort && (Date.now() - data.timestamp) < 60000) {
        // Clear the pending data after recovery
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
        console.log('[SessionManager] Recovered and cleared pending backend trace');
        return data.traceId;
      }

      // If too old or port mismatch, clear it
      if ((Date.now() - data.timestamp) > 60000) {
        localStorage.removeItem(PENDING_BACKEND_TRACE_KEY);
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
