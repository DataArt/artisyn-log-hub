/**
 * OTEL facts writer (2026-10-30 otel-tabs-traces) — the only code that writes `otel_calls`,
 * `otel_spans`, `otel_cost_buckets`, `otel_session_state` and `otel_reclass_queue` rows
 * (`sessions.service.ts` purges them). Used by the realtime ingest route, the projection drain
 * and the reclassification queue.
 *
 * Lock order (DD-2), the same for every writer: (realtime only) the advisory lock
 * `session-owner:<sessionId>` → `otel_session_state` `FOR UPDATE` ({@link lockOtelState}) → a
 * plain read of `sessions.deleted`. Writers never lock `sessions` or `logs_otel` rows. Every
 * write stamps the state's next `seq` on each row it inserts or changes; a write that changes
 * nothing leaves `seq` alone.
 *
 * Every function takes the caller's transaction handle and must run inside the transaction that
 * holds the state lock.
 */
import { sql, type SQL } from 'drizzle-orm';
import { maxVersion } from '../../common/semver';
import type { DrizzleDb } from '../../database/database.module';
import { descendantSessionsCte, topAncestorIdsSql } from '../session-tree.sql';
import {
  bucketStart5m,
  classifyOtelCall,
  isOtelCallProvisional,
} from './otel-classify';
import type { OtelChangeKind, OtelStructure } from './otel-facts.types';
import {
  extractOtelCalls,
  extractOtelSpans,
  maxHookVersion,
  type ExtractedOtelCall,
  type ExtractedOtelSpan,
} from './otel-records';
import { OTEL_SPAN_LLM_REQUEST } from './otel-span-names';

/** Which channel a write comes from. */
export type OtelSource = 'realtime' | 'chunk';

/** `source_mask` bit of a row seen on the realtime channel (DD-14). */
export const OTEL_SOURCE_REALTIME_BIT = 1;

/** `source_mask` bit of a row seen in a projected chunk (DD-14). */
export const OTEL_SOURCE_CHUNK_BIT = 2;

/** Depth cap of the span rollup walk; a cyclic parent chain stops here. */
const ROLLUP_MAX_DEPTH = 64;

function sourceBit(source: OtelSource): number {
  return source === 'realtime'
    ? OTEL_SOURCE_REALTIME_BIT
    : OTEL_SOURCE_CHUNK_BIT;
}

/**
 * Thrown by {@link lockOtelState} when the root session is soft-deleted (DD-2, DD-25): throwing
 * inside the transaction callback rolls the transaction back, so a deleted session never regrows
 * OTEL rows. Callers catch it outside the transaction (realtime → `ignored: 'deleted'`,
 * projection → the claimed rows are skipped).
 */
export class OtelSessionDeletedError extends Error {
  constructor(readonly rootId: number) {
    super(`OTEL write refused: session ${rootId} is deleted`);
    this.name = 'OtelSessionDeletedError';
  }
}

/** One `otel_session_state` row. */
export interface OtelSessionState {
  sessionId: number;
  userId: number | null;
  seq: number;
  transcriptSeq: number | null;
  otelHookVersion: string | null;
  hasSpans: boolean;
  hasProvisional: boolean;
  rtLastAt: Date | null;
  chunkLastAt: Date | null;
  rtGapAt: Date | null;
  rtReceiverId: string | null;
  rtBatchSeq: number | null;
  createdAt: Date;
}

/** The state lock of one root (DD-2). */
export interface OtelStateLock {
  /** The locked row as read under the lock; `seq` follows {@link nextSeq}. */
  state: OtelSessionState;
  /**
   * The seq this transaction stamps on its rows: the first call bumps `otel_session_state.seq`
   * by one and returns it; later calls in the same transaction return the same value.
   */
  nextSeq(): Promise<number>;
}

type DbNumber = number | string | null;

interface StateDbRow {
  session_id: number | string;
  user_id: DbNumber;
  seq: number | string;
  transcript_seq: DbNumber;
  otel_hook_version: string | null;
  has_spans: boolean;
  has_provisional: boolean;
  rt_last_at: Date | string | null;
  chunk_last_at: Date | string | null;
  rt_gap_at: Date | string | null;
  rt_receiver_id: string | null;
  rt_batch_seq: DbNumber;
  created_at: Date | string;
}

function numOrNull(value: DbNumber): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function dateOrNull(value: Date | string | null): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function toState(row: StateDbRow): OtelSessionState {
  return {
    sessionId: Number(row.session_id),
    userId: numOrNull(row.user_id),
    seq: Number(row.seq),
    transcriptSeq: numOrNull(row.transcript_seq),
    otelHookVersion: row.otel_hook_version,
    hasSpans: row.has_spans,
    hasProvisional: row.has_provisional,
    rtLastAt: dateOrNull(row.rt_last_at),
    chunkLastAt: dateOrNull(row.chunk_last_at),
    rtGapAt: dateOrNull(row.rt_gap_at),
    rtReceiverId: row.rt_receiver_id,
    rtBatchSeq: numOrNull(row.rt_batch_seq),
    createdAt: dateOrNull(row.created_at) ?? new Date(0),
  };
}

/**
 * JSON text for a `jsonb` bind parameter. NUL characters are dropped from every string, since
 * Postgres `jsonb` / `text` reject `\u0000`; BigInts travel as decimal strings.
 */
function jsonParam(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === 'string') return v.split('\u0000').join('');
    if (typeof v === 'bigint') return v.toString();
    return v;
  });
}

/** A `jsonb` array of strings for `jsonb_array_elements_text`. */
function textArrayJson(values: readonly string[]): SQL {
  return sql`${jsonParam(values)}::jsonb`;
}

