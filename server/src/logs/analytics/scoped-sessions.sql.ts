import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  attributeFilterSql,
  type ParsedAttributeFilter,
} from '../attribute-filter.sql';
import type { TeamScope } from '../team-scope';

/**
 * The shared session-selection step behind all four usage-analytics services.
 *
 * Phase A selects the *root* sessions matching the caller's date range, branch and user
 * filters under the team-visibility rule; each service then runs its own Phase B, rolling up
 * `descendant_sessions` (the recursive sub-agent tree) keyed on those root ids. This is the
 * same two-phase shape `cache-read-ratio.service.ts` and `executive-summary.service.ts` use —
 * two round trips regardless of how many sessions the range holds.
 *
 * Why the tree and not just the roots: sub-agents hold ~62% of all `tool_use` blocks on the
 * live DB, so a root-only figure reports near-zero tools for any agent-driven session.
 *
 * Each root's tree is counted exactly once. A sub-agent session that was *also* uploaded
 * standalone can never be a Phase A root, because Phase A requires an `artisyn` log row and a
 * sub-agent upload has none — so its subtree is reached only through its true root.
 */

export interface AnalyticsScope {
  teamId?: number;
  requesterUserId: number;
  /**
   * The caller's resolved team access-mode scope
   * (`RepositoriesService.resolveTeamScope()`), replacing the old
   * `teamVisibilityEnabled: boolean`. Its `visibleUserIds` drives the row filter
   * ({@link scopedUserFilterSql}) and its `visibility` drives prompt masking in whichever
   * projection carries `firstPrompt` onto the wire.
   */
  scope: TeamScope;
  startDate: Date;
  endDate: Date;
  branches: string[];
  users: string[];
  /**
   * Repeatable `attr=<key>:<op>:<value>`
   * filters, already parsed+type-validated by the caller (this file has no DB access to the
   * repo's resolved attribute definitions, so it never validates them itself). Omitted or
   * empty narrows nothing, matching `branches`/`users`' own "empty = no filter" convention.
   */
  attributeFilters?: ParsedAttributeFilter[];
}

/** One root session selected by Phase A. */
export interface ScopedRootSession {
  sessionRowId: number;
  /** `sessions.session_id` — the transcript's own id, used by the active-session list. */
  sessionId: string;
  /**
   * `logs.user_id` — the member who uploaded this session.
   *
   * Selected purely so `maskFirstPrompt()` can tell "my own row" from "another member's
   * row"; the struct otherwise carries only `userEmail`, which is a display value and
   * not a stable identity to compare ids against.
   */
  userId: number;
  startTime: string;
  endTime: string | null;
  userEmail: string;
  branch: string | null;
  firstPrompt: string | null;
  workTimeMs: number;
  turnCount: number;
  /**
   * `COALESCE(session_stats.claude_version, session_stats.claude_version_otel)` — the
   * transcript-derived Claude Code version, falling back to the OTEL one. Optional so
   * hand-built fixtures keep compiling; `undefined`/`null` means the version is unknown.
   */
  claudeVersion?: string | null;
}

interface RootSessionSqlRow {
  session_row_id: string | number;
  session_id: string;
  user_id: string | number;
  start_time: string | Date;
  end_time: string | Date | null;
  user_email: string;
  branch: string | null;
  first_prompt: string | null;
  work_time_ms: string | number | null;
  turn_count: string | number | null;
  claude_version: string | null;
}

/**
 * `bigint` columns arrive as strings from node-postgres, `float8` as numbers. Normalises both
 * without turning a genuinely missing value into a misleading `0` (see {@link numOrNull}).
 */
export function num(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return typeof value === 'number' ? value : parseFloat(value);
}

export function numOrNull(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' ? value : parseFloat(value);
}

/**
 * Comma-separated bound parameters for an `IN (...)` list.
 *
 * Never `= ANY($n::text[])`: drizzle expands an array placeholder into a parameter *list*, so
 * that form reaches Postgres as `($6)::text[]` with a plain string bound and fails with
 * `malformed array literal`. Each value stays a bound parameter here, so a branch name or
 * e-mail containing a quote or comma is still safe.
 */
export function textList(values: string[]): SQL {
  return sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );
}

