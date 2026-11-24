import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { RepeatedFailureLog } from '../../common/repeated-failure-log';
import {
  PART_CACHE_DELETE_RECHECK_MS,
  PART_CACHE_FILE_RE,
  PART_CACHE_LOG_DIR_RE,
  PART_CACHE_STALE_TEMP_MS,
  PART_CACHE_STATE_FILE,
  PART_CACHE_STATE_TEMP_RE,
  PART_CACHE_TEMP_RE,
  PART_CACHE_TOUCH_THROTTLE_MS,
  readPartCacheConfig,
  type PartCacheConfig,
} from './part-cache.config';
import { partCacheCounters } from './part-cache-counters';
import type {
  PartCacheCountersView,
  PartCacheCurrentState,
  PartCacheHit,
  PartCacheRemovedCount,
  PartCacheSweepState,
  PartCacheView,
} from './part-cache.types';

const SWEEP_INTERVAL_NAME = 'part-cache-sweep';
/** How long one admin-view folder scan is reused (the System tab polls every 10 s). */
const CURRENT_SCAN_REUSE_MS = 5_000;
const DAY_MS = 86_400_000;
const REV_RE = /^\d+$/;
/** Rename failures that mean "the target is there / held open" (Windows: EPERM over an open file). */
const RENAME_TARGET_BUSY_CODES = new Set(['EPERM', 'EEXIST', 'EBUSY']);

