// F19 — change surface (docs/qaa-overview/scenarios/05 §F19). Counts are proven against
// `session_changed_paths` of the session TREE (a root plus its sub-agent children, via an
// independent recursive walk). The shape metrics (concentration, band, entropy, path distance)
// are an algorithm — the H block's table tests own it — so here they are golden values only.
//
// World: w1-s01 changed src/app.ts (+10 -2, modified) and docs/readme.md (+5, added);
// w1-s02 changed nothing itself, its child w1-s03 added src/health.ts (+20).
//
// OKF usage (session route, 2026-10-27 OKF usage tab): the s02 -> s03 tree is bound to the world's
// OKF snapshot (bundle `docs/kb`: index.md, a gitignored private.md, scheduler.md). s02 read
// index.md and private.md, s03 read scheduler.md twice. The verdict and the tree are an algorithm
// (okf-verdict.md); here the bundle summary and the per-agent read totals are proven against
// `session_okf_access` and the stored snapshot body, in the personal view and in a team view,
// where the DD-30 filter drops the gitignored file.
import type { ContractFamily, ReadSpec } from '../types';
import { listedRootsSql } from './oracle-sql';

const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

/** Session pks of the tree rooted at session pk `$1` (root and sub-agents). */
const TREE_NODES = `
  WITH RECURSIVE tree AS (
    SELECT id, session_id FROM sessions WHERE id = $1
    UNION ALL
    SELECT c.id, c.session_id FROM sessions c JOIN tree t ON c.parent_session_id = t.session_id
  )`;

/**
 * One row per bundle of the snapshot the tree root `$1` is bound to: article count (listed files
 * without the bundle's index.md, which no analysis counts), distinct articles read (read/grep),
 * read bytes under the bundle root. `team`: the files the snapshot marks `ignored` count nowhere
 * (DD-30).
 */
function okfBundlesSql(team: boolean): string {
  const visible = team ? `NOT (f->>'ignored')::boolean` : 'true';
  const article = `${visible} AND f->>'path' <> b->>'index'`;
  return `${TREE_NODES},
    acc AS (SELECT a.* FROM tree t JOIN session_okf_access a ON a.session_id = t.id
             WHERE a.op IN ('read', 'grep'))
    SELECT b->>'root' AS root, b->>'index' AS idx, (b->>'ignored')::boolean AS ignored,
           (SELECT count(*) FROM jsonb_array_elements(b->'files') f WHERE ${article}) AS files,
           (SELECT count(DISTINCT acc.path_key) FROM acc
             WHERE acc.path_key IN (SELECT f->>'path' FROM jsonb_array_elements(b->'files') f
                                     WHERE ${article})) AS files_read,
           (SELECT coalesce(sum(acc.bytes), 0) FROM acc
             WHERE acc.path_key LIKE (b->>'root') || '/%'
               AND acc.path_key NOT IN (SELECT f->>'path' FROM jsonb_array_elements(b->'files') f
                                         WHERE NOT (${visible}))) AS read_bytes
      FROM okf_snapshots o, jsonb_array_elements(o.body->'bundles') b
     WHERE o.snapshot_id = (SELECT okf_snapshot_id FROM sessions WHERE id = $1)
       AND o.user_id = (SELECT min(user_id) FROM logs WHERE session_id = $1)
     ORDER BY root`;
}

const OKF_BUNDLE_FIELDS = {
  root: 'root',
  index: 'idx',
  ignored: 'ignored',
  files: { col: 'files', as: 'number' },
  filesRead: { col: 'files_read', as: 'number' },
  readBytes: { col: 'read_bytes', as: 'number' },
} as const;

const OKF_ROUTE =
  'GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage' as const;
const OKF_TRAIL_ROUTE =
  'GET /api/v1/repositories/:repoId/sessions/:sessionId/okf-usage/trail' as const;

/**
 * The trail of tree node `$1` (package 3): its id and description, never truncated here, and one
 * item per `tool_use` block of its stored claude transcript — the trail is rebuilt from the
 * transcript, not from the stored OKF rows, and the world's bodies carry no tool calls.
 */
