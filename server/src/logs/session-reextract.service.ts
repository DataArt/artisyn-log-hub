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
import { writeClaudeDerived } from './claude-derived-writer';
import {
  getDescendantSessionIds,
  lockSessionTreeForIngest,
} from './session-tree.sql';
import { ToolUsageRebuildService } from './tool-monitoring/tool-usage-rebuild.service';
import { markTreeStale } from './tool-monitoring/tool-usage-writer';
import { readTreeEditSha } from './tree-edit-sha';

const TICK_INTERVAL_NAME = 'session-reextract-tick';

/** Tick interval when `SESSION_REEXTRACT_INTERVAL_MS` is unset or invalid. */
export const DEFAULT_SESSION_REEXTRACT_INTERVAL_MS = 15_000;

/** Outcome of re-extracting one queued tree. */
type ReextractOutcome = 'none' | 'done' | 'skipped' | 'failed';

interface TranscriptRowMeta {
  id: number | string;
  session_row_id: number | string;
  session_id: string;
  log_type: 'claude' | 'claude-subagent';
  user_id: number | string;
}

/**
 * Re-extraction drain of transcript stats (impl-plan DD-22 / DD-14a of
 * 2026-11-23-session-logs-streaming).
 *
 * A tree's `claude` / `claude-subagent` stats are extracted against the tree's artisyn edit
 * records. When an `artisyn` upload changes those records, `LogsService.upsert` queues the tree
 * root in `session_reextract_queue` and nudges this service after the commit.
 *
 * Triggers, one drain (the `ToolUsageRebuildService` pattern):
 * - the first tick on module init, then a `SchedulerRegistry` interval every
 *   `SESSION_REEXTRACT_INTERVAL_MS` (default 15 000);
 * - {@link notify}. A nudge that arrives while a pass is running schedules one more pass.
 *
 * Each unit of work, after `RebuildGovernor.admit()`, is one tree in one transaction:
 * 1. pick the oldest queue row not tried in this pass (no lock yet);
 * 2. take the tree's ingest lock (`lockSessionTreeForIngest`) — BEFORE locking the queue row,
 *    because ingest upserts that row while it holds the tree lock, so the opposite order
 *    could deadlock;
 * 3. lock the queue row `FOR UPDATE SKIP LOCKED` (another worker may have taken it);
 * 4. for each `claude` / `claude-subagent` row of the tree, read ONE body at a time, parse it,
 *    call `writeClaudeDerived` and set `stats_edit_sha256` to the tree's current edit revision
 *    (the update does not touch `body`, so the `logs_body_guard` trigger does not fire);
 * 5. `markTreeStale` and delete the queue row.
 *
 * A soft-deleted root only drops its queue row. A tree whose re-extraction fails is logged and
 * skipped for the rest of the pass (its row stays and is retried on the next pass).
 */
