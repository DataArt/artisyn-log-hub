import { eq, sql } from 'drizzle-orm';
import { maxVersion } from '../common/semver';
import type { DrizzleDb } from '../database/database.module';
import {
  sessionCallTokens,
  sessionRequestIds,
  sessionStats,
} from '../database/schema/index';
import { registerUnpricedModels } from '../model-pricing/unpriced-model-registry';
import type { OtelStatusEvent } from './artisyn-extractor';
import type { ClaudeStats } from './claude-extractor';
import type { SessionCallTokens } from './cost.sql';

/**
 * Upserts a `session_stats` row for one session from a `ClaudeStats` result.
 *
 * Extracted from `LogsService.upsert()` so the upload path and the
 * "recompute all sessions" maintenance path (`RepositoriesService.recomputeAllSessionStats`)
 * share the same column list instead of duplicating it.
 *
 * `telemetryCost` is deliberately absent from both `values()` and `onConflictDoUpdate.set`
 * below — a documented exception to the "every column in `values()` must also be here" rule.
 * It is owned exclusively by `upsertSessionTelemetryCost()`, so a `claude` transcript
 * re-upload or `recompute-all-sessions` run must leave it untouched.
 *
 * The four `cs_*` change-surface columns are the second such exception, for the same
 * reason and with the same shape: they are owned exclusively by
 * {@link upsertSessionChangeSurfaceCounters}, which `session-changed-paths-writer.ts` calls
 * in the same breath as it rewrites `session_changed_paths`. Splitting them out is what keeps
 * the counters from ever describing a different set of rows than the table holds — a second
 * writer here would need the repo root, which is not part of `ClaudeStats` and is routinely
 * not yet known when the transcript is extracted.
 *
 * The three OTEL status columns (`otel_state`, `otel_reason`, `otel_status`) are the third
 * exception: they are owned exclusively by {@link upsertSessionOtelStatus} (DD-28), so a
 * transcript re-upload or a recompute never clears the hook's last reported status.
 */
export async function upsertSessionStatsRow(
  db: DrizzleDb,
  sessionRowId: number,
  stats: ClaudeStats,
): Promise<void> {
  await db
    .insert(sessionStats)
    .values({
      sessionId: sessionRowId,
      model: stats.model,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cacheReadTokens: stats.cacheReadTokens,
      cacheWriteTokens: stats.cacheWriteTokens,
      cacheWrite5mTokens: stats.cacheWrite5mTokens,
      cacheWrite1hTokens: stats.cacheWrite1hTokens,
      webSearchRequests: stats.webSearchRequests,
      inputTokensFast: stats.inputTokensFast,
      outputTokensFast: stats.outputTokensFast,
      workTimeMs: stats.workTimeMs,
      filesEditedWritten: stats.filesEditedWritten,
      linesChanged: stats.linesChanged,
      imageCount: stats.imageCount,
      imageTotalBytes: stats.imageTotalBytes,
      mcpCallsTotal: stats.mcpCallsTotal,
      mcpCallsByServer: stats.mcpCallsByServer,
      linesAdded: stats.linesAdded,
      linesRemoved: stats.linesRemoved,
      commitCount: stats.commitCount,
      prCount: stats.prCount,
      turnCount: stats.turnCount,
      diffLinesCoveredCalls: stats.diffLinesCoveredCalls,
      diffLinesTotalCalls: stats.diffLinesTotalCalls,
      tokenByServiceTier: stats.tokenByServiceTier,
      claudeVersion: stats.claudeVersion,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionStats.sessionId,
      set: {
        model: stats.model,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheReadTokens: stats.cacheReadTokens,
        cacheWriteTokens: stats.cacheWriteTokens,
        cacheWrite5mTokens: stats.cacheWrite5mTokens,
        cacheWrite1hTokens: stats.cacheWrite1hTokens,
        webSearchRequests: stats.webSearchRequests,
        inputTokensFast: stats.inputTokensFast,
        outputTokensFast: stats.outputTokensFast,
        workTimeMs: stats.workTimeMs,
        filesEditedWritten: stats.filesEditedWritten,
        linesChanged: stats.linesChanged,
        imageCount: stats.imageCount,
        imageTotalBytes: stats.imageTotalBytes,
        mcpCallsTotal: stats.mcpCallsTotal,
        mcpCallsByServer: stats.mcpCallsByServer,
        // Every column in `values()` above must also be here. A column missing from this
        // block silently keeps its old value on re-upload and on
        // `recompute-all-sessions` — the row already exists, so only the conflict path runs.
        linesAdded: stats.linesAdded,
        linesRemoved: stats.linesRemoved,
        commitCount: stats.commitCount,
        prCount: stats.prCount,
        turnCount: stats.turnCount,
        diffLinesCoveredCalls: stats.diffLinesCoveredCalls,
        diffLinesTotalCalls: stats.diffLinesTotalCalls,
        tokenByServiceTier: stats.tokenByServiceTier,
        claudeVersion: stats.claudeVersion,
        updatedAt: new Date(),
      },
    });

  // Register the session's model as unpriced when it has no effective price. Living
  // here (the single session_stats writer for transcripts) covers the upload, import and
  // recompute-all-sessions paths at once. Runs on the caller's handle, so it joins the same
  // transaction; errors are not swallowed.
  await registerUnpricedModels(db, [stats.model]);
}

