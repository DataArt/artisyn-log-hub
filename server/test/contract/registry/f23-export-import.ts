// F23 — export / import jobs and the full recompute (docs/qaa-overview/scenarios/05 §F23).
//
// Export runs as a background job: its row settles (`settle`) once the job has written its zip
// into the run's temp EXPORT_IMPORT_DIR. The import routes take a multipart zip; their positive
// path (staging a real export and re-importing it) is the repository export/import scenarios'
// job — here they get their guard and validation rows, and the job-status reads run against the
// world's fixed jobs (w1-job-export-done, w1-job-export-running, w1-job-import-done).
import type { ContractFamily } from '../types';
import { listedRootsSql } from './oracle-sql';

const JOB_STATUS_FIELDS = {
  status: 'status',
  processed: 'processed',
  total: 'total',
} as const;

export const f23ExportImport: ContractFamily = {
  id: 'F23',
  name: 'export-import',
  cases: [
    {
      // What an `all` export would contain: the listed root sessions and the raw size of the
      // logs of their trees.
      id: 'F23-scope',
      route: 'GET /api/v1/repositories/:repoId/export-import/scope',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { scope: 'all' },
      expect: { status: 200 },
      read: {
        sql: `SELECT count(*) AS sessions FROM ${listedRootsSql('$1')} r`,
        args: ['@R1.id'],
        shape: 'object',
        fields: { sessionCount: { col: 'sessions', as: 'number' } },
        ignore: ['approxUncompressedBytes'],
        strict: true,
      },
    },
    {
      id: 'F23-scope-bad',
      route: 'GET /api/v1/repositories/:repoId/export-import/scope',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      query: { scope: 'everything' },
      expect: { status: 400 },
    },
    {
      // Export and import are owner-or-team-owner: a team member is refused.
      id: 'F23-scope-member',
      route: 'GET /api/v1/repositories/:repoId/export-import/scope',
      actor: 'member',
      params: { repoId: '@R1.id' },
      query: { scope: 'all', teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-export',
      route: 'POST /api/v1/repositories/:repoId/export',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      body: { scope: 'all' },
      expect: { status: 202 },
      settle: {
        until: `(SELECT status IN ('done', 'error') FROM export_import_jobs WHERE id = $jobId)`,
      },
      write: {
        watch: ['export_import_jobs'],
        delta: {
          inserted: [
            {
              table: 'export_import_jobs',
              where: 'id = $jobId',
              check: [
                `kind = 'export'`,
                `status = 'done'`,
                'repo_id = @R1.id',
                'user_id = @owner.id',
                'processed = total',
                'total = 3',
                `result_file_name LIKE '%.zip'`,
                'error_message IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F23-export-outsider',
      route: 'POST /api/v1/repositories/:repoId/export',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      body: { scope: 'all' },
      expect: { status: 403 },
    },
    {
      id: 'F23-export-status',
      route: 'GET /api/v1/repositories/:repoId/export/:jobId/status',
      actor: 'owner',
      params: { repoId: '@R1.id', jobId: '@exportDone.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT status::text AS status, processed, total FROM export_import_jobs WHERE id = $1`,
        args: ['@exportDone.id'],
        shape: 'object',
        fields: JOB_STATUS_FIELDS,
        strict: true,
      },
    },
    {
      // An import job is not an export job.
      id: 'F23-export-status-wrong-kind',
      route: 'GET /api/v1/repositories/:repoId/export/:jobId/status',
      actor: 'owner',
      params: { repoId: '@R1.id', jobId: '@importDone.id' },
      expect: { status: 404 },
    },
    {
      id: 'F23-download-not-finished',
      route: 'GET /api/v1/repositories/:repoId/export/:jobId/download',
      actor: 'owner',
      params: { repoId: '@R1.id', jobId: '@exportRunning.id' },
      expect: { status: 409 },
    },
    {
      id: 'F23-download-unknown',
      route: 'GET /api/v1/repositories/:repoId/export/:jobId/download',
      actor: 'owner',
      params: { repoId: '@R1.id', jobId: 'no-such-job' },
      expect: { status: 404 },
    },
    {
      id: 'F23-download-outsider',
      route: 'GET /api/v1/repositories/:repoId/export/:jobId/download',
      actor: 'outsider',
      params: { repoId: '@R1.id', jobId: '@exportDone.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-import-upload-no-file',
      route: 'POST /api/v1/repositories/:repoId/import/upload',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 400 },
    },
    {
      id: 'F23-import-upload-outsider',
      route: 'POST /api/v1/repositories/:repoId/import/upload',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-import-confirm-unknown-token',
      route: 'POST /api/v1/repositories/:repoId/import/:uploadToken/confirm',
      actor: 'owner',
      params: { repoId: '@R1.id', uploadToken: 'never-staged.zip' },
      body: {},
      expect: { status: 404 },
    },
    {
      // A staged upload whose import was refused stays refused: the 404 carries the reason the
      // job was failed with, not the generic "never staged" text.
      id: 'F23-import-confirm-errored-upload',
      route: 'POST /api/v1/repositories/:repoId/import/:uploadToken/confirm',
      actor: 'owner',
      params: { repoId: '@R1.id', uploadToken: '@stagedError.id' },
      body: {},
      expect: {
        status: 404,
        bodyMatches: { message: '@stagedError.errorMessage' },
      },
    },
    {
      id: 'F23-import-status',
      route: 'GET /api/v1/repositories/:repoId/import/:jobId/status',
      actor: 'owner',
      params: { repoId: '@R1.id', jobId: '@importDone.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT status::text AS status, processed, total FROM export_import_jobs WHERE id = $1`,
        args: ['@importDone.id'],
        shape: 'object',
        fields: JOB_STATUS_FIELDS,
        strict: true,
      },
    },
    {
      id: 'F23-import-status-outsider',
      route: 'GET /api/v1/repositories/:repoId/import/:jobId/status',
      actor: 'outsider',
      params: { repoId: '@R1.id', jobId: '@importDone.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-bootstrap-upload-no-file',
      route: 'POST /api/v1/repositories/bootstrap-import/upload',
      actor: 'owner',
      expect: { status: 400 },
    },
    {
      id: 'F23-bootstrap-upload-anon',
      route: 'POST /api/v1/repositories/bootstrap-import/upload',
      actor: 'anon',
      expect: { status: 401 },
    },
    {
      id: 'F23-bootstrap-confirm-unknown-token',
      route: 'POST /api/v1/repositories/bootstrap-import/:uploadToken/confirm',
      actor: 'owner',
      params: { uploadToken: 'never-staged.zip' },
      expect: { status: 404 },
    },
    {
      id: 'F23-bootstrap-confirm-errored-upload',
      route: 'POST /api/v1/repositories/bootstrap-import/:uploadToken/confirm',
      actor: 'owner',
      params: { uploadToken: '@stagedError.id' },
      expect: {
        status: 404,
        bodyMatches: { message: '@stagedError.errorMessage' },
      },
    },
    {
      // A bootstrap import's status is the caller's own import job, with the repository it
      // landed in.
      id: 'F23-bootstrap-status',
      route: 'GET /api/v1/repositories/bootstrap-import/:jobId/status',
      actor: 'owner',
      params: { jobId: '@importDone.id' },
      expect: { status: 200 },
      read: {
        sql: `SELECT status::text AS status, processed, total, repo_id
                FROM export_import_jobs WHERE id = $1`,
        args: ['@importDone.id'],
        shape: 'object',
        fields: { ...JOB_STATUS_FIELDS, repoId: 'repo_id' },
        strict: true,
      },
    },
    {
      // Somebody else's job does not exist for the caller.
      id: 'F23-bootstrap-status-other-user',
      route: 'GET /api/v1/repositories/bootstrap-import/:jobId/status',
      actor: 'member',
      params: { jobId: '@importDone.id' },
      expect: { status: 404 },
    },
    {
      // The server re-reads every session's logs: the token totals it derives from the claude
      // bodies equal the world's (the world's stats were summed from those very bodies). The
      // other per-session tables are re-derived; their contents belong to the algorithm tests.
      id: 'F23-recompute',
      route: 'POST /api/v1/repositories/:repoId/recompute-all-sessions',
      actor: 'owner',
      params: { repoId: '@R1.id' },
      expect: { status: 201 },
      write: {
        watch: [],
        derived: [
          'session_stats',
          'session_call_tokens',
          'session_costs',
          'session_tool_stats',
          'session_changed_paths',
          'session_file_stats',
          'session_harness_usage',
          'session_cause_stats',
          'session_request_ids',
          'harness_elements',
          // OKF DD-9: recompute rebuilds every tree node's rows from the claude bodies.
          'session_okf_access',
        ],
        delta: {},
        after: [
          `(SELECT input_tokens = 1000000 AND output_tokens = 250000
                   AND cache_read_tokens = 200000 AND cache_write_5m_tokens = 100000
              FROM session_stats WHERE session_id = @s01.id)`,
          `(SELECT input_tokens = 500000 AND cache_write_1h_tokens = 50000
              FROM session_stats WHERE session_id = @s02.id)`,
        ],
      },
    },
    {
      id: 'F23-recompute-outsider',
      route: 'POST /api/v1/repositories/:repoId/recompute-all-sessions',
      actor: 'outsider',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      // The admin role grants no data access (2026-10-21-private-repo-visibility). assertRepoOwnerOrTeamOwner has no admin bypass.
      id: 'F23-scope-admin',
      route: 'GET /api/v1/repositories/:repoId/export-import/scope',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { scope: 'all' },
      expect: { status: 403 },
    },
    {
      id: 'F23-scope-admin-team',
      route: 'GET /api/v1/repositories/:repoId/export-import/scope',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { scope: 'all', teamId: '@T1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-export-admin',
      route: 'POST /api/v1/repositories/:repoId/export',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      body: { scope: 'all' },
      expect: { status: 403 },
    },
    {
      id: 'F23-import-upload-admin',
      route: 'POST /api/v1/repositories/:repoId/import/upload',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-recompute-admin',
      route: 'POST /api/v1/repositories/:repoId/recompute-all-sessions',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      expect: { status: 403 },
    },
    {
      id: 'F23-recompute-admin-team',
      route: 'POST /api/v1/repositories/:repoId/recompute-all-sessions',
      actor: 'admin',
      params: { repoId: '@R1.id' },
      query: { teamId: '@T1.id' },
      expect: { status: 403 },
    },
  ],
};
