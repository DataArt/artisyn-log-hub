import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, inArray, eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../database/database.constants';
import type { DrizzleDb } from '../database/database.module';
import * as schema from '../database/schema';
import type {
  SessionLogLine,
  SessionLogsDeltaResponse,
  SessionLogsDeltaUpdate,
  SubagentStatsRow,
} from './dto/session-logs-delta.dto';
import { subagentOtelCostSql } from './otel-cost.sql';
import { readOtelStateRow } from './otel/otel-facts-read.sql';
import { computeOtelLiveness } from './otel/otel-facts.reader';
import {
  checkGrowth,
  classifyDeltaRows,
  DELTA_LOG_TYPES,
  decodeDeltaCursor,
  encodeDeltaCursor,
  microsToUt,
  type DeltaCurrentRow,
  type DeltaCursorRow,
  type DeltaLogTypeCode,
} from './session-logs-delta';
import { getDescendantSessionIds } from './session-tree.sql';
import { extractWorkflows, type WorkflowRun } from './workflow-extractor';
import {
  resolveWorkflowAgentLinkage,
  type WorkflowLinkageRow,
} from './workflow-linkage';

/**
 * The `session_stats` rows of the given sessions, keyed back by `sessions.session_id`, for the
 * client's cost attribution — shared by `/logs` (every descendant of the root) and the delta
 * (the new and changed sub-agents only), so both return the same fields under the same guard.
 */
export function selectSubagentStats(
  db: DrizzleDb,
  sessionRowIds: number[],
  rootRowId: number,
) {
  // FR-6 (2026-11-03 otel-cost-attribution): the sub-agent's OTEL cost, non-null exactly
  // when `selectSubagentCost` would take it (old Claude Code, OTEL above the transcript cost).
  const otelCost = subagentOtelCostSql({
    claudeVersion: sql`${schema.sessionStats.claudeVersion}`,
    claudeVersionOtel: sql`${schema.sessionStats.claudeVersionOtel}`,
    subSessionId: sql`${schema.sessions.sessionId}`,
    rootRowId: sql`${rootRowId}::bigint`,
  });
  return db
    .select({
      sessionId: schema.sessions.sessionId,
      model: schema.sessionStats.model,
      inputTokens: schema.sessionStats.inputTokens,
      outputTokens: schema.sessionStats.outputTokens,
      cacheReadTokens: schema.sessionStats.cacheReadTokens,
      cacheWriteTokens: schema.sessionStats.cacheWriteTokens,
      // Without these the client's Workflow-agent fallback fold
      // (log-parser.ts) can only fill the new TokenBreakdown fields with 0, which
      // would under-price every web search and every fast-mode token an agent spent.
      webSearchRequests: schema.sessionStats.webSearchRequests,
      inputTokensFast: schema.sessionStats.inputTokensFast,
      outputTokensFast: schema.sessionStats.outputTokensFast,
      // The productivity counters, so the client can compute a tree-scoped
      // code-impact figure from the same `session_stats` rows the server-side
      // rollup (`session-tree-metrics.sql.ts`) sums — the Info/Summary tabs and the
      // analytics pages therefore cannot disagree. Additive: no existing field
      // changes meaning.
      linesChanged: schema.sessionStats.linesChanged,
      filesEditedWritten: schema.sessionStats.filesEditedWritten,
      linesAdded: schema.sessionStats.linesAdded,
      linesRemoved: schema.sessionStats.linesRemoved,
      diffLinesCoveredCalls: schema.sessionStats.diffLinesCoveredCalls,
      diffLinesTotalCalls: schema.sessionStats.diffLinesTotalCalls,
      otelCostUsd: sql<number | null>`(
        SELECT CASE WHEN o.v > COALESCE((
          SELECT sc_sa.cost::float FROM session_costs sc_sa
          WHERE sc_sa.session_id = ${schema.sessions.id}
        ), 0.0) THEN o.v END
        FROM (SELECT ${otelCost} AS v) o
      )`.mapWith((v: unknown) => (v == null ? null : Number(v))),
    })
    .from(schema.sessions)
    .innerJoin(
      schema.sessionStats,
      eq(schema.sessionStats.sessionId, schema.sessions.id),
    )
    .where(
      and(
        inArray(schema.sessions.id, sessionRowIds),
        // Guard, same predicate as the server-side tree rollup: a descendant
        // whose `session_stats` row exists only because OTEL cost telemetry arrived
        // (no transcript ever uploaded) contributes nothing. Without it the client
        // would sum a node the server rollup skips, and the two figures would drift.
        sql`EXISTS (
          SELECT 1 FROM logs tl
          WHERE tl.session_id = ${schema.sessions.id}
            AND tl.log_type IN ('claude', 'claude-subagent')
        )`,
      ),
    );
}

