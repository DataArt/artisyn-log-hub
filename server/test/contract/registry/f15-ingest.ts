// F15 — log ingest (docs/qaa-overview/scenarios/05 §F15). Only `POST /api/v2/logs` exists (the
// synchronous v1 upload was removed). The endpoint's own contract is the enqueue: one `pending`
// `upload_queue` row plus its staged file; the request never parses the body. The contract run
// parks the worker (setup/global-setup.ts), so the row is observed exactly as the request left
// it. What the worker then writes (sessions, logs, stats) is proven by the ingest scenarios
// (tests/scenarios/ingest/*) and the golden sessions (tests/golden/*).
import { createHash } from 'node:crypto';
import type { ContractFamily } from '../types';

const NDJSON =
  '{"type":"user","sessionId":"w1-new-upload","message":{"role":"user","content":"hello"}}\n';

/** sha256 hex of NDJSON as the hook declares it (2026-11-23 session-logs-streaming DD-24). */
const NDJSON_SHA256 = createHash('sha256').update(NDJSON, 'utf8').digest('hex');

/** One hook `otel-status` line (2026-10-30 otel-shared-receiver, DD-16). */
function otelStatusLine(
  timestamp: string,
  state: string,
  reason: string | null,
) {
  return {
    type: 'otel-status',
    timestamp,
    sessionId: 'w1-new-otel-status',
    state,
    reason,
    detail: null,
    received: { logs: 0, metrics: 0, spans: 0, firstAt: null },
    claudeVersion: '2.1.300',
    forward: 'off',
    hookVersion: '2.30.0',
    receiverVersion: '2.30.0',
  };
}