interface CachedFile {
  logDir: string;
  path: string;
  size: number;
  mtimeMs: number;
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function tempSuffix(): string {
  return `${process.pid}-${randomBytes(4).toString('hex')}`;
}

/**
 * Disk file cache of the gzip of a session log part (impl-plan
 * 2026-11-24-session-parts-disk-cache, DD-1..DD-11; KB `session-part-cache.md`).
 *
 * Layout: `<dir>/<logId>/<bodyRev>.json.gz`, written via `.tmp-*` files and a rename. The
 * file's mtime is its "last read" time: a hit refreshes it (throttled), and the sweep evicts by
 * TTL and then oldest-first down to `maxBytes`. Never touches the DB, and every failure is
 * contained: a read error is a miss, a write error only costs a later refill.
 *
 * The sweep runs independently in every cluster worker; it is idempotent cleanup, so concurrent
 * passes are safe (`ENOENT` counts as success).
 */
@Injectable()
export class PartCacheService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PartCacheService.name);
  private readonly config: PartCacheConfig;
  private readonly writeFailures = new RepeatedFailureLog(
    this.logger,
    'Part cache write',
  );
  private readonly readFailures = new RepeatedFailureLog(
    this.logger,
    'Part cache read',
  );
  private readonly sweepFailures = new RepeatedFailureLog(
    this.logger,
    'Part cache sweep',
  );
  private readonly deleteFailures = new RepeatedFailureLog(
    this.logger,
    'Part cache removal of deleted data',
  );

  /** Per-process estimate of the cache size: seeded by every sweep, grown by every fill. */
  private estimatedBytes = 0;
  private sweepRunning = false;
  private rerunRequested = false;
  private inFlightSweep: Promise<PartCacheSweepState | null> | null = null;
  private readonly recheckTimers = new Set<NodeJS.Timeout>();
  private readonly removedByDataDeletion: PartCacheRemovedCount = {
    files: 0,
    bytes: 0,
  };
  /** Last admin-view scan, reused for `CURRENT_SCAN_REUSE_MS`. */
  private currentScan: {
    at: number;
    result: Promise<PartCacheCurrentState>;
  } | null = null;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {
    this.config = readPartCacheConfig();
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) return;
    void this.sweep('timer');
    const interval = setInterval(
      () => void this.sweep('timer'),
      this.config.sweepIntervalMs,
    );
    this.schedulerRegistry.addInterval(SWEEP_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', SWEEP_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(SWEEP_INTERVAL_NAME);
    }
    for (const timer of this.recheckTimers) clearTimeout(timer);
    this.recheckTimers.clear();
    if (this.inFlightSweep) {
      await this.inFlightSweep;
    }
  }

  // ---------------------------------------------------------------- layout (DD-2)

  private logDir(logId: number): string {
    return path.join(this.config.dir, String(logId));
  }

  private filePath(logId: number, bodyRev: string): string {
    return path.join(this.logDir(logId), `${bodyRev}.json.gz`);
  }

  private static validKey(logId: number, bodyRev: string): boolean {
    return Number.isSafeInteger(logId) && logId > 0 && REV_RE.test(bodyRev);
  }

  // ---------------------------------------------------------------- read (DD-4)

  /** Opens the cached file of a part; null on a miss or any error (non-ENOENT errors warn). */
  async openForRead(
    logId: number,
    bodyRev: string,
  ): Promise<PartCacheHit | null> {
    if (!this.config.enabled || !PartCacheService.validKey(logId, bodyRev)) {
      return null;
    }
    const filePath = this.filePath(logId, bodyRev);
    let fh: fs.promises.FileHandle | null = null;
    try {
      fh = await fs.promises.open(filePath, 'r');
      const stat = await fh.stat();
      const stream = fh.createReadStream({ autoClose: true });
      const hit: PartCacheHit = {
        stream,
        size: stat.size,
        filePath,
        mtimeMs: stat.mtimeMs,
      };
      fh = null; // owned by the stream now
      return hit;
    } catch (err) {
      if (fh) await fh.close().catch(() => undefined);
      if (errCode(err) !== 'ENOENT') {
        this.readFailures.failed(
          new Error(
            `Part cache open failed for log ${logId}: ${errMessage(err)}`,
          ),
        );
      }
      return null;
    }
  }

  /** Fire-and-forget "last read" refresh, at most once per `PART_CACHE_TOUCH_THROTTLE_MS`. */
  touchOnHit(hit: PartCacheHit): void {
    if (!this.config.enabled) return;
    if (Date.now() - hit.mtimeMs <= PART_CACHE_TOUCH_THROTTLE_MS) return;
    const now = new Date();
    fs.promises.utimes(hit.filePath, now, now).catch((err: unknown) => {
      this.logger.debug(
        `Part cache touch failed for ${hit.filePath}: ${errMessage(err)}`,
      );
    });
  }

  // ---------------------------------------------------------------- fill (DD-6)

  /** Fire-and-forget fill of a part's gzip; never throws. */
  store(logId: number, bodyRev: string, gz: Buffer): void {
    if (!this.config.enabled || !PartCacheService.validKey(logId, bodyRev)) {
      return;
    }
    if (gz.length > this.config.maxBytes) return;
    this.storeAsync(logId, bodyRev, gz).then(
      () => this.writeFailures.succeeded(),
      (err: unknown) =>
        this.writeFailures.failed(
          new Error(
            `Part cache write failed for log ${logId}: ${errMessage(err)}`,
          ),
        ),
    );
  }

  private async storeAsync(
    logId: number,
    bodyRev: string,
    gz: Buffer,
  ): Promise<void> {
    const dir = this.logDir(logId);
    const finalPath = this.filePath(logId, bodyRev);
    await fs.promises.mkdir(dir, { recursive: true });
    if (await this.exists(finalPath)) return;

    const tempPath = path.join(dir, `.tmp-${bodyRev}-${tempSuffix()}.json.gz`);
    await fs.promises.writeFile(tempPath, gz, { flag: 'wx' });
    let added = true;
    try {
      await fs.promises.rename(tempPath, finalPath);
    } catch (err) {
      const code = errCode(err);
      await fs.promises.unlink(tempPath).catch(() => undefined);
      if (
        code === undefined ||
        !RENAME_TARGET_BUSY_CODES.has(code) ||
        !(await this.exists(finalPath))
      ) {
        throw err;
      }
      added = false; // a concurrent writer already placed the same revision
    }

    // FR-6: strictly older revisions of this log go; a newer one is never undone.
    const current = BigInt(bodyRev);
    const names = await fs.promises.readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const match = PART_CACHE_FILE_RE.exec(name);
      if (!match || BigInt(match[1]) >= current) continue;
      const oldPath = path.join(dir, name);
      try {
        const stat = await fs.promises.stat(oldPath);
        await fs.promises.unlink(oldPath);
        this.estimatedBytes = Math.max(0, this.estimatedBytes - stat.size);
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
      }
    }

    if (added) {
      partCacheCounters.fill();
      this.estimatedBytes += gz.length;
      if (this.estimatedBytes > this.config.maxBytes) {
        void this.sweep('cap');
      }
    }
  }

  private async exists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.stat(filePath);
      return true;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return false;
      throw err;
    }
  }

  // ---------------------------------------------------------------- sweep (DD-7, DD-9)

  /** One sweep (plus one rerun if a cap trigger arrived meanwhile); null when skipped. */
  async sweep(trigger: 'timer' | 'cap'): Promise<PartCacheSweepState | null> {
    if (!this.config.enabled) return null;
    if (this.sweepRunning) {
      if (trigger === 'cap') this.rerunRequested = true;
      return null;
    }
    this.sweepRunning = true;
    const run = (async () => {
      let state = await this.runPass(trigger);
      while (this.rerunRequested) {
        this.rerunRequested = false;
        state = await this.runPass('cap');
      }
      return state;
    })();
    this.inFlightSweep = run;
    try {
      return await run;
    } finally {
      this.sweepRunning = false;
      this.inFlightSweep = null;
    }
  }

  private async runPass(
    trigger: 'timer' | 'cap',
  ): Promise<PartCacheSweepState> {
    const started = Date.now();
    const { dir, ttlDays, maxBytes } = this.config;
    const removedTtl: PartCacheRemovedCount = { files: 0, bytes: 0 };
    const removedCap: PartCacheRemovedCount = { files: 0, bytes: 0 };
    let removedTempFiles = 0;
    let error: string | null = null;
    let kept: CachedFile[] = [];

    try {
      await fs.promises.mkdir(dir, { recursive: true });
      const staleBefore = started - PART_CACHE_STALE_TEMP_MS;
      const files: CachedFile[] = [];
      const logDirs: string[] = [];

      for (const entry of await fs.promises.readdir(dir, {
        withFileTypes: true,
      })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory() && PART_CACHE_LOG_DIR_RE.test(entry.name)) {
          logDirs.push(entryPath);
        } else if (
          entry.isFile() &&
          PART_CACHE_STATE_TEMP_RE.test(entry.name) &&
          (await this.unlinkIfStale(entryPath, staleBefore))
        ) {
          removedTempFiles++;
        }
      }

      for (const logDir of logDirs) {
        let names: fs.Dirent[];
        try {
          names = await fs.promises.readdir(logDir, { withFileTypes: true });
        } catch (err) {
          if (errCode(err) === 'ENOENT') continue;
          throw err;
        }
        for (const entry of names) {
          if (!entry.isFile()) continue;
          const filePath = path.join(logDir, entry.name);
          if (PART_CACHE_FILE_RE.test(entry.name)) {
            try {
              const stat = await fs.promises.stat(filePath);
              files.push({
                logDir,
                path: filePath,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
              });
            } catch (err) {
              if (errCode(err) !== 'ENOENT') throw err;
            }
          } else if (
            PART_CACHE_TEMP_RE.test(entry.name) &&
            (await this.unlinkIfStale(filePath, staleBefore))
          ) {
            removedTempFiles++;
          }
        }
      }

      const emptiedDirs = new Set<string>();
      const ttlCutoff = Date.now() - ttlDays * DAY_MS;
      for (const file of files) {
        if (file.mtimeMs < ttlCutoff && (await this.unlinkFile(file.path))) {
          removedTtl.files++;
          removedTtl.bytes += file.size;
          emptiedDirs.add(file.logDir);
        } else {
          kept.push(file);
        }
      }

      kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
      let total = kept.reduce((sum, f) => sum + f.size, 0);
      const survivors: CachedFile[] = [];
      for (const file of kept) {
        if (total > maxBytes && (await this.unlinkFile(file.path))) {
          total -= file.size;
          removedCap.files++;
          removedCap.bytes += file.size;
          emptiedDirs.add(file.logDir);
        } else {
          survivors.push(file);
        }
      }
      kept = survivors;

      const stillUsed = new Set(kept.map((f) => f.logDir));
      for (const logDir of emptiedDirs) {
        if (stillUsed.has(logDir)) continue;
        await fs.promises.rmdir(logDir).catch((err: unknown) => {
          const code = errCode(err);
          if (code !== 'ENOTEMPTY' && code !== 'ENOENT' && code !== 'EEXIST') {
            throw err;
          }
        });
      }
      this.sweepFailures.succeeded();
    } catch (err) {
      error = errMessage(err);
      this.sweepFailures.failed(err);
    }

    const sizeBytes = kept.reduce((sum, f) => sum + f.size, 0);
    if (error === null) this.estimatedBytes = sizeBytes;
    const oldest = kept.length > 0 ? kept[0].mtimeMs : null;
    const state: PartCacheSweepState = {
      at: new Date().toISOString(),
      durationMs: Date.now() - started,
      trigger,
      sizeBytes,
      fileCount: kept.length,
      oldestReadAt: oldest === null ? null : new Date(oldest).toISOString(),
      removedTtl,
      removedCap,
      removedTempFiles,
      error,
    };
    if (removedTtl.files + removedCap.files + removedTempFiles > 0) {
      this.logger.log(
        `Part cache sweep (${trigger}) removed ${removedTtl.files} file(s) by TTL, ` +
          `${removedCap.files} by cap, ${removedTempFiles} temp file(s); ` +
          `${kept.length} file(s), ${sizeBytes} bytes left`,
      );
    }
    await this.writeState(state);
    return state;
  }

  /** Unlinks a temp file older than `staleBefore`; true when it was removed. */
  private async unlinkIfStale(
    filePath: string,
    staleBefore: number,
  ): Promise<boolean> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (stat.mtimeMs >= staleBefore) return false;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return false;
      throw err;
    }
    return this.unlinkFile(filePath);
  }

  /** Unlinks a file; `ENOENT` counts as success, any other error is logged and keeps the file. */
  private async unlinkFile(filePath: string): Promise<boolean> {
    try {
      await fs.promises.unlink(filePath);
      return true;
    } catch (err) {
      if (errCode(err) === 'ENOENT') return true;
      this.logger.warn(
        `Part cache sweep could not remove ${filePath}: ${errMessage(err)}`,
      );
      return false;
    }
  }

  /** Writes the state file via a temp file + rename; best effort, never throws. */
  private async writeState(state: PartCacheSweepState): Promise<void> {
    const target = path.join(this.config.dir, PART_CACHE_STATE_FILE);
    const temp = `${target}.tmp-${tempSuffix()}`;
    const json = JSON.stringify(state);
    try {
      await fs.promises.writeFile(temp, json);
      try {
        await fs.promises.rename(temp, target);
      } catch (err) {
        await fs.promises.unlink(temp).catch(() => undefined);
        if (errCode(err) !== 'EPERM') throw err;
        await fs.promises.writeFile(target, json);
      }
    } catch (err) {
      this.logger.warn(
        `Part cache sweep state write failed: ${errMessage(err)}`,
      );
    }
  }

  // ---------------------------------------------------------------- deleted data (DD-8)

  /** Fire-and-forget removal of deleted logs' folders, now and once more after a delay. */
  removeLogFolders(logIds: readonly number[]): void {
    if (!this.config.enabled) return;
    const ids = logIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    if (ids.length === 0) return;
    void this.removeFolders(ids);
    const timer = setTimeout(() => {
      this.recheckTimers.delete(timer);
      void this.removeFolders(ids);
    }, PART_CACHE_DELETE_RECHECK_MS);
    timer.unref();
    this.recheckTimers.add(timer);
  }

  private async removeFolders(ids: readonly number[]): Promise<void> {
    for (const id of ids) {
      try {
        await this.removeFolder(id);
        this.deleteFailures.succeeded();
      } catch (err) {
        this.deleteFailures.failed(
          new Error(
            `Part cache removal failed for log ${id}: ${errMessage(err)}`,
          ),
        );
      }
    }
  }

  private async removeFolder(logId: number): Promise<void> {
    const dir = this.logDir(logId);
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch (err) {
      if (errCode(err) === 'ENOENT') return;
      throw err;
    }
    let files = 0;
    let bytes = 0;
    for (const name of names) {
      if (!PART_CACHE_FILE_RE.test(name)) continue;
      try {
        const stat = await fs.promises.stat(path.join(dir, name));
        files++;
        bytes += stat.size;
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
      }
    }
    await fs.promises.rm(dir, { recursive: true, force: true });
    this.removedByDataDeletion.files += files;
    this.removedByDataDeletion.bytes += bytes;
    this.estimatedBytes = Math.max(0, this.estimatedBytes - bytes);
  }

  // ---------------------------------------------------------------- admin view (DD-10)

  /** `counters` is the cluster-wide sum, built by the caller from the supervisor snapshot. */
  async getAdminView(counters: PartCacheCountersView): Promise<PartCacheView> {
    const { enabled, dir, maxBytes, ttlDays, sweepIntervalMs } = this.config;
    const [current, lastSweep] = enabled
      ? await Promise.all([this.scanCurrent(), this.readState()])
      : [null, null];
    return {
      enabled,
      dir,
      maxBytes,
      ttlDays,
      sweepIntervalMs,
      current,
      counters,
      lastSweep,
      removedByDataDeletion: { ...this.removedByDataDeletion },
    };
  }

  /**
   * Live size of the cache for the admin view: a read-only walk (readdir + stat, no deletions)
   * of `<dir>/<logId>/*.json.gz`. The result is reused for `CURRENT_SCAN_REUSE_MS` and
   * concurrent callers share one walk, so an admin tab polling every 10 s costs at most one
   * walk per worker per few seconds. Never throws: a failure is reported in `error`.
   */
  private scanCurrent(): Promise<PartCacheCurrentState> {
    const cached = this.currentScan;
    if (cached && Date.now() - cached.at < CURRENT_SCAN_REUSE_MS) {
      return cached.result;
    }
    const result = this.walkCurrent();
    this.currentScan = { at: Date.now(), result };
    return result;
  }

  private async walkCurrent(): Promise<PartCacheCurrentState> {
    let sizeBytes = 0;
    let fileCount = 0;
    let oldest: number | null = null;
    let error: string | null = null;
    try {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(this.config.dir, {
          withFileTypes: true,
        });
      } catch (err) {
        if (errCode(err) !== 'ENOENT') throw err;
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !PART_CACHE_LOG_DIR_RE.test(entry.name)) {
          continue;
        }
        const logDir = path.join(this.config.dir, entry.name);
        let names: string[];
        try {
          names = await fs.promises.readdir(logDir);
        } catch (err) {
          if (errCode(err) === 'ENOENT') continue;
          throw err;
        }
        for (const name of names) {
          if (!PART_CACHE_FILE_RE.test(name)) continue;
          try {
            const stat = await fs.promises.stat(path.join(logDir, name));
            sizeBytes += stat.size;
            fileCount++;
            if (oldest === null || stat.mtimeMs < oldest) oldest = stat.mtimeMs;
          } catch (err) {
            if (errCode(err) !== 'ENOENT') throw err;
          }
        }
      }
    } catch (err) {
      error = errMessage(err);
    }
    return {
      scannedAt: new Date().toISOString(),
      sizeBytes,
      fileCount,
      oldestReadAt: oldest === null ? null : new Date(oldest).toISOString(),
      error,
    };
  }

  private async readState(): Promise<PartCacheSweepState | null> {
    try {
      const raw = await fs.promises.readFile(
        path.join(this.config.dir, PART_CACHE_STATE_FILE),
        'utf8',
      );
      const parsed: unknown = JSON.parse(raw);
      return isSweepState(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function isRemovedCount(value: unknown): value is PartCacheRemovedCount {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.files === 'number' && typeof v.bytes === 'number';
}

function isSweepState(value: unknown): value is PartCacheSweepState {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === 'string' &&
    typeof v.durationMs === 'number' &&
    (v.trigger === 'timer' || v.trigger === 'cap') &&
    typeof v.sizeBytes === 'number' &&
    typeof v.fileCount === 'number' &&
    (v.oldestReadAt === null || typeof v.oldestReadAt === 'string') &&
    isRemovedCount(v.removedTtl) &&
    isRemovedCount(v.removedCap) &&
    typeof v.removedTempFiles === 'number' &&
    (v.error === null || typeof v.error === 'string')
  );
}
