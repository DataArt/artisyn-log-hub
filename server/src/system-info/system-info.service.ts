import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import archiver from 'archiver';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { monitorEventLoopDelay } from 'perf_hooks';
import { Pool } from 'pg';
import type { BuildInfo } from '../common/build-info';
import { readBuildInfo } from '../common/build-info';
import { computeInstanceCount } from '../common/instance-count';
import { workerStatsReporter } from '../cluster/worker-stats-reporter';
import { PG_POOL } from '../database/database.constants';
import { requestMetricsTracker } from './request-metrics.middleware';
import { SupervisorInfo, SystemInfoResponse } from './system-info.types';

const DB_SPACE_TABLE = 'logs';

@Injectable()
export class SystemInfoService implements OnModuleDestroy {
  private readonly logger = new Logger(SystemInfoService.name);

  // Module-scoped-in-effect: this service is a singleton, so the histogram is
  // enabled exactly once for the process's lifetime, at construction.
  private readonly eventLoopHistogram = monitorEventLoopDelay({
    resolution: 20,
  });

  private buildInfoCache: BuildInfo | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    this.eventLoopHistogram.enable();
    // Registered once at service construction, never per request: the
    // reporter's `message` listener is what caches the primary's snapshot so
    // getSystemInfo() needs no request-time IPC round trip. A no-op when
    // there is no IPC channel (local dev, jest).
    workerStatsReporter.start();
  }

  async getSystemInfo(): Promise<SystemInfoResponse> {
    const [db, dbSpace] = await Promise.all([
      this.getDbInfo(),
      this.getDbSpace(),
    ]);

    const supervisor = this.getSupervisorInfo();
    const cpusVisible = os.availableParallelism();

    return {
      instances: {
        expected: computeInstanceCount(cpusVisible),
        actual: supervisor.processes.length,
      },
      cpus: { visible: cpusVisible, raw: os.cpus().length },
      loadAverage: os.loadavg() as [number, number, number],
      memory: {
        processRssBytes: process.memoryUsage().rss,
        systemUsedBytes: os.totalmem() - os.freemem(),
        systemTotalBytes: os.totalmem(),
      },
      uptime: this.getUptime(),
      db,
      dbSpace,
      build: this.getBuildInfo(),
      node: {
        version: process.version,
        env: process.env.NODE_ENV ?? 'development',
      },
      eventLoopLagMs: this.getEventLoopLagMs(),
      requests: {
        perSecond: requestMetricsTracker.getRequestsPerSecond(),
        active: requestMetricsTracker.getActiveCount(),
      },
      disk: this.getDiskUsage(),
      supervisor,
    };
  }

  private getUptime(): SystemInfoResponse['uptime'] {
    // Standard lightweight container check. Docker doesn't always namespace
    // /proc/uptime, so os.uptime() inside a container is best-effort (may
    // reflect host uptime rather than the container's own) — good enough for
    // an admin diagnostics panel, and far better than a misleading number
    // outside a container.
    const isContainer = fs.existsSync('/.dockerenv');
    return {
      processSeconds: process.uptime(),
      containerSeconds: isContainer ? os.uptime() : null,
    };
  }

  private getEventLoopLagMs(): number {
    // mean is NaN until the histogram has recorded at least one sample
    // (e.g. immediately after process start) — never surface NaN to the API.
    const meanNs = this.eventLoopHistogram.mean;
    return Number.isFinite(meanNs) ? meanNs / 1e6 : 0;
  }

  private async getDbInfo(): Promise<SystemInfoResponse['db']> {
    const pool = {
      max: Number(process.env.DB_POOL_MAX) || 20,
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
    };

    const start = Date.now();
    try {
      // Same pattern as HealthController.checkDatabase().
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        return { connected: true, pingMs: Date.now() - start, pool };
      } finally {
        client.release();
      }
    } catch {
      return { connected: false, pingMs: null, pool };
    }
  }

  private async getDbSpace(): Promise<SystemInfoResponse['dbSpace']> {
    // Independent try/catch from getDbInfo(): a
    // permission failure here must never affect the DB connected/pool
    // metrics, and vice versa.
    try {
      const client = await this.pool.connect();
      try {
        const rowEstimateResult = await client.query<{
          row_estimate: string;
        }>(
          'SELECT reltuples::bigint AS row_estimate FROM pg_class WHERE relname = $1',
          [DB_SPACE_TABLE],
        );
        const tableBytesResult = await client.query<{ bytes: string }>(
          'SELECT pg_total_relation_size($1) AS bytes',
          [DB_SPACE_TABLE],
        );
        const databaseBytesResult = await client.query<{ bytes: string }>(
          'SELECT pg_database_size(current_database()) AS bytes',
        );

        // PostgreSQL 14 changed pg_class.reltuples for a table that has never
        // been vacuumed or analyzed from 0 to -1 ("unknown"), so on PG14+ a
        // freshly created database reports -1 until autovacuum first analyzes
        // the table — which the admin panel would render verbatim as
        // "Logs table: -1 rows". Clamp to 0, restoring the pre-PG14 reading.
        // Note this keeps 0 ambiguous between "empty" and "not analyzed yet";
        // that ambiguity existed on every version before PG14 too.
        const rawRowEstimate = Number(
          rowEstimateResult.rows[0]?.row_estimate ?? 0,
        );

        return {
          available: true,
          logsTableRowEstimate: Math.max(0, rawRowEstimate),
          logsTableBytes: Number(tableBytesResult.rows[0]?.bytes ?? 0),
          databaseTotalBytes: Number(databaseBytesResult.rows[0]?.bytes ?? 0),
        };
      } finally {
        client.release();
      }
    } catch {
      return {
        available: false,
        logsTableRowEstimate: null,
        logsTableBytes: null,
        databaseTotalBytes: null,
      };
    }
  }

  private getBuildInfo(): BuildInfo {
    if (!this.buildInfoCache) {
      this.buildInfoCache = readBuildInfo();
    }
    return this.buildInfoCache;
  }

  /** Resolved relative to CWD, same convention as app-logger.ts / sql-logger.ts. */
  private getLogsDir(): string {
    return path.resolve('logs');
  }

  private getDiskUsage(): SystemInfoResponse['disk'] {
    const logsDir = this.getLogsDir();
    const logsDirBytes = this.getDirectorySize(logsDir);

    let filesystemTotalBytes = 0;
    let filesystemFreeBytes = 0;
    try {
      const stats = fs.statfsSync(logsDir);
      filesystemTotalBytes = stats.blocks * stats.bsize;
      filesystemFreeBytes = stats.bfree * stats.bsize;
    } catch {
      // logs/ may not exist yet on a fresh checkout before the first log
      // line is written — report zero rather than throwing.
    }

    return { logsDirBytes, filesystemTotalBytes, filesystemFreeBytes };
  }

  /**
   * Archives the entire logs directory into a single .zip, written
   * synchronously (the caller awaits full completion before responding) to
   * the OS temp dir rather than into `logs/` itself, so the archive never
   * shows up as a growing file inside the directory it's archiving.
   * Returns the temp file path — the caller is responsible for deleting it
   * once the download response has finished.
   */
  async createLogsArchive(): Promise<{ filePath: string; fileName: string }> {
    const logsDir = this.getLogsDir();
    const fileName = `logs-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
    const filePath = path.join(os.tmpdir(), fileName);

    const start = Date.now();
    this.logger.log(`Logs archive started: ${logsDir} -> ${filePath}`);

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(filePath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => resolve());
      output.on('error', (err) => reject(err));
      archive.on('error', (err) => reject(err));

      archive.pipe(output);
      if (fs.existsSync(logsDir)) {
        archive.directory(logsDir, 'logs');
      }
      void archive.finalize();
    });

    const bytes = fs.statSync(filePath).size;
    this.logger.log(
      `Logs archive finished: ${filePath} (${bytes} bytes) in ${Date.now() - start}ms`,
    );

    return { filePath, fileName };
  }

  private getDirectorySize(dir: string): number {
    if (!fs.existsSync(dir)) return 0;

    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        total += this.getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    }
    return total;
  }

  /**
   * The cluster primary broadcasts a merged snapshot of every worker slot;
   * the worker-side reporter caches the last one it received, so this is a
   * plain in-memory read with no IPC round trip. `null` means no snapshot has
   * ever arrived — the sole signal that this process is not running under a
   * cluster primary (local dev, jest, `node index.js` by hand).
   */
  private getSupervisorInfo(): SupervisorInfo {
    const snapshot = workerStatsReporter.getSnapshot();
    if (snapshot) return snapshot;

    // Single synthetic entry describing the current process, so the admin
    // panel still renders something useful outside cluster mode.
    return {
      clustered: false,
      processes: [
        {
          instance: null,
          pid: process.pid,
          memoryBytes: process.memoryUsage().rss,
          restarts: 0,
          lastRestartAt: null,
          status: 'online (single process)',
        },
      ],
    };
  }

  /**
   * The reporter is started from this service's constructor, so it is torn
   * down here — the one, deliberate place its push interval is cleared and
   * its `message` listener removed (leaving no open handle behind under
   * jest, and no timer holding the event loop open during shutdown).
   */
  onModuleDestroy(): void {
    workerStatsReporter.stop();
  }
}
