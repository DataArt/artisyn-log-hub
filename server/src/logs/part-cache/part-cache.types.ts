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

/** A read-only scan of the cache folder made for the admin view (never deletes anything). */
export interface PartCacheCurrentState {
  /** ISO time the scan finished (results are reused for a few seconds). */
  scannedAt: string;
  /** Total `*.json.gz` bytes right now. */
  sizeBytes: number;
  fileCount: number;
  /** ISO of the smallest mtime (last read), null when the cache is empty. */
  oldestReadAt: string | null;
  /** Message of a scan failure (e.g. EACCES on the folder), else null. */
  error: string | null;
}

/** Part cache request counters of one process since its start. */
export interface PartCacheCounters {
  /** Cacheable parts served from a cache file. */
  hits: number;
  /** Cacheable parts (numeric revision with a valid gzip copy) served from the database. */
  misses: number;
  /** Cache files written. */
  fills: number;
}

/** Counters summed over the cluster workers that have reported. */
export interface PartCacheCountersView extends PartCacheCounters {
  /** How many worker processes the sum covers (1 outside cluster mode). */
  workers: number;
}

/** The `partCache` field of `GET /api/v1/admin/system`. */
export interface PartCacheView {
  enabled: boolean;
  /** Resolved absolute path. */
  dir: string;
  maxBytes: number;
  ttlDays: number;
  sweepIntervalMs: number;
  /** Live scan of the folder; null when the cache is disabled. */
  current: PartCacheCurrentState | null;
  /** Hit / miss / fill counters since each worker's start, summed over the cluster. */
  counters: PartCacheCountersView;
  /** Read from the state file; null when absent/unreadable or disabled. */
  lastSweep: PartCacheSweepState | null;
  /** The answering worker process, since its start. */
  removedByDataDeletion: PartCacheRemovedCount;
}