/** An artisyn body: one prompt, then a newer, an older and an unknown-reason `otel-status`. */
const OTEL_STATUS_NDJSON =
  [
    {
      event: 'prompt_start',
      timestamp: '2026-01-20T10:00:00.000Z',
      session_id: 'w1-new-otel-status',
      prompt: 'Map the spice fields',
    },
    otelStatusLine('2026-01-20T10:10:00.000Z', 'partial', 'managed-endpoint'),
    otelStatusLine('2026-01-20T10:05:00.000Z', 'none', 'not-configured'),
    otelStatusLine('2026-01-20T10:20:00.000Z', 'none', 'galaxy-brain'),
  ]
    .map((line) => JSON.stringify(line))
    .join('\n') + '\n';

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
      // 2026-10-30 otel-shared-receiver (DD-16, DD-28): an artisyn body carrying `otel-status`
      // lines — a later one, an older one and one with an unknown reason — is enqueued like any
      // other artisyn body: one `pending` row of exactly its size, no session_stats write and no
      // 4xx for the unknown values. What the worker then stores (the latest by timestamp, an
      // unknown reason as `unknown`, end_time untouched) is checked by @S-INGEST-02 step 11,
      // because the contract run parks the worker.
      id: 'F15-upload-otel-status',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-otel-status', type: 'artisyn' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: OTEL_STATUS_NDJSON,
      expect: { status: 201, bodyMatches: { warnings: [] } },
      write: {
        watch: ['upload_queue', 'session_stats'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-otel-status'`,
              check: [
                `status = 'pending'`,
                `log_type = 'artisyn'`,
                'user_id = @author.id',
                `size_bytes = ${Buffer.byteLength(OTEL_STATUS_NDJSON)}`,
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
      // Sub-agent `.meta.json` labels (2026-10-21 workflow-agent-meta-labels, DD-1/DD-3): a
      // `claude-subagent` upload stages `agentDescription` / `workflowPhase` on its queue row.
      id: 'F15-upload-subagent-meta',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'agent-w1-new-meta',
        type: 'claude-subagent',
        parentSessionId: 'w1-s07-author',
        agentDescription: 'load-config',
        workflowPhase: 'Config',
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
              where: `session_id = 'agent-w1-new-meta'`,
              check: [
                `status = 'pending'`,
                `log_type = 'claude-subagent'`,
                `agent_description = 'load-config'`,
                `workflow_phase = 'Config'`,
              ],
            },
          ],
        },
      },
    },
    {
      // DD-1: a 300-char description is cut to 255 code points and a whitespace-only phase is
      // dropped to NULL — silently, never a 4xx.
      id: 'F15-upload-subagent-meta-sanitised',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'agent-w1-new-meta-long',
        type: 'claude-subagent',
        parentSessionId: 'w1-s07-author',
        agentDescription: 'x'.repeat(300),
        workflowPhase: '  ',
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
              where: `session_id = 'agent-w1-new-meta-long'`,
              check: [
                `status = 'pending'`,
                `agent_description = '${'x'.repeat(255)}'`,
                'workflow_phase IS NULL',
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
      // OKF DD-22: a valid but never-stored OKF snapshot id, ref-only — the hook is told to
      // resend the full snapshot (`unknownOkfSnapshotId`). The queue row records an id only for
      // an `okfSnapshotFull=1` upload.
      id: 'F15-upload-unknown-okf-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-unknown-okf',
        type: 'artisyn',
        okfSnapshotId: UNKNOWN_SNAPSHOT_ID,
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: {
          warnings: [],
          unknownOkfSnapshotId: UNKNOWN_SNAPSHOT_ID,
          unknownSnapshotId: undefined,
        },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-unknown-okf'`,
              check: [
                `status = 'pending'`,
                'okf_snapshot_id IS NULL',
                'harness_snapshot_id IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      // The world's OKF snapshot (stored for the owner) is known: no unknownOkfSnapshotId.
      id: 'F15-upload-known-okf-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'ownerKey',
      query: {
        sessionId: 'w1-new-upload-known-okf',
        type: 'artisyn',
        okfSnapshotId: '@okfSnapshotId',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { unknownOkfSnapshotId: undefined },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-known-okf'`,
              check: [`status = 'pending'`, 'okf_snapshot_id IS NULL'],
            },
          ],
        },
      },
    },
    {
      // okfSnapshotFull=1: the queue row records the id (the in-flight "known" check), and
      // unknownOkfSnapshotId never comes back for a full upload.
      id: 'F15-upload-okf-snapshot-full',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-okf-full',
        type: 'artisyn',
        okfSnapshotId: UNKNOWN_SNAPSHOT_ID,
        okfSnapshotFull: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { warnings: [], unknownOkfSnapshotId: undefined },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-okf-full'`,
              check: [
                `status = 'pending'`,
                `okf_snapshot_id = '${UNKNOWN_SNAPSHOT_ID}'`,
              ],
            },
          ],
        },
      },
    },
    {
      // DD-18: an id that is not 64 lowercase hex is silently ignored — never a 400, never an
      // unknownOkfSnapshotId, nothing recorded, even with okfSnapshotFull=1.
      id: 'F15-upload-invalid-okf-snapshot',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-invalid-okf',
        type: 'artisyn',
        okfSnapshotId: 'NOT-A-SNAPSHOT-ID',
        okfSnapshotFull: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { warnings: [], unknownOkfSnapshotId: undefined },
      },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-invalid-okf'`,
              check: [`status = 'pending'`, 'okf_snapshot_id IS NULL'],
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
      // 2026-11-23 session-logs-streaming DD-27/DD-25: s05 was deleted (sessions.deleted and its
      // deleted_session_log row), so its owner's upload is answered `complete: true` with
      // nothing staged; with `uploadFeedback=1` the answer says `sessionDeleted: true` and
      // carries `failedUploads` (none: the owner's one failed row is no server failure).
      id: 'F15-upload-deleted-session-feedback',
      route: 'POST /api/v2/logs',
      actor: 'ownerKey',
      query: {
        sessionId: '@s05.sessionId',
        type: 'claude',
        uploadFeedback: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: {
          complete: true,
          sessionDeleted: true,
          failedUploads: [],
        },
      },
      noDb: true,
    },
    {
      // Without `uploadFeedback=1` (every hook before 3.2.0) the same answer carries neither
      // new field — the response stays what an old hook already parses.
      id: 'F15-upload-deleted-session-no-feedback',
      route: 'POST /api/v2/logs',
      actor: 'ownerKey',
      query: { sessionId: '@s05.sessionId', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: {
          complete: true,
          sessionDeleted: undefined,
          failedUploads: undefined,
        },
      },
      noDb: true,
    },
    {
      // A sub-agent of a deleted root is refused through its parent (DD-27's upward walk).
      id: 'F15-upload-deleted-parent',
      route: 'POST /api/v2/logs',
      actor: 'ownerKey',
      query: {
        sessionId: 'agent-w1-late-child',
        type: 'claude-subagent',
        parentSessionId: '@s05.sessionId',
        uploadFeedback: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: { complete: true, sessionDeleted: true },
      },
      noDb: true,
    },
    {
      // DD-24: a well-formed `contentSha256` (64 lowercase hex) is stored on the queue row; the
      // worker later compares it with the staged body.
      id: 'F15-upload-content-sha256',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-sha',
        type: 'claude',
        contentSha256: NDJSON_SHA256,
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201, bodyMatches: { warnings: [] } },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-upload-sha'`,
              check: [
                `status = 'pending'`,
                `content_sha256 = '${NDJSON_SHA256}'`,
                'failure_delivered = false',
              ],
            },
          ],
        },
      },
    },
    {
      // Anything else (here upper-case hex) is ignored, never a 400: the row is staged without it.
      id: 'F15-upload-content-sha256-malformed',
      route: 'POST /api/v2/logs',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-upload-sha-bad',
        type: 'claude',
        contentSha256: NDJSON_SHA256.toUpperCase(),
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
              where: `session_id = 'w1-new-upload-sha-bad'`,
              check: [`status = 'pending'`, 'content_sha256 IS NULL'],
            },
          ],
        },
      },
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
    // --- POST /api/v2/logs/append (2026-11-24-traffic-optimization DD-1): the delta of a
    // claude / claude-subagent log from 0-based line `startLine`. The contract is the same
    // enqueue as `POST /api/v2/logs`, plus `start_line` on the row; whether the delta fits the
    // stored log is decided later by the (parked) worker — @S-INGEST-02 / @S-INGEST-04.
    {
      id: 'F15-append',
      route: 'POST /api/v2/logs/append',
      actor: 'authorKey',
      query: {
        sessionId: 'w1-new-append',
        type: 'claude',
        startLine: '3',
        contentSha256: NDJSON_SHA256,
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201, bodyMatches: { warnings: [] } },
      write: {
        watch: ['upload_queue'],
        delta: {
          inserted: [
            {
              table: 'upload_queue',
              where: `session_id = 'w1-new-append'`,
              check: [
                `status = 'pending'`,
                `log_type = 'claude'`,
                'user_id = @author.id',
                'start_line = 3',
                `size_bytes = ${Buffer.byteLength(NDJSON)}`,
                `content_sha256 = '${NDJSON_SHA256}'`,
                'upload_id IS NULL',
                'error_message IS NULL',
              ],
            },
          ],
        },
      },
    },
    {
      // Same foreign-session answer as `POST /api/v2/logs`: a warning, nothing staged.
      id: 'F15-append-foreign-session',
      route: 'POST /api/v2/logs/append',
      actor: 'memberKey',
      query: { sessionId: '@s01.sessionId', type: 'claude', startLine: '0' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 201 },
      noDb: true,
    },
    {
      // Same deleted-session answer as `POST /api/v2/logs` (DD-27/DD-25).
      id: 'F15-append-deleted-session',
      route: 'POST /api/v2/logs/append',
      actor: 'ownerKey',
      query: {
        sessionId: '@s05.sessionId',
        type: 'claude',
        startLine: '0',
        uploadFeedback: '1',
      },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 201,
        bodyMatches: {
          complete: true,
          sessionDeleted: true,
          failedUploads: [],
        },
      },
      noDb: true,
    },
    {
      id: 'F15-append-missing-start-line',
      route: 'POST /api/v2/logs/append',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-append', type: 'claude' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 400,
        bodyMatches: { message: 'Missing startLine query parameter' },
      },
    },
    {
      id: 'F15-append-bad-start-line',
      route: 'POST /api/v2/logs/append',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-append', type: 'claude', startLine: '-1' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 400,
        bodyMatches: { message: 'startLine must be a non-negative integer' },
      },
    },
    {
      id: 'F15-append-non-claude-type',
      route: 'POST /api/v2/logs/append',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-append', type: 'artisyn', startLine: '0' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: {
        status: 400,
        bodyMatches: {
          message:
            'Append is supported only for claude and claude-subagent logs',
        },
      },
    },
    {
      id: 'F15-append-empty-body',
      route: 'POST /api/v2/logs/append',
      actor: 'authorKey',
      query: { sessionId: 'w1-new-append', type: 'claude', startLine: '0' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: '   ',
      expect: {
        status: 400,
        bodyMatches: { message: 'Request body must not be empty' },
      },
    },
    {
      id: 'F15-append-no-key',
      route: 'POST /api/v2/logs/append',
      actor: 'anon',
      query: { sessionId: 'w1-new-append', type: 'claude', startLine: '0' },
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: NDJSON,
      expect: { status: 401 },
    },
  ],
};
