import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { computeDayTag } from '../common/sql-logger';
import {
  DEFAULT_LOG_RETENTION_CHECK_INTERVAL_MS,
  LogFileInfo,
  parseRetentionEnv,
  planLogCleanup,
  readLogRetentionPolicy,
} from './log-retention-plan';

const TICK_INTERVAL_NAME = 'log-retention-tick';

/**
 * Deletes the server's own old `logs/app-*.log` / `logs/sql-*.log` files: once at bootstrap and
 * then every `LOG_RETENTION_CHECK_INTERVAL_MS` (default 1 h). What is deleted is decided by
 * `planLogCleanup()` — `LOG_RETENTION_DAYS` (default 5) days of app logs,
 * `SQL_LOG_RETENTION_DAYS` (default 3) days of SQL logs and a `LOG_RETENTION_MAX_MB`
 * (default 100) cap on their total size; today's files are never touched.
 *
 * Every cluster worker runs it, like `ExportImportJobCleanupScheduler`: the sweep is idempotent
 * and a file another worker already removed (`ENOENT`) is not an error. A file that cannot be
 * deleted yet (e.g. still held open on Windows) is retried on the next tick.
 */
@Injectable()
export class LogRetentionService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(LogRetentionService.name);
  private isTickRunning = false;

  constructor(private readonly schedulerRegistry: SchedulerRegistry) {}

  onApplicationBootstrap(): void {
    const intervalMs =
      parseRetentionEnv(
        process.env.LOG_RETENTION_CHECK_INTERVAL_MS,
        DEFAULT_LOG_RETENTION_CHECK_INTERVAL_MS,
      ) || DEFAULT_LOG_RETENTION_CHECK_INTERVAL_MS;
    void this.tick();
    const interval = setInterval(() => void this.tick(), intervalMs);
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  onModuleDestroy(): void {
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
  }

  async tick(): Promise<void> {
    if (this.isTickRunning) return;
    this.isTickRunning = true;
    try {
      await this.sweep(path.resolve('logs'));
    } catch (err) {
      this.logger.error(
        `Log retention sweep failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err instanceof Error ? err.stack : undefined,
      );
    } finally {
      this.isTickRunning = false;
    }
  }

  private async sweep(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
      throw err;
    }

    const files: LogFileInfo[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const stat = await fs.promises.stat(path.join(dir, entry.name));
        files.push({ name: entry.name, size: stat.size });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
      }
    }

    const toDelete = planLogCleanup(
      files,
      computeDayTag(),
      readLogRetentionPolicy(),
    );
    let removed = 0;
    for (const name of toDelete) {
      try {
        await fs.promises.unlink(path.join(dir, name));
        removed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
          this.logger.warn(
            `Failed to remove old log file ${name}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    if (removed > 0) {
      this.logger.log(`Removed ${removed} old log file(s)`);
    }
  }
}
