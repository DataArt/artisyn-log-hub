// F19 — change surface (docs/qaa-overview/scenarios/05 §F19). Counts are proven against
// `session_changed_paths` of the session TREE (a root plus its sub-agent children, via an
// independent recursive walk). The shape metrics (concentration, band, entropy, path distance)
// are an algorithm — the H block's table tests own it — so here they are golden values only.
//
// World: w1-s01 changed src/app.ts (+10 -2, modified) and docs/readme.md (+5, added);
// w1-s02 changed nothing itself, its child w1-s03 added src/health.ts (+20).
//
// OKF usage (session route, 2026-11-21 OKF tab minimal): the s02 -> s03 tree is bound to the
// world's OKF snapshot (bundle `docs/kb`: index.md, a gitignored private.md, scheduler.md, a
// nested reserved `sub/log.md`, and a dot-path `.drafts/wip.md` that is not part of the bundle).
// s02 read index.md and private.md, s03 read scheduler.md twice. The unit is the tree node (an
// agent). The counting rules are an algorithm (okf-usage-counting.md); here the summary and the
// per-file numbers are proven against `session_okf_access`, `session_stats`, `session_costs` and
// the stored snapshot body, in the personal view and in a team view, where the fail-closed
// filter drops the gitignored file and its read row. The snapshot carries hook 3.1.0
// front-matter metadata (scheduler.md deprecated, private.md without front matter), so the
// response has `versions` and `format` — golden, their rules are okf-metadata.md's.
import type { ContractFamily } from '../types';
import {
  listedRootsSql,
  OKF_FILE_FIELDS,
  OKF_SUMMARY_FIELDS,
  okfFilesSelectSql,
  okfReadsCtes,
  okfSummarySelectSql,
} from './oracle-sql';

const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

/** Session pks of the tree rooted at session pk `$1` (root and sub-agents). */
const TREE_NODES = `
  WITH RECURSIVE tree AS (
    SELECT id, session_id FROM sessions WHERE id = $1
    UNION ALL
    SELECT c.id, c.session_id FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
  )`;

/** SQL: bundle file `f` is gitignored — a team view shows neither it nor a read of it. */
const OKF_IGNORED = `(f->>'ignored')::boolean`;

/**
 * The tree of root `$1`, the snapshot it is bound to (`okf_snap`) and its KB read rows, the unit
 * being the tree node. `team`: a read row of a file the snapshot marks `ignored` is dropped.
 */
function okfSessionCtes(team: boolean): string {
  const keep = team
    ? `a.path_key NOT IN (SELECT f->>'path'
                            FROM okf_snap s, jsonb_array_elements(s.body->'bundles') b,
                                 jsonb_array_elements(b->'files') f
                           WHERE ${OKF_IGNORED})`
    : 'true';
  return `${TREE_NODES},
    okf_snap AS (SELECT o.body FROM okf_snapshots o
                  WHERE o.snapshot_id = (SELECT okf_snapshot_id FROM sessions WHERE id = $1)
                    AND o.user_id = (SELECT min(user_id) FROM logs WHERE session_id = $1)),${okfReadsCtes('id', keep)}`;
}

/**
 * `summary` of the tree of root `$1`. M = the opened node plus its descendants that have a
 * `claude` / `claude-subagent` log.
 */
function okfSessionSummarySql(team: boolean): string {
  return `${okfSessionCtes(team)}
    ${okfSummarySelectSql(`(SELECT count(*) FROM tree t
                             WHERE t.id = $1
                                OR EXISTS (SELECT 1 FROM logs l
                                            WHERE l.session_id = t.id
                                              AND l.log_type IN ('claude', 'claude-subagent')))`)}`;
}

/** `files` of the tree of root `$1`; `team`: without the gitignored files. */
function okfSessionFilesSql(team: boolean): string {
  return `${okfSessionCtes(team)}
    ${okfFilesSelectSql(team ? `NOT ${OKF_IGNORED}` : 'true')}`;
}

/** Golden: what both views of the s02 tree share. `takenAt` = `okf_snapshots.created_at`. */
const OKF_SESSION_GOLDEN = {
  unit: 'agents',
  snapshot: {
    branch: 'main',
    takenAt: '2026-01-11T09:00:00.000Z',
    hasMeta: true,
  },
  bundleRoots: ['docs/kb'],
  currentFormat: '0.3',
  notInSnapshotUnits: 0,
};

/**
 * Golden: the folders of the bundle — `agents` = the tree nodes that read a file under the bundle
 * root (s02 and s03 in both views: a team view still has s02's index.md read); `sub/` only holds
 * the never opened `sub/log.md`. No folder-level search.
 */
