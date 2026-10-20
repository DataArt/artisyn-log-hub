/**
 * db-seed.ts — direct writes into the stand's schema for state no public endpoint can produce
 * (impl-plan DD 1, "Attribution").
 *
 * The rule: seed through the public API wherever an endpoint exists (log upload, API keys,
 * `POST /api/v2/session-attribution`, settings, …) and come here only for what the API cannot
 * do — for example attribution values or runs with a chosen timestamp, an outcome the hook
 * never sends, or a row for a session that no API key of the scenario owns. Every helper runs
 * on the `db` fixture's pool, whose search_path is the stand's schema.
 */
import type { Pool, QueryResultRow } from 'pg';

export type SeedValue = string | number | boolean | Date | null | readonly unknown[] | Record<string, unknown>;
export type SeedRow = Record<string, SeedValue | undefined>;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`db-seed: "${name}" is not a plain snake_case identifier`);
  return `"${name}"`;
}

function toParam(value: SeedValue): unknown {
  if (value === null || value instanceof Date) return value;
  // jsonb columns take JSON text; arrays of scalars bound by pg as Postgres arrays would hit
  // jsonb columns as the wrong type, so objects and arrays are always sent as JSON.
  if (typeof value === 'object') return JSON.stringify(value);
  return value;
}

/**
 * Inserts one row into `table` (snake_case column names, `undefined` values skipped) and
 * returns it (`RETURNING *`). Table and column names are validated, values are bound.
 */
export async function insertRow<T extends QueryResultRow = QueryResultRow>(db: Pool, table: string, row: SeedRow): Promise<T> {
  const entries = Object.entries(row).filter((e): e is [string, SeedValue] => e[1] !== undefined);
  if (entries.length === 0) throw new Error(`db-seed: empty row for ${table}`);
  const columns = entries.map(([k]) => ident(k)).join(', ');
  const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
  const { rows } = await db.query<T>(
    `INSERT INTO ${ident(table)} (${columns}) VALUES (${placeholders}) RETURNING *`,
    entries.map(([, v]) => toParam(v)),
  );
  return rows[0];
}

/** `sessions.id` of a session by its string id; throws when the session was not ingested. */
export async function sessionRowId(db: Pool, sessionId: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>('SELECT id FROM sessions WHERE session_id = $1', [sessionId]);
  if (rows.length === 0) throw new Error(`db-seed: no session "${sessionId}" in the stand schema`);
  return rows[0].id;
}

export type AttributionValues = Record<string, string | string[] | boolean | number | null>;

export interface SeedAttributionInput {
  /** String session id (`sessions.session_id`). */
  sessionId: string;
  values: AttributionValues;
  promptWatermark?: number;
  updatedAt?: Date;
}

/**
 * Writes the session's current attribution values (`session_attribution`), replacing any
 * existing row unconditionally — unlike the API's conditional upsert, the watermark does not
 * have to grow.
 */
export async function seedSessionAttribution(db: Pool, input: SeedAttributionInput): Promise<void> {
  const id = await sessionRowId(db, input.sessionId);
  await db.query(
    `INSERT INTO session_attribution (session_id, prompt_watermark, values, updated_at)
     VALUES ($1, $2, $3::jsonb, coalesce($4, now()))
     ON CONFLICT (session_id) DO UPDATE
       SET prompt_watermark = excluded.prompt_watermark,
           values = excluded.values,
           updated_at = excluded.updated_at`,
    [id, input.promptWatermark ?? 1, JSON.stringify(input.values), input.updatedAt ?? null],
  );
}

export interface SeedAttributionRunInput {
  sessionId: string;
  outcome: 'applied' | 'ignored_stale' | 'failed';
  promptWatermark?: number;
  startedAt?: Date;
  finishedAt?: Date;
  failureReason?: string | null;
  evalSessionId?: string | null;
  invokingSessionId?: string | null;
  model?: string | null;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** Appends one `session_attribution_runs` row and returns its id. */
export async function seedSessionAttributionRun(db: Pool, input: SeedAttributionRunInput): Promise<number> {
  const startedAt = input.startedAt ?? new Date();
  const row = await insertRow<{ id: number }>(db, 'session_attribution_runs', {
    session_id: await sessionRowId(db, input.sessionId),
    prompt_watermark: input.promptWatermark ?? 1,
    eval_session_id: input.evalSessionId ?? null,
    invoking_session_id: input.invokingSessionId ?? null,
    started_at: startedAt,
    finished_at: input.finishedAt ?? startedAt,
    outcome: input.outcome,
    failure_reason: input.failureReason ?? null,
    model: input.model ?? null,
    cost_usd: input.costUsd != null ? input.costUsd.toFixed(6) : null,
    input_tokens: input.inputTokens ?? 0,
    output_tokens: input.outputTokens ?? 0,
    cache_read_tokens: input.cacheReadTokens ?? 0,
    cache_write_tokens: input.cacheWriteTokens ?? 0,
  });
  return row.id;
}
