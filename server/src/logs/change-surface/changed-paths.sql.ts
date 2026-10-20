/**
 * Change surface — the SQL side: where a session's repo roots come from, and how a
 * scope's raw path rows are streamed back out.
 *
 * Aggregation deliberately does NOT happen here. Entropy and pairwise folder distance are
 * not expressible cheaply in SQL, and doing the fold in one shared TypeScript function
 * (`computeChangeSurface()`) is what makes every surface agreeing structural rather
 * than a testing promise.
 */
import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../../database/database.module';
import {
  extractEditResultRecords,
  type HookEditRecordIndex,
} from '../artisyn-extractor';
import { descendantSessionsCte } from '../session-tree.sql';
import {
  CHANGE_SURFACE_MAX_SCOPE_ROWS,
  type ChangeSurfaceBucketSize,
  type ChangedPathFact,
  type ChangeKind,
  type FileKind,
} from './change-surface.types';

/** Postgres `bigint[]` literal of session ids, for the recursive CTE. */
function sessionIdsArray(ids: readonly number[]): SQL {
  return sql`${`{${ids.join(',')}}`}::bigint[]`;
}

/**
 * The candidate repo roots for one session, longest-match-first consumers aside
 * (`normaliseChangedPath()` does the matching).
 *
 * Both values live on the **artisyn** log's row, and only the tree's root session has one —
 * a `claude-subagent` session never gets an artisyn log of its own. So the lookup walks up
 * `sessions.parent_session_id` until it finds a session that has one, with the same
 * `depth < 50` guard `descendantSessionsCte` uses: `parent_session_id` has no FK and no
 * cycle check, and an unguarded recursive `UNION ALL` over a corrupted chain never
 * terminates.
 *
 * Returns `[]` when no ancestor has a root — an old hook, or an artisyn log that has not
 * been uploaded yet. That is a normal state, not an error: the caller stores the raw paths
 * anyway and `renormaliseSessionChangedPaths()` fills the normalised columns in later.
 */
