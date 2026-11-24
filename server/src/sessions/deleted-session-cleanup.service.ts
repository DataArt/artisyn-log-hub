import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { readPositiveIntEnv } from '../common/env-int';
import { RebuildGovernor } from '../common/load-governor/rebuild-governor';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { lockSessionTreeForIngest } from '../logs/session-tree.sql';
import { isTombstoned } from './session-tombstone.service';
import { SessionsService } from './sessions.service';

const TICK_INTERVAL_NAME = 'deleted-session-cleanup-tick';

/** Tick interval when `DELETED_SESSION_CLEANUP_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_DELETED_SESSION_CLEANUP_INTERVAL_MS = 60_000;

/** Sessions handled per step per pass. */
export const DELETED_SESSION_CLEANUP_BATCH = 200;

/**
 * The `deleted = true` sessions that still own a row in a DD-28 survivor table (or a `logs`
 * row). `turn_end_advisor_runs` is keyed by the session id string.
 */
const STILL_OWNS_SURVIVORS = sql`(
  EXISTS (SELECT 1 FROM logs x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM logs_otel x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM otel_api_calls x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_request_ids x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_tool_stats x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_harness_usage x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_changed_paths x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_cause_stats x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_attribution x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_attribution_runs x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM session_prompt_watermark x WHERE x.session_id = s.id)
  OR EXISTS (SELECT 1 FROM turn_end_advisor_runs x WHERE x.session_id = s.session_id)
)`;

/**
 * Deleted-session cleanup (DD-28 of 2026-11-23-session-logs-streaming), a governed background
 * drain started per DD-14a: a first pass on module init, then one every
 * `DELETED_SESSION_CLEANUP_INTERVAL_MS` (default 60 000). Each pass:
 *
 * 1. finds up to {@link DELETED_SESSION_CLEANUP_BATCH} live sub-agent sessions whose parent is
 *    a tombstone (a `deleted` session row or a `deleted_session_log` row) — uploaded before the
 *    tombstone check existed, or ingested past it — and, per session and under the tree's
 *    ingest lock, confirms with `isTombstoned`, then `markSessionTreeDeleted(tx, pk, null)` and
 *    `purgeSessionChildData`. A deeper live chain converges over the following passes;
 * 2. purges the child data of up to {@link DELETED_SESSION_CLEANUP_BATCH} `deleted` sessions
 *    that still own survivor rows — sessions deleted before the survivor tables were purged at
 *    delete time.
 *
 * Every unit of work waits on `RebuildGovernor.admit()`. Safe across a cluster: step 1 rechecks
 * the row under the tree lock, and step 2 is idempotent.
 */
@Injectable()
export class DeletedSessionCleanupService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DeletedSessionCleanupService.name);
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly governor: RebuildGovernor,
    private readonly sessionsService: SessionsService,
  ) {}

  onModuleInit(): void {
    this.start();
    const interval = setInterval(
      () => {
        if (this.inFlight !== null) return;
        this.start();
      },
      readPositiveIntEnv(
        'DELETED_SESSION_CLEANUP_INTERVAL_MS',
        DEFAULT_DELETED_SESSION_CLEANUP_INTERVAL_MS,
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

  private start(): void {
    if (this.stopped) return;
    const run = this.runPass()
      .then(() => undefined)
      .catch((err: unknown) => {
        this.logger.error(
          `Deleted-session cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err.stack : undefined,
        );
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  /** One pass: both steps. Returns the counts for the log line. */
  async runPass(): Promise<{ orphansDeleted: number; purged: number }> {
    const orphansDeleted = await this.deleteOrphanDescendants();
    const purged = await this.purgeSurvivors();
    this.governor.reportIdle();
    if (orphansDeleted > 0 || purged > 0) {
      this.logger.log(
        `Deleted-session cleanup: ${orphansDeleted} session(s) under a deleted parent deleted, ` +
          `${purged} deleted session(s) purged of leftover rows`,
      );
    }
    return { orphansDeleted, purged };
  }

  /** Step 1. Returns the number of sessions marked deleted. */
  private async deleteOrphanDescendants(): Promise<number> {
    const res = await this.db.execute(sql`
      SELECT s.id, s.session_id, s.parent_session_id
      FROM sessions s
      WHERE s.deleted = false
        AND s.parent_session_id IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM sessions p
                   WHERE p.session_id = s.parent_session_id AND p.deleted = true)
          OR EXISTS (SELECT 1 FROM deleted_session_log d
                      WHERE d.session_id = s.parent_session_id)
        )
      ORDER BY s.id
      LIMIT ${DELETED_SESSION_CLEANUP_BATCH}
    `);
    const rows = res.rows as unknown as {
      id: number | string;
      session_id: string;
      parent_session_id: string;
    }[];

    let marked = 0;
    for (const row of rows) {
      if (this.stopped) break;
      await this.governor.admit();
      try {
        marked += await this.db.transaction(async (tx) => {
          await lockSessionTreeForIngest(tx, row.session_id, undefined);
          if (!(await isTombstoned(tx, row.parent_session_id))) return 0;
          const ids = await this.sessionsService.markSessionTreeDeleted(
            tx,
            Number(row.id),
            null,
          );
          await this.sessionsService.purgeSessionChildData(tx, ids);
          return ids.length;
        });
      } catch (err) {
        this.logger.warn(
          `Deleted-session cleanup skipped session ${row.session_id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return marked;
  }

  /** Step 2. Returns the number of deleted sessions purged. */
  private async purgeSurvivors(): Promise<number> {
    if (this.stopped) return 0;
    const res = await this.db.execute(sql`
      SELECT s.id
      FROM sessions s
      WHERE s.deleted = true AND ${STILL_OWNS_SURVIVORS}
      ORDER BY s.id
      LIMIT ${DELETED_SESSION_CLEANUP_BATCH}
    `);
    const ids = (res.rows as unknown as { id: number | string }[]).map((r) =>
      Number(r.id),
    );
    if (ids.length === 0) return 0;
    await this.governor.admit();
    await this.db.transaction(async (tx) => {
      await this.sessionsService.purgeSessionChildData(tx, ids);
    });
    return ids.length;
  }
}
