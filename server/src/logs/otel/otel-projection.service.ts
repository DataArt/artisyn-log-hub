import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { sql, type SQL } from 'drizzle-orm';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';
import {
  OTEL_CLEANUP_BATCH,
  OTEL_PROJECTION_BATCH,
  OTEL_PROJECTION_FAILED,
  OTEL_PROJECTION_VERSION,
  OTEL_RECLASS_BATCH,
  resolveOtelProjectionIntervalMs,
  OTEL_SESSION_ENDED_MS,
} from './otel-facts.constants';
import {
  applyOtelLines,
  lockOtelState,
  OtelSessionDeletedError,
  reclassifyOtelSession,
} from './otel-facts-writer';

const TICK_INTERVAL_NAME = 'otel-projection-tick';

/** One claimed `logs_otel` row (step 1). */
interface ClaimedChunk {
  id: number;
  sessionId: number;
  userId: number;
}

/** The claimed chunks of one root session (step 2). */
interface RootGroup {
  rootId: number;
  userId: number;
  chunkIds: number[];
}

/** Counters of one tick, for the summary log line. */
export interface OtelProjectionTickStats {
  /** `logs_otel` rows claimed. */
  chunks: number;
  /** Root sessions whose chunks were projected. */
  sessions: number;
  /** Chunks whose projection failed (marked `-1`). */
  failedChunks: number;
  /** Chunks skipped because their session is deleted. */
  deletedChunks: number;
  /** `otel_calls` + `otel_spans` rows first inserted as `fill` (DD-3). */
  fills: number;
  /** Reclassification-queue rows handled (DD-5). */
  reclassified: number;
  /** Idle provisional roots queued for finalising (DD-5). */
  finalised: number;
  /** Deleted roots whose OTEL rows were removed (DD-16 step 5). */
  cleaned: number;
}

function bigintArray(ids: readonly number[]): SQL {
  return sql`${`{${ids.map((id) => Math.trunc(id)).join(',')}}`}::bigint[]`;
}

function intArray(ids: readonly number[]): SQL {
  return sql`${`{${ids.map((id) => Math.trunc(id)).join(',')}}`}::int[]`;
}

/**
 * Background projection of the OTEL facts (DD-16, 2026-10-30 otel-tabs-traces). Every
 * `OTEL_PROJECTION_INTERVAL_MS` (env-overridable, default 5000) one tick:
 *
 * 1. **claims** up to `OTEL_PROJECTION_BATCH` pending `logs_otel` rows
 *    (`otel_projection_version IS NULL`) and stamps them with `OTEL_PROJECTION_VERSION` in a short
 *    committed transaction, BEFORE any work — a chunk that keeps failing, or one of a deleted
 *    session, never blocks the queue, and a re-uploaded chunk (the ingest upsert sets NULL) is
 *    projected again;
 * 2. **projects** each root session in its own transaction: the OTEL state lock (`create: true`)
 *    and the deleted check (DD-2), `applyOtelLines(…, 'chunk')` per claimed body, then
 *    `chunk_last_at` and the gap-close rule (DD-14). A deleted session's chunks are skipped; a
 *    failure is logged and marks the claimed rows `-1` (re-queued by the startup re-mark);
 * 3. drains the **reclassification queue** (DD-5), one `DELETE … RETURNING` claim per
 *    transaction, up to `OTEL_RECLASS_BATCH` roots;
 * 4. queues **idle provisional roots** for finalising (DD-5);
 * 5. **cleans up** the OTEL rows of up to `OTEL_CLEANUP_BATCH` deleted roots, found through
 *    `otel_session_state` (sessions soft-deleted while an old server build ran).
 *
 * Then it writes one summary log line when the tick did anything. Safe across a cluster: every
 * claim uses `SKIP LOCKED` and every write the per-root state lock.
 */
