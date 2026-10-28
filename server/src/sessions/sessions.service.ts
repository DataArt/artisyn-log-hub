import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import { loadTreeCostRows, readTreeCost } from '../logs/session-tree-cost.sql';
import {
  contexts,
  deletedSessionLog,
  logContexts,
  logs,
  sessionCallTokens,
  sessionCosts,
  sessionFileStats,
  sessionOkfAccess,
  sessionStats,
  sessions,
  userFavoriteSessions,
} from '../database/schema/index';
import { deleteOrphanHarnessSnapshots } from '../logs/harness-snapshot';
import { deleteOrphanOkfSnapshots } from '../logs/okf/okf-snapshot';
import { getDescendantSessionIds } from '../logs/session-tree.sql';
import { UploadQueueService } from '../logs/upload-queue.service';

type AuditRow = {
  sessionPk: number;
  sessionIdStr: string;
  startTime: Date | null;
  endTime: Date | null;
  workTimeMs: number | null;
  totalCost: string | null;
};

export interface RetentionDailyBucket {
  day: string; // ISO UTC midnight
  sessionCount: number;
  totalSizeBytes: number;
}

export interface RetentionStats {
  oldestSessionAt: string | null; // ISO, null when there are zero non-deleted sessions
  youngestSessionAt: string | null;
  totalSessionCount: number;
  dailySeries: RetentionDailyBucket[];
}