async function selectStateForUpdate(
  tx: DrizzleDb,
  rootId: number,
): Promise<OtelSessionState | null> {
  const result = await tx.execute(sql`
    SELECT session_id, user_id, seq, transcript_seq, otel_hook_version, has_spans,
           has_provisional, rt_last_at, chunk_last_at, rt_gap_at, rt_receiver_id,
           rt_batch_seq, created_at
      FROM otel_session_state
     WHERE session_id = ${rootId}
       FOR UPDATE
  `);
  const row = (result.rows as unknown as StateDbRow[])[0];
  return row ? toState(row) : null;
}

/**
 * Takes the OTEL state lock of a root session (DD-2 step 2 and 3).
 *
 * - `create: true` (realtime and projection only) first inserts the state row with
 *   `INSERT … ON CONFLICT DO NOTHING`, with `user_id` = `userId`; `create: false` never creates
 *   one, so a root without OTEL data keeps `hasOtel=false`.
 * - Then locks the row `FOR UPDATE` and returns `null` when there is none.
 * - Then reads `sessions.deleted` without a row lock and throws {@link OtelSessionDeletedError}
 *   (which rolls the transaction back) when it is true.
 */
export async function lockOtelState(
  tx: DrizzleDb,
  rootId: number,
  options: { create: boolean; userId?: number | null },
): Promise<OtelStateLock | null> {
  if (options.create) {
    await tx.execute(sql`
      INSERT INTO otel_session_state (session_id, user_id)
      VALUES (${rootId}, ${options.userId ?? null})
      ON CONFLICT (session_id) DO NOTHING
    `);
  }
  const state = await selectStateForUpdate(tx, rootId);
  if (!state) return null;

  const deleted = await tx.execute(sql`
    SELECT deleted FROM sessions WHERE id = ${rootId}
  `);
  const sessionRow = (deleted.rows as unknown as { deleted: boolean }[])[0];
  if (!sessionRow || sessionRow.deleted) {
    throw new OtelSessionDeletedError(rootId);
  }

  let reserved: number | null = null;
  return {
    state,
    async nextSeq(): Promise<number> {
      if (reserved !== null) return reserved;
      const bumped = await tx.execute(sql`
        UPDATE otel_session_state SET seq = seq + 1
         WHERE session_id = ${rootId}
        RETURNING seq
      `);
      const row = (bumped.rows as unknown as { seq: number | string }[])[0];
      reserved = Number(row.seq);
      state.seq = reserved;
      return reserved;
    },
  };
}

// ---------------------------------------------------------------------------
// Tree membership (DD-4 inputs)
// ---------------------------------------------------------------------------

interface TreeMembership {
  /** The tree has any `session_request_ids` row. */
  treeHasRequestIds: boolean;
  /** Request id → it is found only in sub-agent (non-root) transcripts of the tree. */
  inTree: Map<string, { inSubagentTranscript: boolean }>;
}

/**
 * Which of `requestIds` the root's session tree records in `session_request_ids`, and whether
 * the tree records any request id at all.
 */
