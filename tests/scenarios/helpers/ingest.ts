/**
 * ingest.ts — raw log uploads and the DB rows they leave behind, for the S-INGEST scenarios.
 *
 * `POST /api/v2/logs` stages the body and queues it (`logs-v2.controller.ts`); the queue worker
 * parses it into one `logs` row per (session, type) whose `body` is the JSON array of lines
 * (`logs.service.ts` upsert). These helpers send exactly the bytes a scenario builds (plain,
 * gzip with or without `Content-Encoding`, chunks) and read the stored result through the `db`
 * fixture, whose search_path is the stand schema.
 */
import { gzipSync } from 'zlib';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import type { Pool } from 'pg';

export type LogParams = Record<string, string | number>;

/** NDJSON of `rows`, one JSON line each, trailing newline. */
export function ndjson(rows: readonly object[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

/**
 * `POST /api/v2/logs` with `params` as the query and `body` as the raw request body.
 * `Content-Type: application/x-ndjson` unless `headers` overrides it; `key` adds `X-API-Key`.
 */
export function postLogs(
  api: APIRequestContext,
  key: string | null,
  params: LogParams,
  body: string | Buffer,
  headers: Record<string, string> = {},
): Promise<APIResponse> {
  return api.post('/api/v2/logs', {
    params,
    headers: {
      'Content-Type': 'application/x-ndjson',
      ...(key ? { 'X-API-Key': key } : {}),
      ...headers,
    },
    data: body,
  });
}

export interface AppendUpload {
  /** `X-API-Key`; null sends none. */
  key: string | null;
  sessionId: string;
  type: string;
  /** 0-based record index the delta starts at; omitted = no `startLine` param (a 400 case). */
  startLine?: number | string;
  /** The delta: NDJSON text of the new lines. */
  body: string | Buffer;
  /** Gzip the body and send `Content-Encoding: gzip`, as the hook does for a big delta. */
  gzip?: boolean;
  /** sha256 hex of the (uncompressed) delta body. */
  contentSha256?: string;
  /** Extra query params (`uploadFeedback`, …). */
  params?: LogParams;
}

/**
 * `POST /api/v2/logs/append` (2026-11-24-traffic-optimization): stages a delta of a `claude` /
 * `claude-subagent` log that continues the stored log at record `startLine`. The worker applies
 * it as stored body + delta, or fails the row as `upload-full` when the stored log does not
 * have exactly `startLine` records.
 */
export function postLogsAppend(
  api: APIRequestContext,
  { key, sessionId, type, startLine, body, gzip = false, contentSha256, params = {} }: AppendUpload,
): Promise<APIResponse> {
  const query: LogParams = { sessionId, type, ...params };
  if (startLine !== undefined) query.startLine = startLine;
  if (contentSha256 !== undefined) query.contentSha256 = contentSha256;
  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return api.post('/api/v2/logs/append', {
    params: query,
    headers: {
      'Content-Type': 'application/x-ndjson',
      ...(key ? { 'X-API-Key': key } : {}),
      ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    },
    data: gzip ? gzipSync(raw) : raw,
  });
}

/** Number of `logs` rows of the string session id (any type). */
export async function logRowCount(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    'SELECT count(*) AS n FROM logs l JOIN sessions s ON s.id = l.session_id WHERE s.session_id = $1',
    [sessionId],
  );
  return Number(rows[0].n);
}

/** Number of `sessions` rows with the string session id (0 or 1). */
export async function sessionRowCount(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM sessions WHERE session_id = $1', [
    sessionId,
  ]);
  return Number(rows[0].n);
}

/** Number of `upload_queue` rows of the session (any status). */
export async function queueRowCount(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>('SELECT count(*) AS n FROM upload_queue WHERE session_id = $1', [
    sessionId,
  ]);
  return Number(rows[0].n);
}

/** The stored `logs.body` (array of lines) of one session and type, or null when there is no row. */
export async function storedBody(db: Pool, sessionId: string, logType: string): Promise<unknown[] | null> {
  const { rows } = await db.query<{ body: unknown[] }>(
    `SELECT l.body FROM logs l JOIN sessions s ON s.id = l.session_id
      WHERE s.session_id = $1 AND l.log_type = $2`,
    [sessionId, logType],
  );
  return rows[0]?.body ?? null;
}

/**
 * Holds the ingest lock of the session tree rooted at `rootSessionId` until the returned
 * function is called: the same transaction-scoped advisory lock `lockSessionTreeForIngest`
 * (`server/src/logs/session-tree.sql.ts`) takes, on a connection of its own. While it is held,
 * every ingest of that tree (the queue's `checkUnchanged` / `upsert`) and the re-extract drain
 * block on it — a scenario uses that to keep work queued deterministically. The release commits
 * the transaction and returns the connection; call it in a `finally`.
 */
export async function holdSessionTreeLock(db: Pool, rootSessionId: string): Promise<() => Promise<void>> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('session-tree:' || $1::varchar, 0))", [
      rootSessionId,
    ]);
  } catch (err) {
    client.release();
    throw err;
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  };
}

/** Outcomes of the session's upload-queue measurements (`success`, `skipped`, `superseded`, …), oldest first. */
export async function measurementOutcomes(db: Pool, sessionId: string): Promise<string[]> {
  const { rows } = await db.query<{ outcome: string }>(
    'SELECT outcome FROM upload_queue_measurements WHERE session_id = $1 ORDER BY id',
    [sessionId],
  );
  return rows.map((r) => r.outcome);
}

/**
 * `size_bytes` of the successful processing measurements of the session — the queue row's size,
 * i.e. what the server counted for the staged (decompressed) body.
 *
 * The scheduler records the measurement *after* it deletes the queue row, so a
 * `waitForQueueIdle` that just returned does not guarantee the row is there yet: read it
 * through `expect.poll`, never with a bare `await`.
 */
export async function processedSizes(db: Pool, sessionId: string): Promise<number[]> {
  const { rows } = await db.query<{ size_bytes: string }>(
    `SELECT size_bytes FROM upload_queue_measurements
      WHERE session_id = $1 AND outcome = 'success' ORDER BY id`,
    [sessionId],
  );
  return rows.map((r) => Number(r.size_bytes));
}
