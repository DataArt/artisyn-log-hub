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
import { extractWorkflows, WORKFLOWS_VERSION } from './workflow-extractor';

const TICK_INTERVAL_NAME = 'workflows-backfill-tick';

/** Tick interval when `WORKFLOWS_BACKFILL_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_WORKFLOWS_BACKFILL_INTERVAL_MS = 15_000;

/**
 * Workflows backfill (impl-plan DD-6 / DD-14a of 2026-11-23-session-logs-streaming).
 *
 * Ingest stores a root transcript's workflow runs in `session_stats.workflows`; rows written
 * before migration 0096 (or after a `WORKFLOWS_VERSION` bump that nulls `workflows_version`)
 * have none, and readers fall back to parsing the root `claude` body until this drain fills
 * them. It starts on module init (first tick) and then ticks every
 * `WORKFLOWS_BACKFILL_INTERVAL_MS`.
 *
 * Each unit of work, after `RebuildGovernor.admit()`, is one transaction that:
 * 1. claims ONE `session_stats` row with `workflows_version IS NULL` whose live session has a
 *    `claude` log, `FOR UPDATE OF ss SKIP LOCKED` (safe across a cluster; an ingest that
 *    upserts the same row waits and then overwrites it with its own fresh value);
 * 2. reads that one body as text (one body in memory at a time), extracts the runs and
 *    writes `workflows` + `workflows_version`.
 *
 * A NULL or unparsable body stores `[]`, so a poison row cannot loop forever. A tick drains
 * until nothing is left, then reports idle to the governor.
 */
@Injectable()
export class WorkflowsBackfillService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WorkflowsBackfillService.name);
  private inFlight: Promise<void> | null = null;
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
        'WORKFLOWS_BACKFILL_INTERVAL_MS',
        DEFAULT_WORKFLOWS_BACKFILL_INTERVAL_MS,
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
    const run = this.drain()
      .then((filled) => {
        if (filled > 0) {
          this.logger.log(`Backfilled workflows of ${filled} session(s)`);
        }
      })
      .catch((err: unknown) =>
        this.logFailure('Workflows backfill pass failed', err),
      )
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  /** Drains every pending row, one per transaction. Returns the number filled. */
  async drain(): Promise<number> {
    let filled = 0;
    while (!this.stopped) {
      await this.governor.admit();
      if (this.stopped) break;
      const done = await this.fillOne();
      if (!done) break;
      filled++;
    }
    this.governor.reportIdle();
    return filled;
  }

  /** Claims and fills one pending row (steps above). False when none is pending. */
  private async fillOne(): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const claimed = (
        await tx.execute(sql`
          SELECT ss.session_id FROM session_stats ss
          JOIN sessions s ON s.id = ss.session_id
          WHERE ss.workflows_version IS NULL
            AND NOT s.deleted
            AND EXISTS (
              SELECT 1 FROM logs l
              WHERE l.session_id = ss.session_id AND l.log_type = 'claude'
            )
          ORDER BY ss.session_id
          LIMIT 1
          FOR UPDATE OF ss SKIP LOCKED
        `)
      ).rows as { session_id: number | string }[];
      if (claimed.length === 0) return false;
      const sessionRowId = Number(claimed[0].session_id);

      const bodyRows = (
        await tx.execute(sql`
          SELECT body::text AS t FROM logs
          WHERE session_id = ${sessionRowId} AND log_type = 'claude'
          LIMIT 1
        `)
      ).rows as { t: string | null }[];
      const workflows = this.extract(sessionRowId, bodyRows[0]?.t ?? null);

      await tx.execute(sql`
        UPDATE session_stats
        SET workflows = ${JSON.stringify(workflows)}::jsonb,
            workflows_version = ${WORKFLOWS_VERSION}
        WHERE session_id = ${sessionRowId}
      `);
      return true;
    });
  }

  private extract(
    sessionRowId: number,
    text: string | null,
  ): ReturnType<typeof extractWorkflows> {
    if (text === null) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? extractWorkflows(parsed) : [];
    } catch (err: unknown) {
      this.logFailure(
        `Workflows backfill of session ${sessionRowId} could not parse the body`,
        err,
      );
      return [];
    }
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
