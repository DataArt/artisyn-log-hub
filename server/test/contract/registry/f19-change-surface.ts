// F19 — change surface (docs/qaa-overview/scenarios/05 §F19). Counts are proven against
// `session_changed_paths` of the session TREE (a root plus its sub-agent children, via an
// independent recursive walk). The shape metrics (concentration, band, entropy, path distance)
// are an algorithm — the H block's table tests own it — so here they are golden values only.
//
// World: w1-s01 changed src/app.ts (+10 -2, modified) and docs/readme.md (+5, added);
// w1-s02 changed nothing itself, its child w1-s03 added src/health.ts (+20).
import type { ContractFamily } from '../types';
import { listedRootsSql } from './oracle-sql';

const MONTH = { startDate: '2026-01-01', endDate: '2026-01-31' };

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
