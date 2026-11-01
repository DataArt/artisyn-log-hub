/**
 * otel.ts — driving and reading the OTEL tabs (task 2026-10-30-otel-tabs-traces) for S-OTEL-01
 * and the OTEL steps of S-COMPAT-01 / S-SLIFE-08.
 *
 *  - writes go the way the hook sends them: the regular chunk upload (`POST /api/v2/logs`,
 *    `type=claude-otel`, through the upload queue) and the realtime batch
 *    (`POST /api/v2/otel-realtime`, synchronous), both with `X-API-Key`;
 *  - a chunk is projected into the OTEL tables by the server's background drain (every 5 s);
 *    {@link waitForOtelProjected} waits until no chunk of the session is pending and no
 *    reclassification is queued;
 *  - reads use the UI routes with the user's cookie: repository facts, session snapshot / delta,
 *    team facts.
 */
import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import type { Pool } from 'pg';
import type { ScenarioUser } from '../fixtures';
import { chunkBody, transcriptBodies, type OtelLine, type TranscriptSpec } from '../fixtures/otel/otel-lines';
import { waitForQueueIdle } from './queue';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Uploads one `claude-otel` chunk (one receiver chunk file) and waits for the upload queue. */
export async function uploadOtelChunk(
  api: APIRequestContext,
  apiKey: string,
  sessionId: string,
  lines: readonly OtelLine[],
  queue: { db: Pool; userId: number },
): Promise<void> {
  const res = await api.post('/api/v2/logs', {
    params: { sessionId, type: 'claude-otel' },
    headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
    data: chunkBody(lines),
  });
  expect(res.status(), `claude-otel chunk of ${sessionId}: ${await res.text()}`).toBe(201);
  await waitForQueueIdle(queue.db, queue.userId);
}

/** Uploads the artisyn and the claude log of a transcript spec (or only one of them). */
export async function uploadTranscript(
  api: APIRequestContext,
  apiKey: string,
  spec: TranscriptSpec,
  queue: { db: Pool; userId: number },
  only?: 'artisyn' | 'claude',
): Promise<void> {
  const bodies = transcriptBodies(spec);
  const types = (only ? [only] : ['artisyn', 'claude']) as Array<'artisyn' | 'claude'>;
  for (const type of types) {
    const res = await api.post('/api/v2/logs', {
      params: { sessionId: spec.sessionId, type },
      headers: { 'Content-Type': 'application/x-ndjson', 'X-API-Key': apiKey },
      data: bodies[type],
    });
    expect(res.status(), `${type} log of ${spec.sessionId}: ${await res.text()}`).toBe(201);
  }
  await waitForQueueIdle(queue.db, queue.userId);
}

export interface RealtimeBatch {
  sessionId: string;
  receiverId: string;
  batchSeq: number;
  droppedLines?: number;
  lines: readonly OtelLine[];
  hookVersion?: string;
}

/** One realtime batch, as the 2.29.0 receiver sends it; returns the raw response. */
export function postRealtime(api: APIRequestContext, apiKey: string | null, batch: RealtimeBatch): Promise<APIResponse> {
  return api.post('/api/v2/otel-realtime', {
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
    data: {
      sessionId: batch.sessionId,
      hookVersion: batch.hookVersion ?? '2.29.0',
      receiverId: batch.receiverId,
      batchSeq: batch.batchSeq,
      droppedLines: batch.droppedLines ?? 0,
      lines: batch.lines,
    },
  });
}

/** {@link postRealtime} that must answer 200; returns the body. */
export async function sendRealtime(
  api: APIRequestContext,
  apiKey: string,
  batch: RealtimeBatch,
): Promise<{ accepted: { calls: number; spans: number }; cursor: string; minIntervalMs: number; ignored?: string }> {
  const res = await postRealtime(api, apiKey, batch);
  expect(res.status(), `realtime batch ${batch.batchSeq} of ${batch.sessionId}: ${await res.text()}`).toBe(200);
  return (await res.json()) as { accepted: { calls: number; spans: number }; cursor: string; minIntervalMs: number; ignored?: string };
}

/**
 * Waits until every `logs_otel` chunk of the session is projected (the drain ticks every 5 s)
 * and no reclassification of the session is queued.
 */
