import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  logRepositories,
  logs,
  repoConfig,
  repositories,
} from '../database/schema/index';
import { selectEditResultRecordsForSession } from './artisyn-extractor';
import { DEFAULT_HIGH_CACHE_CREATION_THRESHOLD } from './cache-ratio.sql';
import {
  loadSessionTreeEditRecords,
  resolveSessionRepoRoots,
} from './change-surface/changed-paths.sql';
import { upsertSessionChangedPaths } from './change-surface/session-changed-paths-writer';
import { extractClaudeStats } from './claude-extractor';
import { rebuildSessionOkfAccess } from './okf/okf-access-writer';
import { enqueueOtelReclass } from './otel/otel-facts-writer';
import {
  type CauseStatsScope,
  upsertSessionCauseStatsRow,
} from './session-cause-stats-writer';
import { recomputeSessionCosts } from './session-cost/session-cost-writer';
import {
  resolveFileStatsScopes,
  resolveSessionTreeRepoUrls,
  writeSessionFileStats,
} from './session-file-stats-writer';
import { upsertSessionHarnessUsageRows } from './session-harness-usage-writer';
import {
  replaceSessionCallTokens,
  replaceSessionRequestIds,
  upsertSessionStatsRow,
} from './session-stats-writer';
import { upsertSessionToolStatsRows } from './session-tool-stats-writer';
import { listTeamScopesForUrls, readConfigThreshold } from './team-repo-config';
import { classifyTurnCauses, walkTurns } from './turn-walk';

/** Input of {@link writeClaudeDerived}: one stored `claude` / `claude-subagent` transcript. */
export interface ClaudeDerivedInput {
  sessionRowId: number;
  sessionId: string;
  logType: 'claude' | 'claude-subagent';
  lines: object[];
  userId: number;
}

/**
 * Writes every row derived from one `claude` / `claude-subagent` transcript (impl-plan DD-23 of
 * 2026-11-23-session-logs-streaming): `session_stats` (with the stored workflows), request ids,
 * call tokens and costs, changed paths, tool stats, harness usage, file stats, OKF accesses and
 * cause stats. This is the former Step 3 of `LogsService.upsert()`, moved unchanged so the
 * upload, the zip import and the re-extract drain share one extraction.
 *
 * Runs on the caller's transaction handle. Any change to it means bumping `INGEST_VERSION`.
 */
export async function writeClaudeDerived(
  tx: DrizzleDb,
  input: ClaudeDerivedInput,
): Promise<void> {
  const { sessionRowId, sessionId, logType, lines, userId } = input;
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
  await enqueueOtelReclass(tx, sessionRowId);
  await replaceSessionCallTokens(tx, sessionRowId, stats.callTokens);
  await recomputeSessionCosts(tx, [sessionRowId]);

  // Step 3a — changed paths. The repo root comes from the tree's artisyn log and
  // is routinely still unknown here (separate uploads, either order); the raw paths are
  // stored regardless and the artisyn branch of `upsert()` renormalises them once it lands.
  // The same roots drive the file-category stats in Step 3b (one root rule).
  const repoRoots = await resolveSessionRepoRoots(tx, sessionRowId);
  await upsertSessionChangedPaths(
    tx,
    sessionRowId,
    stats.changedPaths,
    repoRoots,
  );
  await upsertSessionToolStatsRows(tx, sessionRowId, stats.toolStats);
  await upsertSessionHarnessUsageRows(tx, sessionRowId, stats.harnessUsage);

  // Step 3b — populate session_file_stats: one row set per config scope of the session
  // tree's repo URLs (every team row, every user's personal row, plus the uploader's).
  // Read paths are made repo-relative against `repoRoots`; while the artisyn log has not
  // landed yet they fall back to the KNOWN_TOP_LEVEL_DIRS heuristic and the artisyn
  // branch of `upsert()` heals them (`rewriteSessionTreeFileStats`).
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
  // Step 3b' — OKF access rows of this node (FR-3), same roots as the file stats. With
  // no root yet nothing is stored; the heal rebuilds them once the artisyn log lands.
  await rebuildSessionOkfAccess(
    tx,
    sessionRowId,
    lines,
    repoRoots,
    logType === 'claude-subagent',
  );

  // Step 3c — populate session_cause_stats (one row per applicable config scope)
  const sessionRepoUrls = await getSessionRepoUrls(tx, sessionRowId);
  await upsertSessionCauseStats(
    tx,
    sessionRowId,
    lines,
    logType === 'claude-subagent',
    userId,
    sessionRepoUrls,
  );
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
async function upsertSessionCauseStats(
  tx: DrizzleDb,
  sessionRowId: number,
  lines: object[],
  isSubagentLog: boolean,
  userId: number,
  sessionRepoUrls: string[],
): Promise<void> {
  const scopes = await resolveCauseStatsScopes(tx, sessionRepoUrls, userId);
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
async function resolveCauseStatsScopes(
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
    threshold: personalRow?.threshold ?? DEFAULT_HIGH_CACHE_CREATION_THRESHOLD,
  });
  return scopes;
}

/**
 * Repo URLs this session's logs are linked to — the input to every scoped per-session
 * stats write. Used by `upsertSessionCauseStats` only — file stats resolve
 * their scopes tree-wide via `resolveSessionTreeRepoUrls`.
 */
async function getSessionRepoUrls(
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
