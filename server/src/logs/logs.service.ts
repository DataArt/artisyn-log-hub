import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, eq, inArray, ne, or, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import {
  contexts,
  logContexts,
  logRepositories,
  logs,
  logsOtel,
  otelApiCalls,
  repoConfig,
  repositories,
  sessions,
  users,
} from '../database/schema/index';
import {
  extractCodeInventory,
  extractContextPairs,
  extractFirstPrompt,
  extractGitBranch,
  extractGitRoots,
  extractHarnessMcpInventory,
  extractHarnessRuleInventory,
  extractHarnessSkillInventory,
  extractHookStatus,
  extractRepoUrls,
  extractTimestampRange,
  selectEditResultRecordsForSession,
} from './artisyn-extractor';
import {
  bindSessionSnapshot,
  extractHarnessSnapshot,
  extractHarnessSnapshotRef,
  loadHarnessSnapshot,
  storeHarnessSnapshot,
} from './harness-snapshot';
import {
  loadSessionTreeEditRecords,
  resolveSessionRepoRoots,
} from './change-surface/changed-paths.sql';
import {
  renormaliseSessionChangedPaths,
  upsertSessionChangedPaths,
} from './change-surface/session-changed-paths-writer';
import { registerUnpricedModels } from '../model-pricing/unpriced-model-registry';
import { upsertRepoCodeInventory } from './change-surface/repo-code-inventory';
import { normalizeRepoUrl } from './repo-url-normalizer';
import { isRawLocalPath, toLocalRepoIdentity } from './local-repo-identity';
import { extractClaudeStats } from './claude-extractor';
import {
  resolveFileStatsScopes,
  resolveSessionTreeRepoUrls,
  rewriteSessionTreeFileStats,
  writeSessionFileStats,
} from './session-file-stats-writer';
import {
  replaceSessionCallTokens,
  replaceSessionRequestIds,
  upsertSessionClaudeVersionOtel,
  upsertSessionStatsRow,
  upsertSessionTelemetryCost,
} from './session-stats-writer';
import { upsertSessionToolStatsRows } from './session-tool-stats-writer';
import { recomputeSessionCosts } from './session-cost/session-cost-writer';
import {
  type CauseStatsScope,
  upsertSessionCauseStatsRow,
} from './session-cause-stats-writer';
import {
  type HarnessElementInput,
  upsertHarnessElements,
} from './harness-elements-writer';
import { upsertSessionHarnessUsageRows } from './session-harness-usage-writer';
import { classifyTurnCauses, walkTurns } from './turn-walk';
import { DEFAULT_HIGH_CACHE_CREATION_THRESHOLD } from './cache-ratio.sql';
import { listTeamScopesForUrls, readConfigThreshold } from './team-repo-config';
import {
  buildOtelSessionSummary,
  computeChunkKey,
  type OtelApiCall,
  summarizeOtelChunk,
} from './otel-chunk';

/** Rows per `otel_api_calls` insert statement — well under Postgres' 65535 bind-parameter cap. */
const OTEL_API_CALLS_BATCH = 500;

/**
 * Fixed unusable `passwordHash` sentinel for import-created placeholder users
 * — no real password ever hashes to this literal string,
 * so a placeholder row can never authenticate. No schema change / "is
 * placeholder" marker column: nothing currently needs to filter these
 * specially, only to have `logs.userId`/`repositories.userId` resolve to a
 * valid row.
 */
export const PLACEHOLDER_IMPORT_USER_PASSWORD_HASH = '!placeholder-import-user';

/**
 * Outcome of `LogsService.upsert()` (open-source readiness):
 * - `ok` — the upload was written;
 * - `deleted` — the session is soft-deleted, nothing was written;
 * - `foreign-session` — the session belongs to another user, nothing was written.
 */
export type UpsertResult = { status: 'ok' | 'deleted' | 'foreign-session' };

/**
 * The owner of a session: the `user_id` of any `logs` or
 * `logs_otel` row of that session. `null` when no such row exists yet — a session
 * with no stored data has no owner, so the first uploader claims it.
 *
 * Takes the db handle explicitly so it can run both inside the `upsert()`
 * transaction (after the per-session advisory lock) and lock-free from the v2
 * controller's synchronous pre-check.
 */
export async function findSessionOwnerId(
  db: DrizzleDb,
  sessionId: string,
): Promise<number | null> {
  const result = await db.execute<{ user_id: number }>(sql`
    SELECT owner.user_id
    FROM (
      SELECT l.user_id
      FROM ${logs} l
      JOIN ${sessions} s ON s.id = l.session_id
      WHERE s.session_id = ${sessionId}
      UNION ALL
      SELECT o.user_id
      FROM ${logsOtel} o
      JOIN ${sessions} s ON s.id = o.session_id
      WHERE s.session_id = ${sessionId}
    ) owner
    LIMIT 1
  `);
  const row = result.rows[0];
  return row ? Number(row.user_id) : null;
}

/** Ids per query of the zip-import conflict pre-check — keeps bind parameters bounded. */
export const IMPORT_CONFLICT_QUERY_BATCH = 1000;

/**
 * The subset of `sessionIds` whose session has at least one `logs` or `logs_otel`
 * row with `user_id` ≠ `userId` (the stricter "any row" rule of the zip-import
 * pre-check, unlike `findSessionOwnerId`'s `LIMIT 1`). Soft-deleted sessions are
 * ignored unless `opts.includeDeleted` — the parent check counts them, because a
 * restore would re-attach the child. Returns distinct ids, sorted.
 */
export async function findForeignSessionIds(
  db: DrizzleDb,
  sessionIds: string[],
  userId: number,
  opts: { includeDeleted: boolean },
): Promise<string[]> {
  const unique = [...new Set(sessionIds)];
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += IMPORT_CONFLICT_QUERY_BATCH) {
    const batch = unique.slice(i, i + IMPORT_CONFLICT_QUERY_BATCH);
    const deletedFilter = opts.includeDeleted
      ? undefined
      : eq(sessions.deleted, false);
    const fromLogs = await db
      .selectDistinct({ sessionId: sessions.sessionId })
      .from(logs)
      .innerJoin(sessions, eq(sessions.id, logs.sessionId))
      .where(
        and(
          inArray(sessions.sessionId, batch),
          ne(logs.userId, userId),
          deletedFilter,
        ),
      );
    const fromOtel = await db
      .selectDistinct({ sessionId: sessions.sessionId })
      .from(logsOtel)
      .innerJoin(sessions, eq(sessions.id, logsOtel.sessionId))
      .where(
        and(
          inArray(sessions.sessionId, batch),
          ne(logsOtel.userId, userId),
          deletedFilter,
        ),
      );
    for (const row of [...fromLogs, ...fromOtel]) found.add(row.sessionId);
  }
  return [...found].sort();
}