@Injectable()
export class SessionReextractService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionReextractService.name);
  private inFlight: Promise<void> | null = null;
  private rerunRequested = false;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly governor: RebuildGovernor,
    private readonly toolUsageRebuild: ToolUsageRebuildService,
  ) {}

  onModuleInit(): void {
    this.start();
    const interval = setInterval(
      () => {
        if (this.inFlight !== null) return;
        this.start();
      },
      readPositiveIntEnv(
        'SESSION_REEXTRACT_INTERVAL_MS',
        DEFAULT_SESSION_REEXTRACT_INTERVAL_MS,
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
        this.logFailure('Session re-extract drain failed', err),
      )
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
    this.inFlight = run;
  }

  private async runPasses(): Promise<void> {
    do {
      this.rerunRequested = false;
      const done = await this.drain();
      if (done > 0) {
        this.logger.log(
          `Re-extracted transcript stats of ${done} session tree(s)`,
        );
      }
    } while (this.rerunRequested && !this.stopped);
  }

  /** Re-extracts every queued tree, one per transaction. Returns the number done. */
  async drain(): Promise<number> {
    const triedIds: number[] = [];
    let done = 0;
    while (!this.stopped) {
      await this.governor.admit();
      if (this.stopped) break;
      const outcome = await this.reextractOne(triedIds);
      if (outcome === 'none') break;
      if (outcome === 'done') done++;
    }
    this.governor.reportIdle();
    return done;
  }

  /**
   * Re-extracts one queued tree (steps above). `triedIds` are skipped for the rest of the
   * pass and receive the picked root, whatever the outcome.
   */
  private async reextractOne(triedIds: number[]): Promise<ReextractOutcome> {
    const skip = sql`${`{${triedIds.join(',')}}`}::int[]`;
    const picked = (
      await this.db.execute(sql`
        SELECT q.session_pk, s.session_id, s.deleted
        FROM session_reextract_queue q
        JOIN sessions s ON s.id = q.session_pk
        WHERE q.session_pk <> ALL(${skip})
        ORDER BY q.requested_at ASC
        LIMIT 1
      `)
    ).rows as {
      session_pk: number | string;
      session_id: string;
      deleted: boolean;
    }[];
    if (picked.length === 0) return 'none';
    const rootPk = Number(picked[0].session_pk);
    const rootSessionId = picked[0].session_id;
    triedIds.push(rootPk);

    try {
      const outcome = await this.db.transaction(async (tx) => {
        await lockSessionTreeForIngest(tx, rootSessionId, undefined);
        const locked = (
          await tx.execute(sql`
            SELECT session_pk FROM session_reextract_queue
            WHERE session_pk = ${rootPk}
            FOR UPDATE SKIP LOCKED
          `)
        ).rows;
        // Another worker took (or already finished) this tree.
        if (locked.length === 0) return 'skipped' as const;

        if (!picked[0].deleted) {
          await this.reextractTree(tx, rootPk);
        }
        await tx.execute(
          sql`DELETE FROM session_reextract_queue WHERE session_pk = ${rootPk}`,
        );
        return picked[0].deleted ? ('skipped' as const) : ('done' as const);
      });
      if (outcome === 'done') {
        this.toolUsageRebuild.notify();
        return 'done';
      }
      return 'skipped';
    } catch (err: unknown) {
      this.logFailure(`Session re-extract of tree root ${rootPk} failed`, err);
      return 'failed';
    }
  }

  /** Steps 4–5: one transcript body in memory at a time. */
  private async reextractTree(tx: DrizzleDb, rootPk: number): Promise<void> {
    const descendants =
      (await getDescendantSessionIds(tx, [rootPk])).get(rootPk) ?? [];
    const treeIds = [rootPk, ...descendants];
    const rows = (
      await tx.execute(sql`
        SELECT l.id, l.session_id AS session_row_id, s.session_id, l.log_type, l.user_id
        FROM logs l
        JOIN sessions s ON s.id = l.session_id
        WHERE l.session_id = ANY(${`{${treeIds.join(',')}}`}::int[])
          AND l.log_type IN ('claude', 'claude-subagent')
          AND l.body IS NOT NULL
        ORDER BY l.id
      `)
    ).rows as unknown as TranscriptRowMeta[];

    for (const row of rows) {
      const logId = Number(row.id);
      const sessionRowId = Number(row.session_row_id);
      const read = (
        await tx.execute(
          sql`SELECT body::text AS t FROM logs WHERE id = ${logId}`,
        )
      ).rows as { t: string | null }[];
      const text = read[0]?.t ?? null;
      if (text === null) continue;
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) continue;
      const lines = parsed.filter(
        (line): line is object => typeof line === 'object' && line !== null,
      );
      const statsEditSha256 = await readTreeEditSha(tx, sessionRowId);
      await writeClaudeDerived(tx, {
        sessionRowId,
        sessionId: row.session_id,
        logType: row.log_type,
        lines,
        userId: Number(row.user_id),
      });
      await tx.execute(
        sql`UPDATE logs SET stats_edit_sha256 = ${statsEditSha256} WHERE id = ${logId}`,
      );
    }
    await markTreeStale(tx, rootPk);
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