export async function waitForOtelProjected(db: Pool, sessionId: string, timeoutMs = 30_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const { rows } = await db.query<{ pending: string; queued: string }>(
          `SELECT (SELECT count(*) FROM logs_otel lo WHERE lo.session_id = s.id AND lo.otel_projection_version IS NULL) AS pending,
                  (SELECT count(*) FROM otel_reclass_queue q WHERE q.session_id = s.id) AS queued
             FROM sessions s WHERE s.session_id = $1`,
          [sessionId],
        );
        if (rows.length === 0) return 'no session';
        return `${rows[0].pending}/${rows[0].queued}`;
      },
      { timeout: timeoutMs, message: `OTEL projection of ${sessionId}` },
    )
    .toBe('0/0');
}

/**
 * Puts a session back into the state of data uploaded before the OTEL tables existed (or while
 * the server was an older build): its OTEL fact rows are gone and every chunk is unprojected —
 * exactly what migration 0078 leaves behind. The drain then rebuilds it.
 */
export async function resetOtelProjection(db: Pool, sessionId: string): Promise<void> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM sessions WHERE session_id = $1', [sessionId]);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`resetOtelProjection: no session ${sessionId}`);
  for (const table of ['otel_session_state', 'otel_calls', 'otel_spans', 'otel_cost_buckets', 'otel_reclass_queue']) {
    await db.query(`DELETE FROM ${table} WHERE session_id = $1`, [id]);
  }
  await db.query('UPDATE logs_otel SET otel_projection_version = NULL WHERE session_id = $1', [id]);
}