function trailRead(nodeRef: string): ReadSpec {
  return {
    sql: `SELECT jsonb_build_object('id', s.session_id, 'label', s.agent_description) AS agent,
                 false AS truncated,
                 (SELECT coalesce(jsonb_agg(b), '[]'::jsonb)
                    FROM logs l, jsonb_array_elements(l.body) line,
                         jsonb_array_elements(
                           CASE jsonb_typeof(line->'message'->'content')
                             WHEN 'array' THEN line->'message'->'content'
                             ELSE '[]'::jsonb END) b
                   WHERE l.session_id = s.id
                     AND l.log_type IN ('claude', 'claude-subagent')
                     AND b->>'type' = 'tool_use') AS items
            FROM sessions s WHERE s.id = $1`,
    args: [nodeRef],
    shape: 'object',
    fields: {
      agent: { col: 'agent', as: 'json' },
      truncated: 'truncated',
      items: { col: 'items', as: 'json' },
    },
    strict: true,
  };
}

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
      // Personal view: the bound snapshot's one bundle, all three files counted (private.md too).
      // A 3-file bundle is below SHARE_MIN_BUNDLE_FILES, so the verdict is a plain `ok`.
      id: 'F19-okf-session',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        minRows: 1,
        bodyMatches: {
          hasSnapshot: true,
          // Checks (2026-11-05, okf-verdict.md rule 13): both tree nodes read the bundle; s02
          // started at index.md, s03 at scheduler.md (no search first → given); the 2-article
          // bundle cannot be judged by share; no node wrote an article it read.
          verdict: {
            level: 'ok',
            qualifiers: [],
            findings: [],
            checks: [
              {
                rule: 'kb_used',
                status: 'ok',
                params: {
                  agentsWithKb: 2,
                  agents: 2,
                  folders: 'docs/kb',
                  articles: 2,
                },
              },
              {
                rule: 'entry',
                status: 'ok',
                params: { index: 1, search: 0, given: 1, agents: 2 },
              },
              {
                rule: 'session_share',
                status: 'na',
                params: {
                  reason: 'small_bundles',
                  fix: 0.25,
                  mess: 0.5,
                  minFiles: 10,
                },
              },
              {
                rule: 'upkeep',
                status: 'ok',
                params: { agents: 0, articles: 0, agentId: null, path: null },
              },
            ],
          },
        },
      },
      read: {
        sql: okfBundlesSql(false),
        args: ['@s02.id'],
        shape: 'array',
        path: 'bundles',
        fields: OKF_BUNDLE_FIELDS,
      },
    },
    {
      // Per agent (tree node, `sessions.session_id`): read/grep calls and bytes on KB files —
      // the sub-agent s03's reads are its own (FR-4).
      id: 'F19-okf-session-agents',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `${TREE_NODES}
              SELECT t.session_id AS id,
                     (SELECT s.agent_description FROM sessions s WHERE s.id = t.id) AS label,
                     (SELECT coalesce(sum(a.calls), 0) FROM session_okf_access a
                       WHERE a.session_id = t.id AND a.op IN ('read', 'grep')
                         AND a.path_key NOT LIKE '%/') AS kb_reads,
                     (SELECT coalesce(sum(a.bytes), 0) FROM session_okf_access a
                       WHERE a.session_id = t.id AND a.op IN ('read', 'grep')
                         AND a.path_key NOT LIKE '%/') AS kb_read_bytes,
                     (SELECT count(*) FROM session_okf_event e
                       WHERE e.session_id = t.id AND e.op = 'search') AS searches,
                     (SELECT CASE WHEN count(*) = 0 THEN NULL
                                  ELSE jsonb_build_object('k', count(*) FILTER (WHERE r.followed),
                                                          'n', count(*)) END
                        FROM (SELECT p.read_ord, bool_or(p.followed) AS followed
                                FROM session_okf_pointer p
                               WHERE p.session_id = t.id AND p.is_new AND NOT p.partial
                               GROUP BY p.read_ord) r) AS yield
                FROM tree t`,
        args: ['@s02.id'],
        shape: 'array',
        path: 'agents',
        sortBy: 'id',
        fields: {
          id: 'id',
          // Optional since the OKF tab quick wins: the sub-agent's description, null for the root.
          label: 'label',
          kbReads: { col: 'kb_reads', as: 'number' },
          kbReadBytes: { col: 'kb_read_bytes', as: 'number' },
          // 2026-11-03 value signals: code search events and pointer yield (FR-1) per node.
          searches: { col: 'searches', as: 'number' },
          yield: { col: 'yield', as: 'json' },
        },
      },
    },
    {
      // 2026-11-03 value signals: the whole tree's signal totals. Reads that showed a new
      // pointer: s02's index.md read and s03's first scheduler.md read; only s03 followed one.
      // s03 grepped scheduler.ts twice after reading scheduler.md (= exploredMinSearches) → one
      // searched-after pair; no node searched an area instead of reading, no dead pointer, no
      // upkeep, no cap hit, default thresholds.
      id: 'F19-okf-session-signals',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          thresholds: { custom: [] },
          upkeep: [],
          eventsTruncated: false,
        },
      },
      read: {
        sql: `${TREE_NODES},
              shown AS (SELECT p.session_id, p.read_ord, bool_or(p.followed) AS followed
                          FROM tree t JOIN session_okf_pointer p ON p.session_id = t.id
                         WHERE p.is_new AND NOT p.partial
                         GROUP BY p.session_id, p.read_ord)
              SELECT (SELECT count(*) FROM shown) AS with_new,
                     (SELECT count(*) FROM shown WHERE followed) AS followed,
                     0 AS routing,
                     -- searched-after pairs (FR-2): in-area searches after the first read,
                     -- per (node, article) with ≥ 2 (the area is scheduler.md's two pointers)
                     (SELECT count(*) FROM (
                        SELECT p.session_id, p.article_path
                          FROM tree t JOIN session_okf_pointer p ON p.session_id = t.id
                         WHERE NOT p.partial
                         GROUP BY p.session_id, p.article_path
                        HAVING (SELECT count(*) FROM session_okf_event e
                                 WHERE e.session_id = p.session_id AND e.op = 'search'
                                   AND e.ord > min(p.read_ord)
                                   AND e.path IN ('server/src/scheduler.ts',
                                                  'server/src/legacy-cron.ts')) >= 2
                      ) x) AS searched_after,
                     0 AS dead`,
        args: ['@s02.id'],
        shape: 'object',
        path: 'signals',
        fields: {
          readsWithNewPointers: { col: 'with_new', as: 'number' },
          readsFollowed: { col: 'followed', as: 'number' },
          routingMissArticles: { col: 'routing', as: 'number' },
          searchedAfterPairs: { col: 'searched_after', as: 'number' },
          deadPointers: { col: 'dead', as: 'number' },
        },
        strict: true,
      },
    },
    {
      // Team view (T1): the gitignored private.md is gone from the file count, the files read
      // and the read bytes (DD-30 fail closed).
      id: 'F19-okf-session-team',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { teamId: '@T1.id' },
      expect: { status: 200, minRows: 1, bodyMatches: { hasSnapshot: true } },
      read: {
        sql: okfBundlesSql(true),
        args: ['@s02.id'],
        shape: 'array',
        path: 'bundles',
        fields: OKF_BUNDLE_FIELDS,
      },
    },
    {
      // A session with neither OKF rows nor a snapshot: no KB at all, `verdict: null`. The
      // opened node is always listed as an agent, with nothing read.
      id: 'F19-okf-session-none',
      route: OKF_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s01.sessionId' },
      expect: {
        status: 200,
        bodyMatches: {
          verdict: null,
          hasSnapshot: false,
          bundles: [],
          tree: [],
          agents: [
            {
              id: '@s01.sessionId',
              taskHead: 'Add a spice-yield endpoint',
              label: null,
              entry: null,
              kbReads: 0,
              kbReadBytes: 0,
              files: [],
              // 2026-11-03 value signals: empty, not absent, on a node with no OKF rows.
              pointers: [],
              promptNamedPaths: 0,
              routingMisses: [],
              // Package 3: the articles it searched after reading (trail links).
              searchedAfter: [],
              upkeepArticles: [],
              searches: 0,
              yield: null,
            },
          ],
        },
      },
      read: {
        sql: `SELECT path_key FROM session_okf_access WHERE session_id = $1 ORDER BY path_key`,
        args: ['@s01.id'],
        shape: 'array',
        path: 'readTop',
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
      // Package 3 agent trail: the sub-agent s03 of the opened tree s02. The trail is rebuilt
      // from the node's stored transcript (like the facts route), never from the stored OKF rows:
      // one item per tool_use access — the world's bodies carry no tool calls, so none. The label
      // is s03's own description; nothing is capped.
      id: 'F19-okf-trail',
      route: OKF_TRAIL_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { agent: '@s03.sessionId' },
      expect: { status: 200 },
      read: trailRead('@s03.id'),
    },
    {
      // The opened node itself: the root has no description.
      id: 'F19-okf-trail-root',
      route: OKF_TRAIL_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { agent: '@s02.sessionId' },
      expect: { status: 200 },
      read: trailRead('@s02.id'),
    },
    {
      id: 'F19-okf-trail-outsider',
      route: OKF_TRAIL_ROUTE,
      actor: 'outsider',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { agent: '@s03.sessionId' },
      expect: { status: 403 },
    },
    {
      id: 'F19-okf-trail-no-agent',
      route: OKF_TRAIL_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      expect: { status: 400 },
    },
    {
      // s01 is a session of the same repository but not a node of s02's tree.
      id: 'F19-okf-trail-foreign-node',
      route: OKF_TRAIL_ROUTE,
      actor: 'owner',
      params: { repoId: '@R1.id', sessionId: '@s02.sessionId' },
      query: { agent: '@s01.sessionId' },
      expect: { status: 404 },
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
