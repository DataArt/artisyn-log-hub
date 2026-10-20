/**
 * ingest.ts — raw log uploads and the DB rows they leave behind, for the S-INGEST scenarios.
 *
 * `POST /api/v2/logs` stages the body and queues it (`logs-v2.controller.ts`); the queue worker
 * parses it into one `logs` row per (session, type) whose `body` is the JSON array of lines
 * (`logs.service.ts` upsert). These helpers send exactly the bytes a scenario builds (plain,
 * gzip with or without `Content-Encoding`, chunks) and read the stored result through the `db`
 * fixture, whose search_path is the stand schema.
 */
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