/** Row counts of the session's OTEL fact tables. */
export async function otelRowCounts(db: Pool, sessionId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of ['otel_session_state', 'otel_calls', 'otel_spans', 'otel_cost_buckets', 'logs_otel']) {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM ${table} t JOIN sessions s ON s.id = t.session_id WHERE s.session_id = $1`,
      [sessionId],
    );
    out[table] = Number(rows[0].n);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Read routes (types: server/src/logs/otel/otel-facts.types.ts)
// ---------------------------------------------------------------------------------------------

export interface OtelBucket {
  start: string;
  key: string;
  calls: number;
  costUsdMicros: string;
  tokens: string;
  changeKind: string;
}

export interface OtelKpis {
  totalCostUsdMicros: string;
  apiCalls: number;
  hiddenCostUsdMicros: string;
  hiddenCalls: number;
  hiddenShare: number;
  sessions: number;
  users: number;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  perActivePersonCostUsdMicros?: string | null;
  repositories?: number;
}

export interface OtelFlowRow {
  model: string | null;
  userEmail: string | null;
  branch: string | null;
  repository: string | null;
  other: boolean;
  costUsdMicros: string;
}

export interface OtelQuerySourceRow {
  querySource: string;
  known: boolean;
  hidden: boolean;
  calls: number;
  costUsdMicros: string;
}

export interface RepoFacts {
  interval: string;
  hasOtel: boolean;
  hasOtelInPeriod: boolean;
  slowUpdates: boolean;
  hookVersion: string | null;
  realtime: { unconfirmedCalls: number; realtimeSessions: number; chunkDelayedSessions: number; gapSessions: number };
  buckets: OtelBucket[];
  kpis: OtelKpis;
  kpisPrev: OtelKpis | null;
  flows: OtelFlowRow[];
  querySources: OtelQuerySourceRow[];
  sessions: Array<{ sessionId: string; costUsdMicros: string; unconfirmedCalls: number; hasTraces: boolean }>;
  /** OTEL coverage of the scope (2026-10-30 otel-shared-receiver, DD-29). */
  coverage: OtelCoverage;
}

/** `coverage` of the repository and team facts routes (DD-29). */
export interface OtelCoverage {
  otelSessions: number;
  totalSessions: number;
  otelUsers: number;
  reasons: Array<{ reason: string; count: number }>;
}

/** `status.otelStatus` of the session OTEL route: the root's latest `otel-status` event (DD-28). */
export interface OtelStatusDto {
  state: string;
  reason: string | null;
  detail: string | null;
  received: { logs: number; metrics: number; spans: number; firstAt: string | null };
  claudeVersion: string | null;
  hookVersion: string | null;
  receiverVersion: string | null;
  forward: string | null;
}

export interface TeamFacts extends Omit<RepoFacts, 'sessions'> {
  filterOptions: { people: Array<{ userId: number; email: string }>; repositories: Array<{ repoId: number; repoUrl: string }> };
  people: Array<{ userId: number; email: string; costUsdMicros: string; sessions: number }>;
  repositories: Array<{ repoId: number; repoUrl: string; costUsdMicros: string; sessions: number; people: number }>;
}

export interface OtelCallRow {
  callKey: string;
  requestId: string | null;
  querySource: string | null;
  structure: 'main' | 'subagent' | 'hidden';
  provisional: boolean;
  confirmed: boolean;
  costUsdMicros: string | null;
  changeKind: string;
}

export interface OtelSpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  endTime: string | null;
  requestId: string | null;
  costUsdMicros: string | null;
  rollupCostUsdMicros: string | null;
  hidden: boolean | null;
  confirmed: boolean;
  changeKind: string;
}

export interface SessionOtel {
  cursor: string;
  full: boolean;
  status: {
    hasOtel: boolean;
    hasSpans: boolean;
    live: boolean;
    slowUpdates: boolean;
    slowReason: string | null;
    otelHookVersion: string | null;
    realtime: { active: boolean; unconfirmedCalls: number; unconfirmedSpans: number; gap: boolean; chunkDelayed: boolean };
    otelStatus: OtelStatusDto | null;
    costExcludesUtilityCalls: boolean;
  };
  buckets: OtelBucket[];
  calls: OtelCallRow[];
  spans: OtelSpanRow[];
  kpis: { totalCostUsdMicros: string; hiddenCostUsdMicros: string; hiddenCalls: number; apiCalls: number } | null;
}

/** `from`/`to` of the last `days` days, ending a minute from now (the 7-day preset by default). */
export function lastDays(days = 7): { from: string; to: string } {
  const to = new Date(Date.now() + 60_000);
  return { from: new Date(to.getTime() - days * DAY_MS).toISOString(), to: to.toISOString() };
}

type Query = Record<string, string | number | string[] | undefined>;

function toSearch(q: Query): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) for (const x of v) p.append(k, x);
    else p.set(k, String(v));
  }
  return p.toString();
}

/** `GET /api/v1/repositories/:repoId/otel/facts` → its JSON (200 expected). */
export async function repoFacts(user: ScenarioUser, repoId: number, q: Query = {}): Promise<RepoFacts> {
  const res = await user.api.get(`/api/v1/repositories/${repoId}/otel/facts?${toSearch({ ...lastDays(), tz: 'UTC', ...q })}`);
  expect(res.status(), `repository ${repoId} OTEL facts: ${await res.text()}`).toBe(200);
  return (await res.json()) as RepoFacts;
}

/** The status of the repository facts route for `user` (access checks). */
export async function repoFactsStatus(user: ScenarioUser, repoId: number, q: Query = {}): Promise<number> {
  return (await user.api.get(`/api/v1/repositories/${repoId}/otel/facts?${toSearch({ ...lastDays(), ...q })}`)).status();
}

/** `GET /api/v1/repositories/:repoId/sessions/:sid/otel` (snapshot, or a delta with `since`). */
export async function sessionOtel(user: ScenarioUser, repoId: number, sessionId: string, q: Query = {}): Promise<SessionOtel> {
  const res = await user.api.get(`/api/v1/repositories/${repoId}/sessions/${encodeURIComponent(sessionId)}/otel?${toSearch({ tz: 'UTC', ...q })}`);
  expect(res.status(), `session ${sessionId} OTEL: ${await res.text()}`).toBe(200);
  return (await res.json()) as SessionOtel;
}

/** `GET /api/v1/teams/:teamId/otel/facts` → its JSON (200 expected). */
export async function teamFacts(user: ScenarioUser, teamId: number, q: Query = {}): Promise<TeamFacts> {
  const res = await user.api.get(`/api/v1/teams/${teamId}/otel/facts?${toSearch({ ...lastDays(), tz: 'UTC', ...q })}`);
  expect(res.status(), `team ${teamId} OTEL facts: ${await res.text()}`).toBe(200);
  return (await res.json()) as TeamFacts;
}

/** The status of the team facts route for `user`. */
export async function teamFactsStatus(user: ScenarioUser, teamId: number): Promise<number> {
  return (await user.api.get(`/api/v1/teams/${teamId}/otel/facts?${toSearch(lastDays())}`)).status();
}

/** Σ `costUsdMicros` of rows. */
export function sumMicros(rows: ReadonlyArray<{ costUsdMicros: string | null }>): number {
  return rows.reduce((n, r) => n + Number(r.costUsdMicros ?? 0), 0);
}

/** `12500` → `$0.0125` / `30000` → `$0.03` — the OTEL tabs' money format (`otel-format.ts`). */
export function otelUsd(microsValue: number): string {
  const usd = microsValue / 1_000_000;
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
