/**
 * Client trace assembly of the session OTEL tab (2026-10-30 otel-tabs-traces, DD-12; algorithm
 * doc `docs/knowledgebase/algorithms/otel-trace-assembly.md`).
 *
 * `assembleOtelTraces(spans, calls)` turns the flat span rows of one session into turns:
 *
 * 1. Spans are grouped by `traceId`; inside a trace each span hangs under its parent.
 * 2. A span whose parent has not arrived yet (an orphan) is placed under a provisional
 *    "turn in progress" row of its trace. Claude Code exports a span when it ends, so the
 *    `interaction` root of a running turn arrives last.
 * 3. A trace with no `interaction` span whose roots are all `llm_request` spans is
 *    `standalone` (e.g. `prompt_suggestion`). It is attached, as a separate root row, to the
 *    interaction turn whose `[start, end]` contains its start, else to the latest turn that
 *    started before it; with neither it is a turn of its own.
 * 4. Each turn gets a header: start, duration, cost, hidden cost, LLM calls, depth, spans,
 *    waiting (the union of its `blocked_on_user` intervals) and output tokens. The interaction
 *    rollup (`costUsdMicros`) excludes attached standalone rows; they are summed apart.
 *
 * Turns come out ordered by start (ties by trace id); children by start (ties by span id).
 *
 * `splitOtelTurnTime(turn)` splits a turn's duration into waiting → model → tool → other (FR-31)
 * and `orderOtelTurns(turns, order)` orders the navigator's turns by start / cost / slowest
 * (FR-30).
 */
import type {
  OtelCallRow,
  OtelSpanRow,
} from '../../../../../models/repositories';

export const OTEL_SPAN_INTERACTION = 'claude_code.interaction';
export const OTEL_SPAN_LLM_REQUEST = 'claude_code.llm_request';
export const OTEL_SPAN_TOOL = 'claude_code.tool';
export const OTEL_SPAN_BLOCKED_ON_USER = 'claude_code.tool.blocked_on_user';
export const OTEL_SPAN_TOOL_EXECUTION = 'claude_code.tool.execution';

export interface OtelTraceNode {
  /** `spanId`, or `pending:<traceId>` for the provisional "turn in progress" row. */
  key: string;
  /** Null for the provisional row. */
  span: OtelSpanRow | null;
  /** 0 for a turn's root rows. */
  depth: number;
  children: OtelTraceNode[];
  /** The span's parent has not arrived; it sits under the provisional row. */
  orphan: boolean;
  /** A standalone `llm_request` row attached to this turn (DD-12 step 3). */
  standalone: boolean;
  startMs: number;
  /** The span end; for the provisional row the latest end below it. Null while open. */
  endMs: number | null;
  /** The span's own cost; null for the provisional row and spans without a call. */
  costUsdMicros: number | null;
  /** Own + every descendant's cost (the server's rollup, or the sum below for the provisional row). */
  rollupCostUsdMicros: number;
}

export interface OtelTurnHeader {
  startMs: number;
  /** The latest span end of the turn (a running turn ends at its latest span end). */
  endMs: number;
  durationMs: number;
  /** Interaction rollup; standalone rows not included. */
  costUsdMicros: number;
  /** Cost of the attached standalone rows. */
  standaloneCostUsdMicros: number;
  /** Own cost of the turn's hidden `llm_request` spans, standalone rows included. */
  hiddenCostUsdMicros: number;
  /** `llm_request` spans, standalone rows included. */
  llmCalls: number;
  /** Deepest row depth (root rows are depth 0). */
  depth: number;
  spans: number;
  /** Union of the turn's `blocked_on_user` intervals, clipped to the turn. */
  waitingMs: number;
  /** Output tokens of the calls matched to the turn's `llm_request` spans by `requestId`. */
  outputTokens: number;
}

export interface OtelTurn {
  /** The trace id of the turn's interaction (or of its only trace). */
  key: string;
  traceId: string;
  /** Some parent (at last the `interaction` root) has not arrived yet: the turn is running. */
  inProgress: boolean;
  /** The turn's own trace was standalone and found no turn to attach to. */
  standaloneOnly: boolean;
  /** Root rows: the interaction (or provisional) row first, then attached standalone rows. */
  rows: OtelTraceNode[];
  header: OtelTurnHeader;
}