/**
 * The subset of `emails` (already normalised: trimmed, lower-case) registered to a
 * user other than `userId`. Import placeholder users do not count; users with a
 * NULL `password_hash` (azure-oauth, auto-provisioned identify users) do — hence
 * `IS DISTINCT FROM` rather than `<>`, which would drop NULLs. Returns distinct
 * emails, sorted.
 */
export async function findForeignAuthorEmails(
  db: DrizzleDb,
  emails: string[],
  userId: number,
): Promise<string[]> {
  const unique = [...new Set(emails)];
  const found = new Set<string>();
  for (let i = 0; i < unique.length; i += IMPORT_CONFLICT_QUERY_BATCH) {
    const batch = unique.slice(i, i + IMPORT_CONFLICT_QUERY_BATCH);
    const rows = await db
      .select({ email: users.email })
      .from(users)
      .where(
        and(
          inArray(users.email, batch),
          ne(users.id, userId),
          sql`${users.passwordHash} IS DISTINCT FROM ${PLACEHOLDER_IMPORT_USER_PASSWORD_HASH}`,
        ),
      );
    for (const row of rows) found.add(row.email);
  }
  return [...found].sort();
}

/** Outcome of `LogsService.importSession()` — same meanings as `UpsertResult`. */
export type ImportSessionResult = {
  status: 'ok' | 'deleted' | 'foreign-session';
};

