// F09 — admin: upload queue (docs/qaa-overview/scenarios/05 §F09). The world holds two `failed`
// rows; the worker is parked for the whole contract run (setup/global-setup.ts), so a row that
// flips them to `pending` stays observable.
import type { ContractFamily } from '../types';

/** The staged file the F09 spec writes for world row #1 before the rows run. */
export const F09_STAGED_FILE = {
  name: 'w1-q-failed-1.ndjson',
  text: '{"type":"user"}\n{"broken\n',
};

export const f09AdminUploadQueue: ContractFamily = {
  id: 'F09',
  name: 'admin-upload-queue',
  cases: [
    {
      id: 'F09-list',
      route: 'GET /api/v1/admin/upload-queue',
      actor: 'admin',
      expect: { status: 200, minRows: 2 },
      read: {
        sql: `SELECT id, file_name, size_bytes, received_at, session_id, log_type, user_id,
                     status::text AS status, error_message, upload_id, chunks_received,
                     total_chunks,
                     (SELECT min(r.repo_url) FROM sessions s
                        JOIN logs l ON l.session_id = s.id
                        JOIN log_repositories lr ON lr.log_id = l.id
                        JOIN repositories r ON r.id = lr.repo_id
                       WHERE s.session_id = upload_queue.session_id) AS repo_url
                FROM upload_queue`,
        shape: 'array',
        sortBy: 'id',
        fields: {
          id: 'id',
          fileName: 'file_name',
          sizeBytes: { col: 'size_bytes', as: 'number' },
          receivedAt: { col: 'received_at', as: 'iso' },
          sessionId: 'session_id',
          logType: 'log_type',
          userId: 'user_id',
          status: 'status',
          errorMessage: 'error_message',
          uploadId: 'upload_id',
          chunksReceived: 'chunks_received',
          totalChunks: 'total_chunks',
          repoUrl: 'repo_url',
        },
        strict: true,
      },
    },
    {
      id: 'F09-list-member',
      route: 'GET /api/v1/admin/upload-queue',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      // One row per queue status, in enum order, zeros included.
      id: 'F09-stats-by-status',
      route: 'GET /api/v1/admin/upload-queue/stats',
      actor: 'admin',
      expect: { status: 200, minRows: 5 },
      read: {
        sql: `SELECT s.status::text AS status,
                     (SELECT count(*) FROM upload_queue q WHERE q.status = s.status) AS files,
                     (SELECT coalesce(sum(q.size_bytes), 0) FROM upload_queue q
                       WHERE q.status = s.status) AS bytes
                FROM unnest(enum_range(NULL::upload_queue_status)) WITH ORDINALITY AS s(status, n)
               ORDER BY s.n`,
        shape: 'array',
        path: 'byStatus',
        fields: {
          status: 'status',
          files: { col: 'files', as: 'number' },
          bytes: { col: 'bytes', as: 'number' },
        },
        strict: true,
      },
    },
    {
      id: 'F09-stats-total',
      route: 'GET /api/v1/admin/upload-queue/stats',
      actor: 'admin',
      expect: { status: 200 },
      read: {
        sql: `SELECT count(*) AS files, coalesce(sum(size_bytes), 0) AS bytes FROM upload_queue`,
        shape: 'object',
        path: 'total',
        fields: {
          files: { col: 'files', as: 'number' },
          bytes: { col: 'bytes', as: 'number' },
        },
        strict: true,
      },
    },
    {
      // Delivered-latency figures count successful measurements of the last 15 minutes only.
      id: 'F09-stats-latency',
      route: 'GET /api/v1/admin/upload-queue/stats',
      actor: 'admin',
      expect: { status: 200 },
      read: {
        sql: `SELECT avg(queue_latency_ms) AS avg_ms, min(queue_latency_ms) AS min_ms,
                     max(queue_latency_ms) AS max_ms,
                     percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_latency_ms) AS p95_ms
                FROM upload_queue_measurements
               WHERE outcome = 'success' AND finished_at > now() - interval '15 minutes'`,
        shape: 'object',
        path: 'latency',
        fields: {
          avgMs: { col: 'avg_ms', as: 'numeric' },
          p95Ms: { col: 'p95_ms', as: 'numeric' },
          minMs: { col: 'min_ms', as: 'numeric' },
          maxMs: { col: 'max_ms', as: 'numeric' },
        },
        strict: true,
      },
    },
    {
      id: 'F09-stats-member',
      route: 'GET /api/v1/admin/upload-queue/stats',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F09-clear-failed',
      route: 'DELETE /api/v1/admin/upload-queue/failed',
      actor: 'admin',
      expect: { status: 200, bodyMatches: { deletedCount: 2 } },
      write: {
        watch: ['upload_queue'],
        delta: {
          deleted: [
            { table: 'upload_queue', where: `status = 'failed'`, count: 2 },
          ],
        },
      },
    },
    {
      id: 'F09-clear-failed-member',
      route: 'DELETE /api/v1/admin/upload-queue/failed',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F09-reprocess-failed',
      route: 'POST /api/v1/admin/upload-queue/reprocess-failed',
      actor: 'admin',
      expect: { status: 200, bodyMatches: { updatedCount: 2 } },
      write: {
        watch: ['upload_queue'],
        delta: {
          updated: [
            {
              table: 'upload_queue',
              where: `status = 'failed'`,
              count: 2,
              changed: { status: 'pending', error_message: null },
              anyChange: ['updated_at'],
            },
          ],
        },
      },
    },
    {
      id: 'F09-reprocess-failed-member',
      route: 'POST /api/v1/admin/upload-queue/reprocess-failed',
      actor: 'member',
      expect: { status: 403 },
    },
    {
      id: 'F09-file',
      route: 'GET /api/v1/admin/upload-queue/:id/file',
      actor: 'admin',
      params: { id: 1 },
      expect: { status: 200, bodyText: F09_STAGED_FILE.text },
      noDb: true,
    },
    {
      // Row #2 has no staged file on disk.
      id: 'F09-file-missing',
      route: 'GET /api/v1/admin/upload-queue/:id/file',
      actor: 'admin',
      params: { id: 2 },
      expect: { status: 404 },
    },
    {
      id: 'F09-file-member',
      route: 'GET /api/v1/admin/upload-queue/:id/file',
      actor: 'member',
      params: { id: 1 },
      expect: { status: 403 },
    },
  ],
};
