import * as path from 'path';
import { readPositiveIntEnv } from '../../common/env-int';

/**
 * Configuration of the session log part disk cache (impl-plan DD-1 of
 * 2026-11-24-session-parts-disk-cache). Read once, when `PartCacheService` is constructed.
 */
export interface PartCacheConfig {
  enabled: boolean;
  /** Resolved absolute cache folder. */
  dir: string;
  ttlDays: number;
  maxBytes: number;
  sweepIntervalMs: number;
}

export const DEFAULT_PART_CACHE_TTL_DAYS = 14;
export const DEFAULT_PART_CACHE_MAX_MB = 1024;
export const DEFAULT_PART_CACHE_SWEEP_INTERVAL_MS = 10_800_000;

/** A hit refreshes the file's mtime ("last read") at most once per this interval. */
export const PART_CACHE_TOUCH_THROTTLE_MS = 3_600_000;
/** Temp files older than this are left over from a crashed write and are removed by the sweep. */
export const PART_CACHE_STALE_TEMP_MS = 600_000;
/** Sweep state file, in the cache folder root. */
export const PART_CACHE_STATE_FILE = '.sweep-state.json';
/** Delay of the second removal pass of a deleted log's folder. */
export const PART_CACHE_DELETE_RECHECK_MS = 5_000;
/** A cached part file: `<bodyRev>.json.gz`. */
export const PART_CACHE_FILE_RE = /^(\d+)\.json\.gz$/;
/** A part temp file inside a `<logId>/` folder. */
export const PART_CACHE_TEMP_RE = /^\.tmp-/;
/** A sweep state temp file in the cache folder root. */
export const PART_CACHE_STATE_TEMP_RE = /^\.sweep-state\.json\.tmp-/;
/** A `<logId>/` folder name. */
export const PART_CACHE_LOG_DIR_RE = /^\d+$/;

const BYTES_PER_MB = 1_048_576;

/**
 * The default folder copies the default of `resolveStagingDir()` (upload queue) instead of
 * calling it, because that function creates the folder as a side effect.
 */
export function readPartCacheConfig(): PartCacheConfig {
  const dir = path.resolve(
    process.env.SESSION_PART_CACHE_DIR ||
      path.join(process.env.UPLOAD_QUEUE_DIR || 'upload-queue', 'part-cache'),
  );
  return {
    enabled: process.env.SESSION_PART_CACHE_ENABLED !== 'false',
    dir,
    ttlDays: readPositiveIntEnv(
      'SESSION_PART_CACHE_TTL_DAYS',
      DEFAULT_PART_CACHE_TTL_DAYS,
    ),
    maxBytes:
      readPositiveIntEnv(
        'SESSION_PART_CACHE_MAX_MB',
        DEFAULT_PART_CACHE_MAX_MB,
      ) * BYTES_PER_MB,
    sweepIntervalMs: readPositiveIntEnv(
      'SESSION_PART_CACHE_SWEEP_INTERVAL_MS',
      DEFAULT_PART_CACHE_SWEEP_INTERVAL_MS,
    ),
  };
}