/** Rows per `session_request_ids` insert — well under Postgres' 65535 bind-parameter cap. */
const REQUEST_IDS_BATCH = 1000;

/** Width of `session_request_ids.request_id`. */
const REQUEST_ID_MAX = 255;

/**
 * Replaces one session's `session_request_ids` rows with `ids` — the distinct transcript
 * `requestId`s of its assistant lines. The sole writer of that table
 * outside the migration backfill, called right after every `upsertSessionStatsRow()`.
 *
 * Delete-then-insert, so a re-uploaded or recomputed transcript never leaves a stale id behind.
 * Callers must pass a transaction handle (or wrap the call in one) so readers never see the
 * session with its ids deleted but not yet re-inserted. Ids are cut to the varchar(255) width
 * and empty ones dropped, matching the backfill; `onConflictDoNothing` absorbs any duplicate.
 */
export async function replaceSessionRequestIds(
  db: DrizzleDb,
  sessionRowId: number,
  ids: string[],
): Promise<void> {
  await db
    .delete(sessionRequestIds)
    .where(eq(sessionRequestIds.sessionId, sessionRowId));
  const distinct = [
    ...new Set(
      ids.filter((id) => id !== '').map((id) => id.slice(0, REQUEST_ID_MAX)),
    ),
  ];
  for (let i = 0; i < distinct.length; i += REQUEST_IDS_BATCH) {
    await db
      .insert(sessionRequestIds)
      .values(
        distinct
          .slice(i, i + REQUEST_IDS_BATCH)
          .map((requestId) => ({ sessionId: sessionRowId, requestId })),
      )
      .onConflictDoNothing();
  }
}

/**
 * Upserts one session's `session_call_tokens` row with its per-call token arrays
 * (`ClaudeStats.callTokens`) — the sole writer of that table, called right after every
 * `replaceSessionRequestIds()` and before `recomputeSessionCosts()`, which reads it.
 *
 * Throws when the present arrays differ in length: index `i` of every array must be the
 * same call, and a ragged record would silently misprice tiered calls. A session with no
 * calls stores the row with empty arrays.
 */
export async function replaceSessionCallTokens(
  db: DrizzleDb,
  sessionRowId: number,
  calls: SessionCallTokens,
): Promise<void> {
  const lengths = new Set(
    Object.values(calls)
      .filter((arr): arr is number[] => Array.isArray(arr))
      .map((arr) => arr.length),
  );
  if (lengths.size > 1) {
    throw new Error(
      `session_call_tokens for session ${sessionRowId}: per-call arrays differ in length (${[...lengths].join(', ')})`,
    );
  }
  await db
    .insert(sessionCallTokens)
    .values({ sessionId: sessionRowId, calls, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: sessionCallTokens.sessionId,
      set: { calls, updatedAt: new Date() },
    });
}

/**
 * Upserts ONLY `telemetry_cost` (+ `updated_at`) for one session — the sole writer of that
 * column. Creates the `session_stats` row if one doesn't exist yet (an OTEL-only
 * session, with no `claude`/`claude-subagent` log), leaving every other counter at its
 * schema default. Never touches any column `upsertSessionStatsRow()` owns, and vice versa.
 *
 * `telemetryCostMicros` is `null` when the recomputed `SUM(logs_otel.cost_usd_micros)` is
 * exactly 0 ("no confirmed signal yet", not a genuine zero-cost session).
 */
