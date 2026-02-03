// Utilities for SmartPerfetto auto-pin heuristics.
//
// Keep this file dependency-free so it can be unit-tested easily.

export function getActivityHintFromBufferTxTrackName(
  trackName: string,
): string | null {
  // Examples:
  // - BufferTX - com.example.app/com.example.app.MainActivity#5960
  // - BufferTX - com.example.app/com.example.app/.MainActivity#5960 (rare)
  const parts = trackName.split(' - ');
  if (parts.length < 2) return null;

  const payload = parts.slice(1).join(' - ');
  const hashIdx = payload.lastIndexOf('#');
  if (hashIdx <= 0) return null;

  const beforeHash = payload.slice(0, hashIdx);
  const slashIdx = beforeHash.lastIndexOf('/');
  const activityFqcn = slashIdx >= 0 ? beforeHash.slice(slashIdx + 1) : beforeHash;
  const normalized = activityFqcn.startsWith('.') ? activityFqcn.slice(1) : activityFqcn;

  const lastDot = normalized.lastIndexOf('.');
  const activityShort = lastDot >= 0 ? normalized.slice(lastDot + 1) : normalized;
  if (!activityShort) return null;

  // Avoid matching generic tokens.
  if (activityShort.length < 3) return null;

  return activityShort;
}

export function needsActiveDisambiguation(pattern: string): boolean {
  // Tracks which are typically global (no upid/utid) and can appear multiple times.
  return /(^|\b)(BufferTX|QueuedBuffer|BufferQueue|SurfaceTexture)\b/i.test(pattern);
}

export function getMaxPinsForPattern(pattern: string): number | undefined {
  if (/surfaceflinger/i.test(pattern)) return 1;
  if (/(^|\b)BufferTX\b/i.test(pattern)) return 1;
  if (/(^|\b)QueuedBuffer\b/i.test(pattern)) return 1;
  if (/(^|\b)BufferQueue\b/i.test(pattern)) return 1;
  if (/(^|\b)SurfaceTexture\b/i.test(pattern)) return 1;
  return undefined;
}

