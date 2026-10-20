import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { eq, sql } from 'drizzle-orm';
import * as fs from 'fs';
import * as path from 'path';
import { NO_LOG_MARKER } from '../common/sql-logger';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { uploadQueue, uploadQueueMeasurements } from '../database/schema/index';
import { LogsService } from './logs.service';
import { parseNdjsonLinesTolerant } from './ndjson-parser';
import {
  getMeasurementPruneIntervalMs,
  getMeasurementRetentionMs,
  type UploadQueueMeasurementOutcome,
} from './upload-queue-stats.constants';
import { UploadQueueService } from './upload-queue.service';
import { FOREIGN_SESSION_WARNING } from './upload-warnings';

const TICK_INTERVAL_NAME = 'upload-queue-tick';

/** Raw shape of a `RETURNING *` row from `upload_queue` — snake_case column
 * names, since this bypasses Drizzle's schema-aware camelCase mapping. */
interface UploadQueueRawRow extends Record<string, unknown> {
  id: number;
  file_name: string;
  size_bytes: string | number;
  received_at: Date;
  session_id: string;
  log_type: string;
  user_id: number;
  parent_session_id: string | null;
  workflow_run_id: string | null;
  status: string;
  error_message: string | null;
  updated_at: Date;
  upload_id: string | null;
  chunks_received: number | null;
  total_chunks: number | null;
}

/**
 * Drives the async `POST /api/v2/logs` pipeline: each tick claims and
 * processes rows one at a time, in a loop bounded by
 * `UPLOAD_QUEUE_TICK_BUDGET_MS` (default 500ms) of wall-clock time — at
 * least one row always gets processed per tick even with the budget
 * exhausted or set to 0, so a burst of many small rows (e.g. `claude-otel`
 * chunks) drains in the same tick instead of backing up at one row/tick.
 * Also: atomic cross-worker claim, in-memory same-process
 * overlap guard, and lease-timeout-based `processing ->
 * pending` crash recovery.
 */