async function loadTreeMembership(
  tx: DrizzleDb,
  rootId: number,
  requestIds: readonly string[],
): Promise<TreeMembership> {
  const rootArray = sql`${`{${Math.trunc(rootId)}}`}::bigint[]`;
  const result = await tx.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(rootArray)},
    wanted AS (
      SELECT DISTINCT jsonb_array_elements_text(${textArrayJson(requestIds)}) AS request_id
    )
    SELECT sri.request_id,
           NOT BOOL_OR(d.depth = 0) AS in_subagent,
           NULL::boolean AS tree_has
      FROM descendant_sessions d
      JOIN session_request_ids sri ON sri.session_id = d.id
      JOIN wanted w ON w.request_id = sri.request_id
     GROUP BY sri.request_id
    UNION ALL
    SELECT NULL, NULL, EXISTS (
      SELECT 1 FROM descendant_sessions d
        JOIN session_request_ids sri ON sri.session_id = d.id
    )
  `);
  const membership: TreeMembership = {
    treeHasRequestIds: false,
    inTree: new Map(),
  };
  for (const row of result.rows as unknown as {
    request_id: string | null;
    in_subagent: boolean | null;
    tree_has: boolean | null;
  }[]) {
    if (row.request_id === null) {
      membership.treeHasRequestIds = row.tree_has === true;
    } else {
      membership.inTree.set(row.request_id, {
        inSubagentTranscript: row.in_subagent === true,
      });
    }
  }
  return membership;
}

function structureOf(
  membership: TreeMembership,
  requestId: string | null,
  querySource: string | null,
  provisional: boolean,
): OtelStructure {
  const hit = requestId === null ? undefined : membership.inTree.get(requestId);
  return classifyOtelCall({
    inTree: hit !== undefined,
    inSubagentTranscript: hit?.inSubagentTranscript ?? false,
    querySource,
    treeHasRequestIds: membership.treeHasRequestIds,
    provisional,
  });
}

// ---------------------------------------------------------------------------
// Calls + bucket deltas (DD-3, DD-4, DD-7)
// ---------------------------------------------------------------------------

/** Highlight precedence when several changes land in one bucket key (strongest first). */
const KIND_RANK: Record<OtelChangeKind, number> = {
  update: 5,
  new: 4,
  fill: 3,
  reclass: 2,
  confirm: 1,
};

function strongerKind(a: OtelChangeKind, b: OtelChangeKind): OtelChangeKind {
  return KIND_RANK[a] >= KIND_RANK[b] ? a : b;
}

interface OldCallRow {
  call_key: string;
  request_id: string | null;
  query_source: string | null;
  model: string | null;
  claude_code_version: string | null;
  prompt_id: string | null;
  agent_id: string | null;
  event_time: Date | string;
  input_tokens: number | string;
  output_tokens: number | string;
  cache_read_tokens: number | string;
  cache_write_tokens: number | string;
  cost_usd_micros: number | string | null;
  structure: OtelStructure;
  provisional: boolean;
  source_mask: number;
  first_seq: number | string;
}

/** The values one call contributes to its bucket. */
interface CallContribution {
  bucketStart: Date;
  structure: OtelStructure;
  querySource: string;
  model: string;
  ccVersion: string;
  cost: bigint;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

interface BucketDelta {
  bucketStart: Date;
  structure: OtelStructure;
  querySource: string;
  model: string;
  ccVersion: string;
  calls: number;
  cost: bigint;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  kind: OtelChangeKind;
}

function bucketKey(c: CallContribution): string {
  return [
    c.bucketStart.toISOString(),
    c.structure,
    c.querySource,
    c.model,
    c.ccVersion,
  ].join('\u0000');
}

function addContribution(
  deltas: Map<string, BucketDelta>,
  c: CallContribution,
  sign: 1 | -1,
  kind: OtelChangeKind,
): void {
  const key = bucketKey(c);
  let delta = deltas.get(key);
  if (!delta) {
    delta = {
      bucketStart: c.bucketStart,
      structure: c.structure,
      querySource: c.querySource,
      model: c.model,
      ccVersion: c.ccVersion,
      calls: 0,
      cost: 0n,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      kind,
    };
    deltas.set(key, delta);
  }
  delta.calls += sign;
  delta.cost += sign === 1 ? c.cost : -c.cost;
  delta.inputTokens += sign * c.inputTokens;
  delta.outputTokens += sign * c.outputTokens;
  delta.cacheReadTokens += sign * c.cacheReadTokens;
  delta.cacheWriteTokens += sign * c.cacheWriteTokens;
  delta.kind = strongerKind(delta.kind, kind);
}

function isZeroDelta(d: BucketDelta): boolean {
  return (
    d.calls === 0 &&
    d.cost === 0n &&
    d.inputTokens === 0 &&
    d.outputTokens === 0 &&
    d.cacheReadTokens === 0 &&
    d.cacheWriteTokens === 0
  );
}

function contributionOfOld(row: OldCallRow): CallContribution {
  return {
    bucketStart: bucketStart5m(dateOrNull(row.event_time) ?? new Date(0)),
    structure: row.structure,
    querySource: row.query_source ?? '',
    model: row.model ?? '',
    ccVersion: row.claude_code_version ?? '',
    cost: row.cost_usd_micros === null ? 0n : BigInt(row.cost_usd_micros),
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
  };
}

function contributionOfNew(
  call: ExtractedOtelCall,
  structure: OtelStructure,
): CallContribution {
  return {
    bucketStart: bucketStart5m(call.eventTime),
    structure,
    querySource: call.querySource ?? '',
    model: call.model ?? '',
    ccVersion: call.claudeCodeVersion ?? '',
    cost: call.costUsdMicros ?? 0n,
    inputTokens: call.inputTokens,
    outputTokens: call.outputTokens,
    cacheReadTokens: call.cacheReadTokens,
    cacheWriteTokens: call.cacheWriteTokens,
  };
}

/** The call's data fields differ from the stored row (structure and mask aside). */
function callDataChanged(old: OldCallRow, call: ExtractedOtelCall): boolean {
  const oldCost =
    old.cost_usd_micros === null ? null : BigInt(old.cost_usd_micros);
  const oldTime = dateOrNull(old.event_time)?.getTime() ?? NaN;
  return (
    old.request_id !== call.requestId ||
    old.query_source !== call.querySource ||
    old.model !== call.model ||
    old.claude_code_version !== call.claudeCodeVersion ||
    old.prompt_id !== call.promptId ||
    old.agent_id !== call.agentId ||
    oldTime !== call.eventTime.getTime() ||
    Number(old.input_tokens) !== call.inputTokens ||
    Number(old.output_tokens) !== call.outputTokens ||
    Number(old.cache_read_tokens) !== call.cacheReadTokens ||
    Number(old.cache_write_tokens) !== call.cacheWriteTokens ||
    oldCost !== call.costUsdMicros
  );
}

/** Kind of a row first inserted by `source` (DD-3): a chunk into a realtime session is `fill`. */
function insertKind(
  source: OtelSource,
  sessionHasRealtime: boolean,
): OtelChangeKind {
  return source === 'chunk' && sessionHasRealtime ? 'fill' : 'new';
}

/**
 * Applies additive bucket deltas (DD-7): each non-zero delta is added to its key with this
 * write's `seq` and the strongest contributing kind. A zero delta writes nothing.
 */
async function applyBucketDeltas(
  tx: DrizzleDb,
  rootId: number,
  deltas: Iterable<BucketDelta>,
  seq: number,
): Promise<number> {
  const rows = [...deltas]
    .filter((d) => !isZeroDelta(d))
    .map((d) => ({
      bucket_start: d.bucketStart.toISOString(),
      structure: d.structure,
      query_source: d.querySource,
      model: d.model,
      cc_version: d.ccVersion,
      calls: d.calls,
      cost_usd_micros: d.cost,
      input_tokens: d.inputTokens,
      output_tokens: d.outputTokens,
      cache_read_tokens: d.cacheReadTokens,
      cache_write_tokens: d.cacheWriteTokens,
      change_kind: d.kind,
    }));
  if (rows.length === 0) return 0;
  const result = await tx.execute(sql`
    INSERT INTO otel_cost_buckets (
      session_id, user_id, bucket_start, structure, query_source, model, cc_version,
      calls, cost_usd_micros, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, seq, change_kind
    )
    SELECT ${rootId},
           (SELECT user_id FROM otel_session_state WHERE session_id = ${rootId}),
           r.bucket_start, r.structure, r.query_source, r.model, r.cc_version,
           r.calls, r.cost_usd_micros, r.input_tokens, r.output_tokens,
           r.cache_read_tokens, r.cache_write_tokens, ${seq}, r.change_kind
      FROM jsonb_to_recordset(${jsonParam(rows)}::jsonb) AS r(
             bucket_start timestamptz, structure text, query_source text, model text,
             cc_version text, calls integer, cost_usd_micros bigint, input_tokens bigint,
             output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
             change_kind text)
    ON CONFLICT ON CONSTRAINT otel_cost_buckets_pk DO UPDATE SET
      user_id = COALESCE(otel_cost_buckets.user_id, EXCLUDED.user_id),
      calls = otel_cost_buckets.calls + EXCLUDED.calls,
      cost_usd_micros = otel_cost_buckets.cost_usd_micros + EXCLUDED.cost_usd_micros,
      input_tokens = otel_cost_buckets.input_tokens + EXCLUDED.input_tokens,
      output_tokens = otel_cost_buckets.output_tokens + EXCLUDED.output_tokens,
      cache_read_tokens = otel_cost_buckets.cache_read_tokens + EXCLUDED.cache_read_tokens,
      cache_write_tokens = otel_cost_buckets.cache_write_tokens + EXCLUDED.cache_write_tokens,
      seq = EXCLUDED.seq,
      change_kind = EXCLUDED.change_kind
  `);
  return result.rowCount ?? rows.length;
}

/** Outcome of {@link upsertOtelCalls}. */
export interface OtelCallsUpsertResult {
  /** `otel_calls` rows inserted or changed (stamped with `seq`). */
  changed: number;
  /** `otel_cost_buckets` rows written. */
  bucketsChanged: number;
  /** Any written call is provisional (feeds `has_provisional`). */
  anyProvisional: boolean;
}

/**
 * Upserts extracted calls into `otel_calls` (DD-3, DD-4, DD-7):
 * - reads the existing rows of the batch's keys `FOR UPDATE`;
 * - ORs the source bit into `source_mask`; `first_seq` is set on insert only;
 * - classifies `structure` with {@link classifyOtelCall} (`provisional` from `first_seq` vs the
 *   state's `transcript_seq`);
 * - `change_kind`: insert → `new`, or `fill` for a chunk into a session with realtime data; a
 *   changed value → `update`; only the mask → `confirm`; only structure → `reclass`; nothing
 *   changed → no write;
 * - subtracts each changed row's old bucket contribution and adds its new one.
 *
 * `seq` is the value this write stamps; the caller persists it in the state row.
 */
export async function upsertOtelCalls(
  tx: DrizzleDb,
  rootId: number,
  calls: readonly ExtractedOtelCall[],
  source: OtelSource,
  seq: number,
): Promise<OtelCallsUpsertResult> {
  const result: OtelCallsUpsertResult = {
    changed: 0,
    bucketsChanged: 0,
    anyProvisional: false,
  };
  if (calls.length === 0) return result;

  const stateRes = await tx.execute(sql`
    SELECT transcript_seq, (rt_last_at IS NOT NULL) AS has_realtime
      FROM otel_session_state WHERE session_id = ${rootId}
  `);
  const stateRow = (
    stateRes.rows as unknown as {
      transcript_seq: DbNumber;
      has_realtime: boolean;
    }[]
  )[0];
  const transcriptSeq = numOrNull(stateRow?.transcript_seq ?? null);
  const sessionHasRealtime = stateRow?.has_realtime === true;

  const keys = calls.map((c) => c.callKey);
  const oldRes = await tx.execute(sql`
    SELECT call_key, request_id, query_source, model, claude_code_version, prompt_id,
           agent_id, event_time, input_tokens, output_tokens, cache_read_tokens,
           cache_write_tokens, cost_usd_micros, structure, provisional, source_mask, first_seq
      FROM otel_calls
     WHERE session_id = ${rootId}
       AND call_key IN (SELECT jsonb_array_elements_text(${textArrayJson(keys)}))
       FOR UPDATE
  `);
  const oldByKey = new Map<string, OldCallRow>();
  for (const row of oldRes.rows as unknown as OldCallRow[]) {
    oldByKey.set(row.call_key, row);
  }

  const requestIds = [
    ...new Set(
      calls.map((c) => c.requestId).filter((id): id is string => id !== null),
    ),
  ];
  const membership = await loadTreeMembership(tx, rootId, requestIds);

  const bit = sourceBit(source);
  const deltas = new Map<string, BucketDelta>();
  const writes: Record<string, unknown>[] = [];

  for (const call of calls) {
    const old = oldByKey.get(call.callKey);
    const firstSeq = old ? Number(old.first_seq) : seq;
    const provisional = isOtelCallProvisional(firstSeq, transcriptSeq);
    const structure = structureOf(
      membership,
      call.requestId,
      call.querySource,
      provisional,
    );
    const sourceMask = (old?.source_mask ?? 0) | bit;

    let kind: OtelChangeKind;
    if (!old) {
      kind = insertKind(source, sessionHasRealtime);
    } else if (callDataChanged(old, call)) {
      kind = 'update';
    } else if (sourceMask !== old.source_mask) {
      kind = 'confirm';
    } else if (structure !== old.structure || provisional !== old.provisional) {
      kind = 'reclass';
    } else {
      continue;
    }

    if (old) addContribution(deltas, contributionOfOld(old), -1, kind);
    addContribution(deltas, contributionOfNew(call, structure), 1, kind);
    if (provisional) result.anyProvisional = true;

    writes.push({
      call_key: call.callKey,
      request_id: call.requestId,
      query_source: call.querySource,
      model: call.model,
      claude_code_version: call.claudeCodeVersion,
      prompt_id: call.promptId,
      agent_id: call.agentId,
      event_time: call.eventTime.toISOString(),
      input_tokens: call.inputTokens,
      output_tokens: call.outputTokens,
      cache_read_tokens: call.cacheReadTokens,
      cache_write_tokens: call.cacheWriteTokens,
      cost_usd_micros: call.costUsdMicros,
      structure,
      provisional,
      source_mask: sourceMask,
      first_seq: firstSeq,
      change_kind: kind,
    });
  }
  if (writes.length === 0) return result;

  await tx.execute(sql`
    INSERT INTO otel_calls (
      session_id, call_key, request_id, query_source, model, claude_code_version, prompt_id,
      agent_id, event_time, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, cost_usd_micros, structure, provisional, source_mask, first_seq,
      seq, change_kind
    )
    SELECT ${rootId}, r.call_key, r.request_id, r.query_source, r.model,
           r.claude_code_version, r.prompt_id, r.agent_id, r.event_time, r.input_tokens,
           r.output_tokens, r.cache_read_tokens, r.cache_write_tokens, r.cost_usd_micros,
           r.structure, r.provisional, r.source_mask, r.first_seq, ${seq}, r.change_kind
      FROM jsonb_to_recordset(${jsonParam(writes)}::jsonb) AS r(
             call_key text, request_id text, query_source text, model text,
             claude_code_version text, prompt_id text, agent_id text,
             event_time timestamptz, input_tokens bigint, output_tokens bigint,
             cache_read_tokens bigint, cache_write_tokens bigint, cost_usd_micros bigint,
             structure text, provisional boolean, source_mask smallint, first_seq bigint,
             change_kind text)
    ON CONFLICT ON CONSTRAINT otel_calls_pk DO UPDATE SET
      request_id = EXCLUDED.request_id,
      query_source = EXCLUDED.query_source,
      model = EXCLUDED.model,
      claude_code_version = EXCLUDED.claude_code_version,
      prompt_id = EXCLUDED.prompt_id,
      agent_id = EXCLUDED.agent_id,
      event_time = EXCLUDED.event_time,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cache_read_tokens = EXCLUDED.cache_read_tokens,
      cache_write_tokens = EXCLUDED.cache_write_tokens,
      cost_usd_micros = EXCLUDED.cost_usd_micros,
      structure = EXCLUDED.structure,
      provisional = EXCLUDED.provisional,
      source_mask = EXCLUDED.source_mask,
      seq = EXCLUDED.seq,
      change_kind = EXCLUDED.change_kind
  `);
  result.changed = writes.length;
  result.bucketsChanged = await applyBucketDeltas(
    tx,
    rootId,
    deltas.values(),
    seq,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Spans + rollup (DD-3, DD-10, DD-11)
// ---------------------------------------------------------------------------

/** Outcome of {@link upsertOtelSpans}. */
export interface OtelSpansUpsertResult {
  /** `otel_spans` rows inserted, changed or re-costed (stamped with `seq`). */
  changed: number;
  /** Traces with a written span: the input of {@link recomputeSpanRollups}. */
  traceIds: string[];
}

/** The span columns whose change makes an upsert an `update` (cost included). */
const SPAN_DATA_COLUMNS = [
  'parent_span_id',
  'name',
  'start_time',
  'end_time',
  'request_id',
  'agent_id',
  'query_source',
  'context',
  'attributes',
  'cost_usd_micros',
] as const;

function rowOf(prefix: string): SQL {
  return sql.raw(
    `ROW(${SPAN_DATA_COLUMNS.map((c) => `${prefix}.${c}`).join(', ')})`,
  );
}

/**
 * Upserts extracted spans into `otel_spans` (DD-3, DD-11):
 * - an `llm_request` span takes `cost_usd_micros` from `otel_calls` by
 *   `(session_id, request_id)`;
 * - an existing span gets `update` when a value changed, `confirm` when only `source_mask` grew,
 *   and is left alone otherwise; an insert is `new` (or `fill`, see {@link upsertOtelCalls});
 * - then re-costs the existing `llm_request` spans whose call was written by this write (calls
 *   stamped `seq`), so the cost arrives in either order. A span already stamped by this write
 *   keeps its kind.
 *
 * Run it after {@link upsertOtelCalls} of the same write.
 */
export async function upsertOtelSpans(
  tx: DrizzleDb,
  rootId: number,
  spans: readonly ExtractedOtelSpan[],
  source: OtelSource,
  seq: number,
): Promise<OtelSpansUpsertResult> {
  const traceIds = new Set<string>();
  let changed = 0;

  if (spans.length > 0) {
    const stateRes = await tx.execute(sql`
      SELECT (rt_last_at IS NOT NULL) AS has_realtime
        FROM otel_session_state WHERE session_id = ${rootId}
    `);
    const hasRealtime =
      (stateRes.rows as unknown as { has_realtime: boolean }[])[0]
        ?.has_realtime === true;
    const kind = insertKind(source, hasRealtime);

    const rows = spans.map((s) => ({
      trace_id: s.traceId,
      span_id: s.spanId,
      parent_span_id: s.parentSpanId,
      name: s.name,
      start_time: s.startTime.toISOString(),
      end_time: s.endTime === null ? null : s.endTime.toISOString(),
      request_id: s.requestId,
      agent_id: s.agentId,
      query_source: s.querySource,
      context: s.context,
      attributes: s.attributes,
    }));
    const upserted = await tx.execute(sql`
      INSERT INTO otel_spans (
        session_id, trace_id, span_id, parent_span_id, name, start_time, end_time,
        request_id, agent_id, query_source, context, attributes, cost_usd_micros,
        rollup_cost_usd_micros, source_mask, first_seq, seq, change_kind
      )
      SELECT ${rootId}, r.trace_id, r.span_id, r.parent_span_id, r.name, r.start_time,
             r.end_time, r.request_id, r.agent_id, r.query_source, r.context,
             COALESCE(r.attributes, '{}'::jsonb),
             CASE WHEN r.name = ${OTEL_SPAN_LLM_REQUEST} THEN c.cost_usd_micros END,
             NULL, ${sourceBit(source)}, ${seq}, ${seq}, ${kind}
        FROM jsonb_to_recordset(${jsonParam(rows)}::jsonb) AS r(
               trace_id text, span_id text, parent_span_id text, name text,
               start_time timestamptz, end_time timestamptz, request_id text, agent_id text,
               query_source text, context text, attributes jsonb)
        LEFT JOIN otel_calls c
          ON c.session_id = ${rootId} AND c.request_id = r.request_id
      ON CONFLICT ON CONSTRAINT otel_spans_pk DO UPDATE SET
        parent_span_id = EXCLUDED.parent_span_id,
        name = EXCLUDED.name,
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time,
        request_id = EXCLUDED.request_id,
        agent_id = EXCLUDED.agent_id,
        query_source = EXCLUDED.query_source,
        context = EXCLUDED.context,
        attributes = EXCLUDED.attributes,
        cost_usd_micros = EXCLUDED.cost_usd_micros,
        source_mask = otel_spans.source_mask | EXCLUDED.source_mask,
        seq = EXCLUDED.seq,
        change_kind = CASE
          WHEN ${rowOf('otel_spans')} IS DISTINCT FROM ${rowOf('EXCLUDED')} THEN 'update'
          ELSE 'confirm'
        END
      WHERE ${rowOf('otel_spans')} IS DISTINCT FROM ${rowOf('EXCLUDED')}
         OR (otel_spans.source_mask | EXCLUDED.source_mask) <> otel_spans.source_mask
      RETURNING trace_id
    `);
    for (const row of upserted.rows as unknown as { trace_id: string }[]) {
      traceIds.add(row.trace_id);
      changed++;
    }
  }

  const recosted = await tx.execute(sql`
    UPDATE otel_spans s SET
      cost_usd_micros = c.cost_usd_micros,
      seq = ${seq},
      change_kind = CASE WHEN s.seq = ${seq} THEN s.change_kind ELSE 'update' END
      FROM otel_calls c
     WHERE s.session_id = ${rootId}
       AND s.name = ${OTEL_SPAN_LLM_REQUEST}
       AND s.request_id IS NOT NULL
       AND c.session_id = ${rootId}
       AND c.seq = ${seq}
       AND c.request_id = s.request_id
       AND s.cost_usd_micros IS DISTINCT FROM c.cost_usd_micros
    RETURNING s.trace_id, (s.first_seq = ${seq}) AS inserted_now
  `);
  for (const row of recosted.rows as unknown as {
    trace_id: string;
    inserted_now: boolean;
  }[]) {
    traceIds.add(row.trace_id);
    if (!row.inserted_now) changed++;
  }

  return { changed, traceIds: [...traceIds] };
}

/**
 * Recomputes `rollup_cost_usd_micros` = own cost + Σ child rollups of every span of the given
 * traces with one recursive walk (DD-11). An orphan (parent not yet arrived) is rolled up as a
 * root. Only rows whose rollup changed are written and stamped `seq` (`update`, unless the row
 * was already stamped by this write). Returns the number of rows written.
 */
export async function recomputeSpanRollups(
  tx: DrizzleDb,
  rootId: number,
  traceIds: readonly string[],
  seq: number,
): Promise<number> {
  if (traceIds.length === 0) return 0;
  const result = await tx.execute(sql`
    WITH RECURSIVE sp AS (
      SELECT trace_id, span_id, parent_span_id, cost_usd_micros
        FROM otel_spans
       WHERE session_id = ${rootId}
         AND trace_id IN (SELECT jsonb_array_elements_text(${textArrayJson(traceIds)}))
    ),
    walk AS (
      SELECT trace_id, span_id AS anc_id, span_id AS cur_id, cost_usd_micros, 0 AS depth
        FROM sp
      UNION ALL
      SELECT w.trace_id, w.anc_id, c.span_id, c.cost_usd_micros, w.depth + 1
        FROM walk w
        JOIN sp c
          ON c.trace_id = w.trace_id
         AND c.parent_span_id = w.cur_id
         AND c.span_id <> w.cur_id
       WHERE w.depth < ${ROLLUP_MAX_DEPTH}
    ),
    roll AS (
      SELECT trace_id, anc_id, SUM(cost_usd_micros)::bigint AS rollup
        FROM walk
       GROUP BY trace_id, anc_id
    )
    UPDATE otel_spans s SET
      rollup_cost_usd_micros = roll.rollup,
      seq = ${seq},
      change_kind = CASE WHEN s.seq = ${seq} THEN s.change_kind ELSE 'update' END
      FROM roll
     WHERE s.session_id = ${rootId}
       AND s.trace_id = roll.trace_id
       AND s.span_id = roll.anc_id
       AND s.rollup_cost_usd_micros IS DISTINCT FROM roll.rollup
    RETURNING (s.first_seq = ${seq}) AS inserted_now
  `);
  return (result.rows as unknown as { inserted_now: boolean }[]).filter(
    (r) => !r.inserted_now,
  ).length;
}

// ---------------------------------------------------------------------------
// One write: realtime batch or projected chunk
// ---------------------------------------------------------------------------

/** Outcome of {@link applyOtelLines}. */
export interface OtelApplyResult {
  /** The state's `seq` after the write (unchanged when nothing changed). */
  seq: number;
  /** Rows were inserted or changed. */
  changed: boolean;
  /** `api_request` calls / spans extracted from the lines. */
  calls: number;
  spans: number;
  /** `spans` lines skipped by the extraction caps. */
  skippedSpans: number;
}

/**
 * Applies one batch of chunk lines to a root's OTEL facts, inside the transaction that holds the
 * state lock ({@link lockOtelState}): extracts calls and spans, upserts calls (with bucket
 * deltas), upserts spans, recomputes the touched traces' rollups, then updates the state row:
 * `seq` (only when a row changed), `user_id` (when still NULL), `has_spans`,
 * `has_provisional`, `otel_hook_version` (the highest seen) and, for `source: 'realtime'`,
 * `rt_last_at = now()`. `chunk_last_at` and the `rt_*` gap fields are the callers' (DD-14,
 * DD-16, DD-17).
 */
export async function applyOtelLines(
  tx: DrizzleDb,
  rootId: number,
  userId: number | null,
  lines: readonly unknown[],
  source: OtelSource,
): Promise<OtelApplyResult> {
  const state = await selectStateForUpdate(tx, rootId);
  if (!state) {
    throw new Error(
      `applyOtelLines: no otel_session_state row for session ${rootId} (lockOtelState first)`,
    );
  }
  if (state.userId === null && userId !== null) {
    await tx.execute(sql`
      UPDATE otel_session_state SET user_id = ${userId}
       WHERE session_id = ${rootId} AND user_id IS NULL
    `);
  }

  const seq = state.seq + 1;
  const lineList = [...lines];
  const calls = extractOtelCalls(lineList);
  const { spans, skipped } = extractOtelSpans(lineList);

  const callRes = await upsertOtelCalls(tx, rootId, calls, source, seq);
  const spanRes = await upsertOtelSpans(tx, rootId, spans, source, seq);
  const rolled = await recomputeSpanRollups(tx, rootId, spanRes.traceIds, seq);
  const changed =
    callRes.changed + callRes.bucketsChanged + spanRes.changed + rolled > 0 ||
    spanRes.traceIds.length > 0;

  const hookVersion = maxVersion([
    state.otelHookVersion,
    maxHookVersion(lineList),
  ]);
  const realtime = source === 'realtime';
  await tx.execute(sql`
    UPDATE otel_session_state SET
      seq = ${changed ? seq : state.seq},
      has_spans = has_spans OR ${spans.length > 0},
      has_provisional = has_provisional OR ${callRes.anyProvisional},
      otel_hook_version = ${hookVersion},
      rt_last_at = CASE WHEN ${realtime} THEN now() ELSE rt_last_at END
     WHERE session_id = ${rootId}
  `);

  return {
    seq: changed ? seq : state.seq,
    changed,
    calls: calls.length,
    spans: spans.length,
    skippedSpans: skipped,
  };
}

// ---------------------------------------------------------------------------
// Bucket rebuild + reclassification (DD-5, DD-7)
// ---------------------------------------------------------------------------

/**
 * Rebuilds a root's `otel_cost_buckets` from its `otel_calls` (DD-7): a `GROUP BY` over the
 * calls (5-minute UTC floor of `event_time`, NULL dimensions as `''`) compared with the stored
 * rows; only changed keys are written, stamped `seq` / `changeKind`. A stored key with no calls
 * left is set to zero, never deleted. Returns the number of rows written.
 */
export async function rebuildOtelBuckets(
  tx: DrizzleDb,
  rootId: number,
  seq: number,
  changeKind: OtelChangeKind,
): Promise<number> {
  const result = await tx.execute(sql`
    WITH target AS (
      SELECT to_timestamp(
               (floor(extract(epoch FROM event_time) / 300) * 300)::double precision
             ) AS bucket_start,
             structure,
             COALESCE(query_source, '') AS query_source,
             COALESCE(model, '') AS model,
             COALESCE(claude_code_version, '') AS cc_version,
             COUNT(*)::int AS calls,
             COALESCE(SUM(cost_usd_micros), 0)::bigint AS cost_usd_micros,
             COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
             COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
             COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
             COALESCE(SUM(cache_write_tokens), 0)::bigint AS cache_write_tokens
        FROM otel_calls
       WHERE session_id = ${rootId}
       GROUP BY 1, 2, 3, 4, 5
    ),
    cur AS (
      SELECT * FROM otel_cost_buckets WHERE session_id = ${rootId}
    ),
    diff AS (
      SELECT COALESCE(t.bucket_start, b.bucket_start) AS bucket_start,
             COALESCE(t.structure, b.structure) AS structure,
             COALESCE(t.query_source, b.query_source) AS query_source,
             COALESCE(t.model, b.model) AS model,
             COALESCE(t.cc_version, b.cc_version) AS cc_version,
             COALESCE(t.calls, 0) AS calls,
             COALESCE(t.cost_usd_micros, 0) AS cost_usd_micros,
             COALESCE(t.input_tokens, 0) AS input_tokens,
             COALESCE(t.output_tokens, 0) AS output_tokens,
             COALESCE(t.cache_read_tokens, 0) AS cache_read_tokens,
             COALESCE(t.cache_write_tokens, 0) AS cache_write_tokens
        FROM target t
        FULL JOIN cur b
          ON b.bucket_start = t.bucket_start
         AND b.structure = t.structure
         AND b.query_source = t.query_source
         AND b.model = t.model
         AND b.cc_version = t.cc_version
       WHERE b.session_id IS NULL
          OR ROW(b.calls, b.cost_usd_micros, b.input_tokens, b.output_tokens,
                 b.cache_read_tokens, b.cache_write_tokens)
             IS DISTINCT FROM
             ROW(COALESCE(t.calls, 0), COALESCE(t.cost_usd_micros, 0),
                 COALESCE(t.input_tokens, 0), COALESCE(t.output_tokens, 0),
                 COALESCE(t.cache_read_tokens, 0), COALESCE(t.cache_write_tokens, 0))
    )
    INSERT INTO otel_cost_buckets (
      session_id, user_id, bucket_start, structure, query_source, model, cc_version,
      calls, cost_usd_micros, input_tokens, output_tokens, cache_read_tokens,
      cache_write_tokens, seq, change_kind
    )
    SELECT ${rootId},
           (SELECT user_id FROM otel_session_state WHERE session_id = ${rootId}),
           d.bucket_start, d.structure, d.query_source, d.model, d.cc_version,
           d.calls, d.cost_usd_micros, d.input_tokens, d.output_tokens,
           d.cache_read_tokens, d.cache_write_tokens, ${seq}, ${changeKind}
      FROM diff d
    ON CONFLICT ON CONSTRAINT otel_cost_buckets_pk DO UPDATE SET
      user_id = COALESCE(otel_cost_buckets.user_id, EXCLUDED.user_id),
      calls = EXCLUDED.calls,
      cost_usd_micros = EXCLUDED.cost_usd_micros,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      cache_read_tokens = EXCLUDED.cache_read_tokens,
      cache_write_tokens = EXCLUDED.cache_write_tokens,
      seq = EXCLUDED.seq,
      change_kind = EXCLUDED.change_kind
  `);
  return result.rowCount ?? 0;
}

/**
 * Queues a session for OTEL reclassification (DD-5): called right after
 * `replaceSessionRequestIds`. Takes no lock beyond the queue row's own.
 */
export async function enqueueOtelReclass(
  tx: DrizzleDb,
  sessionRowId: number,
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO otel_reclass_queue (session_id) VALUES (${sessionRowId})
    ON CONFLICT (session_id) DO NOTHING
  `);
}