/** Step (b): one tree row's metadata — never its body. */
interface TreeMetaRow extends DeltaCurrentRow {
  /** `sessions.session_id`. */
  sessionId: string;
  parentSessionId: string | null;
  workflowRunId: string | null;
  /** `sessions.agent_description` (sub-agent `.meta.json` description). */
  agentDescription: string | null;
  /** `sessions.workflow_phase` (sub-agent `.meta.json` workflow phase). */
  workflowPhase: string | null;
}

/** Step (c): what was read of one changed or new row. */
interface SliceRow {
  sid: number;
  t: DeltaLogTypeCode;
  /** `updated_at` at read time (base 36 µs) — the next cursor's `ut`. */
  ut: string;
  len: number;
  /** Fingerprint at the client's `prevN` (`''` when `prevN = 0` or past the end). */
  fpPrev: string;
  /** Fingerprint at `len` — the next cursor's `fp`. */
  fpLen: string;
  /** `body[prevN:]`, or null when the growth check failed in SQL. */
  lines: SessionLogLine[] | null;
}

/** A row to slice: its key plus what the client already holds (`0` / `''` for a new row). */
interface SliceRequest {
  sid: number;
  t: DeltaLogTypeCode;
  prevN: number;
  prevFp: string;
}

const CODE_BY_LOG_TYPE: Readonly<Record<string, DeltaLogTypeCode>> = {
  artisyn: 'a',
  claude: 'c',
  'claude-subagent': 's',
};

function sliceKey(sid: number, t: DeltaLogTypeCode): string {
  return `${sid}:${t}`;
}

type DbScalar = string | number | null;

/**
 * Incremental session logs for the Session Map (session-map DD-6..8): only what changed since
 * the client's cursor, a `reload` when the stored logs no longer extend what the client holds.
 * Access is checked by the caller (`resolveSessionLogsAccess`) — this service sees only the
 * root's `sessions.id`.
 */
