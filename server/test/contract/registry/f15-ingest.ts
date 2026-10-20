// F15 — log ingest (docs/qaa-overview/scenarios/05 §F15). Only `POST /api/v2/logs` exists (the
// synchronous v1 upload was removed). The endpoint's own contract is the enqueue: one `pending`
// `upload_queue` row plus its staged file; the request never parses the body. The contract run
// parks the worker (setup/global-setup.ts), so the row is observed exactly as the request left
// it. What the worker then writes (sessions, logs, stats) is proven by the ingest scenarios
// (tests/scenarios/ingest/*) and the golden sessions (tests/golden/*).
import type { ContractFamily } from '../types';

const NDJSON =
  '{"type":"user","sessionId":"w1-new-upload","message":{"role":"user","content":"hello"}}\n';

export const f15Ingest: ContractFamily = {
  id: 'F15',
  name: 'ingest',
  cases: [
    {
      id: 'F15-upload',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-upload', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201, bodyMatches: { warnings: [] } },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload'`,
              check: [
                `status = 'pending'`,
                `log_type = 'claude'`,
                'user_id = @author.id',
                `size_bytes = ${Buffer.byteLength(NDJSON)}`,
                'upload_id IS NULL',
                'error_message IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      id: 'F15-upload-child-session',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-child',
        type: 'claude',
        parentSessionId: 'w1-s07-author',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201 },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-child'`,
              check: [
                `status = 'pending'`,
                `parent_session_id = 'w1-s07-author'`,
              ],
            },
          ],
        },
      },
    },
    {
      // First chunk of a two-part upload: the row waits as `partially_uploaded`.
      id: 'F15-upload-first-chunk',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-chunked',
        type: 'claude',
        uploadId: 'w1-upload-0001',
        chunkIndex: '0',
        totalChunks: '2',
        totalSize: String(Buffer.byteLength(NDJSON) * 2),
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201, bodyMatches: { complete: false } },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `upload_id = 'w1-upload-0001'`,
              check: [
                `status = 'partially_uploaded'`,
                'chunks_received = 1',
                'total_chunks = 2',
                `session_id = 'w1-new-chunked'`,
              ],
            },
          ],
        },
      },
    },
    {
      // A session owned by another user is refused before anything is staged; the hook gets a
      // warning instead of an error.
      id: 'F15-upload-foreign-session',
      route: 'POST /api/v2/logs',
      actor: 'memberKey',
      query: { sessionId: '@s01.sessionId', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201 },
      noDb: true,
    },
    {
      id: 'F15-upload-no-session-id',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: { type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 400 },
    },
    {
      id: 'F15-upload-empty-body',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-upload', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: '   ',
      expect: { status: 400 },
    },
    {
      id: 'F15-upload-incomplete-chunk-params',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-upload', type: 'claude', uploadId: 'x' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 400 },
    },
    {
      id: 'F15-upload-no-key',
      route: 'POST /api/v2/logs',
      actor: 'anon',
      query: { sessionId: 'w1-new-upload', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 401 },
    },
  ],
};