/** Merges intervals and returns their total length; empty or reversed intervals count 0. */
export function unionIntervalsMs(
  intervals: readonly (readonly [number, number])[],
): number {
  const sorted = intervals
    .filter(([s, e]) => e > s)
    .map(([s, e]) => [s, e] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let curStart = Number.NaN;
  let curEnd = Number.NaN;
  for (const [s, e] of sorted) {
    if (Number.isNaN(curStart) || s > curEnd) {
      if (!Number.isNaN(curStart)) total += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else if (e > curEnd) {
      curEnd = e;
    }
  }
  if (!Number.isNaN(curStart)) total += curEnd - curStart;
  return total;
}

function micros(v: string | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ms(iso: string | null): number | null {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

function compareNodes(a: OtelTraceNode, b: OtelTraceNode): number {
  return a.startMs - b.startMs || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function spanNode(span: OtelSpanRow): OtelTraceNode {
  const own = micros(span.costUsdMicros);
  return {
    key: span.spanId,
    span,
    depth: 0,
    children: [],
    orphan: false,
    standalone: false,
    startMs: ms(span.startTime) ?? 0,
    endMs: ms(span.endTime),
    costUsdMicros: own,
    rollupCostUsdMicros: micros(span.rollupCostUsdMicros) ?? own ?? 0,
  };
}

function setDepth(node: OtelTraceNode, depth: number): void {
  node.depth = depth;
  node.children.sort(compareNodes);
  for (const c of node.children) setDepth(c, depth + 1);
}

function* walk(node: OtelTraceNode): Generator<OtelTraceNode> {
  yield node;
  for (const c of node.children) yield* walk(c);
}

function latestEnd(node: OtelTraceNode): number {
  let end = node.endMs ?? node.startMs;
  for (const n of walk(node)) end = Math.max(end, n.endMs ?? n.startMs);
  return end;
}

/** One trace as a list of root rows (the provisional row included when it has orphans). */
interface AssembledTrace {
  traceId: string;
  roots: OtelTraceNode[];
  hasInteraction: boolean;
  /** Has a provisional "turn in progress" row (some parent has not arrived yet). */
  hasPending: boolean;
  standalone: boolean;
  startMs: number;
  endMs: number;
}

function assembleTrace(traceId: string, spans: OtelSpanRow[]): AssembledTrace {
  const nodes = new Map<string, OtelTraceNode>();
  for (const s of spans) nodes.set(s.spanId, spanNode(s));
  const roots: OtelTraceNode[] = [];
  const orphans: OtelTraceNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.span?.parentSpanId ?? null;
    if (parentId === null) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (parent !== undefined && parent !== node) {
      parent.children.push(node);
    } else {
      node.orphan = true;
      orphans.push(node);
    }
  }
  // A parent cycle (malformed data) is reachable from no root: flatten its spans into orphans.
  const reached = new Set<OtelTraceNode>();
  for (const top of [...roots, ...orphans]) {
    for (const n of walk(top)) reached.add(n);
  }
  for (const node of nodes.values()) {
    if (reached.has(node)) continue;
    node.children = [];
    node.orphan = true;
    orphans.push(node);
  }
  if (orphans.length > 0) {
    orphans.sort(compareNodes);
    const pending: OtelTraceNode = {
      key: `pending:${traceId}`,
      span: null,
      depth: 0,
      children: orphans,
      orphan: false,
      standalone: false,
      startMs: Math.min(...orphans.map((o) => o.startMs)),
      endMs: null,
      costUsdMicros: null,
      rollupCostUsdMicros: orphans.reduce(
        (sum, o) => sum + o.rollupCostUsdMicros,
        0,
      ),
    };
    pending.endMs = latestEnd(pending);
    roots.push(pending);
  }
  for (const r of roots) setDepth(r, 0);
  roots.sort(compareNodes);
  const hasInteraction = spans.some((s) => s.name === OTEL_SPAN_INTERACTION);
  const standalone =
    !hasInteraction &&
    orphans.length === 0 &&
    roots.length > 0 &&
    roots.every((r) => r.span?.name === OTEL_SPAN_LLM_REQUEST);
  return {
    traceId,
    roots,
    hasInteraction,
    hasPending: orphans.length > 0,
    standalone,
    startMs: Math.min(...roots.map((r) => r.startMs)),
    endMs: Math.max(...roots.map(latestEnd)),
  };
}

function buildHeader(
  rows: OtelTraceNode[],
  outputByRequest: Map<string, number>,
): OtelTurnHeader {
  let startMs = Number.POSITIVE_INFINITY;
  let endMs = Number.NEGATIVE_INFINITY;
  let costUsdMicros = 0;
  let standaloneCostUsdMicros = 0;
  let hiddenCostUsdMicros = 0;
  let llmCalls = 0;
  let depth = 0;
  let spans = 0;
  let outputTokens = 0;
  const waiting: [number, number][] = [];
  for (const row of rows) {
    if (row.standalone) standaloneCostUsdMicros += row.rollupCostUsdMicros;
    else costUsdMicros += row.rollupCostUsdMicros;
    for (const n of walk(row)) {
      startMs = Math.min(startMs, n.startMs);
      endMs = Math.max(endMs, n.endMs ?? n.startMs);
      depth = Math.max(depth, n.depth);
      const span = n.span;
      if (span === null) continue;
      spans += 1;
      if (span.name === OTEL_SPAN_LLM_REQUEST) {
        llmCalls += 1;
        if (span.hidden === true) hiddenCostUsdMicros += n.costUsdMicros ?? 0;
        if (span.requestId !== null) {
          outputTokens += outputByRequest.get(span.requestId) ?? 0;
        }
      }
      if (span.name === OTEL_SPAN_BLOCKED_ON_USER && n.endMs !== null) {
        waiting.push([n.startMs, n.endMs]);
      }
    }
  }
  if (!Number.isFinite(startMs)) startMs = 0;
  if (!Number.isFinite(endMs)) endMs = startMs;
  const clipped = waiting.map(
    ([s, e]) => [Math.max(s, startMs), Math.min(e, endMs)] as const,
  );
  return {
    startMs,
    endMs,
    durationMs: endMs - startMs,
    costUsdMicros,
    standaloneCostUsdMicros,
    hiddenCostUsdMicros,
    llmCalls,
    depth,
    spans,
    waitingMs: unionIntervalsMs(clipped),
    outputTokens,
  };
}

/** The turn a standalone trace starting at `startMs` attaches to (DD-12 step 3). */
function attachTarget(
  turns: readonly AssembledTrace[],
  startMs: number,
): AssembledTrace | null {
  let containing: AssembledTrace | null = null;
  let latestBefore: AssembledTrace | null = null;
  for (const t of turns) {
    if (t.startMs <= startMs && startMs <= t.endMs) {
      if (containing === null || t.startMs > containing.startMs) containing = t;
    }
    if (t.startMs <= startMs) {
      if (latestBefore === null || t.startMs > latestBefore.startMs) {
        latestBefore = t;
      }
    }
  }
  return containing ?? latestBefore;
}

export function assembleOtelTraces(
  spans: readonly OtelSpanRow[],
  calls: readonly OtelCallRow[],
): OtelTurn[] {
  const byTrace = new Map<string, OtelSpanRow[]>();
  for (const s of spans) {
    const list = byTrace.get(s.traceId);
    if (list) list.push(s);
    else byTrace.set(s.traceId, [s]);
  }
  const outputByRequest = new Map<string, number>();
  for (const c of calls) {
    if (c.requestId === null) continue;
    outputByRequest.set(
      c.requestId,
      (outputByRequest.get(c.requestId) ?? 0) + c.outputTokens,
    );
  }

  const traces = [...byTrace.entries()].map(([id, list]) =>
    assembleTrace(id, list),
  );
  const turnTraces = traces.filter((t) => !t.standalone);
  const attached = new Map<string, OtelTraceNode[]>();
  const loneStandalone: AssembledTrace[] = [];
  for (const t of traces) {
    if (!t.standalone) continue;
    const target = attachTarget(turnTraces, t.startMs);
    if (target === null) {
      loneStandalone.push(t);
      continue;
    }
    for (const r of t.roots) r.standalone = true;
    const list = attached.get(target.traceId) ?? [];
    list.push(...t.roots);
    attached.set(target.traceId, list);
  }

  const turns: OtelTurn[] = [];
  for (const t of turnTraces) {
    const extra = (attached.get(t.traceId) ?? []).sort(compareNodes);
    const rows = [...t.roots, ...extra];
    turns.push({
      key: t.traceId,
      traceId: t.traceId,
      inProgress: t.hasPending,
      standaloneOnly: false,
      rows,
      header: buildHeader(rows, outputByRequest),
    });
  }
  for (const t of loneStandalone) {
    turns.push({
      key: t.traceId,
      traceId: t.traceId,
      inProgress: false,
      standaloneOnly: true,
      rows: t.roots,
      header: buildHeader(t.roots, outputByRequest),
    });
  }
  turns.sort(
    (a, b) =>
      a.header.startMs - b.header.startMs ||
      (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0),
  );
  return turns;
}

// --- Turn time split (FR-31) and turn order (FR-30) ------------------------------------------

/** The turn time split of the navigator's "Time" bar (DD-12, FR-31). All values in ms. */
export interface OtelTurnTimeSplit {
  durationMs: number;
  /** Union of the `blocked_on_user` intervals. */
  waitingMs: number;
  /** Union of the `llm_request` intervals (standalone rows included), minus waiting. */
  modelMs: number;
  /** Union of the `tool.execution` intervals, minus waiting and model. */
  toolMs: number;
  /** Duration minus the three above. */
  otherMs: number;
}

/**
 * Splits a turn's duration into waiting → model → tool → other (DD-12, FR-31).
 *
 * The `blocked_on_user`, `llm_request` and `tool.execution` intervals of every row of the turn
 * (attached standalone rows included) are clipped to the turn and assigned in priority order
 * waiting → model → tool, so each instant counts once: waiting = |W|, model = |W ∪ M| − |W|,
 * tool = |W ∪ M ∪ T| − |W ∪ M|, other = duration − the three. A span with no end yet is left
 * out (the same rule as the header's `waitingMs`); a running turn ends at its latest span end.
 */
export function splitOtelTurnTime(turn: OtelTurn): OtelTurnTimeSplit {
  const { startMs, endMs, durationMs } = turn.header;
  const waiting: [number, number][] = [];
  const model: [number, number][] = [];
  const tool: [number, number][] = [];
  for (const row of turn.rows) {
    for (const n of walk(row)) {
      if (n.span === null || n.endMs === null) continue;
      const iv: [number, number] = [
        Math.max(n.startMs, startMs),
        Math.min(n.endMs, endMs),
      ];
      if (n.span.name === OTEL_SPAN_BLOCKED_ON_USER) waiting.push(iv);
      else if (n.span.name === OTEL_SPAN_LLM_REQUEST) model.push(iv);
      else if (n.span.name === OTEL_SPAN_TOOL_EXECUTION) tool.push(iv);
    }
  }
  const w = unionIntervalsMs(waiting);
  const wm = unionIntervalsMs([...waiting, ...model]);
  const wmt = unionIntervalsMs([...waiting, ...model, ...tool]);
  return {
    durationMs,
    waitingMs: w,
    modelMs: wm - w,
    toolMs: wmt - wm,
    otherMs: Math.max(0, durationMs - wmt),
  };
}

/** Navigator turn order (FR-30). */
export type OtelTurnOrder = 'start' | 'cost' | 'slowest';

/**
 * Orders turns for the navigator (DD-12, FR-30): `start` (ascending, the default), `cost`
 * (interaction rollup, descending) or `slowest` (duration, descending); ties by start, then by
 * trace id. Returns a new array.
 */
export function orderOtelTurns(
  turns: readonly OtelTurn[],
  order: OtelTurnOrder,
): OtelTurn[] {
  const byStart = (a: OtelTurn, b: OtelTurn) =>
    a.header.startMs - b.header.startMs ||
    (a.traceId < b.traceId ? -1 : a.traceId > b.traceId ? 1 : 0);
  const primary = (a: OtelTurn, b: OtelTurn): number => {
    if (order === 'cost')
      return b.header.costUsdMicros - a.header.costUsdMicros;
    if (order === 'slowest') return b.header.durationMs - a.header.durationMs;
    return 0;
  };
  return [...turns].sort((a, b) => primary(a, b) || byStart(a, b));
}

/** Every node of a turn in display order (depth first), for the minimap and lookups. */
export function flattenOtelTurn(turn: OtelTurn): OtelTraceNode[] {
  const out: OtelTraceNode[] = [];
  for (const row of turn.rows) for (const n of walk(row)) out.push(n);
  return out;
}