@Injectable()
export class UploadQueueSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(UploadQueueSchedulerService.name);
  private isTickRunning = false;
  // Tracks whichever `tick()` call is currently in flight (if any), so
  // `onModuleDestroy()` can await it before shutdown proceeds to
  // `DatabaseModule.onApplicationShutdown()`'s `pool.end()` — otherwise a
  // tick already started by the interval just before teardown could still be
  // mid-await (e.g. between `reclaimExpiredLeases()` and
  // `claimNextPendingRow()`) when the pool closes, throwing an unhandled
  // "Cannot use a pool after calling end on the pool" that crashes the
  // process. `deleteInterval()` alone only stops *future* firings.
  private inFlightTick: Promise<void> | null = null;
  // Per-process throttle for the measurement retention prune. `tick()` runs once a
  // second in each of 3–15 cluster workers; without this an unguarded prune would issue 3–15
  // pointless `DELETE`s every second. 0 means "never pruned in this process yet", so the
  // first tick after a (re)start always prunes.
  private lastPrunedAtMs = 0;
  // Same per-process throttle for `expireStalePartialUploads()`.
  private lastPartialSweepAtMs = 0;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly logsService: LogsService,
    private readonly uploadQueueService: UploadQueueService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  /**
   * Crash recovery: reclaim whatever was `processing` — and already
   * lease-expired — when this process was last down; then start ticking.
   *
   * Both steps run in `onApplicationBootstrap` rather than `onModuleInit` so
   * no tick fires until the whole context is up. The schema itself is already
   * final by this point regardless — `initializeDatabase()` runs before the
   * context is created at all (src/database/database-init.ts).
   *
   * Uses `SchedulerRegistry`'s dynamic API (not the `@Interval()` decorator)
   * so `UPLOAD_QUEUE_INTERVAL_MS` is read at runtime, after the e2e test
   * bootstrap's env-var override has already run.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.reclaimExpiredLeases();

    const intervalMs = Number(process.env.UPLOAD_QUEUE_INTERVAL_MS) || 1000;
    const interval = setInterval(() => {
      this.inFlightTick = this.tick().finally(() => {
        this.inFlightTick = null;
      });
    }, intervalMs);
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  /**
   * Order matters here: stop any *future* tick from starting first
   * (`deleteInterval`), then await whichever tick is *currently* in flight,
   * so it's guaranteed to finish (or fail) before NestJS moves on to
   * `OnApplicationShutdown` hooks (`DatabaseModule`'s `pool.end()`).
   */
  async onModuleDestroy(): Promise<void> {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlightTick) {
      await this.inFlightTick;
    }
  }

  private getLeaseTimeoutMs(): number {
    return Number(process.env.UPLOAD_QUEUE_LEASE_TIMEOUT_MS) || 180000;
  }

  /**
   * Wall-clock budget (from `tick()`'s start) for how long a single tick may
   * keep claiming and processing additional rows. Read at runtime (not
   * cached) so e2e tests can override it via `process.env` the same way
   * `getLeaseTimeoutMs()` does. Unlike that getter, `0` is a valid override
   * here (e2e tests use it to restore exact one-row-per-tick timing), so a
   * bare `|| 500` — which would treat `0` as falsy and fall through to the
   * default — can't be used.
   */
  private getTickBudgetMs(): number {
    const raw = Number(process.env.UPLOAD_QUEUE_TICK_BUDGET_MS);
    return Number.isFinite(raw) && raw >= 0 ? raw : 500;
  }

  /**
   * Resets any `processing` row whose lease has expired back to `pending`.
   * Safe to run repeatedly and concurrently with
   * other workers — it only ever touches rows whose lease already lapsed, so
   * a row a different worker is legitimately still processing (recent
   * `updated_at`) is never disturbed.
   */
  async reclaimExpiredLeases(): Promise<void> {
    const leaseTimeoutMs = this.getLeaseTimeoutMs();
    await this.db.execute(
      sql`${sql.raw(NO_LOG_MARKER)}
          UPDATE upload_queue SET status = 'pending', updated_at = now()
          WHERE status = 'processing'
            AND updated_at < now() - (${leaseTimeoutMs}::text || ' milliseconds')::interval`,
    );
  }

  /**
   * Records one row in `upload_queue_measurements` for a completed processing
   * attempt — success or failure. This is the only source of worker throughput data: the
   * `upload_queue` row is gone by the time a success is recorded, and each cluster worker has
   * its own process memory, so in-process counters would under-report by the instance count.
   *
   * Both durations are denormalised here rather than derived in SQL, so
   * the stats aggregate is a plain `SUM`/`percentile_cont` over indexed integer columns.
   * They are clamped at 0 because `received_at` comes from the database clock while
   * `startedAt`/`finishedAt` come from this process's clock — a small skew between the two
   * must not produce a negative latency that then drags the averages down.
   *
   * `size_bytes` is coerced with `Number(...)` because `pg` returns `BIGINT` as a string
   * (see `UploadQueueRawRow.size_bytes`), exactly as the `logsService.upsert()` call above
   * already does.
   *
   * Callers must wrap this — it is never allowed to fail an upload.
   */
  private async recordMeasurement(
    row: UploadQueueRawRow,
    startedAt: Date,
    finishedAt: Date,
    outcome: UploadQueueMeasurementOutcome,
  ): Promise<void> {
    const receivedAtMs = new Date(row.received_at).getTime();
    await this.db.insert(uploadQueueMeasurements).values({
      sessionId: row.session_id,
      logType: row.log_type,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      queueLatencyMs: Math.max(0, finishedAt.getTime() - receivedAtMs),
      sizeBytes: Number(row.size_bytes),
      outcome,
    });
  }

  /**
   * Deletes measurement rows older than `UPLOAD_QUEUE_MEASUREMENT_RETENTION_MS`, at most
   * once per `UPLOAD_QUEUE_MEASUREMENT_PRUNE_INTERVAL_MS` **per process**
   * — `tick()` fires every second in each of 3–15 instances, and an unthrottled prune
   * would be pure churn.
   *
   * `now` is injectable so the throttle predicate and the cutoff are unit-testable without
   * fake timers, following `ExportImportJobCleanupScheduler.cleanupStaleJobs()`. The
   * `DELETE` carries `NO_LOG_MARKER` like the other per-tick queries here, so it does not
   * flood `sql-*.log`.
   */
  async pruneMeasurements(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    if (nowMs - this.lastPrunedAtMs < getMeasurementPruneIntervalMs()) return;
    this.lastPrunedAtMs = nowMs;

    const cutoff = new Date(nowMs - getMeasurementRetentionMs());
    await this.db.execute(
      sql`${sql.raw(NO_LOG_MARKER)}
          DELETE FROM upload_queue_measurements WHERE finished_at < ${cutoff}`,
    );
  }

  /**
   * Age (since the last chunk arrived) after which a `partially_uploaded` row
   * is treated as abandoned. Default 24 hours — far beyond any live upload,
   * whose chunks arrive seconds apart.
   */
  private getPartialUploadTtlMs(): number {
    return Number(process.env.UPLOAD_QUEUE_PARTIAL_UPLOAD_TTL_MS) || 86400000;
  }

  /** Minimum gap between partial-upload sweeps per process. Default 10 minutes. */
  private getPartialSweepIntervalMs(): number {
    return (
      Number(process.env.UPLOAD_QUEUE_PARTIAL_UPLOAD_SWEEP_INTERVAL_MS) ||
      600000
    );
  }

  /**
   * Expires abandoned chunked uploads (`UploadQueueService.
   * expireStalePartialUploads()`), throttled per process like
   * `pruneMeasurements()`. `now` is injectable for unit tests.
   */
  async expireStalePartialUploads(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    if (nowMs - this.lastPartialSweepAtMs < this.getPartialSweepIntervalMs()) {
      return;
    }
    this.lastPartialSweepAtMs = nowMs;

    const expired = await this.uploadQueueService.expireStalePartialUploads(
      new Date(nowMs - this.getPartialUploadTtlMs()),
    );
    if (expired > 0) {
      this.logger.log(
        `Expired ${expired} abandoned partially_uploaded upload-queue row(s) older than ${this.getPartialUploadTtlMs()}ms`,
      );
    }
  }

  /**
   * Claims + processes rows in a loop, one at a time, until either nothing
   * is left `pending` or `getTickBudgetMs()` of wall-clock time has elapsed
   * since the tick started. The budget check runs at the *end* of each
   * iteration (do/while), so a tick always processes at least one available
   * row even when the budget is 0 or already exhausted — this is what lets
   * a burst of small rows (e.g. many `claude-otel` chunks) drain within one
   * tick instead of trickling out at one row per tick.
   */
  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      await this.reclaimExpiredLeases();
      await this.pruneMeasurements();
      await this.expireStalePartialUploads();
      const budgetMs = this.getTickBudgetMs();
      const start = Date.now();
      do {
        const claimed = await this.claimNextPendingRow();
        if (!claimed) return;
        await this.processRow(claimed);
      } while (Date.now() - start < budgetMs);
    } catch (err) {
      // Fail-soft, matching `SessionRetentionService`/
      // `ExportImportJobCleanupScheduler`: per-row failures are already
      // handled (and marked `failed`) inside `processRow()`, so anything
      // reaching here is a tick-level DB failure — `reclaimExpiredLeases()`
      // or `claimNextPendingRow()`. Letting it escape would reject the
      // promise the `setInterval` callback never awaits, i.e. an
      // `unhandledRejection` that takes the whole process down over a
      // transient DB hiccup. Log it and let the next tick retry.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Upload queue tick failed: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  /**
   * Atomically claims the oldest `pending` row via `FOR UPDATE SKIP LOCKED`
   * — self-corrects regardless of cluster worker count,
   * with no instance-index gating needed.
   */
  private async claimNextPendingRow(): Promise<UploadQueueRawRow | null> {
    const result = await this.db.execute<UploadQueueRawRow>(
      sql`${sql.raw(NO_LOG_MARKER)}
          UPDATE upload_queue
          SET status = 'processing', updated_at = now()
          WHERE id = (
            SELECT id FROM upload_queue
            WHERE status = 'pending'
            ORDER BY received_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          )
          RETURNING *`,
    );
    return result.rows[0] ?? null;
  }

  private async processRow(row: UploadQueueRawRow): Promise<void> {
    const stagingDir = this.uploadQueueService.resolveStagingDir();
    let filePath = path.join(stagingDir, row.file_name);
    // Start of the *active* work on this row — the file read onwards. Everything
    // before it is setup, and the wait that preceded the claim is captured separately as
    // the queue latency (`finished_at - received_at`).
    const startedAt = new Date();

    try {
      let rawBody: string;
      try {
        rawBody = await fs.promises.readFile(filePath, 'utf8');
      } catch (err) {
        // Self-heal a specific stale-pointer state (fixed at the source in
        // UploadQueueService.reassembleChunks(), but a row already stuck in
        // it from before that fix needs recovering here too): a chunked
        // upload whose row still names a `.chunkN` part-file that
        // reassembly already deleted, because the process died between the
        // unlink and the DB update that should have repointed the row at
        // `${uploadId}.raw`. The reassembled file's actual bytes are not
        // lost — they're sitting right there under the other name.
        if (
          err instanceof Error &&
          'code' in err &&
          (err as NodeJS.ErrnoException).code === 'ENOENT' &&
          row.upload_id
        ) {
          const rawFilePath = path.join(stagingDir, `${row.upload_id}.raw`);
          try {
            rawBody = await fs.promises.readFile(rawFilePath, 'utf8');
            this.logger.warn(
              `Recovered stale pointer for id=${row.id} uploadId=${row.upload_id}: ${row.file_name} was already gone, found and used ${row.upload_id}.raw instead`,
            );
            filePath = rawFilePath;
          } catch {
            throw err;
          }
        } else {
          throw err;
        }
      }
      const { lines, dropped, totalLines } = parseNdjsonLinesTolerant(rawBody);
      if (dropped.length > 0) {
        // Torn records from an old hook (see MAX_DROPPED_LINE_RATIO): the rest
        // of the session is ingested, the loss is recorded here.
        const shown = dropped
          .slice(0, 5)
          .map(
            (d) => `${d.lineNo} (${d.chars} chars): ${d.reason.slice(0, 120)}`,
          )
          .join('; ');
        this.logger.warn(
          `Upload queue ingested with ${dropped.length} malformed line(s) dropped of ${totalLines}: id=${row.id} sessionId=${row.session_id} logType=${row.log_type} fileName=${row.file_name}: ${shown}${dropped.length > 5 ? '; …' : ''}`,
        );
      }

      const upsertResult = await this.logsService.upsert(
        row.session_id,
        row.log_type,
        lines,
        row.user_id,
        Number(row.size_bytes),
        row.parent_session_id ?? undefined,
        row.workflow_run_id ?? undefined,
      );

      if (upsertResult.status === 'foreign-session') {
        // Open-source readiness: another user owns this session (the
        // controller's lock-free pre-check lost a race). Nothing was written; the row is
        // kept as `rejected_foreign_session` so the uploader gets the warning once via
        // `getPendingWarnings` and the admin stats show it.
        await this.rejectForeignSession(row, filePath, startedAt);
        return;
      }

      await this.db.delete(uploadQueue).where(eq(uploadQueue.id, row.id));
      try {
        // Deliberately after the delete: recording a measurement must never delay (or
        // fail) the completion of an upload, so this runs once the row is already gone.
        await this.recordMeasurement(row, startedAt, new Date(), 'success');
      } catch (err) {
        this.logger.warn(
          `Failed to record upload queue measurement (success) for id=${row.id} sessionId=${row.session_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      try {
        await fs.promises.unlink(filePath);
      } catch {
        // Best-effort: the DB row is already gone, which is the source of
        // truth for "processed" — a leftover file is at worst a small amount
        // of disk cruft, not a correctness issue.
      }
    } catch (err) {
      // Parse errors, upsert()/DB errors, and
      // file-read I/O errors are all classified identically. Logged via
      // Logger.error (this is the mechanism that surfaces the failure in the
      // admin Error Logs tab, with zero changes needed to ErrorLogsService),
      // with enough identifying detail (id/sessionId/logType/fileName) to
      // correlate an Error Logs tab entry back to the Upload Queue tab row.
      let message = err instanceof Error ? err.message : String(err);
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        message += ` (${await this.diagnoseMissingFile(stagingDir, row)})`;
      }
      this.logger.error(
        `Upload queue processing failed: id=${row.id} sessionId=${row.session_id} logType=${row.log_type} fileName=${row.file_name}: ${message}`,
        err instanceof Error ? err.stack : undefined,
      );

      await this.db
        .update(uploadQueue)
        .set({
          status: 'failed',
          errorMessage: message,
          updatedAt: new Date(),
        })
        .where(eq(uploadQueue.id, row.id));

      try {
        // A failed attempt still consumed worker time, so it counts towards utilisation —
        // but never towards the success throughput or the delivered-latency figures.
        await this.recordMeasurement(row, startedAt, new Date(), 'failure');
      } catch (recordErr) {
        this.logger.warn(
          `Failed to record upload queue measurement (failure) for id=${row.id} sessionId=${row.session_id}: ${
            recordErr instanceof Error ? recordErr.message : String(recordErr)
          }`,
        );
      }
    }
  }

  /**
   * Terminal handling of a `foreign-session` upsert result: marks the row
   * `rejected_foreign_session` with the hook-facing warning as `errorMessage`,
   * removes the staged file (the data must not be kept) and records a `failure`
   * measurement — the attempt consumed worker time but delivered nothing.
   */
  private async rejectForeignSession(
    row: UploadQueueRawRow,
    filePath: string,
    startedAt: Date,
  ): Promise<void> {
    await this.db
      .update(uploadQueue)
      .set({
        status: 'rejected_foreign_session',
        errorMessage: FOREIGN_SESSION_WARNING(row.session_id),
        updatedAt: new Date(),
      })
      .where(eq(uploadQueue.id, row.id));
    try {
      await fs.promises.unlink(filePath);
    } catch {
      // Best-effort, as on the success path: the row status is the source of truth.
    }
    try {
      await this.recordMeasurement(row, startedAt, new Date(), 'failure');
    } catch (err) {
      this.logger.warn(
        `Failed to record upload queue measurement (failure) for id=${row.id} sessionId=${row.session_id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Best-effort context for an `ENOENT` on `row.file_name`: lists whatever
   * `${uploadId}.*` files (chunked uploads) or exact `sessionId`-prefixed
   * matches actually exist in the staging dir right now. Appended to the
   * `failed` row's `errorMessage` so the admin Upload Queue tab shows enough
   * to diagnose a stale-pointer race like the one `reassembleChunks()` used
   * to have, without needing shell access to the container.
   */
  private async diagnoseMissingFile(
    stagingDir: string,
    row: UploadQueueRawRow,
  ): Promise<string> {
    try {
      const entries = await fs.promises.readdir(stagingDir);
      const prefix = row.upload_id ?? row.session_id;
      const matches = entries.filter((entry) => entry.startsWith(prefix));
      return matches.length > 0
        ? `related files found in staging dir: ${matches.join(', ')}`
        : `no related files found in staging dir for prefix=${prefix}`;
    } catch (err) {
      return `could not list staging dir for diagnosis: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }
  }
}