@Injectable()
export class OtelProjectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OtelProjectionService.name);
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  onModuleInit(): void {
    const interval = setInterval(() => {
      if (this.inFlight !== null || this.stopped) return;
      const run = this.tick()
        .then(() => undefined)
        .catch((err: unknown) =>
          this.logFailure('OTEL projection tick failed', err),
        )
        .finally(() => {
          if (this.inFlight === run) this.inFlight = null;
        });
      this.inFlight = run;
    }, resolveOtelProjectionIntervalMs());
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

  /** One tick (steps 1–5 above) plus the summary log line. */
  async tick(): Promise<OtelProjectionTickStats> {
    const startedAt = Date.now();
    const stats: OtelProjectionTickStats = {
      chunks: 0,
      sessions: 0,
      failedChunks: 0,
      deletedChunks: 0,
      fills: 0,
      reclassified: 0,
      finalised: 0,
      cleaned: 0,
    };

    await this.projectChunks(stats);
    if (!this.stopped) await this.drainReclassQueue(stats);
    if (!this.stopped) stats.finalised = await this.enqueueIdleRoots();
    if (!this.stopped) stats.cleaned = await this.cleanupDeletedRoots();

    if (
      stats.chunks + stats.reclassified + stats.finalised + stats.cleaned >
      0
    ) {
      this.logger.log(
        `OTEL projection: chunks=${stats.chunks} sessions=${stats.sessions} ` +
          `fills=${stats.fills} failed=${stats.failedChunks} deleted=${stats.deletedChunks} ` +
          `reclassified=${stats.reclassified} finalised=${stats.finalised} ` +
          `cleaned=${stats.cleaned} durationMs=${Date.now() - startedAt}`,
      );
    }
    return stats;
  }

  // -------------------------------------------------------------------------
  // Steps 1–2: claim and project chunks
  // -------------------------------------------------------------------------

  private async projectChunks(stats: OtelProjectionTickStats): Promise<void> {
    const claimed = await this.claimChunks();
    stats.chunks = claimed.length;
    if (claimed.length === 0) return;

    for (const group of await this.groupByRoot(claimed)) {
      if (this.stopped) break;
      try {
        const fills = await this.projectRoot(group);
        stats.sessions++;
        stats.fills += fills;
      } catch (err: unknown) {
        if (err instanceof OtelSessionDeletedError) {
          // Deleted session: its chunks stay stamped and are simply skipped (DD-16 step 2).
          stats.deletedChunks += group.chunkIds.length;
          continue;
        }
        stats.failedChunks += group.chunkIds.length;
        this.logFailure(
          `OTEL projection of session ${group.rootId} (chunks ${group.chunkIds.join(',')}) failed`,
          err,
        );
        await this.markFailed(group.chunkIds);
      }
    }
  }

  /**
   * Step 1 — stamps up to `OTEL_PROJECTION_BATCH` pending rows with the current version in one
   * short committed statement (the partial index on `IS NULL` serves the inner select).
   */
  private async claimChunks(): Promise<ClaimedChunk[]> {
    const result = await this.db.execute(sql`
      UPDATE logs_otel SET otel_projection_version = ${OTEL_PROJECTION_VERSION}
       WHERE id IN (
         SELECT id FROM logs_otel
          WHERE otel_projection_version IS NULL
          ORDER BY id
          LIMIT ${OTEL_PROJECTION_BATCH}
          FOR UPDATE SKIP LOCKED
       )
      RETURNING id, session_id, user_id
    `);
    const rows = result.rows as unknown as {
      id: number | string;
      session_id: number | string;
      user_id: number | string;
    }[];
    return rows
      .map((r) => ({
        id: Number(r.id),
        sessionId: Number(r.session_id),
        userId: Number(r.user_id),
      }))
      .sort((a, b) => a.id - b.id);
  }

  /** Resolves each chunk's root session (DD-1) and groups the chunks per root, in id order. */
  private async groupByRoot(claimed: ClaimedChunk[]): Promise<RootGroup[]> {
    const sessionIds = [...new Set(claimed.map((c) => c.sessionId))];
    const rootRes = await this.db.execute(sql`
      WITH RECURSIVE ${topAncestorIdsSql(bigintArray(sessionIds))}
      SELECT id, top_id FROM top_ancestors
    `);
    const rootOf = new Map<number, number>();
    for (const row of rootRes.rows as unknown as {
      id: number | string;
      top_id: number | string;
    }[]) {
      rootOf.set(Number(row.id), Number(row.top_id));
    }

    const groups = new Map<number, RootGroup>();
    for (const chunk of claimed) {
      const rootId = rootOf.get(chunk.sessionId) ?? chunk.sessionId;
      const group = groups.get(rootId);
      if (group) {
        group.chunkIds.push(chunk.id);
      } else {
        groups.set(rootId, {
          rootId,
          userId: chunk.userId,
          chunkIds: [chunk.id],
        });
      }
    }
    return [...groups.values()];
  }

  /**
   * Step 2 — projects one root's claimed chunks in one transaction. Returns the number of
   * `fill` rows (calls + spans) the projection inserted. Throws {@link OtelSessionDeletedError}
   * (rolled back) for a deleted root.
   */
  private async projectRoot(group: RootGroup): Promise<number> {
    return this.db.transaction(async (tx) => {
      const lock = await lockOtelState(tx, group.rootId, {
        create: true,
        userId: group.userId,
      });
      if (!lock) {
        throw new Error(
          `no otel_session_state row for session ${group.rootId} after create`,
        );
      }
      const seqBefore = lock.state.seq;

      // The bodies are read without row locks (DD-2: OTEL writers never lock logs_otel rows).
      const bodiesRes = await tx.execute(sql`
        SELECT id, body FROM logs_otel
         WHERE id = ANY(${intArray(group.chunkIds)})
         ORDER BY id
      `);
      const bodies = bodiesRes.rows as unknown as {
        id: number | string;
        body: unknown;
      }[];
      // One apply per chunk: two chunks may carry the same call, and one upsert statement
      // must never touch a row twice.
      for (const { body } of bodies) {
        if (!Array.isArray(body) || body.length === 0) continue;
        await applyOtelLines(
          tx,
          group.rootId,
          group.userId,
          body as unknown[],
          'chunk',
        );
      }

      // chunk_last_at = upload time of the newest projected chunk (server clock), and the
      // gap-close rule (DD-14): rt_gap_at is cleared once the tree has no pending chunk and
      // the chunks have caught up with the gap.
      await tx.execute(sql`
        WITH RECURSIVE ${descendantSessionsCte(bigintArray([group.rootId]))},
        newest AS (
          SELECT MAX(created_at) AS created_at FROM logs_otel
           WHERE id = ANY(${intArray(group.chunkIds)})
        ),
        caught_up AS (
          SELECT GREATEST(st.chunk_last_at, (SELECT created_at FROM newest)) AS chunk_last_at
            FROM otel_session_state st
           WHERE st.session_id = ${group.rootId}
        )
        UPDATE otel_session_state st SET
          chunk_last_at = (SELECT chunk_last_at FROM caught_up),
          rt_gap_at = CASE
            WHEN st.rt_gap_at IS NOT NULL
             AND (SELECT chunk_last_at FROM caught_up) >= st.rt_gap_at
             AND NOT EXISTS (
               SELECT 1 FROM logs_otel lo
                WHERE lo.session_id IN (SELECT id FROM descendant_sessions)
                  AND lo.otel_projection_version IS NULL
             )
            THEN NULL
            ELSE st.rt_gap_at
          END
         WHERE st.session_id = ${group.rootId}
      `);

      const fillsRes = await tx.execute(sql`
        SELECT
          (SELECT COUNT(*) FROM otel_calls
            WHERE session_id = ${group.rootId} AND seq > ${seqBefore}
              AND change_kind = 'fill')
          +
          (SELECT COUNT(*) FROM otel_spans
            WHERE session_id = ${group.rootId} AND seq > ${seqBefore}
              AND change_kind = 'fill') AS fills
      `);
      return Number(
        (fillsRes.rows as unknown as { fills: number | string }[])[0]?.fills ??
          0,
      );
    });
  }

  /** Marks chunks whose projection failed; the startup re-mark (< current) retries them. */
  private async markFailed(chunkIds: number[]): Promise<void> {
    try {
      await this.db.execute(sql`
        UPDATE logs_otel SET otel_projection_version = ${OTEL_PROJECTION_FAILED}
         WHERE id = ANY(${intArray(chunkIds)})
           AND otel_projection_version = ${OTEL_PROJECTION_VERSION}
      `);
    } catch (err: unknown) {
      this.logFailure(
        `Marking OTEL chunks ${chunkIds.join(',')} as failed failed`,
        err,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 3: reclassification queue (DD-5)
  // -------------------------------------------------------------------------

  private async drainReclassQueue(
    stats: OtelProjectionTickStats,
  ): Promise<void> {
    for (let i = 0; i < OTEL_RECLASS_BATCH && !this.stopped; i++) {
      let claimed: { sessionId: number; queuedAt: string } | null = null;
      try {
        const done = await this.db.transaction(async (tx) => {
          // The dequeue is the first statement of the transaction that does the work: a
          // transcript committing meanwhile re-inserts the row, so no update is lost.
          const res = await tx.execute(sql`
            DELETE FROM otel_reclass_queue
             WHERE session_id = (
               SELECT session_id FROM otel_reclass_queue
                ORDER BY queued_at
                LIMIT 1
                FOR UPDATE SKIP LOCKED
             )
            RETURNING session_id, queued_at::text AS queued_at
          `);
          const row = (
            res.rows as unknown as {
              session_id: number | string;
              queued_at: string;
            }[]
          )[0];
          if (!row) return false;
          claimed = {
            sessionId: Number(row.session_id),
            queuedAt: row.queued_at,
          };
          try {
            await reclassifyOtelSession(tx, claimed.sessionId);
          } catch (err: unknown) {
            // A deleted root: lockOtelState threw before any write, so committing keeps only
            // the dequeue.
            if (!(err instanceof OtelSessionDeletedError)) throw err;
          }
          return true;
        });
        if (!done) break;
        stats.reclassified++;
      } catch (err: unknown) {
        const failed = claimed as {
          sessionId: number;
          queuedAt: string;
        } | null;
        this.logFailure(
          `OTEL reclassification of session ${failed?.sessionId ?? '?'} failed`,
          err,
        );
        if (failed === null) break;
        // The rollback restored the queue row; drop it so a poison row cannot loop every tick.
        // The next transcript upload of the session queues it again.
        await this.db
          .execute(
            sql`
              DELETE FROM otel_reclass_queue
               WHERE session_id = ${failed.sessionId}
                 AND queued_at = ${failed.queuedAt}::timestamptz
            `,
          )
          .catch((e: unknown) =>
            this.logFailure('Dropping a failed OTEL reclass row failed', e),
          );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 4: idle-root finalising (DD-5)
  // -------------------------------------------------------------------------

  /**
   * Queues roots that still hold provisional calls, have had no OTEL data for
   * `OTEL_SESSION_ENDED_MS` and whose tree records request ids — backfilled history and chunks
   * projected after the final transcript — so no session stays provisional forever. Returns the
   * number of roots queued.
   */
  private async enqueueIdleRoots(): Promise<number> {
    const result = await this.db.execute(sql`
      WITH RECURSIVE candidates AS (
        SELECT st.session_id
          FROM otel_session_state st
          JOIN sessions s ON s.id = st.session_id
         WHERE st.has_provisional
           AND NOT s.deleted
           AND GREATEST(st.rt_last_at, st.chunk_last_at)
               < now() - (${OTEL_SESSION_ENDED_MS} * interval '1 millisecond')
           AND NOT EXISTS (
             SELECT 1 FROM otel_reclass_queue q WHERE q.session_id = st.session_id
           )
      ),
      ${descendantSessionsCte(sql`ARRAY(SELECT session_id FROM candidates)::bigint[]`)}
      INSERT INTO otel_reclass_queue (session_id)
      SELECT root_id FROM (
        SELECT DISTINCT d.root_id
          FROM descendant_sessions d
          JOIN session_request_ids sri ON sri.session_id = d.id
         ORDER BY d.root_id
         LIMIT ${OTEL_RECLASS_BATCH}
      ) r
      ON CONFLICT (session_id) DO NOTHING
    `);
    return result.rowCount ?? 0;
  }

  // -------------------------------------------------------------------------
  // Step 5: deleted-session cleanup
  // -------------------------------------------------------------------------

  /** Deletes the OTEL rows of up to `OTEL_CLEANUP_BATCH` deleted roots; returns the count. */
  private async cleanupDeletedRoots(): Promise<number> {
    const result = await this.db.execute(sql`
      SELECT st.session_id
        FROM otel_session_state st
        JOIN sessions s ON s.id = st.session_id
       WHERE s.deleted
       ORDER BY st.session_id
       LIMIT ${OTEL_CLEANUP_BATCH}
    `);
    const rootIds = (
      result.rows as unknown as { session_id: number | string }[]
    ).map((r) => Number(r.session_id));

    let cleaned = 0;
    for (const rootId of rootIds) {
      if (this.stopped) break;
      try {
        const done = await this.db.transaction(async (tx) => {
          // The state row first (DD-2 / DD-25), the same order as purgeSessionChildData.
          const locked = await tx.execute(sql`
            SELECT session_id FROM otel_session_state
             WHERE session_id = ${rootId}
               FOR UPDATE SKIP LOCKED
          `);
          if (locked.rows.length === 0) return false;
          await tx.execute(
            sql`DELETE FROM otel_session_state WHERE session_id = ${rootId}`,
          );
          await tx.execute(
            sql`DELETE FROM otel_calls WHERE session_id = ${rootId}`,
          );
          await tx.execute(
            sql`DELETE FROM otel_spans WHERE session_id = ${rootId}`,
          );
          await tx.execute(
            sql`DELETE FROM otel_cost_buckets WHERE session_id = ${rootId}`,
          );
          await tx.execute(
            sql`DELETE FROM otel_reclass_queue WHERE session_id = ${rootId}`,
          );
          return true;
        });
        if (done) cleaned++;
      } catch (err: unknown) {
        this.logFailure(
          `OTEL cleanup of deleted session ${rootId} failed`,
          err,
        );
      }
    }
    return cleaned;
  }

  private logFailure(message: string, err: unknown): void {
    this.logger.error(
      `${message}: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
  }
}