/**
 * The team access-mode row filter shared by Phase A here and by the four report services
 * that hand-write the same `WHERE` (`executive-summary`, `cache-read-ratio`,
 * `attribution-breakdown`, `attribution-usage`).
 *
 * Emits nothing when `visibleUserIds` is `null` — a `transparent` team — which is exactly
 * the SQL those queries produced before access modes existed. Otherwise it narrows to the
 * ids the caller may read: `[callerId]` in the personal view and for a plain member, and
 * the acknowledged members for an owner, `manager` or `adlc trainer`.
 *
 * `{…}::int[]` rather than a drizzle array placeholder: drizzle expands an array binding
 * into a comma-separated *parameter list*, which reaches Postgres as `($n)::int[]` and
 * fails with `malformed array literal` — the same trap {@link textList} documents. The ids
 * are integers straight out of `team_members.user_id`, so the literal is not user input.
 *
 * @param logsAlias the `logs` table alias used by the surrounding query.
 */
export function scopedUserFilterSql(scope: TeamScope, logsAlias = 'l'): SQL {
  if (scope.visibleUserIds === null) {
    return sql``;
  }
  const idsLiteral = `{${scope.visibleUserIds.join(',')}}`;
  return sql`AND ${sql.raw(logsAlias)}.user_id = ANY(${idsLiteral}::int[])`;
}

/** A Postgres `bigint[]` literal of session row ids, for the descendant CTE. */
export function sessionIdsArray(rootIds: number[]): SQL {
  return sql`${`{${rootIds.join(',')}}`}::bigint[]`;
}

/**
 * Phase A — the root sessions in scope, with the per-session scalars every service or view
 * needs alongside its own rollup (`work_time_ms`, `turn_count`, first prompt, branch, user).
 */
export async function loadScopedRootSessions(
  db: DrizzleDb,
  repoIds: number[],
  scope: AnalyticsScope,
): Promise<ScopedRootSession[]> {
  if (repoIds.length === 0) return [];

  const repoIdsLiteral = `{${repoIds.join(',')}}`;
  // Team access mode: the ids this caller may read. `own-only` resolves to just
  // their own id — the same rule the endpoints applied before access modes existed — and
  // a `transparent` team emits no user predicate at all.
  const ownerFilter = scopedUserFilterSql(scope.scope, 'l');
  const branchFilter =
    scope.branches.length > 0
      ? sql`AND COALESCE(l.git_branch, 'no branch') IN (${textList(scope.branches)})`
      : sql``;
  const userFilter =
    scope.users.length > 0
      ? sql`AND u.email IN (${textList(scope.users)})`
      : sql``;
  const attrCondition = attributeFilterSql(
    scope.attributeFilters ?? [],
    sql`s.id`,
  );
  const attrFilter = attrCondition ? sql`AND ${attrCondition}` : sql``;

  const result = await db.execute(sql`
    SELECT
      s.id                          AS session_row_id,
      s.session_id                  AS session_id,
      l.user_id                     AS user_id,
      l.start_time                  AS start_time,
      l.end_time                    AS end_time,
      u.email                       AS user_email,
      l.git_branch                  AS branch,
      l.first_prompt                AS first_prompt,
      COALESCE(ss.work_time_ms, 0)  AS work_time_ms,
      COALESCE(ss.turn_count, 0)    AS turn_count,
      COALESCE(ss.claude_version, ss.claude_version_otel) AS claude_version
    FROM sessions s
    INNER JOIN logs l ON l.session_id = s.id
    INNER JOIN log_repositories lr ON lr.log_id = l.id
    INNER JOIN users u ON u.id = l.user_id
    LEFT JOIN session_stats ss ON ss.session_id = s.id
    WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
      AND l.log_type = 'artisyn'
      AND l.first_prompt IS NOT NULL
      AND s.deleted = false
      AND EXISTS (
        SELECT 1 FROM logs cl
        WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
      )
      AND l.start_time >= ${scope.startDate}
      AND l.start_time <= ${scope.endDate}
      ${ownerFilter}
      ${branchFilter}
      ${userFilter}
      ${attrFilter}
  `);

  return (result.rows as unknown as RootSessionSqlRow[]).map((r) => ({
    sessionRowId: Number(r.session_row_id),
    sessionId: r.session_id,
    userId: Number(r.user_id),
    startTime: toIso(r.start_time),
    endTime: r.end_time === null ? null : toIso(r.end_time),
    userEmail: r.user_email,
    branch: r.branch,
    firstPrompt: r.first_prompt,
    workTimeMs: num(r.work_time_ms),
    turnCount: num(r.turn_count),
    claudeVersion: r.claude_version ?? null,
  }));
}

function toIso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

/** UTC `YYYY-MM-DD` day key, matching the existing reports' bucketing convention. */
export function dayKey(isoTimestamp: string): string | null {
  const time = new Date(isoTimestamp);
  if (isNaN(time.getTime())) return null;
  return time.toISOString().slice(0, 10);
}
