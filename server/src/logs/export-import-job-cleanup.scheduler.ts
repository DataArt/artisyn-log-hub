import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { and, inArray, isNotNull, lt } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { exportImportJobs } from '../database/schema/index';
import { resolveExportImportStagingDir } from './export-import-zip';

const TICK_INTERVAL_NAME = 'export-import-job-cleanup-tick';

/**
 * Sweeps expired `exportImportJobs` rows: every
 * `EXPORT_IMPORT_CLEANUP_INTERVAL_MS` (default 5 minutes), deletes rows whose
 * `status` is `done`/`error`/`staged` and whose `updatedAt` is older than
 * `EXPORT_IMPORT_JOB_TTL_MS` (default 30 minutes) — this is what bounds both
 * "abandoned upload" (a `staged_upload` row nobody ever confirmed) and "never
 * downloaded export" (a `done` `export` row nobody ever fetched). Each swept
 * row's `resultFilePath` (if any) is best-effort unlinked first.
 *
 * Each tick also sweeps orphaned files: zips in the staging dir that no row
 * references any more and that are older than the TTL. A row can disappear
 * without its file — `exportImportJobs.userId`/`repoId` are `ON DELETE
 * CASCADE`, so deleting a user or repo drops the row and leaves the zip behind
 * (the download no longer unlinks it).
 *
 * Mirrors `UploadQueueSchedulerService`/`SessionRetentionService`'s
 * `SchedulerRegistry` + `setInterval` mechanics (env vars read at
 * `onApplicationBootstrap()` time so an e2e test's bootstrap override still
 * takes effect), but is simpler: there is no claim/lease step, since running this
 * sweep independently and concurrently in every cluster worker is safe — it's
 * idempotent cleanup, not exclusive "claim a row to *process*" work. Deleting
 * an already-deleted file is a no-op, not a correctness bug.
 */
@Injectable()
export class ExportImportJobCleanupScheduler
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExportImportJobCleanupScheduler.name);
  private isTickRunning = false;
  // Tracks whichever `tick()` call is currently in flight (if any), so
  // `onModuleDestroy()` can await it before shutdown proceeds to
  // `DatabaseModule.onApplicationShutdown()`'s `pool.end()` — otherwise a tick
  // already started by the interval just before teardown could still be
  // mid-await when the pool closes. `deleteInterval()` alone only stops
  // *future* firings.
  private inFlightTick: Promise<void> | null = null;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Runs in `onApplicationBootstrap` rather than `onModuleInit` so the first
   * sweep cannot fire before the whole context is up.
   */
  onApplicationBootstrap(): void {
    const intervalMs =
      Number(process.env.EXPORT_IMPORT_CLEANUP_INTERVAL_MS) || 300000;
    const interval = setInterval(() => {
      this.inFlightTick = this.tick().finally(() => {
        this.inFlightTick = null;
      });
    }, intervalMs);
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  private getTtlMs(): number {
    return Number(process.env.EXPORT_IMPORT_JOB_TTL_MS) || 1800000;
  }

  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      await this.sweep();
      await this.sweepOrphanFiles();
    } catch (err) {
      this.logger.error(
        `Export/import job cleanup sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Selects expired `done`/`error`/`staged` rows relative to `now` (injectable
   * for tests, rather than relying on `jest.useFakeTimers()` — there is no
   * `setTimeout` left to fake once the sweep itself runs), best-effort unlinks
   * each one's `resultFilePath` (a missing file — `ENOENT`, e.g. a concurrent
   * worker's sweep already removed it — is not an error), then deletes the
   * rows.
   */
  async sweep(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - this.getTtlMs());

    const rows = await this.db
      .select({
        id: exportImportJobs.id,
        resultFilePath: exportImportJobs.resultFilePath,
      })
      .from(exportImportJobs)
      .where(
        and(
          inArray(exportImportJobs.status, ['done', 'error', 'staged']),
          lt(exportImportJobs.updatedAt, cutoff),
        ),
      );

    if (rows.length === 0) {
      return;
    }

    for (const row of rows) {
      if (!row.resultFilePath) continue;
      try {
        await fs.promises.unlink(row.resultFilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.logger.warn(
            `Failed to remove export/import file ${row.resultFilePath} for job ${row.id}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    await this.db.delete(exportImportJobs).where(
      inArray(
        exportImportJobs.id,
        rows.map((row) => row.id),
      ),
    );
  }

  /**
   * Unlinks staging-dir files that no `exportImportJobs` row references and
   * whose mtime is older than the TTL. The TTL guard keeps an export still
   * being written or an upload not yet attached to its row (both reference-less
   * for a moment) safe. Every row is consulted regardless of status, so the
   * file of a long-running import is never touched. The dir is listed before
   * the rows are read: a row created after the read can only point at a file
   * newer than the listing.
   */
  async sweepOrphanFiles(now: Date = new Date()): Promise<void> {
    const cutoffMs = now.getTime() - this.getTtlMs();
    const dir = resolveExportImportStagingDir();
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    if (files.length === 0) {
      return;
    }

    const referencedRows = await this.db
      .select({ resultFilePath: exportImportJobs.resultFilePath })
      .from(exportImportJobs)
      .where(isNotNull(exportImportJobs.resultFilePath));
    const referenced = new Set(
      referencedRows.flatMap((row) =>
        row.resultFilePath ? [path.resolve(row.resultFilePath)] : [],
      ),
    );

    let removed = 0;
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      if (referenced.has(path.resolve(filePath))) continue;
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.mtimeMs >= cutoffMs) continue;
        await fs.promises.unlink(filePath);
        removed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.logger.warn(
            `Failed to remove orphaned export/import file ${filePath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} orphaned export/import file(s)`);
    }
  }
}
