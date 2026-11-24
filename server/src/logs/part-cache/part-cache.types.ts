/**
 * Types of the session log part disk cache (impl-plan DD-4, DD-9, DD-10 of
 * 2026-11-24-session-parts-disk-cache).
 */

/** An opened cache file, returned by `PartCacheService.openForRead`. */
export interface PartCacheHit {
  stream: NodeJS.ReadableStream & { destroy(): void };
  size: number;
  filePath: string;
  mtimeMs: number;
}

export interface PartCacheRemovedCount {
  files: number;
  bytes: number;
}

/** Result of one sweep pass, persisted as `<dir>/.sweep-state.json`. */
export interface PartCacheSweepState {
  /** ISO end time. */
  at: string;
  durationMs: number;
  trigger: 'timer' | 'cap';
  /** Total `*.json.gz` bytes after the pass. */
  sizeBytes: number;
  fileCount: number;
  /** ISO of the smallest mtime left, null when the cache is empty. */
  oldestReadAt: string | null;
  removedTtl: PartCacheRemovedCount;
  removedCap: PartCacheRemovedCount;
  removedTempFiles: number;
  /** Message of a pass-level failure (e.g. EACCES on the folder), else null. */
  error: string | null;
}

/** The `partCache` field of `GET /api/v1/admin/system`. */
export interface PartCacheView {
  enabled: boolean;
  /** Resolved absolute path. */
  dir: string;
  maxBytes: number;
  ttlDays: number;
  sweepIntervalMs: number;
  /** Read from the state file; null when absent/unreadable or disabled. */
  lastSweep: PartCacheSweepState | null;
  /** The answering worker process, since its start. */
  removedByDataDeletion: PartCacheRemovedCount;
}