type RetentionStatsRawRow = {
  oldestSessionAt: Date | string;
  youngestSessionAt: Date | string;
  totalSessionCount: string | number;
  day: Date | string;
  sessionCount: string | number;
  totalSizeBytes: string | number;
};

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly uploadQueueService: UploadQueueService,
  ) {}

  async deleteSession(
    requesterId: number,
    sessionIdStr: string,
  ): Promise<void> {
    // Step 1: Look up the session row (must exist and not be deleted)
    const [sessionRow] = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(eq(sessions.sessionId, sessionIdStr), eq(sessions.deleted, false)),
      )
      .limit(1);

    if (!sessionRow) {
      throw new NotFoundException('Session not found');
    }

    const parentId = sessionRow.id;

    // Step 2: Look up the owner — the artisyn log's uploader, else any log's: a bare
    // sub-agent session has no artisyn log, and every log of a session carries the
    // uploading user (same rule as `RepositoriesService.assertSessionVisible`). Without
    // this fallback, owner-only deletion would leave such a session deletable by nobody.
    const [ownerRow] = await this.db
      .select({ userId: logs.userId })
      .from(logs)
      .where(eq(logs.sessionId, parentId))
      .orderBy(sql`CASE WHEN ${logs.logType} = 'artisyn' THEN 0 ELSE 1 END`)
      .limit(1);

    const ownerUserId = ownerRow?.userId;

    // Step 3: Authorisation check — owner-only; the app admin role grants no override
    if (requesterId !== ownerUserId) {
      throw new ForbiddenException(
        'You do not have permission to delete this session',
      );
    }

    // Step 4: Find all descendant sessions (any nesting depth, not just direct
    // children) — `parent_session_id` may now point at an intermediate agent rather
    // than always this root session, so a one-level match would leave orphaned
    // grandchild/great-grandchild rows behind.
    const descendantsMap = await getDescendantSessionIds(this.db, [parentId]);
    const allDescendantIds = descendantsMap.get(parentId) ?? [];
    const childRows =
      allDescendantIds.length === 0
        ? []
        : await this.db
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              and(
                inArray(sessions.id, allDescendantIds),
                eq(sessions.deleted, false),
              ),
            );

    // Step 5: Collect all IDs to purge
    const allIds = [parentId, ...childRows.map((c) => c.id)];

    // Step 5b: Capture audit data for each session before purging
    const auditRows = await this.captureAuditRows(allIds);

    // Step 6: Purge all data inside a transaction
    await this.db.transaction(async (tx) => {
      // a0. Write audit log before purging
      await tx.insert(deletedSessionLog).values(
        auditRows.map((r) => ({
          sessionId: r.sessionIdStr,
          sessionPk: r.sessionPk,
          ownerUserId: ownerUserId ?? null,
          deletedByUserId: requesterId,
          startTime: r.startTime,
          endTime: r.endTime,
          workTimeMs: r.workTimeMs,
          totalCost: r.totalCost,
        })),
      );

      await this.purgeSessionChildData(tx, allIds);

      // Step 8: Soft-delete the session rows
      await tx
        .update(sessions)
        .set({ deleted: true })
        .where(inArray(sessions.id, allIds));
    });

    this.logger.log(
      `Session ${sessionIdStr} and ${childRows.length} child(ren) soft-deleted by user ${requesterId}`,
    );
  }

  /**
   * Deletes all child data (session_stats, session_call_tokens, session_costs,
   * user_favorite_sessions, session_file_stats, session_okf_access, logs, and orphaned contexts) for
   * the given session ids. The two cost tables would cascade on a hard delete of
   * the `sessions` row, but a soft delete keeps that row, so they are purged here.
   * Does NOT touch the `sessions` rows themselves or write audit log rows —
   * callers decide the final disposition (soft-delete vs. hard-delete) and
   * whether/how to record an audit trail.
   */
  private async purgeSessionChildData(
    tx: DrizzleDb,
    ids: number[],
  ): Promise<void> {
    // a. Delete session_stats
    await tx.delete(sessionStats).where(inArray(sessionStats.sessionId, ids));

    // a2. Delete the per-call token rows and the stored session costs
    await tx
      .delete(sessionCallTokens)
      .where(inArray(sessionCallTokens.sessionId, ids));
    await tx.delete(sessionCosts).where(inArray(sessionCosts.sessionId, ids));

    // b. Delete user_favorite_sessions
    await tx
      .delete(userFavoriteSessions)
      .where(inArray(userFavoriteSessions.sessionId, ids));

    // c. Delete session_file_stats
    await tx
      .delete(sessionFileStats)
      .where(inArray(sessionFileStats.sessionId, ids));

    // c2. Delete session_okf_access — it would cascade on a hard delete, but a soft delete
    // keeps the `sessions` row.
    await tx
      .delete(sessionOkfAccess)
      .where(inArray(sessionOkfAccess.sessionId, ids));

    // d. Delete logs (cascades log_repositories and log_contexts automatically)
    await tx.delete(logs).where(inArray(logs.sessionId, ids));

    // e. Delete orphan contexts (contexts not referenced by any log_contexts row)
    const remainingContextIds = tx
      .select({ contextId: logContexts.contextId })
      .from(logContexts);

    await tx
      .delete(contexts)
      .where(notInArray(contexts.id, remainingContextIds));

    // f. Delete any queued/stuck upload_queue rows for these sessions
    // — upload_queue.session_id is a plain varchar,
    // not a foreign key, so there is no cascade; resolve the string
    // sessionIds while the sessions rows are still present in `tx`.
    const sessionIdRows = await tx
      .select({ sessionId: sessions.sessionId })
      .from(sessions)
      .where(inArray(sessions.id, ids));

    await this.uploadQueueService.deleteQueueRowsForSessionIds(
      tx,
      sessionIdRows.map((row) => row.sessionId),
    );

    // g. Clear the harness (DD-11) and OKF snapshot references on these sessions — must run
    // before h, since h's orphan test is "no session references this snapshot id any more".
    await tx
      .update(sessions)
      .set({ harnessSnapshotId: null, okfSnapshotId: null })
      .where(inArray(sessions.id, ids));

    // h. Delete every harness_snapshots row no session references any more (DD-11), across
    // all owners — shared with the team-repo orphan sweep (`teams.service.ts`).
    await deleteOrphanHarnessSnapshots(tx);
    await deleteOrphanOkfSnapshots(tx);
  }

  /**
   * Hard-deletes the given `sessions` rows together with all their child data,
   * inside the caller's transaction. Writes no audit row. Callers pass every
   * id to remove — descendants are NOT resolved here.
   */
  async hardDeleteSessionsInTx(tx: DrizzleDb, ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.purgeSessionChildData(tx, ids);
    await tx.delete(sessions).where(inArray(sessions.id, ids));
  }

  /**
   * Captures the audit-trail snapshot (start/end time, work time, cost) for
   * each session id, to be written to `deleted_session_log` before its data is
   * purged. Resolves each session's own `session_id` string from the `sessions`
   * table when it has no `artisyn` log row to source it from.
   */
  private async captureAuditRows(ids: number[]): Promise<AuditRow[]> {
    // The cost each session shows on every live surface — the complete computed cost of
    // its tree (own + sub-agents + utility calls; null when any part is unpriced), captured
    // here before the purge deletes the rows it is computed from.
    const treeCosts = await loadTreeCostRows(this.db, ids);
    return Promise.all(
      ids.map(async (sid) => {
        const [logRow] = await this.db
          .select({
            startTime: logs.startTime,
            endTime: logs.endTime,
            sessionId: sessions.sessionId,
          })
          .from(logs)
          .innerJoin(sessions, eq(sessions.id, logs.sessionId))
          .where(and(eq(logs.sessionId, sid), eq(logs.logType, 'artisyn')))
          .limit(1);

        let sessionIdStr = logRow?.sessionId;
        if (!sessionIdStr) {
          const [sessionRow] = await this.db
            .select({ sessionId: sessions.sessionId })
            .from(sessions)
            .where(eq(sessions.id, sid))
            .limit(1);
          sessionIdStr = sessionRow?.sessionId ?? String(sid);
        }

        const [statsRow] = await this.db
          .select({ workTimeMs: sessionStats.workTimeMs })
          .from(sessionStats)
          .where(eq(sessionStats.sessionId, sid))
          .limit(1);

        const resolvedCost = readTreeCost(treeCosts.get(sid)).total;
        const totalCost: string | null =
          resolvedCost != null ? resolvedCost.toFixed(8) : null;

        return {
          sessionPk: sid,
          sessionIdStr,
          startTime: logRow?.startTime ?? null,
          endTime: logRow?.endTime ?? null,
          workTimeMs: statsRow?.workTimeMs ?? null,
          totalCost,
        };
      }),
    );
  }

  /**
   * Hard-purges root sessions (and their descendants) whose earliest log row
   * predates the retention cutoff. Unlike `deleteSession` (soft-delete, real
   * requesting user), this permanently removes the `sessions` rows and writes
   * `deletedByUserId: null` audit entries, since there is no requesting user —
   * it is invoked by the automated retention scheduler.
   *
   * Each eligible root (+ its still-active descendants) is purged in its own
   * transaction so one bad root cannot roll back roots already purged earlier
   * in the same call. Per-root failures are logged and skipped; the loop
   * continues with the remaining roots. Returns the number of roots
   * successfully purged.
   *
   * Idempotent across concurrent callers by design — multiple prod instances
   * tick independently, so the exact same root can be selected by more than
   * one instance in the same window. Rather than a DB-level lock (advisory
   * lock / `SELECT ... FOR UPDATE`), each session id's audit row is the claim:
   * the `deleted_session_log.session_pk` unique constraint means only one
   * transaction's `INSERT ... ON CONFLICT DO NOTHING` can ever succeed for a
   * given id, and only ids actually claimed by *this* transaction have their
   * child data purged / row hard-deleted. A losing transaction's insert
   * simply claims nothing and does no further work for those ids — no error,
   * no duplicate audit rows, no double-purge.
   */
  async hardPurgeExpiredSessions(
    retentionDays: number,
    batchSize: number,
  ): Promise<number> {
    const earliestLog = this.db
      .select({
        sessionId: logs.sessionId,
        earliest: sql<Date>`min(${logs.createdAt})`.as('earliest'),
      })
      .from(logs)
      .groupBy(logs.sessionId)
      .as('earliest_log');

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const eligibleRoots = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .innerJoin(earliestLog, eq(earliestLog.sessionId, sessions.id))
      .where(
        and(
          isNull(sessions.parentSessionId),
          eq(sessions.deleted, false),
          lt(earliestLog.earliest, cutoff),
        ),
      )
      .orderBy(earliestLog.earliest)
      .limit(batchSize);

    let purgedCount = 0;

    for (const { id: rootId } of eligibleRoots) {
      try {
        const descendantsMap = await getDescendantSessionIds(this.db, [rootId]);
        const allDescendantIds = descendantsMap.get(rootId) ?? [];

        // Only descendants not already individually soft-deleted get their
        // child data purged/audited — an already soft-deleted
        // descendant's data is already gone, so skip it here.
        const activeDescendantRows =
          allDescendantIds.length === 0
            ? []
            : await this.db
                .select({ id: sessions.id })
                .from(sessions)
                .where(
                  and(
                    inArray(sessions.id, allDescendantIds),
                    eq(sessions.deleted, false),
                  ),
                );

        const activeIds = [rootId, ...activeDescendantRows.map((r) => r.id)];
        // Descendants already individually soft-deleted before this tick
        // never get a fresh audit row/claim — they're always
        // safe to hard-delete outright, regardless of who (if anyone) wins
        // the claim race for the rest of the family below.
        const alreadySoftDeletedIds = allDescendantIds.filter(
          (id) => !activeIds.includes(id),
        );

        const auditRows = await this.captureAuditRows(activeIds);

        const rootClaimed = await this.db.transaction(async (tx) => {
          const claimed = auditRows.length
            ? await tx
                .insert(deletedSessionLog)
                .values(
                  auditRows.map((r) => ({
                    sessionId: r.sessionIdStr,
                    sessionPk: r.sessionPk,
                    ownerUserId: null,
                    deletedByUserId: null,
                    startTime: r.startTime,
                    endTime: r.endTime,
                    workTimeMs: r.workTimeMs,
                    totalCost: r.totalCost,
                  })),
                )
                .onConflictDoNothing({
                  target: deletedSessionLog.sessionPk,
                })
                .returning({ sessionPk: deletedSessionLog.sessionPk })
            : [];

          const claimedIds = new Set(claimed.map((c) => c.sessionPk));
          const idsToPurgeChildDataFor = activeIds.filter((id) =>
            claimedIds.has(id),
          );
          const idsToDelete = [
            ...idsToPurgeChildDataFor,
            ...alreadySoftDeletedIds,
          ];

          if (idsToPurgeChildDataFor.length > 0) {
            await this.purgeSessionChildData(tx, idsToPurgeChildDataFor);
          }
          // Hard-delete the sessions rows themselves — ids we claimed above,
          // plus any already individually soft-deleted descendant (its bare
          // row is still hard-deleted).
          if (idsToDelete.length > 0) {
            await tx.delete(sessions).where(inArray(sessions.id, idsToDelete));
          }

          return claimedIds.has(rootId);
        });

        // Only count this root if this call actually won its claim — a
        // concurrent instance that already claimed (and purged) the whole
        // family reports the purge itself; counting it here too would
        // double-count the same root across instances.
        if (rootClaimed) {
          purgedCount += 1;
        }
      } catch (err) {
        this.logger.error(
          `Failed to hard-purge expired root session ${rootId}`,
          err as Error,
        );
      }
    }

    return purgedCount;
  }

  /**
   * Computes admin/team-owner retention-tab statistics: the "age" span of
   * non-deleted sessions and a UTC-day-bucketed, gap-filled series of daily
   * session counts + total log payload size. Session "age" is
   * `MIN(logs.created_at)` per session
   * — identical semantics to what `SessionRetentionService` uses
   * to judge purge-eligibility. Size is `SUM(pg_column_size(logs.body))`
   * across all of a session's log rows, matching the
   * metric already used at `admin.service.ts`'s `getRepos()`. `pg_column_size`
   * reads the on-disk (TOASTed) representation directly, whereas
   * `octet_length(body::text)` forces a full JSON re-serialization of every
   * row first — negligible for small payloads but multi-seconds once
   * individual log bodies reach multi-MB size.
   *
   * Returns the zero-value shape when there are no non-deleted sessions with
   * log rows, since `generate_series` with NULL bounds yields zero rows and
   * the final query then naturally returns nothing to select summary values
   * from.
   */
  async getRetentionStats(): Promise<RetentionStats> {
    const result = await this.db.execute(sql`
      WITH session_level AS (
        SELECT
          l.session_id,
          MIN(l.created_at) AS session_ts,
          SUM(pg_column_size(l.body)) AS total_size_bytes
        FROM logs l
        INNER JOIN sessions s ON s.id = l.session_id
        WHERE s.deleted = false
        GROUP BY l.session_id
      ),
      summary AS (
        SELECT
          MIN(session_ts) AS oldest,
          MAX(session_ts) AS youngest,
          COUNT(*) AS total_count
        FROM session_level
      ),
      day_series AS (
        SELECT generate_series(
          date_trunc('day', (SELECT oldest FROM summary) AT TIME ZONE 'UTC'),
          date_trunc('day', (SELECT youngest FROM summary) AT TIME ZONE 'UTC'),
          '1 day'::interval
        ) AS day
      ),
      daily AS (
        SELECT
          ds.day,
          COUNT(sl.session_id) AS session_count,
          COALESCE(SUM(sl.total_size_bytes), 0) AS total_size_bytes
        FROM day_series ds
        LEFT JOIN session_level sl
          ON date_trunc('day', sl.session_ts AT TIME ZONE 'UTC') = ds.day
        GROUP BY ds.day
      )
      SELECT
        (SELECT oldest FROM summary) AS "oldestSessionAt",
        (SELECT youngest FROM summary) AS "youngestSessionAt",
        (SELECT total_count FROM summary) AS "totalSessionCount",
        (d.day AT TIME ZONE 'UTC') AS "day",
        d.session_count AS "sessionCount",
        d.total_size_bytes AS "totalSizeBytes"
      FROM daily d
      ORDER BY d.day ASC
    `);

    const rows = result.rows as unknown as RetentionStatsRawRow[];

    if (rows.length === 0) {
      return {
        oldestSessionAt: null,
        youngestSessionAt: null,
        totalSessionCount: 0,
        dailySeries: [],
      };
    }

    const toIso = (value: Date | string): string =>
      value instanceof Date
        ? value.toISOString()
        : new Date(value).toISOString();

    return {
      oldestSessionAt: toIso(rows[0].oldestSessionAt),
      youngestSessionAt: toIso(rows[0].youngestSessionAt),
      totalSessionCount: Number(rows[0].totalSessionCount),
      dailySeries: rows.map((row) => ({
        day: toIso(row.day),
        sessionCount: Number(row.sessionCount),
        totalSizeBytes: Number(row.totalSizeBytes),
      })),
    };
  }
}
