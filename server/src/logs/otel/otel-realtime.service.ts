import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { maxVersion } from '../../common/semver';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { findSessionOwnerId } from '../logs.service';
import { topAncestorIdsSql } from '../session-tree.sql';
import {
  OTEL_CURSOR_PREFIX,
  OTEL_REALTIME_MIN_INTERVAL_MS,
} from './otel-facts.constants';
import type {
  OtelRealtimeRequest,
  OtelRealtimeResponse,
} from './otel-facts.types';
import {
  applyOtelLines,
  lockOtelState,
  OtelSessionDeletedError,
  type OtelSessionState,
} from './otel-facts-writer';

/** Outcome of {@link OtelRealtimeService.ingest}. */
export type OtelRealtimeIngestResult =
  | { status: 'ok'; response: OtelRealtimeResponse }
  | { status: 'foreign-session' };

/**
 * Gap / replay rule of one realtime batch (DD-14), pure:
 * - same receiver, `batchSeq <= rt_batch_seq` → a replay: idempotent upserts, no gap;
 * - same receiver, `batchSeq > rt_batch_seq + 1` → batches were lost: gap;
 * - `droppedLines > 0` on a non-replay batch → gap;
 * - a new receiver (hook restart) starts its own sequence — no gap from the seq alone (a restart
 *   loses its in-memory buffer silently; the chunks cover it, documented).
 *
 * `nextBatchSeq` is the value to store in `rt_batch_seq` (never moves backwards for one receiver).
 */
export function realtimeBatchGap(
  state: Pick<OtelSessionState, 'rtReceiverId' | 'rtBatchSeq'>,
  receiverId: string,
  batchSeq: number,
  droppedLines: number,
): { replay: boolean; gap: boolean; nextBatchSeq: number } {
  const sameReceiver =
    state.rtReceiverId === receiverId && state.rtBatchSeq !== null;
  if (sameReceiver && batchSeq <= (state.rtBatchSeq as number)) {
    return {
      replay: true,
      gap: false,
      nextBatchSeq: state.rtBatchSeq as number,
    };
  }
  const skipped = sameReceiver && batchSeq > (state.rtBatchSeq as number) + 1;
  return {
    replay: false,
    gap: skipped || droppedLines > 0,
    nextBatchSeq: batchSeq,
  };
}

/**
 * Realtime OTEL ingest (DD-17): one synchronous transaction per hook batch, no upload queue.
 *
 * 1. the `session-owner:<sessionId>` advisory lock + {@link findSessionOwnerId} → a different
 *    owner is a foreign session (409);
 * 2. inserts the `sessions` row if missing (by `session_id` only);
 * 3. resolves the root and takes the OTEL state lock (`create: true`, `user_id` on create) plus
 *    the deleted check — a deleted session answers `ignored: 'deleted'` and writes nothing;
 * 4. applies the gap / replay rule (DD-14), the lines (`source: 'realtime'`) and the `rt_*`
 *    fields;
 * 5. answers `{ accepted, cursor, minIntervalMs }`.
 */
@Injectable()
export class OtelRealtimeService {
  private readonly logger = new Logger(OtelRealtimeService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async ingest(
    userId: number,
    body: OtelRealtimeRequest,
  ): Promise<OtelRealtimeIngestResult> {
    const minIntervalMs = OTEL_REALTIME_MIN_INTERVAL_MS;
    try {
      return await this.db.transaction(async (tx) => {
        // Step 1 — ownership, under the same advisory lock as the upload path.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${'session-owner:' + body.sessionId}, 0))`,
        );
        const ownerId = await findSessionOwnerId(tx, body.sessionId);
        if (ownerId !== null && ownerId !== userId) {
          this.logger.warn(
            `otel-realtime rejected: foreign session sessionId=${body.sessionId} userId=${userId} ownerId=${ownerId}`,
          );
          return { status: 'foreign-session' as const };
        }

        // Step 2 — the sessions row, insert-if-missing (DD-2 lock order: no row lock).
        await tx.execute(sql`
          INSERT INTO sessions (session_id) VALUES (${body.sessionId})
          ON CONFLICT (session_id) DO NOTHING
        `);

        // Step 3 — root, state lock, deleted check (throws OtelSessionDeletedError).
        const rootRes = await tx.execute(sql`
          WITH RECURSIVE ${topAncestorIdsSql(sql`ARRAY(SELECT id FROM sessions WHERE session_id = ${body.sessionId})::bigint[]`)}
          SELECT top_id FROM top_ancestors
        `);
        const rootRow = (
          rootRes.rows as unknown as { top_id: number | string }[]
        )[0];
        if (!rootRow) {
          throw new Error(
            `otel-realtime: session ${body.sessionId} vanished after insert`,
          );
        }
        const rootId = Number(rootRow.top_id);
        const lock = await lockOtelState(tx, rootId, {
          create: true,
          userId,
        });
        if (!lock) {
          throw new Error(
            `otel-realtime: no otel_session_state row for session ${rootId} after create`,
          );
        }

        // Step 4 — gap / replay, the lines, the rt_* fields.
        const rule = realtimeBatchGap(
          lock.state,
          body.receiverId,
          body.batchSeq,
          body.droppedLines,
        );
        const applied = await applyOtelLines(
          tx,
          rootId,
          userId,
          body.lines,
          'realtime',
        );
        const versionRes = await tx.execute(sql`
          SELECT otel_hook_version FROM otel_session_state WHERE session_id = ${rootId}
        `);
        const storedVersion =
          (
            versionRes.rows as unknown as {
              otel_hook_version: string | null;
            }[]
          )[0]?.otel_hook_version ?? null;
        const hookVersion = maxVersion([storedVersion, body.hookVersion]);
        await tx.execute(sql`
          UPDATE otel_session_state SET
            rt_receiver_id = ${body.receiverId},
            rt_batch_seq = ${rule.nextBatchSeq},
            rt_gap_at = CASE WHEN ${rule.gap} THEN now() ELSE rt_gap_at END,
            otel_hook_version = ${hookVersion}
           WHERE session_id = ${rootId}
        `);
        if (rule.gap) {
          this.logger.log(
            `otel-realtime gap: session=${body.sessionId} receiver=${body.receiverId} batchSeq=${body.batchSeq} dropped=${body.droppedLines}`,
          );
        }

        // Step 5 — the response.
        return {
          status: 'ok' as const,
          response: {
            accepted: { calls: applied.calls, spans: applied.spans },
            cursor: `${OTEL_CURSOR_PREFIX}${applied.seq}`,
            minIntervalMs,
          },
        };
      });
    } catch (err) {
      if (err instanceof OtelSessionDeletedError) {
        return {
          status: 'ok',
          response: {
            accepted: { calls: 0, spans: 0 },
            cursor: `${OTEL_CURSOR_PREFIX}0`,
            minIntervalMs,
            ignored: 'deleted',
          },
        };
      }
      throw err;
    }
  }
}