/** Outcome of {@link reclassifyOtelSession}. */
export interface OtelReclassResult {
  /** The resolved root, or null when the session row does not exist. */
  rootId: number | null;
  /** The root has OTEL data (a state row). */
  hasOtel: boolean;
  /** `otel_calls` rows reclassified. */
  calls: number;
  /** `otel_cost_buckets` rows rewritten. */
  buckets: number;
}

interface ReclassCallRow {
  call_key: string;
  request_id: string | null;
  query_source: string | null;
  structure: OtelStructure;
  provisional: boolean;
  first_seq: number | string;
}

/**
 * Reclassifies one claimed queue id (DD-5 per-id steps 1–7), in the claiming transaction:
 * 1. resolves the root (`topAncestorIdsSql`);
 * 2. `lockOtelState(…, { create: false })` — no state row → nothing to do (no row is created);
 * 3. loads the root's `otel_calls` and the tree's request-id membership;
 * 4. recomputes `structure` and `provisional` (against the new `transcript_seq`);
 * 5. writes the changed calls (`reclass`);
 * 6. {@link rebuildOtelBuckets} (`reclass`);
 * 7. sets `transcript_seq = seq` and `has_provisional`.
 *
 * Throws {@link OtelSessionDeletedError} (rolling back) for a deleted root.
 */