/** One archived session handed to `LogsService.importSession()`. */
export type ImportSessionInput = {
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  firstPrompt: string | null;
  gitBranch: string | null;
  startTime: string | null;
  endTime: string | null;
  logs: Array<{
    logType: 'claude' | 'artisyn';
    lines: object[];
    resolvedUserId: number;
  }>;
  targetRepoUrl: string;
  targetUserId: number;
  /** Mode 1 (`AUTH_MODE=none`): every log of the session is reassigned to the importer. */
  reassignToImporter: boolean;
};

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  /** Lock-free `findSessionOwnerId` for callers outside this service (zip import). */
  getSessionOwnerId(sessionId: string): Promise<number | null> {
    return findSessionOwnerId(this.db, sessionId);
  }

  async upsert(
    sessionId: string,
    logType: string,
    lines: object[],
    userId: number,
    bodyBytes: number,
    parentSessionId?: string,
    workflowRunId?: string,
  ): Promise<UpsertResult> {
    // Reject uploads for soft-deleted sessions silently
    const deletedRow = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.deleted, true)))
      .limit(1);
    if (deletedRow.length > 0) {
      this.logger.warn(
        `Session ${sessionId} is deleted; upload rejected silently`,
      );
      return { status: 'deleted' };
    }

    let foreignSession = false;
    await this.db.transaction(async (tx) => {
      // Step 0 — Ownership (open-source readiness). The per-session
      // advisory xact lock serialises concurrent first uploads of the same session by
      // different users, so exactly one of them becomes the owner and the other is rejected
      // before it writes anything. Released automatically at commit/rollback.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'session-owner:' + sessionId}, 0))`,
      );
      const ownerId = await findSessionOwnerId(tx, sessionId);
      if (ownerId !== null && ownerId !== userId) {
        this.logger.warn(
          `upload rejected: foreign session sessionId=${sessionId} userId=${userId} ownerId=${ownerId}`,
        );
        foreignSession = true;
        return;
      }

      // Step 1 — Session upsert
      const isSubagent = logType === 'claude-subagent' && !!parentSessionId;
      const hasWorkflowRunId = logType === 'claude-subagent' && !!workflowRunId;
      const [sessionRow] = await tx
        .insert(sessions)
        .values({
          sessionId,
          parentSessionId: isSubagent ? parentSessionId : undefined,
          workflowRunId: hasWorkflowRunId ? workflowRunId : undefined,
        })
        .onConflictDoUpdate({
          target: sessions.sessionId,
          set: {
            sessionId: sql`excluded.session_id`,
            ...(isSubagent
              ? { parentSessionId: sql`excluded.parent_session_id` }
              : {}),
            ...(hasWorkflowRunId
              ? { workflowRunId: sql`excluded.workflow_run_id` }
              : {}),
          },
        })
        .returning({ id: sessions.id });
      const sessionRowId = sessionRow.id;

      // Step 1b — artisyn only: the roots this session already knew before this upload. The
      // Step 2 upsert COALESCEs them, so comparing against these tells whether this chunk
      // taught the session a new root — one of the triggers of the file-stats heal below.
      const [priorArtisynRoots] =
        logType === 'artisyn'
          ? await tx
              .select({
                root: logs.gitRepoRoot,
                worktreeRoot: logs.gitWorktreeRoot,
              })
              .from(logs)
              .where(
                and(
                  eq(logs.sessionId, sessionRowId),
                  eq(logs.logType, 'artisyn'),
                ),
              )
              .limit(1)
          : [];
      const priorRoots = {
        root: priorArtisynRoots?.root ?? null,
        worktreeRoot: priorArtisynRoots?.worktreeRoot ?? null,
      };

      // Step 2 — Log upsert (detect insert vs update)
      const firstPrompt =
        logType === 'artisyn' ? extractFirstPrompt(lines) : null;
      const { startTime, endTime } =
        logType === 'artisyn'
          ? extractTimestampRange(lines)
          : { startTime: null, endTime: null };
      const gitBranch = logType === 'artisyn' ? extractGitBranch(lines) : null;
      // The two repo roots ride the same `artisyn` upload as the branch and are
      // stored exactly like it. They are what makes a changed path resolvable at all;
      // both stay NULL for an older hook that does not send them.
      const gitRoots =
        logType === 'artisyn'
          ? extractGitRoots(lines)
          : { root: null, worktreeRoot: null };

      // Step 2a — `claude-otel` is chunk-shaped, not whole-file shaped. Every upload is ONE
      // receiver chunk, so writing it straight into the `logs` row would overwrite the previous
      // chunk: `logs` is unique on (session_id, log_type), and a fragment is not a replacement.
      // Chunks accumulate in `logs_otel` instead, and the `logs` row below carries only the
      // normalized summary recomputed from all of them.
      const otelBody =
        logType === 'claude-otel'
          ? await this.ingestOtelChunk(tx, sessionRowId, userId, lines)
          : null;

      const [logResult] = await tx
        .insert(logs)
        .values({
          sessionId: sessionRowId,
          logType,
          body: otelBody ?? lines,
          userId,
          firstPrompt,
          startTime: startTime ? new Date(startTime) : null,
          endTime: endTime ? new Date(endTime) : null,
          gitBranch,
          gitRepoRoot: gitRoots.root,
          gitWorktreeRoot: gitRoots.worktreeRoot,
        })
        .onConflictDoUpdate({
          target: [logs.sessionId, logs.logType],
          set: {
            body: sql`excluded.body`,
            updatedAt: sql`now()`,
            firstPrompt: sql`COALESCE(excluded.first_prompt, ${logs.firstPrompt})`,
            startTime: sql`excluded.start_time`,
            endTime: sql`excluded.end_time`,
            gitBranch: sql`excluded.git_branch`,
            // COALESCE, unlike the columns above: an artisyn chunk uploaded before the first
            // `prompt_start`/`SessionStart` carries no git object at all, and clearing an
            // already-learned root would un-normalise every changed path of the session.
            gitRepoRoot: sql`COALESCE(excluded.git_repo_root, ${logs.gitRepoRoot})`,
            gitWorktreeRoot: sql`COALESCE(excluded.git_worktree_root, ${logs.gitWorktreeRoot})`,
          },
        })
        .returning({
          id: logs.id,
          isNewInsert: sql<boolean>`(xmax = 0)`,
        });

      // Step 3 — session_stats upsert for claude and claude-subagent logs
      if (logType === 'claude' || logType === 'claude-subagent') {
        // The hook's per-call records are an INPUT to extraction, never a patch
        // applied afterwards: both this path and
        // `recomputeAllSessionStats` rebuild `session_stats` and `session_changed_paths`
        // purely from the transcript, so anything merged into a finished row would be erased
        // by the next recompute. An empty index (no artisyn log yet, or an old hook) leaves
        // every number exactly as it was before this task.
        const hookEditRecords = selectEditResultRecordsForSession(
          await loadSessionTreeEditRecords(tx, sessionRowId),
          sessionId,
          logType === 'claude-subagent',
        );
        const stats = extractClaudeStats(
          lines,
          '',
          logType === 'claude-subagent',
          hookEditRecords,
        );
        await upsertSessionStatsRow(tx, sessionRowId, stats);
        await replaceSessionRequestIds(tx, sessionRowId, stats.requestIds);
        await replaceSessionCallTokens(tx, sessionRowId, stats.callTokens);
        await recomputeSessionCosts(tx, [sessionRowId]);

        // Step 3a — changed paths. The repo root comes from the tree's artisyn log and
        // is routinely still unknown here (separate uploads, either order); the raw paths are
        // stored regardless and the artisyn branch below renormalises them once it lands.
        // The same roots drive the file-category stats in Step 3b (one root rule).
        const repoRoots = await resolveSessionRepoRoots(tx, sessionRowId);
        await upsertSessionChangedPaths(
          tx,
          sessionRowId,
          stats.changedPaths,
          repoRoots,
        );
        await upsertSessionToolStatsRows(tx, sessionRowId, stats.toolStats);
        await upsertSessionHarnessUsageRows(
          tx,
          sessionRowId,
          stats.harnessUsage,
        );

        // Step 3b — populate session_file_stats: one row set per config scope of the session
        // tree's repo URLs (every team row, every user's personal row, plus the uploader's).
        // Read paths are made repo-relative against `repoRoots`; while the artisyn log has not
        // landed yet they fall back to the KNOWN_TOP_LEVEL_DIRS heuristic and the artisyn
        // branch below heals them (`rewriteSessionTreeFileStats`).
        await writeSessionFileStats(
          tx,
          sessionRowId,
          lines,
          repoRoots,
          await resolveFileStatsScopes(
            tx,
            await resolveSessionTreeRepoUrls(tx, sessionRowId),
            userId,
          ),
        );

        // Step 3c — populate session_cause_stats (one row per applicable config scope)
        const sessionRepoUrls = await this.getSessionRepoUrls(tx, sessionRowId);
        await this.upsertSessionCauseStats(
          tx,
          sessionRowId,
          lines,
          logType === 'claude-subagent',
          userId,
          sessionRepoUrls,
        );
      }

      // Step 4 — Early exit for non-artisyn
      if (logType !== 'artisyn') return;

      // Step 5 — Repository upsert + link. Fires for new inserts and re-uploads.
      // Deliberately NOT gated on isNewInsert: with chunked uploads the first chunk of a
      // session can arrive before its first `prompt_start`, and `git.repo` only ever appears
      // on that event. Gating here left such logs permanently unlinked — the log kept growing
      // on re-upload but never joined its repository, so the session stayed invisible on every
      // repo page. Both inserts below are onConflictDoNothing, so re-running is idempotent
      // (same reasoning as 5b/5c below).
      const rawRepoUrls = extractRepoUrls(lines);
      // A local path (repo without a remote) is scoped by the uploader's email — loaded once,
      // and only when a local path is actually present.
      let uploaderEmail: string | null = null;
      if (rawRepoUrls.some(isRawLocalPath)) {
        const [userRow] = await tx
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, userId));
        uploaderEmail = userRow?.email ?? null;
      }
      const repoUrls = rawRepoUrls
        .map((raw) => {
          if (isRawLocalPath(raw) && uploaderEmail !== null) {
            const identity = toLocalRepoIdentity(uploaderEmail, raw);
            // Only on first insert — re-uploads would repeat this line on every chunk.
            if (logResult.isNewInsert) {
              this.logger.log(`local repo identity: ${raw} → ${identity}`);
            }
            return identity;
          }
          const canonical = normalizeRepoUrl(raw);
          // Only on first insert — re-uploads would repeat this line on every chunk.
          if (raw !== canonical && logResult.isNewInsert) {
            this.logger.log(`repo URL normalized: ${raw} → ${canonical}`);
          }
          return canonical;
        })
        .filter((u) => u.trim());
      // Rows actually inserted by the link insert below (onConflictDoNothing returns only
      // those) — a newly linked repo changes the tree's file-stats scopes.
      let linksInserted = 0;
      if (repoUrls.length > 0) {
        await tx
          .insert(repositories)
          .values(repoUrls.map((url) => ({ repoUrl: url, userId })))
          .onConflictDoNothing({
            target: [repositories.userId, repositories.repoUrl],
          });

        const repoRows = await tx
          .select({ id: repositories.id })
          .from(repositories)
          .where(
            and(
              eq(repositories.userId, userId),
              inArray(repositories.repoUrl, repoUrls),
            ),
          );

        const insertedLinks = await tx
          .insert(logRepositories)
          .values(repoRows.map((r) => ({ logId: logResult.id, repoId: r.id })))
          .onConflictDoNothing()
          .returning({ repoId: logRepositories.repoId });
        linksInserted = insertedLinks.length;
      }

      // Step 5b — Update max_upload_bytes on all repos linked to this artisyn log.
      // Single UPDATE...FROM avoids a round-trip SELECT. Fires for new inserts and re-uploads.
      await tx.execute(
        sql.raw(
          `UPDATE repositories SET max_upload_bytes = GREATEST(COALESCE(max_upload_bytes, 0), ${bodyBytes}) FROM log_repositories WHERE log_repositories.log_id = ${logResult.id} AND log_repositories.repo_id = repositories.id`,
        ),
      );

      // Step 5c — Update hook-state columns on all repos linked to this artisyn log, but only
      // when this upload's body carries a hook-status event. Fires for new inserts and
      // re-uploads (mirrors 5b) — but unlike 5b, an absent hook-status event (e.g. an older
      // hook, or a non-final artisyn body from earlier in the same run) must NOT clear
      // previously-stored hook-state, so we skip the UPDATE entirely rather than writing NULLs.
      // Values are user/hook-controlled, so this uses parameterized `sql` (not `sql.raw` like
      // 5b's numeric bodyBytes) to avoid SQL injection.
      const hookStatus = extractHookStatus(lines);
      if (hookStatus !== null) {
        const activityTime = new Date(hookStatus.timestamp);
        const hookLastActivity = isNaN(activityTime.getTime())
          ? new Date()
          : activityTime;

        await tx.execute(
          sql`UPDATE repositories
              SET hook_version = ${hookStatus.hookVersion},
                  hook_last_activity = ${hookLastActivity},
                  hook_log_tail = ${JSON.stringify(hookStatus.logTail)}::jsonb,
                  hook_non_uploadable_logs = ${JSON.stringify(hookStatus.nonUploadableLogs)}::jsonb,
                  hook_recommendations = ${JSON.stringify(hookStatus.recommendations)}::jsonb
              FROM log_repositories
              WHERE log_repositories.log_id = ${logResult.id}
                AND log_repositories.repo_id = repositories.id`,
        );
      }

      // Step 5d — Harness snapshot store/bind + element inventory upsert (DD-9). Fires for
      // new inserts and re-uploads, across every repo currently linked to this log (via
      // `log_repositories`, same scope as 5b/5c) — not just repos linked by *this* upload's
      // own `git.repo` URL, since a chunk carrying the ref can arrive after the chunk that
      // established the link.
      //
      // 1. Store — a full `harness-snapshot` line in *this* upload is persisted verbatim,
      //    scoped to the uploading owner (content-addressed id, `ON CONFLICT DO NOTHING`).
      // 2. Bind — the session is bound to the first id ever known for it (the ref line, or
      //    the full snapshot's own id when there's no separate ref). Once bound it stays
      //    bound (`harness_snapshot_id IS NULL` guard), so a later re-ref can never move it
      //    (DD-21's accepted race: a purge between "known" and bind leaves the session
      //    pointed at a since-deleted row until the next upload self-heals it).
      // 3. Inventory — runs on *every* upload that carries a ref or a full snapshot, not just
      //    the one that first bound the session: it re-reads the session's *current* bound
      //    id and, if that row still exists, upserts inventory from it into every repo
      //    currently linked — so a repo linked by a later upload still gets inventory, same
      //    as the old per-upload Step 5d. Skipped entirely (no writer call, no repositories
      //    UPDATE) when this upload carries neither line, or the bound row no longer exists
      //    (DD-21) — mirrors 5c's "never overwrite with a lesser signal" rule.
      // 4. Capability columns — `harness_inventory_reported_at` is always set alongside the
      //    inventory upsert; `harness_mcp_per_tool_supported` only flips to `true` when
      //    *this* upload's own full snapshot explicitly carries `perToolDetailSupported:
      //    true` (an old/incapable hook, or a ref-only upload, leaves it untouched).
      const harnessSnapshotLine = extractHarnessSnapshot(lines);
      if (harnessSnapshotLine !== null) {
        await storeHarnessSnapshot(tx, userId, harnessSnapshotLine);
      }

      const harnessSnapshotRef =
        extractHarnessSnapshotRef(lines) ??
        harnessSnapshotLine?.snapshotId ??
        null;
      if (harnessSnapshotRef !== null) {
        await bindSessionSnapshot(tx, sessionRowId, harnessSnapshotRef);
      }

      if (harnessSnapshotRef !== null) {
        const [boundSessionRow] = await tx
          .select({ harnessSnapshotId: sessions.harnessSnapshotId })
          .from(sessions)
          .where(eq(sessions.id, sessionRowId));
        const boundSnapshotId = boundSessionRow?.harnessSnapshotId ?? null;
        const boundSnapshot = boundSnapshotId
          ? await loadHarnessSnapshot(tx, userId, boundSnapshotId)
          : null;

        if (boundSnapshot !== null) {
          const ruleInventory = extractHarnessRuleInventory(boundSnapshot);
          const skillInventory = extractHarnessSkillInventory(boundSnapshot);
          const mcpInventory = extractHarnessMcpInventory(boundSnapshot);

          const linkedRepoRows = await tx
            .select({ repoId: logRepositories.repoId })
            .from(logRepositories)
            .where(eq(logRepositories.logId, logResult.id));

          const elements: HarnessElementInput[] = [
            ...ruleInventory.map((rule) => ({
              kind: 'rule' as const,
              name: rule.name,
            })),
            ...skillInventory.map((skill) => ({
              kind: 'skill' as const,
              name: skill.name,
              source: skill.source,
            })),
            ...mcpInventory.flatMap((server) => [
              {
                kind: 'mcp' as const,
                name: server.name,
                mcpConnected: server.connected ?? null,
              },
              ...server.tools.map((tool) => ({
                kind: 'tool' as const,
                name: tool.name,
                mcpServer: server.name,
                schemaSizeTokens: tool.schemaSizeTokens,
              })),
            ]),
          ];

          const reportedAt = new Date();
          for (const { repoId } of linkedRepoRows) {
            await upsertHarnessElements(tx, repoId, elements, reportedAt);
          }

          // Only flip the capability flag to `true` when *this* upload's own
          // harness-snapshot line explicitly carried `perToolDetailSupported: true` (a
          // capable hook) — an old hook, or a ref-only upload with no full snapshot line,
          // leaves the column untouched, same "skip rather than overwrite with a lesser
          // signal" reasoning as 5c.
          const perToolDetailSupportedThisUpload =
            harnessSnapshotLine?.perToolDetailSupported === true;

          if (perToolDetailSupportedThisUpload) {
            await tx.execute(
              sql`UPDATE repositories
                  SET harness_inventory_reported_at = ${reportedAt},
                      harness_mcp_per_tool_supported = true
                  FROM log_repositories
                  WHERE log_repositories.log_id = ${logResult.id}
                    AND log_repositories.repo_id = repositories.id`,
            );
          } else {
            await tx.execute(
              sql`UPDATE repositories
                  SET harness_inventory_reported_at = ${reportedAt}
                  FROM log_repositories
                  WHERE log_repositories.log_id = ${logResult.id}
                    AND log_repositories.repo_id = repositories.id`,
            );
          }
        }
      }

      // Step 5e — change surface. Two independent pieces, both artisyn-only:
      //
      // 1. The code-inventory snapshot (the report's "% of the codebase" denominator), stored
      //    per repo currently linked to this log — same scope as 5b/5c/5d, since the chunk
      //    carrying the snapshot can arrive after the chunk that established the link. The
      //    upsert is idempotent on `(repo_id, captured_at, branch)`, so a re-uploaded body
      //    cannot grow the table.
      // 2. Renormalisation of the whole session tree's changed paths. This upload is what
      //    made `git_repo_root` known, and the agent transcripts almost always arrived
      //    first — this is the step that turns their stored raw paths into normalised rows
      //    and flips `cs_computed_at` on.
      const codeInventory = extractCodeInventory(lines);
      if (codeInventory !== null) {
        const inventoryRepoRows = await tx
          .select({ repoId: logRepositories.repoId })
          .from(logRepositories)
          .where(eq(logRepositories.logId, logResult.id));
        for (const { repoId } of inventoryRepoRows) {
          await upsertRepoCodeInventory(tx, repoId, codeInventory);
        }
      }

      await renormaliseSessionChangedPaths(tx, sessionRowId);

      // Step 5f — file-stats heal. The tree's claude/claude-subagent transcripts usually
      // landed before this artisyn log, so their `session_file_stats` were written with no
      // repo root and only the uploader-default scope. Rebuild them from the stored bodies —
      // but only when this upload can have changed the outcome (new log, newly linked repo,
      // or a newly learned root): artisyn chunks re-upload often, and reparsing every body on
      // every chunk would be wasted work. Must run before Step 6's new-insert-only exit.
      const effectiveRoot = gitRoots.root ?? priorRoots.root;
      const effectiveWorktreeRoot =
        gitRoots.worktreeRoot ?? priorRoots.worktreeRoot;
      const rootsChanged =
        effectiveRoot !== priorRoots.root ||
        effectiveWorktreeRoot !== priorRoots.worktreeRoot;
      if (logResult.isNewInsert || linksInserted > 0 || rootsChanged) {
        await rewriteSessionTreeFileStats(tx, sessionRowId, userId);
      }

      // Step 6 — Context upsert + link (new inserts only)
      if (!logResult.isNewInsert) return;
      const contextPairs = extractContextPairs(lines);
      if (contextPairs.length > 0) {
        await tx
          .insert(contexts)
          .values(
            contextPairs.map(({ key, value }) => ({
              contextKey: key,
              contextValue: value,
            })),
          )
          .onConflictDoNothing();

        const contextRows = await tx
          .select({ id: contexts.id })
          .from(contexts)
          .where(
            or(
              ...contextPairs.map(({ key, value }) =>
                and(
                  eq(contexts.contextKey, key),
                  eq(contexts.contextValue, value),
                ),
              ),
            ),
          );

        await tx
          .insert(logContexts)
          .values(
            contextRows.map((c) => ({ logId: logResult.id, contextId: c.id })),
          )
          .onConflictDoNothing();
      }
    });
    return foreignSession ? { status: 'foreign-session' } : { status: 'ok' };
  }

  /**
   * Cross-instance user identity resolution: a raw
   * `logs.userId` integer from a different database instance is meaningless
   * here, so import resolves the original log owner's *email* to a local
   * `users` row instead — reusing one if it already exists, otherwise
   * creating an unauthenticatable placeholder (fixed sentinel
   * `passwordHash`). Racing two concurrent imports of the same unknown email
   * is handled via `onConflictDoNothing` + a re-select rather than a unique
   * constraint violation.
   */
  async resolveOrCreatePlaceholderUserByEmail(email: string): Promise<number> {
    const [existing] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (existing) return existing.id;

    const [created] = await this.db
      .insert(users)
      .values({ email, passwordHash: PLACEHOLDER_IMPORT_USER_PASSWORD_HASH })
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id });
    if (created) return created.id;

    // Lost a race with a concurrent import creating the same placeholder.
    const [raceWinner] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!raceWinner) {
      throw new Error(`Failed to resolve or create a user for email ${email}`);
    }
    return raceWinner.id;
  }

  /**
   * Writes one imported session (all its `claude`/`artisyn` logs) during a
   * repository import job, in ONE transaction — a fresh method rather than a
   * call into `upsert()`, since import supplies its own resolved `userId`s/
   * `firstPrompt`/`gitBranch`/`startTime`/`endTime` from the export's
   * `session.json` rather than deriving them from the authenticated uploader
   * or re-running `artisyn-extractor.ts` against body content.
   *
   * Inside the transaction, in order:
   * 1. Takes the same `session-owner:` advisory xact lock as `upsert()`, so a
   *    concurrent hook upload or import of the same session is serialised.
   * 2. A soft-deleted session returns `deleted` without writing anything.
   * 3. Owner guard (skipped when `reassignToImporter`): when the session is
   *    already owned (`findSessionOwnerId`) by a user other than
   *    `targetUserId`, returns `foreign-session` without writing anything —
   *    the pre-check passed, but the session changed hands since.
   * 4. Upserts the `sessions` row once; `parentSessionId`/`workflowRunId`
   *    always upsert from `session.json` regardless of the keep-longer merge
   *    outcome, since they're identity metadata.
   * 5. Writes each log via `writeImportedLog` with an `effectiveUserId`:
   *    `targetUserId` when `reassignToImporter` or when the session already
   *    belongs to the importer (an existing own session never gets a second
   *    owner), otherwise the log's own `resolvedUserId` (a new session).
   * 6. When `reassignToImporter` (`AUTH_MODE=none`), moves every `logs` and
   *    `logs_otel` row of the session to `targetUserId`.
   *
   * Each log applies the keep-longer merge: an existing `(sessionId, logType)`
   * row is overwritten only when the incoming `lines` array is strictly longer
   * than the existing row's `body` array — otherwise the existing row is left
   * entirely untouched and the incoming data is discarded.
   *
   * For `claude` logs that were actually written (new insert or merge win),
   * re-derives `session_stats`/`session_file_stats` via the same
   * `extractClaudeStats`/`writeSessionFileStats` used by `upsert()` rather than
   * trusting the export's frozen stats snapshot.
   *
   * For `artisyn` logs, always links the log to the *current*
   * repository/importing user (`targetRepoUrl`/`targetUserId`) using the same
   * `repositories`/`logRepositories` upsert mechanics as `upsert()`'s step 5 —
   * regardless of the keep-longer merge outcome: even when the row already
   * exists and its body stays untouched, the log must still be linked to the
   * *new* target repo, or the imported session would never appear there
   * despite the import job reporting success.
   */
  async importSession(input: ImportSessionInput): Promise<ImportSessionResult> {
    const { sessionId, parentSessionId, workflowRunId, targetUserId } = input;
    return this.db.transaction(async (tx): Promise<ImportSessionResult> => {
      // Step 1 — same per-session advisory lock key as upsert().
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${'session-owner:' + sessionId}, 0))`,
      );

      // Step 2 — reject imports targeting a soft-deleted session silently.
      const deletedRow = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(eq(sessions.sessionId, sessionId), eq(sessions.deleted, true)),
        )
        .limit(1);
      if (deletedRow.length > 0) {
        this.logger.warn(
          `Session ${sessionId} is deleted; import rejected silently`,
        );
        return { status: 'deleted' };
      }

      // Step 3 — owner guard (not in single-user mode).
      let ownerId: number | null = null;
      if (!input.reassignToImporter) {
        ownerId = await findSessionOwnerId(tx, sessionId);
        if (ownerId !== null && ownerId !== targetUserId) {
          this.logger.warn(
            `import blocked: foreign session sessionId=${sessionId} targetUserId=${targetUserId} ownerId=${ownerId}`,
          );
          return { status: 'foreign-session' };
        }
      }

      // Step 4 — session upsert, once per session.
      const [sessionRow] = await tx
        .insert(sessions)
        .values({
          sessionId,
          parentSessionId: parentSessionId ?? undefined,
          workflowRunId: workflowRunId ?? undefined,
        })
        .onConflictDoUpdate({
          target: sessions.sessionId,
          set: {
            sessionId: sql`excluded.session_id`,
            ...(parentSessionId
              ? { parentSessionId: sql`excluded.parent_session_id` }
              : {}),
            ...(workflowRunId
              ? { workflowRunId: sql`excluded.workflow_run_id` }
              : {}),
          },
        })
        .returning({ id: sessions.id });
      const sessionRowId = sessionRow.id;

      // Step 5 — every log, in order, under its effective owner.
      const ownSession = ownerId !== null && ownerId === targetUserId;
      for (const log of input.logs) {
        const effectiveUserId =
          input.reassignToImporter || ownSession
            ? targetUserId
            : log.resolvedUserId;
        await this.writeImportedLog(
          tx,
          sessionRowId,
          log,
          input,
          effectiveUserId,
        );
      }

      // Step 6 — single-user mode: the importer owns every log of the session.
      if (input.reassignToImporter) {
        await tx
          .update(logs)
          .set({ userId: targetUserId })
          .where(
            and(
              eq(logs.sessionId, sessionRowId),
              ne(logs.userId, targetUserId),
            ),
          );
        await tx
          .update(logsOtel)
          .set({ userId: targetUserId })
          .where(
            and(
              eq(logsOtel.sessionId, sessionRowId),
              ne(logsOtel.userId, targetUserId),
            ),
          );
      }

      return { status: 'ok' };
    });
  }

  /**
   * One log of `importSession()`: keep-longer merge, derived stats for a
   * written `claude` log, and the repo link for an `artisyn` log — all under
   * `effectiveUserId`.
   */
  private async writeImportedLog(
    tx: DrizzleDb,
    sessionRowId: number,
    log: ImportSessionInput['logs'][number],
    input: ImportSessionInput,
    effectiveUserId: number,
  ): Promise<void> {
    const { logType, lines } = log;
    const {
      firstPrompt,
      gitBranch,
      startTime,
      endTime,
      targetRepoUrl,
      targetUserId,
    } = input;

    // Keep-longer merge. Compares array lengths via jsonb_array_length() so
    // the existing (potentially large) body never has to be fetched just to
    // measure it.
    const [existing] = await tx
      .select({
        id: logs.id,
        lineCount: sql<number | null>`jsonb_array_length(${logs.body})`,
      })
      .from(logs)
      .where(and(eq(logs.sessionId, sessionRowId), eq(logs.logType, logType)));

    let logId: number;
    let wrote: boolean;

    if (!existing) {
      const [inserted] = await tx
        .insert(logs)
        .values({
          sessionId: sessionRowId,
          logType,
          body: lines,
          userId: effectiveUserId,
          firstPrompt,
          startTime: startTime ? new Date(startTime) : null,
          endTime: endTime ? new Date(endTime) : null,
          gitBranch,
        })
        .returning({ id: logs.id });
      logId = inserted.id;
      wrote = true;
    } else if (lines.length > (existing.lineCount ?? 0)) {
      await tx
        .update(logs)
        .set({
          body: lines,
          userId: effectiveUserId,
          firstPrompt,
          startTime: startTime ? new Date(startTime) : null,
          endTime: endTime ? new Date(endTime) : null,
          gitBranch,
          updatedAt: sql`now()`,
        })
        .where(eq(logs.id, existing.id));
      logId = existing.id;
      wrote = true;
    } else {
      // Incoming isn't strictly longer — leave the existing row untouched
      // and discard the incoming data for this log entirely.
      logId = existing.id;
      wrote = false;
    }

    // session_stats/session_file_stats for claude logs, reusing the exact
    // extractor calls upsert() uses. Only re-derived when the merge actually
    // wrote a (possibly new) body — if the existing row won the merge, its
    // stats are already correct for that body.
    if (wrote && logType === 'claude') {
      const stats = extractClaudeStats(lines, '', false);
      await upsertSessionStatsRow(tx, sessionRowId, stats);
      await replaceSessionRequestIds(tx, sessionRowId, stats.requestIds);
      await replaceSessionCallTokens(tx, sessionRowId, stats.callTokens);
      await recomputeSessionCosts(tx, [sessionRowId]);
      await upsertSessionToolStatsRows(tx, sessionRowId, stats.toolStats);
      // Same writer, roots and tree-level scopes as upsert() Step 3b. Import adds the
      // claude log before the artisyn log and gets no heal, so an imported session lands on
      // the no-root fallback until a settings save recomputes it (known limitation).
      await writeSessionFileStats(
        tx,
        sessionRowId,
        lines,
        await resolveSessionRepoRoots(tx, sessionRowId),
        await resolveFileStatsScopes(
          tx,
          await resolveSessionTreeRepoUrls(tx, sessionRowId),
          effectiveUserId,
        ),
      );
      const sessionRepoUrls = await this.getSessionRepoUrls(tx, sessionRowId);
      await this.upsertSessionCauseStats(
        tx,
        sessionRowId,
        lines,
        false,
        effectiveUserId,
        sessionRepoUrls,
      );
    }

    // Repo-link mechanics (artisyn logs only), targeting the fixed importing
    // user + current repo's repoUrl rather than extracting git.repo from body
    // content. Runs regardless of `wrote` (see importSession()).
    if (logType !== 'artisyn') return;

    // DD-14: import runs DD-9 steps 1-2 (store + bind) for artisyn logs, scoped to the
    // archive's resolved author (`log.resolvedUserId`) — not `effectiveUserId`, though the
    // two agree in every current code path (`importOneSession`'s `resolvedUserId` already
    // collapses to `targetUserId` whenever `effectiveUserId` would). Step 3 (inventory
    // upsert) is intentionally not run here: an imported session's inventory is populated
    // lazily, the same read path (DD-12) every other session uses.
    const snap = extractHarnessSnapshot(lines);
    if (snap !== null) {
      await storeHarnessSnapshot(tx, log.resolvedUserId, snap);
    }
    const ref = extractHarnessSnapshotRef(lines) ?? snap?.snapshotId ?? null;
    if (ref !== null) {
      await bindSessionSnapshot(tx, sessionRowId, ref);
    }

    await tx
      .insert(repositories)
      .values({ repoUrl: targetRepoUrl, userId: targetUserId })
      .onConflictDoNothing({
        target: [repositories.userId, repositories.repoUrl],
      });

    const [repoRow] = await tx
      .select({ id: repositories.id })
      .from(repositories)
      .where(
        and(
          eq(repositories.userId, targetUserId),
          eq(repositories.repoUrl, targetRepoUrl),
        ),
      );

    if (repoRow) {
      await tx
        .insert(logRepositories)
        .values({ logId, repoId: repoRow.id })
        .onConflictDoNothing();
    }
  }

  /**
   * Store one OTEL chunk and return the session's recomputed normalized record.
   *
   * The chunk is keyed by a hash of its own content, which makes ingest idempotent without any
   * chunk identifier on the wire: the uploader re-ships a chunk whenever its manifest entry is
   * missing, and an identical body simply upserts over itself instead of double-counting cost.
   *
   * Cost is summed here, at chunk-processing time, rather than on read — the raw body stays in
   * `logs_otel` so any later change to the summary can be recomputed from it.
   *
   * The session total is re-aggregated from ALL of the session's chunks rather than added
   * incrementally, so a re-ingested or corrected chunk can never leave a drifted running total.
   */
  private async ingestOtelChunk(
    tx: DrizzleDb,
    sessionRowId: number,
    userId: number,
    lines: object[],
  ): Promise<object[]> {
    // Computed once: it keys both the logs_otel row and the per-call fallback keys.
    const chunkKey = computeChunkKey(lines);
    const summary = summarizeOtelChunk(lines, chunkKey);

    // Locks the session row for the rest of this transaction, so two chunk
    // uploads landing near-simultaneously for the same session serialize instead of
    // each recomputing `telemetry_cost` from a snapshot that excludes the other's
    // uncommitted `logs_otel` row — explicit and local here rather
    // than relying on the `sessions` upsert above incidentally holding the same lock.
    await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionRowId))
      .for('update');

    await tx
      .insert(logsOtel)
      .values({
        sessionId: sessionRowId,
        userId,
        chunkKey,
        receivedAt: summary.receivedAt,
        body: lines,
        costUsdMicros: summary.costUsdMicros,
        recordCount: summary.recordCount,
        processedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [logsOtel.sessionId, logsOtel.chunkKey],
        set: {
          body: sql`excluded.body`,
          receivedAt: sql`excluded.received_at`,
          costUsdMicros: sql`excluded.cost_usd_micros`,
          recordCount: sql`excluded.record_count`,
          processedAt: sql`excluded.processed_at`,
        },
      });

    await this.upsertOtelApiCalls(tx, sessionRowId, summary.calls);

    const [totals] = await tx
      .select({
        // COALESCE so a session whose chunks all carry null cost still yields 0, not null.
        costUsdMicros: sql<string>`COALESCE(SUM(${logsOtel.costUsdMicros}), 0)`,
        chunkCount: sql<string>`COUNT(*)`,
        recordCount: sql<string>`COALESCE(SUM(${logsOtel.recordCount}), 0)`,
      })
      .from(logsOtel)
      .where(eq(logsOtel.sessionId, sessionRowId));

    const totalCostUsdMicros = BigInt(totals?.costUsdMicros ?? '0');

    // Denormalize the same recomputed sum into session_stats.telemetry_cost, in
    // this same transaction. NULL for an exact-zero total — creates
    // the session_stats row if this session has no claude/claude-subagent log yet.
    await upsertSessionTelemetryCost(
      tx,
      sessionRowId,
      totalCostUsdMicros === 0n ? null : totalCostUsdMicros,
    );

    // OTEL fallback for the session's Claude Code version (`service.version`). Only ever
    // raises the stored value; the session row lock above serializes the read-modify-write.
    await upsertSessionClaudeVersionOtel(
      tx,
      sessionRowId,
      summary.claudeVersion,
    );

    // Register the chunk's api_request models that have no effective price, so they show up
    // as unpriced in the admin Model Pricing tab. Same transaction, no lock.
    await registerUnpricedModels(tx, summary.models);

    return [
      buildOtelSessionSummary({
        costUsdMicros: totalCostUsdMicros,
        chunkCount: Number(totals?.chunkCount ?? 0),
        recordCount: Number(totals?.recordCount ?? 0),
      }),
    ];
  }

  /**
   * Upsert one chunk's api_request records into `otel_api_calls` on `(session_id, call_key)`,
   * in the same transaction as its `logs_otel` row. Every value column is
   * overwritten, so re-ingesting a chunk (or a corrected copy of it) never duplicates a call.
   *
   * Calls are de-duplicated by `callKey` first (last occurrence wins): Postgres rejects an
   * `ON CONFLICT DO UPDATE` that would touch the same row twice in one statement.
   */
  private async upsertOtelApiCalls(
    tx: DrizzleDb,
    sessionRowId: number,
    calls: OtelApiCall[],
  ): Promise<void> {
    if (calls.length === 0) return;
    const byKey = new Map<string, OtelApiCall>();
    for (const call of calls) byKey.set(call.callKey, call);
    const rows = [...byKey.values()].map((call) => ({
      sessionId: sessionRowId,
      callKey: call.callKey,
      requestId: call.requestId,
      querySource: call.querySource,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWrite5mTokens: call.cacheWrite5mTokens,
      inputTokensFast: call.inputTokensFast,
      outputTokensFast: call.outputTokensFast,
      costUsdMicros: call.costUsdMicros,
    }));
    for (let i = 0; i < rows.length; i += OTEL_API_CALLS_BATCH) {
      await tx
        .insert(otelApiCalls)
        .values(rows.slice(i, i + OTEL_API_CALLS_BATCH))
        .onConflictDoUpdate({
          target: [otelApiCalls.sessionId, otelApiCalls.callKey],
          set: {
            requestId: sql`excluded.request_id`,
            querySource: sql`excluded.query_source`,
            model: sql`excluded.model`,
            inputTokens: sql`excluded.input_tokens`,
            outputTokens: sql`excluded.output_tokens`,
            cacheReadTokens: sql`excluded.cache_read_tokens`,
            cacheWrite5mTokens: sql`excluded.cache_write_5m_tokens`,
            cacheWrite1hTokens: sql`excluded.cache_write_1h_tokens`,
            webSearchRequests: sql`excluded.web_search_requests`,
            inputTokensFast: sql`excluded.input_tokens_fast`,
            outputTokensFast: sql`excluded.output_tokens_fast`,
            costUsdMicros: sql`excluded.cost_usd_micros`,
          },
        });
    }
  }

  /**
   * Populates `session_cause_stats` — the cache-creation cause decomposition — for
   * every config scope the session is visible under.
   *
   * The decomposition depends on the high-cache-creation threshold, and that threshold is a
   * *scoped* config field: a team-wide value (`team_repo_config`) and a personal override
   * (`repo_config`) can be in force for the same session simultaneously. So, much like
   * `writeSessionFileStats`, one row is written per applicable scope — one per team linking
   * the session's URL (whether or not it has a config), plus the uploader's personal row.
   * Each scope's threshold comes from its own config, falling back to
   * {@link DEFAULT_HIGH_CACHE_CREATION_THRESHOLD}.
   *
   * The transcript is walked ONCE; only the (cheap) threshold classification is repeated per
   * scope — that is the entire reason `walkTurns` is threshold-free.
   */
  private async upsertSessionCauseStats(
    tx: DrizzleDb,
    sessionRowId: number,
    lines: object[],
    isSubagentLog: boolean,
    userId: number,
    sessionRepoUrls: string[],
  ): Promise<void> {
    const scopes = await this.resolveCauseStatsScopes(
      tx,
      sessionRepoUrls,
      userId,
    );
    if (scopes.length === 0) return;

    const walk = walkTurns(lines, isSubagentLog);
    const totalsByThreshold = new Map<
      number,
      ReturnType<typeof classifyTurnCauses>
    >();

    for (const { scope, threshold } of scopes) {
      let totals = totalsByThreshold.get(threshold);
      if (totals === undefined) {
        totals = classifyTurnCauses(walk, threshold);
        totalsByThreshold.set(threshold, totals);
      }
      await upsertSessionCauseStatsRow(
        tx,
        sessionRowId,
        scope,
        threshold,
        totals,
      );
    }
  }

  /**
   * Resolves which `session_cause_stats` scopes to write for a session, with each scope's
   * own threshold. The threshold is read straight out of the config jsonb blob, and
   * only when it really is a JSON number — a malformed blob falls back to the default rather
   * than failing the whole upload.
   */
  private async resolveCauseStatsScopes(
    tx: DrizzleDb,
    sessionRepoUrls: string[],
    userId: number,
  ): Promise<Array<{ scope: CauseStatsScope; threshold: number }>> {
    if (sessionRepoUrls.length === 0) {
      // Not linked to any repository yet (the claude log can arrive before its artisyn
      // sibling): there is no team config to consult, so the uploader's own scope with the
      // default threshold is the only meaningful one.
      return [
        {
          scope: { userId },
          threshold: DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
        },
      ];
    }

    // Every team linking the URL gets its row set: its own team config's threshold, else
    // the default — team-view readers always read `team_id = T`.
    const scopes: Array<{ scope: CauseStatsScope; threshold: number }> = (
      await listTeamScopesForUrls(tx, sessionRepoUrls)
    ).map(({ teamId, config }) => ({
      scope: { teamId },
      threshold:
        readConfigThreshold(config) ?? DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
    }));

    const [personalRow] = await tx
      .select({
        threshold: sql<
          number | null
        >`CASE WHEN jsonb_typeof(${repoConfig.config} -> 'highCacheCreationThreshold') = 'number'
             THEN (${repoConfig.config} ->> 'highCacheCreationThreshold')::int
             ELSE NULL END`,
      })
      .from(repoConfig)
      .innerJoin(repositories, eq(repoConfig.repoId, repositories.id))
      .where(
        and(
          inArray(repositories.repoUrl, sessionRepoUrls),
          eq(repoConfig.userId, userId),
        ),
      )
      .orderBy(asc(repoConfig.repoId))
      .limit(1);

    // The uploader's personal scope is always written (personal threshold, else the
    // default): personal-view readers read `user_id = :userId`, also on a team-linked URL.
    scopes.push({
      scope: { userId },
      threshold:
        personalRow?.threshold ?? DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
    });
    return scopes;
  }

  /**
   * Repo URLs this session's logs are linked to — the input to every scoped per-session
   * stats write. Used by `upsertSessionCauseStats` only — file stats resolve
   * their scopes tree-wide via `resolveSessionTreeRepoUrls`.
   */
  private async getSessionRepoUrls(
    tx: DrizzleDb,
    sessionRowId: number,
  ): Promise<string[]> {
    const repoUrlRows = await tx
      .select({ repoUrl: repositories.repoUrl })
      .from(repositories)
      .innerJoin(logRepositories, eq(logRepositories.repoId, repositories.id))
      .innerJoin(logs, eq(logs.id, logRepositories.logId))
      .where(eq(logs.sessionId, sessionRowId));
    return repoUrlRows.map((r) => r.repoUrl);
  }
}