const OKF_SESSION_FOLDERS = [
  { bundle: 'docs/kb', path: 'docs/kb/', units: 2, search: null },
  { bundle: 'docs/kb', path: 'docs/kb/sub/', units: 0, search: null },
];

const OKF_ROUTE =
  'GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage' as const;

/** `session_changed_paths` rows of the tree rooted at session pk `$1`. */
const TREE_PATHS = `
  WITH RECURSIVE tree AS (
    SELECT id, session_id FROM sessions WHERE id = $1
    UNION ALL
    SELECT c.id, c.session_id FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
  )
  SELECT p.* FROM session_changed_paths p JOIN tree t ON t.id = p.session_id`;

export const f19ChangeSurface: ContractFamily = {
  id: 'F19',
  name: 'change-surface',
  cases: [
    {
      id: 'F19-session',
      route:
        'GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          computed: true,
          repoRootKnown: true,
          concentration: 60,
          band: 'focused',
          filesPerFolder: 1,
          largestFolderShare: 0.5,
          folderEntropyNorm: 1,
          byChangeKind: { added: 1, modified: 1, deleted: 0 },
        },
      },
      read: {
        sql: `SELECT count(*) AS files, count(DISTINCT folder_key) AS folders,
                     jsonb_agg(DISTINCT top_module_key) AS modules,
                     sum(lines_added) AS added, sum(lines_removed) AS removed,
                     count(*) FILTER (WHERE diff_covered_calls > 0) AS diff_covered,
                     count(*) FILTER (WHERE outside_repo) AS outside
                FROM (${TREE_PATHS}) x`,
        args: ['@s01.id'],
        shape: 'object',
        fields: {
          changedFiles: { col: 'files', as: 'number' },
          foldersTouched: { col: 'folders', as: 'number' },
          topLevelModules: { col: 'modules', as: 'json' },
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
          diffCoveredFiles: { col: 'diff_covered', as: 'number' },
          outsideRepoFiles: { col: 'outside', as: 'number' },
        },
      },
    },
    {
      // The root itself changed nothing: everything comes from its sub-agent child.
      id: 'F19-session-tree',
      route:
        'GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: { status: 200 },
      read: {
        sql: `SELECT count(*) AS files, count(DISTINCT folder_key) AS folders,
                     jsonb_agg(DISTINCT top_module_key) AS modules,
                     sum(lines_added) AS added, sum(lines_removed) AS removed
                FROM (${TREE_PATHS}) x`,
        args: ['@s02.id'],
        shape: 'object',
        fields: {
          changedFiles: { col: 'files', as: 'number' },
          foldersTouched: { col: 'folders', as: 'number' },
          topLevelModules: { col: 'modules', as: 'json' },
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
        },
      },
    },
    {
      id: 'F19-session-outsider',
      route:
        'GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: { status: 403 },
    },
    {
      id: 'F19-session-files',
      route:
        'GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files',
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: {
        status: 200,
        minRows: 2,
        bodyMatches: { total: 2, truncated: false },
      },
      read: {
        sql: `SELECT raw_path, rel_path, folder, file_kind, extension, change_kind, edit_calls,
                     diff_covered_calls, lines_added, lines_removed, outside_repo
                FROM (${TREE_PATHS}) x`,
        args: ['@s01.id'],
        shape: 'array',
        path: 'files',
        sortBy: 'relPath',
        fields: {
          rawPath: 'raw_path',
          relPath: 'rel_path',
          folder: 'folder',
          fileKind: 'file_kind',
          extension: 'extension',
          changeKind: 'change_kind',
          editCalls: 'edit_calls',
          diffCoveredCalls: 'diff_covered_calls',
          linesAdded: 'lines_added',
          linesRemoved: 'lines_removed',
          outsideRepo: 'outside_repo',
        },
        strict: true,
      },
    },
    {
      id: 'F19-session-files-outsider',
      route:
        'GET /api/v1/repositories/:repoId/sessions/:sessionId/change-surface/files',
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: { status: 403 },
    },
    {
      // Personal view: both agents of the tree read the KB (2 of 2). `summary` against the
      // stored rows — reads = Σ calls, tokens = Σ bytes / 4, cost = per agent the KB share of
      // its context × the context cost, spend = Σ cost of both nodes. With
      // F19-okf-session-meta-tree (the same sums per file) this is the invariant
      // Σ files = summary; the world has no folder-level search.
      id: 'F19-okf-session',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        bodyMatches: { ...OKF_SESSION_GOLDEN, folders: OKF_SESSION_FOLDERS },
      },
      read: {
        sql: okfSessionSummarySql(false),
        args: ['@s02.id'],
        shape: 'object',
        path: 'summary',
        fields: OKF_SUMMARY_FIELDS,
        strict: true,
      },
    },
    {
      // Team view (T1): the gitignored private.md and s02's read of it are gone from every
      // number (fail closed) — s02 still counts as an agent that read the KB (index.md), with a
      // smaller KB share and so a smaller cost. M and the spend are those of the whole tree.
      id: 'F19-okf-session-team',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { teamId: '@T1.id' },
      expect: {
        status: 200,
        bodyMatches: { ...OKF_SESSION_GOLDEN, folders: OKF_SESSION_FOLDERS },
      },
      read: {
        sql: okfSessionSummarySql(true),
        args: ['@s02.id'],
        shape: 'object',
        path: 'summary',
        fields: OKF_SUMMARY_FIELDS,
        strict: true,
      },
    },
    {
      // Files, versions and format of the personal view. `files`: every listed file of the bound
      // snapshot by path (the dot-path `.drafts/wip.md` is not in the bundle) with the agents
      // that read it; `sub/log.md` was never opened. `versions` and `format` are golden
      // (okf-metadata.md): the bundle declares `0.2` (older than 0.3) and lists four files — two
      // index files (index.md, the nested reserved sub/log.md) and two articles: private.md has
      // no front matter, the deprecated scheduler.md links to its successor.
      id: 'F19-okf-session-meta-tree',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        minRows: 4,
        bodyMatches: {
          versions: [
            {
              root: 'docs/kb',
              files: 4,
              okfVersion: '0.2',
              older: true,
              ignored: false,
            },
          ],
          format: {
            articles: 2,
            indexFiles: 2,
            withProblems: 2,
            groups: [
              {
                problem: 'no_front_matter',
                files: [{ path: 'docs/kb/private.md' }],
              },
              {
                problem: 'deprecated',
                files: [
                  {
                    path: 'docs/kb/scheduler.md',
                    supersededBy: 'docs/kb/scheduler-v2.md',
                  },
                ],
              },
            ],
          },
        },
      },
      read: {
        sql: okfSessionFilesSql(false),
        args: ['@s02.id'],
        shape: 'array',
        path: 'files',
        fields: OKF_FILE_FIELDS,
        strict: true,
      },
    },
    {
      // Team view: private.md is in neither `files`, `versions` nor `format`, and scheduler.md's
      // successor (not a visible file) is not linked — the deprecated flag stays.
      id: 'F19-okf-session-meta-tree-team',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { teamId: '@T1.id' },
      expect: {
        status: 200,
        minRows: 3,
        bodyMatches: {
          versions: [
            {
              root: 'docs/kb',
              files: 3,
              okfVersion: '0.2',
              older: true,
              ignored: false,
            },
          ],
          format: {
            articles: 1,
            indexFiles: 2,
            withProblems: 1,
            groups: [
              {
                problem: 'deprecated',
                files: [{ path: 'docs/kb/scheduler.md' }],
              },
            ],
          },
        },
      },
      read: {
        sql: okfSessionFilesSql(true),
        args: ['@s02.id'],
        shape: 'array',
        path: 'files',
        fields: OKF_FILE_FIELDS,
        strict: true,
      },
    },
    {
      // A session with neither OKF rows nor a snapshot: the one-line state — `snapshot: null`,
      // every array empty, every number zero, cost and spend unknown.
      id: 'F19-okf-session-none',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          unit: 'agents',
          snapshot: null,
          bundleRoots: [],
          currentFormat: '0.3',
          summary: {
            unitsRead: 0,
            unitsTotal: 0,
            reads: 0,
            tokens: 0,
            cost: null,
            readsWithoutCost: 0,
            spend: null,
          },
          versions: [],
          format: null,
          folders: [],
          notInSnapshotUnits: 0,
        },
      },
      read: {
        sql: `SELECT path_key FROM session_okf_access WHERE session_id = $1 ORDER BY path_key`,
        args: ['@s01.id'],
        shape: 'array',
        path: 'files',
        fields: { path: 'path_key' },
      },
    },
    {
      id: 'F19-okf-session-outsider',
      route: OKF_ROUTE,
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: { status: 403 },
    },
    {
      // One bucket per UTC day with at least one listed session that changed something; the
      // session tree's paths count towards the root's day.
      id: 'F19-analytics',
      route: 'GET /api/v1/repositories/:repoId/analytics/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        minRows: 2,
        bodyMatches: { bucket: 'day', groups: null },
      },
      read: {
        sql: `WITH RECURSIVE roots AS (SELECT * FROM ${listedRootsSql('$1')} r),
                   tree AS (SELECT r.id AS root_id, r.id, r.session_id FROM roots r
                            UNION ALL
                            SELECT t.root_id, c.id, c.session_id
                              FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id),
                   paths AS (SELECT date_trunc('day', r.start_time AT TIME ZONE 'UTC') AS day,
                                    r.session_id AS root_sid, p.*
                               FROM roots r JOIN tree t ON t.root_id = r.id
                               JOIN session_changed_paths p ON p.session_id = t.id)
              SELECT day AT TIME ZONE 'UTC' AS day, count(DISTINCT root_sid) AS sessions,
                     jsonb_agg(DISTINCT root_sid) AS session_ids,
                     count(*) AS files, count(DISTINCT folder_key) AS folders,
                     count(DISTINCT top_module_key) AS modules,
                     sum(lines_added) AS added, sum(lines_removed) AS removed
                FROM paths GROUP BY day ORDER BY day`,
        args: ['@R1.id'],
        shape: 'array',
        path: 'buckets',
        fields: {
          bucketStart: { col: 'day', as: 'iso' },
          sessions: { col: 'sessions', as: 'number' },
          sessionIds: { col: 'session_ids', as: 'json' },
          changedFiles: { col: 'files', as: 'number' },
          foldersTouched: { col: 'folders', as: 'number' },
          topLevelModules: { col: 'modules', as: 'number' },
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
        },
        ignore: ['concentration'],
        strict: true,
      },
    },
    {
      id: 'F19-analytics-no-dates',
      route: 'GET /api/v1/repositories/:repoId/analytics/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 400 },
    },
    {
      id: 'F19-analytics-outsider',
      route: 'GET /api/v1/repositories/:repoId/analytics/change-surface',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
    {
      // The period's union of changed paths; sessions with / without changes; the latest code
      // inventory and the changed share of it (3 of 100 files, 35 of 10,000 lines).
      id: 'F19-report',
      route: 'GET /api/v1/repositories/:repoId/reports/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: {
        status: 200,
        bodyMatches: {
          sessionsWithChanges: 2,
          noChangeSessions: 1,
          shareOfTrackedFiles: 0.03,
          shareOfTrackedLines: 0.0035,
          truncated: false,
        },
      },
      read: {
        sql: `WITH RECURSIVE roots AS (SELECT * FROM ${listedRootsSql('$1')} r),
                   tree AS (SELECT r.id, r.session_id FROM roots r
                            UNION ALL
                            SELECT c.id, c.session_id
                              FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id)
              SELECT count(DISTINCT p.rel_path_key) AS files,
                     count(DISTINCT p.folder_key) AS folders,
                     jsonb_agg(DISTINCT p.top_module_key) AS modules,
                     sum(p.lines_added) AS added, sum(p.lines_removed) AS removed
                FROM tree t JOIN session_changed_paths p ON p.session_id = t.id`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'repo',
        fields: {
          changedFiles: { col: 'files', as: 'number' },
          foldersTouched: { col: 'folders', as: 'number' },
          topLevelModules: { col: 'modules', as: 'json' },
          linesAdded: { col: 'added', as: 'number' },
          linesRemoved: { col: 'removed', as: 'number' },
        },
      },
    },
    {
      id: 'F19-report-inventory',
      route: 'GET /api/v1/repositories/:repoId/reports/change-surface',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 200 },
      read: {
        sql: `SELECT repo_id, captured_at, branch, tracked_files, tracked_lines,
                     tracked_binary_files
                FROM repo_code_inventory WHERE repo_id = $1
               ORDER BY captured_at DESC LIMIT 1`,
        args: ['@R1.id'],
        shape: 'object',
        path: 'inventory',
        fields: {
          repoId: 'repo_id',
          capturedAt: { col: 'captured_at', as: 'iso' },
          branch: 'branch',
          trackedFiles: 'tracked_files',
          trackedLines: 'tracked_lines',
          trackedBinaryFiles: 'tracked_binary_files',
        },
        strict: true,
      },
    },
    {
      id: 'F19-report-outsider',
      route: 'GET /api/v1/repositories/:repoId/reports/change-surface',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      query: MONTH,
      expect: { status: 403 },
    },
  ],
};