export async function upsertSessionTelemetryCost(
  db: DrizzleDb,
  sessionRowId: number,
  telemetryCostMicros: bigint | null,
): Promise<void> {
  await db
    .insert(sessionStats)
    .values({
      sessionId: sessionRowId,
      telemetryCost: telemetryCostMicros,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionStats.sessionId,
      set: {
        telemetryCost: telemetryCostMicros,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upserts ONLY `claude_version_otel` (+ `updated_at`) for one session — the sole writer of
 * that column. The OTEL fallback for the session's Claude Code version, used when the
 * `claude` transcript (which owns `claude_version`) is missing or carries no version.
 *
 * A no-op when `chunkVersion` is `null`. Otherwise the stored value becomes the higher of
 * the current value and `chunkVersion`, so it only ever increases (a corrected chunk that is
 * re-ingested never lowers it). The read-modify-write is serialized by the caller, which
 * already holds the session row `FOR UPDATE`. Creates the `session_stats` row when an
 * OTEL-only session has none yet, leaving every other counter at its schema default.
 */
export async function upsertSessionClaudeVersionOtel(
  db: DrizzleDb,
  sessionRowId: number,
  chunkVersion: string | null,
): Promise<void> {
  if (chunkVersion === null) return;
  const [current] = await db
    .select({ claudeVersionOtel: sessionStats.claudeVersionOtel })
    .from(sessionStats)
    .where(eq(sessionStats.sessionId, sessionRowId))
    .limit(1);
  const next = maxVersion([current?.claudeVersionOtel ?? null, chunkVersion]);
  if (next === null) return;
  await db
    .insert(sessionStats)
    .values({
      sessionId: sessionRowId,
      claudeVersionOtel: next,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionStats.sessionId,
      set: {
        claudeVersionOtel: next,
        updatedAt: new Date(),
      },
    });
}

/**
 * The change-surface counters for one session node.
 *
 * All four move together: `computedAt` is the "this node has been through the change-surface
 * extractor" marker every surface reads as `computed`, and the three counters are only
 * meaningful alongside it. `null` across the board is the unknown-repo-root state — no path
 * could be normalised, so every count would be a lie and the surfaces must render "no data",
 * never `0`.
 */
export interface SessionChangeSurfaceCounters {
  changedFiles: number | null;
  foldersTouched: number | null;
  outsideRepoFiles: number | null;
  computedAt: Date | null;
}

/**
 * Upserts ONLY the four `cs_*` columns (+ `updated_at`) for one session — the sole writer of
 * them, exactly as `upsertSessionTelemetryCost()` is the sole writer of `telemetry_cost`.
 *
 * Creates the `session_stats` row when there is none, so a node whose changed paths are
 * renormalised before its transcript was ever extracted still records its marker. Never
 * touches a column `upsertSessionStatsRow()` owns, and vice versa.
 *
 * Concentration is deliberately NOT stored beside these: it is not composable (a per-node
 * value cannot be summed or averaged into a tree's), so a stored copy would be a second
 * source that disagrees with every rendered value. It is recomputed from
 * `session_changed_paths` for every scope instead.
 */
export async function upsertSessionChangeSurfaceCounters(
  db: DrizzleDb,
  sessionRowId: number,
  counters: SessionChangeSurfaceCounters,
): Promise<void> {
  await db
    .insert(sessionStats)
    .values({
      sessionId: sessionRowId,
      csChangedFiles: counters.changedFiles,
      csFoldersTouched: counters.foldersTouched,
      csOutsideRepoFiles: counters.outsideRepoFiles,
      csComputedAt: counters.computedAt,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionStats.sessionId,
      set: {
        // Every column in `values()` above must also be here — a column missing from this
        // block silently keeps its old value on every re-upload and every recompute, since
        // the row already exists and only the conflict path runs.
        csChangedFiles: counters.changedFiles,
        csFoldersTouched: counters.foldersTouched,
        csOutsideRepoFiles: counters.outsideRepoFiles,
        csComputedAt: counters.computedAt,
        updatedAt: new Date(),
      },
    });
}

/**
 * Upserts ONLY `otel_state`, `otel_reason` and `otel_status` (+ `updated_at`) for one session
 * from its latest `otel-status` event (2026-10-30 otel-shared-receiver, DD-28) — the sole writer
 * of those columns, modelled on {@link upsertSessionClaudeVersionOtel}. Called from the artisyn
 * ingest beside step 5c when the upload carries the event.
 *
 * The latest event wins: the conflict update is skipped when the stored
 * `otel_status->>'timestamp'` is newer than the event's (both are `toISOString()` strings, so
 * text order is time order). `event` is already normalised by `extractOtelStatus` — an unknown
 * `state` or `reason` arrives as `unknown`. Creates the `session_stats` row when there is none
 * yet, leaving every other counter at its schema default. Never touches a column
 * `upsertSessionStatsRow()` owns, and vice versa.
 */
export async function upsertSessionOtelStatus(
  db: DrizzleDb,
  sessionRowId: number,
  event: OtelStatusEvent,
): Promise<void> {
  const status = {
    timestamp: event.timestamp,
    detail: event.detail,
    received: event.received,
    claudeVersion: event.claudeVersion,
    forward: event.forward,
    hookVersion: event.hookVersion,
    receiverVersion: event.receiverVersion,
  };
  await db
    .insert(sessionStats)
    .values({
      sessionId: sessionRowId,
      otelState: event.state,
      otelReason: event.reason,
      otelStatus: status,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: sessionStats.sessionId,
      set: {
        // Every column in `values()` above must also be here.
        otelState: event.state,
        otelReason: event.reason,
        otelStatus: status,
        updatedAt: new Date(),
      },
      setWhere: sql`${sessionStats.otelStatus} IS NULL
        OR COALESCE(${sessionStats.otelStatus}->>'timestamp', '') <= ${event.timestamp}`,
    });
}
