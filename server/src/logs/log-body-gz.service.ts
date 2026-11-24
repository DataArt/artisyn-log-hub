import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { promisify } from 'util';
import * as zlib from 'zlib';
import { readPositiveIntEnv } from '../common/env-int';
import { RebuildGovernor } from '../common/load-governor/rebuild-governor';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';

const gzipAsync = promisify(zlib.gzip);

const TICK_INTERVAL_NAME = 'log-body-gz-tick';

/** gzip level of `logs.body_gz` (DD-9). */
export const LOG_BODY_GZIP_LEVEL = 6;

/** Tick interval when `LOG_BODY_GZ_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_LOG_BODY_GZ_INTERVAL_MS = 15_000;

/** Outcome of building one row's compressed copy. */
type BuildOutcome = 'none' | 'built' | 'failed';

/**
 * Builder of the pre-compressed log bodies (impl-plan DD-9 / DD-10 / DD-14a of
 * 2026-11-23-session-logs-streaming).
 *
 * `logs.body_gz` holds the gzip (level {@link LOG_BODY_GZIP_LEVEL}) of `body::text` for the
 * `artisyn`, `claude` and `claude-subagent` rows; it is valid while `body_gz_rev = body_rev`.
 * Every body write bumps `body_rev` (trigger `logs_body_guard`), so the copy goes stale on its
 * own and this drain rebuilds it. Rows written before migration 0096 have `body_rev` NULL and
 * get a revision here.
 *
 * Triggers, one drain (the `ToolUsageRebuildService` pattern):
 * - the first tick on module init, then a `SchedulerRegistry` interval every
 *   `LOG_BODY_GZ_INTERVAL_MS` (default 15 000);
 * - {@link notify}, the post-commit nudge from ingest and zip import. A nudge that arrives
 *   while a pass is running schedules one more pass right after it.
 *
 * Each unit of work, after `RebuildGovernor.admit()`, is one transaction that:
 * 1. claims ONE row matching the `idx_logs_body_gz_pending` predicate, newest first,
 *    `FOR UPDATE SKIP LOCKED` (safe across a cluster; an ingest of that row waits for it);
 * 2. reads `body::text` and `body_rev` (one body in memory at a time);
 * 3. gzips it;
 * 4. stores the copy with its revision, assigning one from `logs_body_rev_seq` when the row
 *    has none, guarded by `body_rev IS NOT DISTINCT FROM` the revision read.
 *
 * The update never touches `body`, so the trigger does not fire. A row whose build fails is
 * logged and skipped for the rest of the pass, so a poison row cannot spin the drain; it is
 * retried on the next pass.
 */
@Injectable()
export class LogBodyGzService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LogBodyGzService.name);
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly governor: RebuildGovernor,
  ) {}

  onModuleInit(): void {
    this.start();
    const interval = setInterval(
      () => {
        if (this.inFlight !== null) return;
        this.start();
      },
      readPositiveIntEnv(
        'LOG_BODY_GZ_INTERVAL_MS',
        DEFAULT_LOG_BODY_GZ_INTERVAL_MS,
      ),
    );
    this.schedulerRegistry.addInterval(TICK_INTERVAL_NAME, interval);
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.schedulerRegistry.doesExist('interval', TICK_INTERVAL_NAME)) {
      this.schedulerRegistry.deleteInterval(TICK_INTERVAL_NAME);
    }
    if (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  /**
   * Post-commit nudge: drains now, or right after the running pass. Never throws and never
   * blocks the caller.
   */
  notify(): void {
    if (this.stopped) return;
    if (this.inFlight !== null) {
      this.rerunRequested = true;
      return;
    }
    this.start();
  }

  private start(): void {
    if (this.stopped) return;
    const run = this.runPasses()
      .catch((err: unknown) =>
        this.logFailure('Log body gzip drain failed', err),
      )
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  private async runPasses(): Promise<void> {
    do {
      this.rerunRequested = false;
      const built = await this.drain();
      if (built > 0) {
        this.logger.log(`Built compressed copies of ${built} log bod(ies)`);
      }
    } while (this.rerunRequested && !this.stopped);
  }

  /** Builds every pending copy, one row per transaction. Returns the number built. */
  async drain(): Promise<number> {
    const failedIds: number[] = [];
    let built = 0;
    while (!this.stopped) {
      await this.governor.admit();
      if (this.stopped) break;
      const outcome = await this.buildOne(failedIds);
      if (outcome === 'none') break;
      if (outcome === 'built') built++;
    }
    this.governor.reportIdle();
    return built;
  }

  /**
   * Claims and builds one pending row (steps above). `failedIds` are skipped and receive the
   * id of a row whose build fails.
   */
  private async buildOne(failedIds: number[]): Promise<BuildOutcome> {
    const claim: { id: number | null } = { id: null };
    try {
      return await this.db.transaction(async (tx) => {
        const skip = sql`${`{${failedIds.join(',')}}`}::bigint[]`;
        const claimed = (
          await tx.execute(sql`
            SELECT id FROM logs
            WHERE log_type IN ('artisyn', 'claude', 'claude-subagent')
              AND body IS NOT NULL
              AND (body_rev IS NULL OR body_gz_rev IS DISTINCT FROM body_rev)
              AND id <> ALL(${skip})
            ORDER BY id DESC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          `)
        ).rows as { id: number | string }[];
        if (claimed.length === 0) return 'none';
        const id = Number(claimed[0].id);
        claim.id = id;

        const read = (
          await tx.execute(sql`
            SELECT body::text AS t, body_rev::text AS rev FROM logs WHERE id = ${id}
          `)
        ).rows as { t: string | null; rev: string | null }[];
        const text = read[0]?.t ?? null;
        if (text === null) {
          // Unreachable (the claim requires a body); skip it for the rest of the pass.
          failedIds.push(id);
          return 'failed';
        }
        const readRev = read[0].rev;

        const gz = await gzipAsync(Buffer.from(text, 'utf8'), {
          level: LOG_BODY_GZIP_LEVEL,
        });

        await tx.execute(sql`
          UPDATE logs
          SET body_rev = r.rev, body_gz = ${gz}, body_gz_rev = r.rev
          FROM (
            SELECT COALESCE(body_rev, nextval('logs_body_rev_seq')) AS rev
            FROM logs WHERE id = ${id}
          ) r
          WHERE logs.id = ${id}
            AND logs.body_rev IS NOT DISTINCT FROM ${readRev}::bigint
        `);
        return 'built';
      });
    } catch (err: unknown) {
      if (claim.id === null) throw err;
      failedIds.push(claim.id);
      this.logFailure(`Log body gzip of row ${claim.id} failed`, err);
      return 'failed';
    }
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
