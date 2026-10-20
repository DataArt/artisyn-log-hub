// F15 — log ingest (docs/qaa-overview/scenarios/05 §F15). Only `POST /api/v2/logs` exists (the
// synchronous v1 upload was removed). The endpoint's own contract is the enqueue: one `pending`
// `upload_queue` row plus its staged file; the request never parses the body. The contract run
// parks the worker (setup/global-setup.ts), so the row is observed exactly as the request left
// it. What the worker then writes (sessions, logs, stats) is proven by the ingest scenarios
// (tests/scenarios/ingest/*) and the golden sessions (tests/golden/*).
import type { ContractFamily } from '../types';

const NDJSON =
  '{"type":"user","sessionId":"w1-new-upload","message":{"role":"user","content":"hello"}}\n';

/** A syntactically valid but never-stored snapshot id (DD-2/DD-8). */
const UNKNOWN_SNAPSHOT_ID = 'd'.repeat(64);

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
      // DD-8: a valid but never-stored id, ref-only (no snapshotFull) — the hook is told to
      // resend the full snapshot next time. The queue row still has no harness_snapshot_id:
      // that column is only set on a snapshotFull=1 upload.
      id: 'F15-upload-unknown-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-unknown-snapshot',
        type: 'claude',
        snapshotId: UNKNOWN_SNAPSHOT_ID,
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { warnings: [], unknownSnapshotId: UNKNOWN_SNAPSHOT_ID },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-unknown-snapshot'`,
              check: [`status = 'pending'`, 'harness_snapshot_id IS NULL'],
            },
          ],
        },
      },
    },
    {
      // The world-seeded id (s04's owner) is already known — no unknownSnapshotId comes back.
      // `warnings` is not asserted: the owner's world data already has a `failed` upload_queue
      // row (w1-q-failed-1), which every owner upload reports as a pending warning regardless.
      id: 'F15-upload-known-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'ownerKey',
      query: {
        sessionId: 'w1-new-upload-known-snapshot',
        type: 'claude',
        snapshotId: '@harnessSnapshotId',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { unknownSnapshotId: undefined },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-known-snapshot'`,
              check: [`status = 'pending'`, 'harness_snapshot_id IS NULL'],
            },
          ],
        },
      },
    },
    {
      // snapshotFull=1: the queue row records the id (so a concurrent upload of the same id
      // reads as "known" via isHarnessSnapshotKnown's queue check), and unknownSnapshotId is
      // never returned for a full-snapshot upload, known or not (DD-8).
      id: 'F15-upload-snapshot-full',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-snapshot-full',
        type: 'claude',
        snapshotId: UNKNOWN_SNAPSHOT_ID,
        snapshotFull: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { warnings: [], unknownSnapshotId: undefined },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-snapshot-full'`,
              check: [
                `status = 'pending'`,
                `harness_snapshot_id = '${UNKNOWN_SNAPSHOT_ID}'`,
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
      // A single-chunk upload (chunkIndex=0, totalChunks=1) completes in one call, same as a
      // plain upload, so the chunk-complete response carries unknownSnapshotId exactly as the
      // single-upload path does.
      id: 'F15-upload-single-chunk-unknown-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-chunk-unknown-snapshot',
        type: 'claude',
        uploadId: 'w1-upload-0002',
        chunkIndex: '0',
        totalChunks: '1',
        totalSize: String(Buffer.byteLength(NDJSON)),
        snapshotId: UNKNOWN_SNAPSHOT_ID,
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { complete: true, unknownSnapshotId: UNKNOWN_SNAPSHOT_ID },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `upload_id = 'w1-upload-0002'`,
              check: [
                `status = 'pending'`,
                `session_id = 'w1-new-upload-chunk-unknown-snapshot'`,
                'harness_snapshot_id IS NULL',
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
