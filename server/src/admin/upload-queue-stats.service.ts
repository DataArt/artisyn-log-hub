import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import * as os from 'os';
import { computeInstanceCount } from '../common/instance-count';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  getMeasurementRetentionMs,
  getStatsWindowMs,
} from '../logs/upload-queue-stats.constants';
import type { UploadQueueStatus } from './upload-queue-admin.service';

export interface UploadQueueStatusBucket {
  status: UploadQueueStatus;
  files: number;
  bytes: number;
}

export interface UploadQueueStats {
  windowMs: number;
  retentionWindowMs: number;
  /** Always every status, zero-filled, in `STATUS_ORDER`. */
  byStatus: UploadQueueStatusBucket[];
  total: { files: number; bytes: number };
  processingNow: number;
  worker: {
    instanceCount: number;
    activeMs: number;
    /** 0..100, clamped. */
    utilizationPercent: number;
    filesPerSec: number | null;
    bytesPerSec: number | null;
    successCount: number;
    failureCount: number;
  };
  worker7d: {
    filesPerSec: number | null;
    bytesPerSec: number | null;
    successCount: number;
  };
  latency: {
    avgMs: number | null;
    p95Ms: number | null;
    minMs: number | null;
    maxMs: number | null;
  };
  drainEtaMs: number | null;
}

/**
 * Fixed display order for `byStatus`. The `GROUP BY status` query only returns statuses that
 * currently have rows, so the service zero-fills the rest and the UI
 * never has to handle a missing bucket.
 */
const STATUS_ORDER: UploadQueueStatus[] = [
  'pending',
  'processing',
  'partially_uploaded',
  'failed',
  'rejected_foreign_session',
];

/** One row of the `GROUP BY status` aggregate, as raw `pg` output (BIGINT/COUNT -> string). */
interface RawStatusBucket {
  status: string;
  files: string | number;
  bytes: string | number;
}

/**
 * Raw shape of the single aggregate row. `db.execute` bypasses Drizzle's type mapping, so
 * `COUNT`/`SUM`/`BIGINT` all arrive as **strings**; only `percentile_cont` (double
 * precision) arrives as a number. The four latency columns are additionally nullable — they
 * are SQL `NULL` when the window holds no successful attempt.
 */
interface RawStatsRow extends Record<string, unknown> {
  byStatus: RawStatusBucket[] | null;
  activeMs: string | number;
  successCount: string | number;
  failureCount: string | number;
  successBytes: string | number;
  successActiveMs: string | number;
  latencyAvgMs: string | number | null;
  latencyMinMs: string | number | null;
  latencyMaxMs: string | number | null;
  latencyP95Ms: string | number | null;
  weekSuccessCount: string | number;
  weekSuccessBytes: string | number;
  weekSuccessActiveMs: string | number;
}

/**
 * Null-preserving numeric coercion for the columns that are genuinely nullable. Plain
 * `Number(null)` is `0`, which would silently report "0 ms latency" for a window that has
 * seen no successful attempt at all.
 */
const toNumOrNull = (v: unknown): number | null =>
  v == null ? null : Number(v);

/**
 * A rate over a summed *active* duration: `count / (activeMs / 1000)`. Returns `null` —
 * never `Infinity` or `NaN` — when the worker has done no measured work in the window, which
 * is what keeps the reported rate from decaying while the worker simply sits idle.
 */
function perSecond(count: number, activeMs: number): number | null {
  if (activeMs <= 0) return null;
  return count / (activeMs / 1000);
}

/**
 * Backs the stats block above the admin "Upload Queue" list: the current queue backlog plus
 * worker load, throughput and end-to-end latency derived from `upload_queue_measurements`.
 *
 * Everything comes from a single `db.execute` (three CTEs, no per-row correlated
 * subqueries), because the client polls this endpoint every 5 seconds.
 */
@Injectable()
export class UploadQueueStatsService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getStats(): Promise<UploadQueueStats> {
    const windowMs = getStatsWindowMs();
    const retentionMs = getMeasurementRetentionMs();