export async function reclassifyOtelSession(
  tx: DrizzleDb,
  sessionRowId: number,
): Promise<OtelReclassResult> {
  const idsArray = sql`${`{${Math.trunc(sessionRowId)}}`}::bigint[]`;
  const rootRes = await tx.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(idsArray)}
    SELECT top_id FROM top_ancestors
  `);
  const rootRow = (rootRes.rows as unknown as { top_id: number | string }[])[0];
  if (!rootRow) return { rootId: null, hasOtel: false, calls: 0, buckets: 0 };
  const rootId = Number(rootRow.top_id);

  const lock = await lockOtelState(tx, rootId, { create: false });
  if (!lock) return { rootId, hasOtel: false, calls: 0, buckets: 0 };

  const callsRes = await tx.execute(sql`
    SELECT call_key, request_id, query_source, structure, provisional, first_seq
      FROM otel_calls
     WHERE session_id = ${rootId}
  `);
  const calls = callsRes.rows as unknown as ReclassCallRow[];
  const requestIds = [
    ...new Set(
      calls.map((c) => c.request_id).filter((id): id is string => id !== null),
    ),
  ];
  const membership = await loadTreeMembership(tx, rootId, requestIds);

  // The seq this write would stamp; it becomes the new transcript_seq when anything changes.
  const candidateSeq = lock.state.seq + 1;
  const changes: {
    call_key: string;
    structure: OtelStructure;
    provisional: boolean;
  }[] = [];
  let anyProvisional = false;
  for (const call of calls) {
    const provisional = isOtelCallProvisional(
      Number(call.first_seq),
      candidateSeq,
    );
    if (provisional) anyProvisional = true;
    const structure = structureOf(
      membership,
      call.request_id,
      call.query_source,
      provisional,
    );
    if (structure !== call.structure || provisional !== call.provisional) {
      changes.push({ call_key: call.call_key, structure, provisional });
    }
  }

  if (changes.length > 0) {
    // A `fill` row keeps its kind: a Stop uploads the transcript and the chunks together, so
    // the reclassification usually lands in the same projection tick as the fill, before any
    // poll saw it. Relabelled `reclass`, an unseen filled row would be highlighted instead of
    // counted in the "Filled N calls" notice; for a seen key `fill` and `reclass` are both
    // silent on the client (DD-3), so keeping it changes nothing else.
    await tx.execute(sql`
      UPDATE otel_calls c SET
        structure = r.structure,
        provisional = r.provisional,
        seq = ${candidateSeq},
        change_kind = CASE WHEN c.change_kind = 'fill' THEN 'fill' ELSE 'reclass' END
        FROM jsonb_to_recordset(${jsonParam(changes)}::jsonb)
             AS r(call_key text, structure text, provisional boolean)
       WHERE c.session_id = ${rootId}
         AND c.call_key = r.call_key
    `);
  }
  const buckets = await rebuildOtelBuckets(tx, rootId, candidateSeq, 'reclass');
  if (changes.length > 0 || buckets > 0) {
    await lock.nextSeq();
  }

  await tx.execute(sql`
    UPDATE otel_session_state SET
      transcript_seq = ${lock.state.seq},
      has_provisional = ${anyProvisional}
     WHERE session_id = ${rootId}
  `);

  return { rootId, hasOtel: true, calls: changes.length, buckets };
}