export async function resolveSessionRepoRoots(
  db: DrizzleDb,
  sessionRowId: number,
): Promise<string[]> {
  const result = await db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, session_id, parent_session_id, 0 AS depth
      FROM sessions
      WHERE id = ${sessionRowId}
      UNION ALL
      SELECT p.id, p.session_id, p.parent_session_id, a.depth + 1
      FROM sessions p
      JOIN ancestors a ON a.parent_session_id = p.session_id
      WHERE a.depth < 50
    )
    SELECT l.git_repo_root, l.git_worktree_root, a.depth
    FROM ancestors a
    JOIN logs l ON l.session_id = a.id AND l.log_type = 'artisyn'
    WHERE l.git_repo_root IS NOT NULL OR l.git_worktree_root IS NOT NULL
    ORDER BY a.depth
    LIMIT 1
  `);

  const row = (
    result.rows as unknown as {
      git_repo_root: string | null;
      git_worktree_root: string | null;
    }[]
  )[0];
  if (row === undefined) return [];

  // Both roots are candidates and both are kept: inside a linked worktree they differ, and
  // `normaliseChangedPath()` strips the longest one that matches.
  return [row.git_repo_root, row.git_worktree_root].filter(
    (root): root is string => typeof root === 'string' && root.trim() !== '',
  );
}

/**
 * Batch form of {@link resolveSessionRepoRoots} for callers that already hold a tree's
 * session ids (recompute): one query over the `artisyn` logs of exactly those sessions, no
 * ancestor walk. The caller resolves a node's roots as "own entry, else its tree root's" —
 * equivalent to the walk, because only a tree's root session ever carries an artisyn log.
 *
 * Applies the same non-empty filter to `[git_repo_root, git_worktree_root]`. Sessions with
 * no artisyn log, or none with a root, are absent from the map; empty input returns an
 * empty map without querying.
 */
export async function loadArtisynRootsBySessionIds(
  db: DrizzleDb,
  sessionIds: readonly number[],
): Promise<Map<number, string[]>> {
  const rootsById = new Map<number, string[]>();
  const ids = [...new Set(sessionIds)];
  if (ids.length === 0) return rootsById;

  const result = await db.execute(sql`
    SELECT l.session_id, l.git_repo_root, l.git_worktree_root
    FROM logs l
    WHERE l.log_type = 'artisyn'
      AND l.session_id = ANY(${sessionIdsArray(ids)})
      AND (l.git_repo_root IS NOT NULL OR l.git_worktree_root IS NOT NULL)
  `);

  for (const row of result.rows as unknown as {
    session_id: string | number;
    git_repo_root: string | null;
    git_worktree_root: string | null;
  }[]) {
    const roots = [row.git_repo_root, row.git_worktree_root].filter(
      (root): root is string => typeof root === 'string' && root.trim() !== '',
    );
    if (roots.length > 0) rootsById.set(Number(row.session_id), roots);
  }
  return rootsById;
}

/**
 * The hook-derived per-edit-call records for a session tree, read from the tree's
 * `artisyn` log — the same upward walk {@link resolveSessionRepoRoots} does, and for the same
 * reason: the records for every node of a tree ride on the *root's* artisyn log, and a
 * `claude-subagent` session has none of its own.
 *
 * Only three fields per event are projected out of the body, in SQL. The `PostToolUse` event
 * also carries `tool_input`, which for a `Write` holds an entire file, so pulling whole
 * bodies into Node on every transcript upload would be materially more expensive than the
 * extraction it feeds. The projected rows are handed to the one parser
 * ({@link extractEditResultRecords}) rather than being re-validated here, so there is still a
 * single definition of what a valid record is.
 *
 * Returns the empty index when no ancestor has an artisyn log yet — the normal
 * transcript-before-artisyn upload order, and never an error: those calls simply stay
 * uncovered until the next recompute.
 */
export async function loadSessionTreeEditRecords(
  db: DrizzleDb,
  sessionRowId: number,
): Promise<HookEditRecordIndex> {
  const result = await db.execute(sql`
    WITH RECURSIVE ancestors AS (
      SELECT id, session_id, parent_session_id, 0 AS depth
      FROM sessions
      WHERE id = ${sessionRowId}
      UNION ALL
      SELECT p.id, p.session_id, p.parent_session_id, a.depth + 1
      FROM sessions p
      JOIN ancestors a ON a.parent_session_id = p.session_id
      WHERE a.depth < 50
    ),
    artisyn_log AS (
      SELECT l.id
      FROM ancestors a
      JOIN logs l ON l.session_id = a.id AND l.log_type = 'artisyn'
      ORDER BY a.depth
      LIMIT 1
    )
    SELECT
      evt->>'tool_use_id' AS tool_use_id,
      evt->>'agent_id' AS agent_id,
      evt->'edit_result' AS edit_result
    FROM artisyn_log al
    JOIN logs l ON l.id = al.id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(l.body) = 'array' THEN l.body ELSE '[]'::jsonb END
    ) AS evt
    WHERE evt->>'hook_event_name' = 'PostToolUse'
      AND evt->'edit_result' IS NOT NULL
  `);

  const rows = result.rows as unknown as {
    tool_use_id: string | null;
    agent_id: string | null;
    edit_result: unknown;
  }[];

  return extractEditResultRecords(
    rows.map((row) => ({
      hook_event_name: 'PostToolUse',
      tool_use_id: row.tool_use_id,
      agent_id: row.agent_id,
      edit_result: row.edit_result,
    })),
  );
}

/**
 * One stored path row, plus the scope tags the aggregate service folds on.
 *
 * `sessionId`/`rootSessionId` are `sessions.id`; `rootSessionKey` is the root's
 * `sessions.session_id` string, which is what the analytics chart hands to `SessionModal`
 * for its bar click-through.
 */
export interface ScopedChangedPathFact extends ChangedPathFact {
  sessionId: number;
  rootSessionId: number;
  rootSessionKey: string;
  /** `null` unless the caller supplied a grouping tag for the root session. */
  groupKey: string | null;
  /** ISO `date_trunc(<bucket>, artisyn.start_time)`; `null` when not bucketing. */
  bucketStart: string | null;
}

export interface ScopedChangedPathsResult {
  facts: ScopedChangedPathFact[];
  /**
   * `true` when the scope hit {@link CHANGE_SURFACE_MAX_SCOPE_ROWS}. The report and the chart
   * must then render an explicit "period too large — narrow the date range" notice rather
   * than a silently partial union.
   */
  truncated: boolean;
}

export interface LoadScopedChangedPathsOptions {
  /**
   * Root sessions of the scope. Their whole trees are included — tree scope is
   * mandatory on every surface, so there is no root-only variant.
   */
  rootSessionIds: readonly number[];
  /**
   * Optional grouping tag(s) per **root** session id. Every descendant inherits its root's
   * tag(s), mirroring how `reports/harness-usage.service.ts` attributes a sub-agent's work to
   * the branch/user of the session that spawned it. A root with more than one tag (a
   * `string[]`-typed attribute's fan-out) produces one joined fact-row
   * copy per tag — the full session/root counted in every one of its groups.
   */
  groupKeyByRootId?: ReadonlyMap<number, string[]> | null;
  /** `'none'` (the default) skips the `date_trunc` entirely. */
  bucket?: ChangeSurfaceBucketSize;
  /** Test seam only — production always uses {@link CHANGE_SURFACE_MAX_SCOPE_ROWS}. */
  maxRows?: number;
}

/** Bucket size -> the `date_trunc` field name. `none` never reaches here. */
const BUCKET_FIELD: Record<Exclude<ChangeSurfaceBucketSize, 'none'>, string> = {
  hour: 'hour',
  day: 'day',
  week: 'week',
};

interface RawScopedRow {
  session_id: string | number;
  root_id: string | number;
  root_session_key: string;
  bucket_start: string | Date | null;
  path_key: string;
  raw_path: string;
  rel_path: string | null;
  rel_path_key: string | null;
  folder: string | null;
  folder_key: string | null;
  top_module_key: string | null;
  depth: number | string | null;
  file_kind: string | null;
  extension: string | null;
  outside_repo: boolean;
  change_kind: string;
  edit_calls: number | string;
  diff_covered_calls: number | string;
  lines_added: number | string;
  lines_removed: number | string;
}

function num(value: number | string | null): number {
  return value === null ? 0 : Number(value);
}

/**
 * Loads every changed-path row under a set of session trees, tagged for grouping/bucketing.
 *
 * The `LIMIT` is `maxRows + 1`, ordered by session, so the caller can tell a full scope from
 * a truncated one without a second `COUNT(*)` — and the ordering keeps a truncated result a
 * whole prefix of sessions rather than a random half-session.
 */
export async function loadScopedChangedPaths(
  db: DrizzleDb,
  options: LoadScopedChangedPathsOptions,
): Promise<ScopedChangedPathsResult> {
  const rootIds = [...new Set(options.rootSessionIds)];
  if (rootIds.length === 0) return { facts: [], truncated: false };

  const maxRows = options.maxRows ?? CHANGE_SURFACE_MAX_SCOPE_ROWS;
  const bucket = options.bucket ?? 'none';
  const bucketExpr =
    bucket === 'none'
      ? sql`NULL::timestamptz`
      : sql`date_trunc(${BUCKET_FIELD[bucket]}, root_log.start_time)`;

  // The grouping tag(s) are per-root-session values the caller already resolved (branch,
  // user or attribute); they are injected as a literal `VALUES` join rather than recomputed
  // here, so this loader stays independent of the four different ways a scope can be
  // grouped. Flattened to one `(root_id, key)` tuple per tag — a root
  // with 2 fanned attribute values produces 2 joined copies of each of its fact rows below,
  // each tagged with a different `group_key`.
  const groupEntries: [number, string][] = [];
  for (const [rootId, keys] of options.groupKeyByRootId?.entries() ?? []) {
    for (const key of keys) groupEntries.push([rootId, key]);
  }
  const groupJoin =
    groupEntries.length === 0
      ? sql`LEFT JOIN (SELECT NULL::bigint AS root_id, NULL::text AS group_key) g ON false`
      : sql`LEFT JOIN (VALUES ${sql.join(
          groupEntries.map(
            ([rootId, key]) => sql`(${rootId}::bigint, ${key}::text)`,
          ),
          sql`, `,
        )}) AS g(root_id, group_key) ON g.root_id = d.root_id`;

  const result = await db.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
    SELECT
      p.session_id,
      d.root_id,
      root_session.session_id AS root_session_key,
      ${bucketExpr} AS bucket_start,
      g.group_key,
      p.path_key, p.raw_path, p.rel_path, p.rel_path_key, p.folder, p.folder_key,
      p.top_module_key, p.depth, p.file_kind, p.extension, p.outside_repo,
      p.change_kind, p.edit_calls, p.diff_covered_calls, p.lines_added, p.lines_removed
    FROM descendant_sessions d
    JOIN session_changed_paths p ON p.session_id = d.id
    JOIN sessions root_session ON root_session.id = d.root_id
    LEFT JOIN logs root_log
      ON root_log.session_id = d.root_id AND root_log.log_type = 'artisyn'
    ${groupJoin}
    ORDER BY p.session_id
    LIMIT ${maxRows + 1}
  `);

  const rows = result.rows as unknown as (RawScopedRow & {
    group_key: string | null;
  })[];
  const truncated = rows.length > maxRows;
  const kept = truncated ? rows.slice(0, maxRows) : rows;

  return {
    truncated,
    facts: kept.map((row) => ({
      sessionId: Number(row.session_id),
      rootSessionId: Number(row.root_id),
      rootSessionKey: row.root_session_key,
      groupKey: row.group_key,
      bucketStart:
        row.bucket_start === null
          ? null
          : new Date(row.bucket_start).toISOString(),
      pathKey: row.path_key,
      rawPath: row.raw_path,
      relPath: row.rel_path,
      relPathKey: row.rel_path_key,
      folder: row.folder,
      folderKey: row.folder_key,
      topModuleKey: row.top_module_key,
      depth: row.depth === null ? null : Number(row.depth),
      fileKind: (row.file_kind as FileKind | null) ?? null,
      extension: row.extension,
      outsideRepo: row.outside_repo === true,
      changeKind: row.change_kind as ChangeKind,
      editCalls: num(row.edit_calls),
      diffCoveredCalls: num(row.diff_covered_calls),
      linesAdded: num(row.lines_added),
      linesRemoved: num(row.lines_removed),
    })),
  };
}

/**
 * `cs_computed_at IS NOT NULL`, `BOOL_OR`-ed over each root's whole tree — the flag that
 * decides between rendering real numbers and rendering "no data".
 *
 * A root missing from the returned map has no computed node at all.
 */
export async function loadScopeComputedFlags(
  db: DrizzleDb,
  rootSessionIds: readonly number[],
): Promise<Map<number, boolean>> {
  const flags = new Map<number, boolean>();
  const rootIds = [...new Set(rootSessionIds)];
  if (rootIds.length === 0) return flags;

  const result = await db.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(sessionIdsArray(rootIds))}
    SELECT d.root_id, BOOL_OR(ss.cs_computed_at IS NOT NULL) AS computed
    FROM descendant_sessions d
    LEFT JOIN session_stats ss ON ss.session_id = d.id
    GROUP BY d.root_id
  `);

  for (const row of result.rows as unknown as {
    root_id: string | number;
    computed: boolean | null;
  }[]) {
    flags.set(Number(row.root_id), row.computed === true);
  }
  return flags;
}