    const result = await this.db.execute<RawStatsRow>(sql`
      WITH queue AS (
        SELECT status::text AS status,
               COUNT(*)                    AS files,
               COALESCE(SUM(size_bytes),0) AS bytes
        FROM upload_queue
        GROUP BY status
      ),
      win AS (
        SELECT
          COALESCE(SUM(duration_ms), 0)                                   AS active_ms,
          COUNT(*) FILTER (WHERE outcome = 'success')                     AS success_count,
          COUNT(*) FILTER (WHERE outcome = 'failure')                     AS failure_count,
          COALESCE(SUM(size_bytes)  FILTER (WHERE outcome = 'success'),0) AS success_bytes,
          COALESCE(SUM(duration_ms) FILTER (WHERE outcome = 'success'),0) AS success_active_ms,
          AVG(queue_latency_ms) FILTER (WHERE outcome = 'success')        AS latency_avg_ms,
          MIN(queue_latency_ms) FILTER (WHERE outcome = 'success')        AS latency_min_ms,
          MAX(queue_latency_ms) FILTER (WHERE outcome = 'success')        AS latency_max_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_latency_ms)
            FILTER (WHERE outcome = 'success')                            AS latency_p95_ms
        FROM upload_queue_measurements
        WHERE finished_at >= now() - (${windowMs}::text || ' milliseconds')::interval
      ),
      week AS (
        SELECT
          COUNT(*) FILTER (WHERE outcome = 'success')                     AS success_count,
          COALESCE(SUM(size_bytes)  FILTER (WHERE outcome = 'success'),0) AS success_bytes,
          COALESCE(SUM(duration_ms) FILTER (WHERE outcome = 'success'),0) AS success_active_ms
        FROM upload_queue_measurements
        WHERE finished_at >= now() - (${retentionMs}::text || ' milliseconds')::interval
      )
      SELECT
        (SELECT json_agg(json_build_object('status', status, 'files', files, 'bytes', bytes)) FROM queue) AS "byStatus",
        w.active_ms          AS "activeMs",
        w.success_count      AS "successCount",
        w.failure_count      AS "failureCount",
        w.success_bytes      AS "successBytes",
        w.success_active_ms  AS "successActiveMs",
        w.latency_avg_ms     AS "latencyAvgMs",
        w.latency_min_ms     AS "latencyMinMs",
        w.latency_max_ms     AS "latencyMaxMs",
        w.latency_p95_ms     AS "latencyP95Ms",
        k.success_count      AS "weekSuccessCount",
        k.success_bytes      AS "weekSuccessBytes",
        k.success_active_ms  AS "weekSuccessActiveMs"
      FROM win w CROSS JOIN week k
    `);

    const raw = result.rows[0];

    // `win`/`week` are bare aggregates, so the CROSS JOIN always yields exactly one row —
    // but an empty result set would otherwise crash the whole admin tab, so degrade to the
    // all-zero shape instead.
    if (!raw) {
      return this.emptyStats(windowMs, retentionMs);
    }

    // `json_agg` over an empty `queue` CTE yields SQL NULL, not an empty array.
    const rawBuckets = raw.byStatus ?? [];
    const byStatus: UploadQueueStatusBucket[] = STATUS_ORDER.map((status) => {
      const found = rawBuckets.find((b) => b.status === status);
      return {
        status,
        files: found ? Number(found.files) : 0,
        bytes: found ? Number(found.bytes) : 0,
      };
    });

    const total = byStatus.reduce(
      (acc, b) => ({ files: acc.files + b.files, bytes: acc.bytes + b.bytes }),
      { files: 0, bytes: 0 },
    );
    const pending = byStatus.find((b) => b.status === 'pending');
    const processingNow =
      byStatus.find((b) => b.status === 'processing')?.files ?? 0;

    const activeMs = Number(raw.activeMs);
    const successCount = Number(raw.successCount);
    const failureCount = Number(raw.failureCount);
    const successBytes = Number(raw.successBytes);
    const successActiveMs = Number(raw.successActiveMs);