@Injectable()
export class SessionLogsDeltaService {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDb) {}

  async getDelta(
    sessionRowId: number,
    cursor: string | undefined,
    now: Date,
  ): Promise<SessionLogsDeltaResponse> {
    const serverTime = now.toISOString();

    // (a) the session tree, metadata only.
    const descendantsMap = await getDescendantSessionIds(this.db, [
      sessionRowId,
    ]);
    const descendantIds = descendantsMap.get(sessionRowId) ?? [];
    const treeIds = new Set<number>([sessionRowId, ...descendantIds]);

    // (b) metadata of every tree row: the root's artisyn + claude rows, a descendant's
    // claude-subagent row only (the /logs rule).
    const meta = await this.readTreeMeta(sessionRowId, descendantIds);
    if (!meta.some((r) => r.sid === sessionRowId && r.t === 'c')) {
      throw new NotFoundException('Session logs not found');
    }

    const classified = classifyDeltaRows(
      decodeDeltaCursor(cursor),
      meta,
      treeIds,
    );
    if (classified.stale.length > 0) return { reload: true, serverTime };

    // (c) bodies of the changed and new rows only — nothing is read when nothing moved.
    const requests: SliceRequest[] = [
      ...classified.changed.map(({ current, prev }) => ({
        sid: current.sid,
        t: current.t,
        prevN: prev.n,
        prevFp: prev.fp,
      })),
      ...classified.new.map((row) => ({
        sid: row.sid,
        t: row.t,
        prevN: 0,
        prevFp: '',
      })),
    ];
    const slices = await this.readSlices(requests);
    const sliceByKey = new Map<string, SliceRow>();
    for (const s of slices) sliceByKey.set(sliceKey(s.sid, s.t), s);

    const nextCursor: DeltaCursorRow[] = classified.unchanged.map(
      ({ prev }) => prev,
    );
    const linesByKey = new Map<string, SessionLogLine[]>();
    for (const req of requests) {
      const slice = sliceByKey.get(sliceKey(req.sid, req.t));
      // A row deleted between (b) and (c) is a rewrite too.
      if (
        slice === undefined ||
        slice.lines === null ||
        checkGrowth(req.prevN, req.prevFp, slice.len, slice.fpPrev) === 'stale'
      ) {
        return { reload: true, serverTime };
      }
      linesByKey.set(sliceKey(req.sid, req.t), slice.lines);
      nextCursor.push({
        sid: req.sid,
        t: req.t,
        ut: slice.ut,
        n: slice.len,
        fp: slice.fpLen,
      });
    }

    const metaBySid = new Map<number, TreeMetaRow>();
    for (const r of meta) if (r.t === 's') metaBySid.set(r.sid, r);

    const subagentAppends: SessionLogsDeltaUpdate['subagentAppends'] = [];
    for (const { current } of classified.changed) {
      if (current.t !== 's') continue;
      const lines = linesByKey.get(sliceKey(current.sid, 's')) ?? [];
      const row = metaBySid.get(current.sid);
      if (row === undefined) continue;
      // A meta-only re-upload (no new lines) still reaches the client when it carries
      // labels (DD-15); an old client skips empty-line appends.
      const hasMeta =
        row.agentDescription !== null || row.workflowPhase !== null;
      if (lines.length === 0 && !hasMeta) continue;
      subagentAppends.push({
        sessionId: row.sessionId,
        lines,
        agentDescription: row.agentDescription,
        workflowPhase: row.workflowPhase,
      });
    }

    const newSubagents: SessionLogsDeltaUpdate['newSubagents'] = [];
    for (const current of classified.new) {
      if (current.t !== 's') continue;
      const row = metaBySid.get(current.sid);
      if (row === undefined) continue;
      newSubagents.push({
        sessionId: row.sessionId,
        parentSessionId: row.parentSessionId,
        workflowRunId: row.workflowRunId,
        agentDescription: row.agentDescription,
        workflowPhase: row.workflowPhase,
        logs: linesByKey.get(sliceKey(current.sid, 's')) ?? [],
      });
    }
    newSubagents.sort((x, y) =>
      x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0,
    );
    subagentAppends.sort((x, y) =>
      x.sessionId < y.sessionId ? -1 : x.sessionId > y.sessionId ? 1 : 0,
    );

    // (d) stats of the new and changed sub-agents, (e) the root's OTEL state.
    const movedSubagentIds = requests
      .filter((r) => r.t === 's')
      .map((r) => r.sid);
    const rootClaudeMoved = requests.some(
      (r) => r.sid === sessionRowId && r.t === 'c',
    );
    const newSubagentAppeared = classified.new.some((r) => r.t === 's');
    const [statsRows, otelState, workflows] = await Promise.all([
      movedSubagentIds.length > 0
        ? selectSubagentStats(this.db, movedSubagentIds, sessionRowId)
        : Promise.resolve([]),
      readOtelStateRow(this.db, sessionRowId),
      // (f) workflows only when the root claude log moved or a new agent appeared.
      rootClaudeMoved || newSubagentAppeared
        ? this.readWorkflows(sessionRowId, meta)
        : Promise.resolve(null),
    ]);

    const subagentStats: Record<string, SubagentStatsRow> = {};
    for (const { sessionId, ...stats } of statsRows) {
      subagentStats[sessionId] = stats;
    }

    return {
      reload: false,
      rootArtisynLines: linesByKey.get(sliceKey(sessionRowId, 'a')) ?? [],
      rootClaudeLines: linesByKey.get(sliceKey(sessionRowId, 'c')) ?? [],
      subagentAppends,
      newSubagents,
      subagentStats,
      workflows,
      liveness: computeOtelLiveness(otelState, now),
      serverTime,
      cursor: encodeDeltaCursor(nextCursor),
    };
  }

  /** Step (b). */
  private async readTreeMeta(
    rootId: number,
    descendantIds: number[],
  ): Promise<TreeMetaRow[]> {
    const descendantsLiteral = `{${descendantIds.join(',')}}`;
    const result = await this.db.execute(sql`
      SELECT s.id, s.session_id, s.parent_session_id, s.workflow_run_id,
             s.agent_description, s.workflow_phase, l.log_type,
             floor(extract(epoch from l.updated_at) * 1000000)::bigint AS ut
        FROM sessions s
        JOIN logs l ON l.session_id = s.id
       WHERE (s.id = ${rootId} AND l.log_type IN ('artisyn', 'claude'))
          OR (s.id = ANY(${descendantsLiteral}::int[])
              AND l.log_type = 'claude-subagent')
    `);
    const rows = result.rows as unknown as {
      id: DbScalar;
      session_id: string;
      parent_session_id: string | null;
      workflow_run_id: string | null;
      agent_description: string | null;
      workflow_phase: string | null;
      log_type: string;
      ut: DbScalar;
    }[];
    const out: TreeMetaRow[] = [];
    for (const r of rows) {
      const t = CODE_BY_LOG_TYPE[r.log_type];
      if (t === undefined || r.ut === null) continue;
      out.push({
        sid: Number(r.id),
        t,
        ut: microsToUt(r.ut),
        sessionId: r.session_id,
        parentSessionId: r.parent_session_id,
        workflowRunId: r.workflow_run_id,
        agentDescription: r.agent_description ?? null,
        workflowPhase: r.workflow_phase ?? null,
      });
    }
    return out;
  }

  /**
   * Step (c): per row, in one statement so length, fingerprints and slice come from the same
   * body version — the length, the fingerprint at the client's `prevN` and at the new length
   * (`left(md5((body -> (n-1))::text), 12)`, the expression the cursor is issued with), and
   * `body[prevN:]` only when the body still extends the client's copy.
   */
  private async readSlices(requests: SliceRequest[]): Promise<SliceRow[]> {
    if (requests.length === 0) return [];
    const values = sql.join(
      requests.map(
        (r) =>
          sql`(${r.sid}::int, ${DELTA_LOG_TYPES[r.t]}::text, ${r.prevN}::int, ${r.prevFp}::text)`,
      ),
      sql`, `,
    );
    const result = await this.db.execute(sql`
      SELECT v.sid, l.log_type,
             floor(extract(epoch from l.updated_at) * 1000000)::bigint AS ut,
             x.len, f.fp_prev, f.fp_len,
             CASE WHEN x.len >= v.prev_n AND f.fp_prev = v.prev_fp THEN (
               SELECT COALESCE(jsonb_agg(e.line ORDER BY e.i), '[]'::jsonb)
                 FROM jsonb_array_elements(x.body) WITH ORDINALITY e(line, i)
                WHERE e.i > v.prev_n
             )::text END AS lines
        FROM (VALUES ${values}) v(sid, log_type, prev_n, prev_fp)
        JOIN logs l ON l.session_id = v.sid AND l.log_type = v.log_type
        CROSS JOIN LATERAL (
          SELECT b AS body, jsonb_array_length(b) AS len
            FROM (SELECT CASE WHEN jsonb_typeof(l.body) = 'array'
                              THEN l.body ELSE '[]'::jsonb END AS b) bb
        ) x
        CROSS JOIN LATERAL (
          SELECT
            CASE WHEN v.prev_n > 0 AND x.len >= v.prev_n
                 THEN left(md5((x.body -> (v.prev_n - 1))::text), 12)
                 ELSE '' END AS fp_prev,
            CASE WHEN x.len > 0
                 THEN left(md5((x.body -> (x.len - 1))::text), 12)
                 ELSE '' END AS fp_len
        ) f
    `);
    const rows = result.rows as unknown as {
      sid: DbScalar;
      log_type: string;
      ut: DbScalar;
      len: DbScalar;
      fp_prev: string;
      fp_len: string;
      lines: string | null;
    }[];
    const out: SliceRow[] = [];
    for (const r of rows) {
      const t = CODE_BY_LOG_TYPE[r.log_type];
      if (t === undefined || r.ut === null) continue;
      out.push({
        sid: Number(r.sid),
        t,
        ut: microsToUt(r.ut),
        len: Number(r.len),
        fpPrev: r.fp_prev,
        fpLen: r.fp_len,
        lines:
          r.lines === null ? null : (JSON.parse(r.lines) as SessionLogLine[]),
      });
    }
    return out;
  }

  /**
   * Step (f): the full workflow list from the root claude body, linked to the tree's agents
   * exactly as `/logs` does. A malformed body yields an empty list, as in `/logs`.
   */
  private async readWorkflows(
    rootId: number,
    meta: readonly TreeMetaRow[],
  ): Promise<WorkflowRun[]> {
    const [row] = await this.db
      .select({ bodyText: sql<string>`${schema.logs.body}::text` })
      .from(schema.logs)
      .where(
        and(
          eq(schema.logs.sessionId, rootId),
          eq(schema.logs.logType, 'claude'),
        ),
      )
      .limit(1);
    if (row === undefined) return [];
    let workflows: WorkflowRun[] = [];
    try {
      workflows = extractWorkflows(JSON.parse(row.bodyText) as unknown[]);
    } catch {
      return [];
    }
    const linkageRows: WorkflowLinkageRow[] = meta
      .filter((r) => r.t === 's')
      .map((r) => ({
        subSessionId: r.sessionId,
        parentSessionId: r.parentSessionId,
        workflowRunId: r.workflowRunId,
      }));
    resolveWorkflowAgentLinkage(workflows, linkageRows);
    return workflows;
  }
}