    // `computeInstanceCount` rather than `SystemInfoService.getSystemInfo()`: the latter
    // runs several database catalogue queries — far too heavy for a 5-second poll — and
    // this yields the same `expected` figure the System Info tab shows.
    const instanceCount = computeInstanceCount(os.availableParallelism());

    const filesPerSec = perSecond(successCount, successActiveMs);
    const bytesPerSec = perSecond(successBytes, successActiveMs);

    // The clamp is load-bearing: a long parse that began before the window opened but
    // finished inside it contributes its whole `duration_ms`, which can exceed the
    // denominator.
    const capacityMs = windowMs * instanceCount;
    const utilizationPercent =
      capacityMs > 0 ? Math.min(100, (activeMs / capacityMs) * 100) : 0;

    const weekSuccessCount = Number(raw.weekSuccessCount);
    const weekSuccessBytes = Number(raw.weekSuccessBytes);
    const weekSuccessActiveMs = Number(raw.weekSuccessActiveMs);

    return {
      windowMs,
      retentionWindowMs: retentionMs,
      byStatus,
      total,
      processingNow,
      worker: {
        instanceCount,
        activeMs,
        utilizationPercent,
        filesPerSec,
        bytesPerSec,
        successCount,
        failureCount,
      },
      worker7d: {
        filesPerSec: perSecond(weekSuccessCount, weekSuccessActiveMs),
        bytesPerSec: perSecond(weekSuccessBytes, weekSuccessActiveMs),
        successCount: weekSuccessCount,
      },
      latency: {
        avgMs: toNumOrNull(raw.latencyAvgMs),
        p95Ms: toNumOrNull(raw.latencyP95Ms),
        minMs: toNumOrNull(raw.latencyMinMs),
        maxMs: toNumOrNull(raw.latencyMaxMs),
      },
      drainEtaMs: this.computeDrainEtaMs(
        pending?.files ?? 0,
        pending?.bytes ?? 0,
        filesPerSec,
        bytesPerSec,
      ),
    };
  }

  /**
   * Time to clear the `pending` backlog at the window's measured rate — the **max** of the
   * file-constrained and byte-constrained estimates, since the slower constraint governs.
   * `processing` rows are already in flight and `partially_uploaded`
   * rows are incomplete client uploads the worker cannot claim, so neither is backlog.
   *
   * Returns `null` — never `Infinity`, `NaN` or a misleading `0` — whenever the throughput
   * is unknown or the backlog is empty.
   */
  private computeDrainEtaMs(
    pendingFiles: number,
    pendingBytes: number,
    filesPerSec: number | null,
    bytesPerSec: number | null,
  ): number | null {
    const byFiles =
      filesPerSec != null && filesPerSec > 0 && pendingFiles > 0
        ? (pendingFiles / filesPerSec) * 1000
        : null;
    const byBytes =
      bytesPerSec != null && bytesPerSec > 0 && pendingBytes > 0
        ? (pendingBytes / bytesPerSec) * 1000
        : null;
    if (byFiles == null && byBytes == null) return null;
    return Math.round(Math.max(byFiles ?? 0, byBytes ?? 0));
  }

  private emptyStats(windowMs: number, retentionMs: number): UploadQueueStats {
    return {
      windowMs,
      retentionWindowMs: retentionMs,
      byStatus: STATUS_ORDER.map((status) => ({ status, files: 0, bytes: 0 })),
      total: { files: 0, bytes: 0 },
      processingNow: 0,
      worker: {
        instanceCount: computeInstanceCount(os.availableParallelism()),
        activeMs: 0,
        utilizationPercent: 0,
        filesPerSec: null,
        bytesPerSec: null,
        successCount: 0,
        failureCount: 0,
      },
      worker7d: { filesPerSec: null, bytesPerSec: null, successCount: 0 },
      latency: { avgMs: null, p95Ms: null, minMs: null, maxMs: null },
      drainEtaMs: null,
    };
  }
}
