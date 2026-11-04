/**
 * Pure model of the Session Map tab (session-map impl-plan Design Decisions 13-17): tool
 * families, per-call cost, agent grouping into columns, the main / agent nodes, timeline bins and
 * ticks, and the per-time-position derivations (card state, header counters, highlight, order).
 *
 * `buildSessionMapModel` is memoised on the merged state by its caller; everything a scrub needs
 * (`stateAt`, `countersAt`, `highlightSet`, `orderAgents`) is O(agents + calls) over that model.
 */
import type { SessionLogLine, SubagentStats } from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import type {
  ModelPricingEntry,
  ModelPricingMap,
} from '../../../../../models/pricing';
import { computeCost } from '../../../../lib/format';
import {
  agentLogTimeSpan,
  extractSubagentStats,
  firstUserPromptText,
  parseSessionLogs,
} from '../log-parser';
import type {
  AgentActivation,
  ParsedSession,
  TokenBreakdown,
  ToolCallDetail,
} from '../types';
import { agentRowLabel } from '../workflow-agent-rows';
import type { SessionMapParseInputs } from './session-map-delta-merge';
import {
  AGENT_LABEL_MAX,
  FAMILIES,
  MAX_TICKS,
  TICK_STEPS_MIN,
  TIMELINE_BINS,
  TOP_N_HIGHLIGHT,
  type ToolFamilyId,
} from './session-map.constants';

// ---------------------------------------------------------------------------
// Tool families (DD-13)
// ---------------------------------------------------------------------------

/** The family of a tool name: the first `FAMILIES` row whose tools (or prefix) match, else `other`. */
export function toolFamily(name: string): ToolFamilyId {
  for (const f of FAMILIES) {
    if (f.prefix !== undefined && name.startsWith(f.prefix)) return f.id;
    if (f.tools.includes(name)) return f.id;
  }
  return 'other';
}

/** A failed call is one with status `error` or `rejected` (DD-13). */
export function isFailedCall(call: Pick<ToolCallDetail, 'status'>): boolean {
  return call.status === 'error' || call.status === 'rejected';
}

function emptyFamilyCounts(): Record<ToolFamilyId, number> {
  const counts = {} as Record<ToolFamilyId, number>;
  for (const f of FAMILIES) counts[f.id] = 0;
  return counts;
}

// ---------------------------------------------------------------------------
// Per-call cost (DD-15)
// ---------------------------------------------------------------------------

/** One slice of a node's priced total, placed at a timestamp. */
export interface MapCostEvent {
  /** Epoch ms. */
  t: number;
  cost: number;
  /** The `tool_use` block this slice belongs to; absent for a text-only message's share. */
  toolUseId?: string;
}

function stripModelDate(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

function pricingFor(
  pricing: ModelPricingMap | undefined,
  model: string | null | undefined,
): ModelPricingEntry | undefined {
  if (!pricing || !model) return undefined;
  return pricing[model] ?? pricing[stripModelDate(model)];
}

function timestampMs(rec: SessionLogLine): number | null {
  const ts = rec['timestamp'];
  if (typeof ts !== 'string') return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : ms;
}

/** One assistant response (all transcript lines sharing a `message.id`), deduplicated. */
interface AssistantMessage {
  /** First valid line timestamp of the message. */
  t: number | null;
  /** The last usage-carrying line of the message — the one the parser counts. */
  usageLine: SessionLogLine | null;
  toolUseIds: string[];
}

function assistantMessages(
  lines: readonly SessionLogLine[],
): AssistantMessage[] {
  const byKey = new Map<string, AssistantMessage>();
  const order: AssistantMessage[] = [];
  lines.forEach((rec, i) => {
    if (rec['type'] !== 'assistant') return;
    const msg = rec['message'] as
      | { id?: unknown; usage?: unknown; content?: unknown }
      | undefined;
    if (!msg || typeof msg !== 'object') return;
    const uuid = rec['uuid'];
    const key =
      typeof msg.id === 'string'
        ? `m:${msg.id}`
        : typeof uuid === 'string'
          ? `u:${uuid}`
          : `i:${i}`;
    let m = byKey.get(key);
    if (!m) {
      m = { t: null, usageLine: null, toolUseIds: [] };
      byKey.set(key, m);
      order.push(m);
    }
    const t = timestampMs(rec);
    if (m.t === null && t !== null) m.t = t;
    if (msg.usage && typeof msg.usage === 'object') m.usageLine = rec;
    if (Array.isArray(msg.content)) {
      for (const block of msg.content as unknown[]) {
        const b = block as { type?: unknown; id?: unknown };
        if (b?.type !== 'tool_use') continue;
        const id = typeof b.id === 'string' ? b.id : '';
        if (id !== '' && m.toolUseIds.includes(id)) continue;
        m.toolUseIds.push(id);
      }
    }
  });
  return order;
}

/** Breakdown and model of one usage line, through the parser's own usage extraction. */
function lineUsage(rec: SessionLogLine): {
  model: string | null;
  tokens: TokenBreakdown;
} {
  return extractSubagentStats([rec]);
}

/**
 * Message weight = `computeCost` of the message's own usage (deduplicated by `message.id`, last
 * usage line), priced by the message's model or `fallbackModel`. Unknown price → weight 0.
 */
function messageWeight(
  m: AssistantMessage,
  pricing: ModelPricingMap | undefined,
  fallbackModel: string | null,
): number {
  if (!m.usageLine) return 0;
  const { model, tokens } = lineUsage(m.usageLine);
  const entry = pricingFor(pricing, model ?? fallbackModel);
  return entry ? computeCost(tokens, entry) : 0;
}

/**
 * Spreads a node's priced `total` over its own transcript (DD-15): each assistant message gets
 * `total × weight / Σweight` at its timestamp; a message with N `tool_use` blocks splits its share
 * evenly over them; a text-only message keeps its share. When `Σweight = 0` (or no message has a
 * timestamp) the whole total sits at `firstMs`. Messages without a timestamp are placed at
 * `firstMs`. The events always sum to `total`.
 */
export function perCallCosts(
  lines: readonly SessionLogLine[],
  total: number,
  pricing: ModelPricingMap | undefined,
  fallbackModel: string | null,
  firstMs: number | null,
): MapCostEvent[] {
  if (total <= 0) return [];
  const messages = assistantMessages(lines);
  const weights = messages.map((m) => messageWeight(m, pricing, fallbackModel));
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0) {
    return firstMs === null ? [] : [{ t: firstMs, cost: total }];
  }
  const events: MapCostEvent[] = [];
  messages.forEach((m, i) => {
    const w = weights[i];
    if (w <= 0) return;
    const t = m.t ?? firstMs;
    if (t === null) return;
    const share = (total * w) / sum;
    if (m.toolUseIds.length === 0) {
      events.push({ t, cost: share });
      return;
    }
    const each = share / m.toolUseIds.length;
    for (const id of m.toolUseIds) {
      events.push(
        id !== '' ? { t, cost: each, toolUseId: id } : { t, cost: each },
      );
    }
  });
  return events;
}

/** Peak context of a transcript: max `input + cacheRead + cacheWrite` over its messages. */
function peakContext(lines: readonly SessionLogLine[]): number | null {
  let peak: number | null = null;
  for (const m of assistantMessages(lines)) {
    if (!m.usageLine) continue;
    const { tokens } = lineUsage(m.usageLine);
    const ctx = tokens.input + tokens.cacheRead + tokens.cacheWrite;
    if (ctx > 0 && (peak === null || ctx > peak)) peak = ctx;
  }
  return peak;
}

function statsBreakdown(s: SubagentStats): TokenBreakdown {
  return {
    input: s.inputTokens,
    output: s.outputTokens,
    cacheRead: s.cacheReadTokens,
    cacheWrite: s.cacheWriteTokens,
    // session_stats carries no TTL split: all to the 5m bucket, as buildAgentNodesForIds does.
    cacheWrite5m: s.cacheWriteTokens,
    cacheWrite1h: 0,
    webSearchRequests: s.webSearchRequests ?? 0,
    inputFast: s.inputTokensFast ?? 0,
    outputFast: s.outputTokensFast ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Grouping (DD-14)
// ---------------------------------------------------------------------------

/** Input row of {@link groupAgents}: one agent with its DB linkage (ids unprefixed). */
export interface GroupAgentInput {
  agentId: string;
  /** Parent agentId (unprefixed) or `null` / the root's id for a depth-1 agent. */
  parentId: string | null;
  workflowRunId: string | null;
  /** First activity, epoch ms. */
  startMs: number | null;
}

export type MapColumnKind = 'workflow' | 'direct';

/** One column: a workflow run or the "Agents spawned by the main session" column. */
export interface AgentColumnLayout {
  /** `wf-<workflowRunId>` or `direct`. */
  key: string;
  kind: MapColumnKind;
  label: string;
  /** The matched / assumed `WorkflowRun`, `null` for the direct column or an unlabelled run. */
  run: WorkflowRun | null;
  workflowRunId: string | null;
  /** Earliest `startMs` of every agent in the column (nested ones included). */
  startMs: number | null;
  /** Top-level agents of the column, input order. */
  rootIds: string[];
}

export interface AgentGrouping {
  columns: AgentColumnLayout[];
  /** agentId → parent agentId, only for nested agents. */
  nestedParent: Map<string, string>;
  /** agentId → its children agentIds, input order. */
  children: Map<string, string[]>;
  /** agentId → column key. */
  columnOf: Map<string, string>;
}

export const DIRECT_COLUMN_KEY = 'direct';
export const DIRECT_COLUMN_LABEL = 'Agents spawned by the main session';
export const UNNAMED_RUN_LABEL = 'workflow run';

function compareStart(a: number | null, b: number | null): number {
  if (a !== null && b !== null) return a - b;
  if (a !== null) return -1;
  if (b !== null) return 1;
  return 0;
}

/**
 * Places agents into columns (DD-14): an agent whose parent is another agent is nested under it;
 * a top-level agent with a `workflowRunId` goes to that run's column (matched by `wfId`, or —
 * while the run is still running — labelled from the k-th `running` run in `toolUseId` order);
 * any other top-level agent goes to the direct column. Workflow columns are ordered by start,
 * the direct column is last and omitted when empty.
 */
export function groupAgents(
  agents: readonly GroupAgentInput[],
  workflows: readonly WorkflowRun[],
): AgentGrouping {
  const byId = new Map<string, GroupAgentInput>();
  for (const a of agents) if (!byId.has(a.agentId)) byId.set(a.agentId, a);

  const nestedParent = new Map<string, string>();
  const children = new Map<string, string[]>();
  for (const a of byId.values()) {
    const p = a.parentId;
    if (p !== null && p !== a.agentId && byId.has(p)) {
      nestedParent.set(a.agentId, p);
      const list = children.get(p) ?? [];
      list.push(a.agentId);
      children.set(p, list);
    }
  }

  // Break parent cycles (corrupt linkage): the agent whose parent edge closes the cycle
  // becomes top-level, so every agent still lands in exactly one column.
  for (const id of [...nestedParent.keys()]) {
    const seen = new Set<string>([id]);
    let cur = id;
    for (;;) {
      const p = nestedParent.get(cur);
      if (p === undefined) break;
      if (seen.has(p)) {
        nestedParent.delete(cur);
        children.set(
          p,
          (children.get(p) ?? []).filter((c) => c !== cur),
        );
        break;
      }
      seen.add(p);
      cur = p;
    }
  }

  const columnRoots = new Map<string, string[]>();
  const columnRunId = new Map<string, string | null>();
  const tops: string[] = [];
  for (const a of byId.values()) {
    if (nestedParent.has(a.agentId)) continue;
    tops.push(a.agentId);
    const key =
      a.workflowRunId != null ? `wf-${a.workflowRunId}` : DIRECT_COLUMN_KEY;
    const list = columnRoots.get(key) ?? [];
    list.push(a.agentId);
    columnRoots.set(key, list);
    columnRunId.set(key, a.workflowRunId ?? null);
  }

  const columnOf = new Map<string, string>();
  const columnStart = new Map<string, number | null>();
  const visit = (id: string, key: string): void => {
    columnOf.set(id, key);
    const s = byId.get(id)?.startMs ?? null;
    const cur = columnStart.get(key) ?? null;
    if (s !== null && (cur === null || s < cur)) columnStart.set(key, s);
    for (const c of children.get(id) ?? []) visit(c, key);
  };
  for (const [key, roots] of columnRoots) {
    columnStart.set(key, null);
    for (const r of roots) visit(r, key);
  }

  const wfKeys = [...columnRoots.keys()]
    .filter((k) => k !== DIRECT_COLUMN_KEY)
    .sort(
      (a, b) =>
        compareStart(columnStart.get(a) ?? null, columnStart.get(b) ?? null) ||
        (a < b ? -1 : a > b ? 1 : 0),
    );

  const runByWfId = new Map<string, WorkflowRun>();
  for (const r of workflows) if (r.wfId != null) runByWfId.set(r.wfId, r);
  const runningRuns = workflows
    .filter((r) => r.status === 'running' && r.wfId == null)
    .slice()
    .sort((a, b) =>
      a.toolUseId < b.toolUseId ? -1 : a.toolUseId > b.toolUseId ? 1 : 0,
    );

  let runningRank = 0;
  const columns: AgentColumnLayout[] = wfKeys.map((key, i) => {
    const workflowRunId = columnRunId.get(key) ?? null;
    let run: WorkflowRun | null =
      workflowRunId !== null ? (runByWfId.get(workflowRunId) ?? null) : null;
    if (run === null) {
      run = runningRuns[runningRank] ?? null;
      runningRank++;
    }
    return {
      key,
      kind: 'workflow',
      label: run ? `${run.name} · run #${i + 1}` : UNNAMED_RUN_LABEL,
      run,
      workflowRunId,
      startMs: columnStart.get(key) ?? null,
      rootIds: columnRoots.get(key) ?? [],
    };
  });
  const directRoots = columnRoots.get(DIRECT_COLUMN_KEY);
  if (directRoots && directRoots.length > 0) {
    columns.push({
      key: DIRECT_COLUMN_KEY,
      kind: 'direct',
      label: DIRECT_COLUMN_LABEL,
      run: null,
      workflowRunId: null,
      startMs: columnStart.get(DIRECT_COLUMN_KEY) ?? null,
      rootIds: directRoots,
    });
  }

  return { columns, nestedParent, children, columnOf };
}

// ---------------------------------------------------------------------------
// Model (DD-14..17)
// ---------------------------------------------------------------------------

/** One tool call on the map, placed at its `startedAt` (or the node's first activity). */
export interface MapCallEvent {
  /** Epoch ms; `null` when neither the call nor its node has a timestamp. */
  t: number | null;
  toolUseId?: string;
  name: string;
  family: ToolFamilyId;
  failed: boolean;
  call: ToolCallDetail;
}

export interface MapToolCount {
  name: string;
  count: number;
}

export interface MapNode {
  /** `main`, or the agentId without the `agent-` prefix. */
  id: string;
  kind: 'main' | 'agent';
  label: string;
  model: string | null;
  /** Priced total of the node's own tokens, USD. */
  cost: number;
  /** `cost / tree total`, 0 when the tree total is 0. */
  share: number;
  familyCounts: Record<ToolFamilyId, number>;
  /** Top 3 tools by call count (ties by name). */
  topTools: MapToolCount[];
  calls: number;
  failures: number;
  peakContext: number | null;
  /** Context window of the node's model, `null` when unknown. */
  contextLength: number | null;
  /** First / last activity, epoch ms. */
  f: number | null;
  l: number | null;
  /** The node has ended (DD-16); only used at "now" while live. */
  finished: boolean;
  events: MapCallEvent[];
  costEvents: MapCostEvent[];
}

export interface MapAgentNode extends MapNode {
  kind: 'agent';
  /** `agent-<id>`, the DB `sessions.session_id`. */
  sessionId: string;
  /** Parent agent id when nested, else `null`. */
  parentId: string | null;
  workflowRunId: string | null;
  columnKey: string;
  depth: number;
  children: MapAgentNode[];
}

export interface MapColumn extends Omit<AgentColumnLayout, 'rootIds'> {
  roots: MapAgentNode[];
  /** Σ cost / calls / failures of every agent in the column (nested ones included). */
  cost: number;
  calls: number;
  failures: number;
  /** Latest `l` of the column's agents. */
  endMs: number | null;
}

export interface MapTimelineBin {
  start: number;
  end: number;
  familyCounts: Record<ToolFamilyId, number>;
  failures: number;
  cost: number;
  /** Cumulative cost at the bin's end. */
  cumulativeCost: number;
}

export interface MapTimeline {
  start: number;
  end: number;
  bins: MapTimelineBin[];
  /** Epoch ms of each tick. */
  ticks: number[];
  tickStepMin: number;
}

export interface SessionMapModel {
  main: MapNode;
  /** Every agent, flat, in input order. */
  agents: MapAgentNode[];
  agentsById: Map<string, MapAgentNode>;
  columns: MapColumn[];
  /** main + every agent. */
  treeCost: number;
  /** Max agent cost — the `zoneColor` scale. */
  maxAgentCost: number;
  sessionStart: number | null;
  sessionEnd: number | null;
  timeline: MapTimeline | null;
  live: boolean;
}

export interface SessionMapTiming {
  live: boolean;
  /** Server clock in epoch ms; extends the timeline end while live. */
  serverTimeMs: number | null;
}

function dedupeCalls(calls: readonly ToolCallDetail[]): ToolCallDetail[] {
  const seen = new Set<string>();
  return calls.filter((c) => {
    if (c.id === undefined) return true;
    if (seen.has(c.id)) return false;
    seen.add(c.id);
    return true;
  });
}

function topTools(calls: readonly ToolCallDetail[]): MapToolCount[] {
  const counts = new Map<string, number>();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (a, b) =>
        b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )
    .slice(0, 3);
}

interface NodeCore {
  calls: ToolCallDetail[];
  lines: readonly SessionLogLine[];
  model: string | null;
  cost: number;
  f: number | null;
  l: number | null;
}

function buildNodeFields(
  core: NodeCore,
  pricing: ModelPricingMap | undefined,
  fallbackMs: number | null,
): Omit<MapNode, 'id' | 'kind' | 'label' | 'share' | 'finished'> {
  const familyCounts = emptyFamilyCounts();
  let failures = 0;
  const events: MapCallEvent[] = core.calls.map((call) => {
    const family = toolFamily(call.name);
    familyCounts[family]++;
    const failed = isFailedCall(call);
    if (failed) failures++;
    const started =
      call.startedAt !== undefined ? Date.parse(call.startedAt) : NaN;
    const t = Number.isNaN(started) ? core.f : started;
    return {
      t,
      ...(call.id !== undefined ? { toolUseId: call.id } : {}),
      name: call.name,
      family,
      failed,
      call,
    };
  });
  return {
    model: core.model,
    cost: core.cost,
    familyCounts,
    topTools: topTools(core.calls),
    calls: core.calls.length,
    failures,
    peakContext: peakContext(core.lines),
    contextLength: pricingFor(pricing, core.model)?.contextLength ?? null,
    f: core.f,
    l: core.l,
    events,
    costEvents: perCallCosts(
      core.lines,
      core.cost,
      pricing,
      core.model,
      core.f ?? fallbackMs,
    ),
  };
}

function truncateLabel(text: string): string {
  return text.length > AGENT_LABEL_MAX
    ? `${text.slice(0, AGENT_LABEL_MAX - 1)}…`
    : text;
}

function tickStep(spanMs: number): number {
  const spanMin = spanMs / 60_000;
  for (const step of TICK_STEPS_MIN) {
    if (Math.floor(spanMin / step) + 1 <= MAX_TICKS) return step;
  }
  const last = TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1] ?? 60;
  return last * Math.ceil(spanMin / last / (MAX_TICKS - 1));
}

/**
 * Timeline (DD-17): `TIMELINE_BINS` equal bins over `[start, end]`, per-family call counts,
 * failures and cost per bin plus the cumulative cost; ticks every 5 / 10 / 30 / 60 min from
 * `start`, whichever first gives at most `MAX_TICKS`.
 */
export function buildTimeline(
  nodes: readonly MapNode[],
  start: number,
  end: number,
): MapTimeline {
  const span = Math.max(0, end - start);
  const width = span > 0 ? span / TIMELINE_BINS : 0;
  const bins: MapTimelineBin[] = [];
  for (let i = 0; i < TIMELINE_BINS; i++) {
    bins.push({
      start: start + i * width,
      end: i === TIMELINE_BINS - 1 ? end : start + (i + 1) * width,
      familyCounts: emptyFamilyCounts(),
      failures: 0,
      cost: 0,
      cumulativeCost: 0,
    });
  }
  const binOf = (t: number): number => {
    if (width <= 0) return 0;
    const i = Math.floor((t - start) / width);
    return Math.min(TIMELINE_BINS - 1, Math.max(0, i));
  };
  for (const n of nodes) {
    for (const e of n.events) {
      if (e.t === null) continue;
      const b = bins[binOf(e.t)];
      b.familyCounts[e.family]++;
      if (e.failed) b.failures++;
    }
    for (const c of n.costEvents) bins[binOf(c.t)].cost += c.cost;
  }
  let cum = 0;
  for (const b of bins) {
    cum += b.cost;
    b.cumulativeCost = cum;
  }
  const step = tickStep(span);
  const ticks: number[] = [];
  const stepMs = step * 60_000;
  for (let t = start; t <= end && ticks.length < MAX_TICKS; t += stepMs) {
    ticks.push(t);
  }
  return { start, end, bins, ticks, tickStepMin: step };
}

/**
 * Builds the Session Map model from the root's parsed session and the parse inputs
 * (`toParseInputs`). Agents are the `claude-subagent` sessions with an `agent-` id, i.e. every
 * key of `inputs.subagentLogs`; each one's transcript is parsed once here.
 */
export function buildSessionMapModel(
  parsed: ParsedSession,
  inputs: SessionMapParseInputs,
  pricing: ModelPricingMap | undefined,
  timing: SessionMapTiming = { live: false, serverTimeMs: null },
): SessionMapModel {
  // --- main node -----------------------------------------------------------
  const mainSpan = agentLogTimeSpan(inputs.main);
  const mainModel = parsed.summary.model ?? null;
  const mainCalls = dedupeCalls(parsed.turns.flatMap((t) => t.allToolCalls));
  const ended = new Set<string>();
  const markEnded = (acts: readonly AgentActivation[]): void => {
    for (const a of acts) if (a.endMs !== undefined) ended.add(a.agentId);
  };
  markEnded(parsed.turns.flatMap((t) => t.agentActivations));
  const mainCost = assistantMessages(inputs.main).reduce(
    (s, m) => s + messageWeight(m, pricing, mainModel),
    0,
  );

  // --- agents --------------------------------------------------------------
  interface AgentDraft {
    agentId: string;
    core: NodeCore;
    prompt: string;
  }
  const drafts: AgentDraft[] = [];
  for (const [agentId, logs] of inputs.subagentLogs) {
    const agentParsed = parseSessionLogs(logs, { isSubagent: true, pricing });
    markEnded(agentParsed.turns.flatMap((t) => t.agentActivations));
    const span = agentLogTimeSpan(logs);
    const own = extractSubagentStats(logs);
    const stats: SubagentStats | undefined =
      inputs.subagentStats[`agent-${agentId}`];
    const model = stats?.model ?? own.model;
    // FR-6: the server-chosen OTEL cost replaces the token×price estimate when it is set.
    const otelCostUsd = (stats ?? inputs.subagentStats[agentId])?.otelCostUsd;
    let cost = 0;
    if (otelCostUsd != null) {
      cost = otelCostUsd;
    } else if (stats) {
      const entry = pricingFor(pricing, stats.model ?? own.model);
      if (entry) cost = computeCost(statsBreakdown(stats), entry);
    } else {
      const entry = pricingFor(pricing, own.model);
      if (entry) cost = computeCost(own.tokens, entry);
    }
    drafts.push({
      agentId,
      prompt: firstUserPromptText(logs),
      core: {
        calls: dedupeCalls(agentParsed.turns.flatMap((t) => t.allToolCalls)),
        lines: logs,
        model,
        cost,
        f: span.startMs ?? null,
        l: span.endMs ?? null,
      },
    });
  }

  const grouping = groupAgents(
    drafts.map((d) => ({
      agentId: d.agentId,
      parentId: inputs.agentParentMap.get(d.agentId) ?? null,
      workflowRunId: inputs.workflowRunIds.get(d.agentId) ?? null,
      startMs: d.core.f,
    })),
    inputs.workflows,
  );

  const runByWfId = new Map<string, WorkflowRun>();
  for (const r of inputs.workflows)
    if (r.wfId != null) runByWfId.set(r.wfId, r);
  const runOfColumn = new Map<string, WorkflowRun | null>();
  for (const c of grouping.columns) runOfColumn.set(c.key, c.run);

  const fallbackMs = mainSpan.startMs ?? null;
  const agents: MapAgentNode[] = drafts.map((d) => {
    const workflowRunId = inputs.workflowRunIds.get(d.agentId) ?? null;
    const columnKey = grouping.columnOf.get(d.agentId) ?? DIRECT_COLUMN_KEY;
    const run =
      workflowRunId !== null
        ? (runByWfId.get(workflowRunId) ??
          (grouping.nestedParent.has(d.agentId)
            ? null
            : (runOfColumn.get(columnKey) ?? null)))
        : null;
    const finished =
      ended.has(d.agentId) || (run !== null && run.status !== 'running');
    return {
      id: d.agentId,
      kind: 'agent',
      sessionId: `agent-${d.agentId}`,
      label: truncateLabel(
        agentRowLabel({
          agentId: d.agentId,
          prompt: d.prompt,
          agentDescription: inputs.agentDescriptions.get(d.agentId),
          children: [],
        }),
      ),
      share: 0,
      finished,
      parentId: grouping.nestedParent.get(d.agentId) ?? null,
      workflowRunId,
      columnKey,
      depth: 0,
      children: [],
      ...buildNodeFields(d.core, pricing, fallbackMs),
    };
  });
  const agentsById = new Map<string, MapAgentNode>();
  for (const a of agents) agentsById.set(a.id, a);
  for (const a of agents) {
    for (const c of grouping.children.get(a.id) ?? []) {
      const child = agentsById.get(c);
      if (child) a.children.push(child);
    }
  }
  const setDepth = (n: MapAgentNode, depth: number): void => {
    n.depth = depth;
    for (const c of n.children) setDepth(c, depth + 1);
  };

  const main: MapNode = {
    id: 'main',
    kind: 'main',
    label: 'Main session',
    share: 0,
    finished: false,
    ...buildNodeFields(
      {
        calls: mainCalls,
        lines: inputs.main,
        model: mainModel,
        cost: mainCost,
        f: mainSpan.startMs ?? null,
        l: mainSpan.endMs ?? null,
      },
      pricing,
      null,
    ),
  };

  const treeCost = agents.reduce((s, a) => s + a.cost, main.cost);
  main.share = treeCost > 0 ? main.cost / treeCost : 0;
  let maxAgentCost = 0;
  for (const a of agents) {
    a.share = treeCost > 0 ? a.cost / treeCost : 0;
    if (a.cost > maxAgentCost) maxAgentCost = a.cost;
  }

  const columns: MapColumn[] = grouping.columns.map((c) => {
    const roots = c.rootIds
      .map((id) => agentsById.get(id))
      .filter((n): n is MapAgentNode => n !== undefined);
    let cost = 0;
    let calls = 0;
    let failures = 0;
    let endMs: number | null = null;
    const walk = (n: MapAgentNode): void => {
      cost += n.cost;
      calls += n.calls;
      failures += n.failures;
      if (n.l !== null && (endMs === null || n.l > endMs)) endMs = n.l;
      n.children.forEach(walk);
    };
    for (const r of roots) {
      setDepth(r, 0);
      walk(r);
    }
    return {
      key: c.key,
      kind: c.kind,
      label: c.label,
      run: c.run,
      workflowRunId: c.workflowRunId,
      startMs: c.startMs,
      roots,
      cost,
      calls,
      failures,
      endMs,
    };
  });

  // --- session span and timeline ------------------------------------------
  let sessionStart: number | null = null;
  let sessionEnd: number | null = null;
  for (const n of [main, ...agents]) {
    if (n.f !== null && (sessionStart === null || n.f < sessionStart))
      sessionStart = n.f;
    if (n.l !== null && (sessionEnd === null || n.l > sessionEnd))
      sessionEnd = n.l;
  }
  if (
    timing.live &&
    timing.serverTimeMs !== null &&
    sessionStart !== null &&
    (sessionEnd === null || timing.serverTimeMs > sessionEnd)
  ) {
    sessionEnd = timing.serverTimeMs;
  }
  const timeline =
    sessionStart !== null && sessionEnd !== null
      ? buildTimeline([main, ...agents], sessionStart, sessionEnd)
      : null;

  return {
    main,
    agents,
    agentsById,
    columns,
    treeCost,
    maxAgentCost,
    sessionStart,
    sessionEnd,
    timeline,
    live: timing.live,
  };
}

// ---------------------------------------------------------------------------
// Per-time-position derivations (DD-16)
// ---------------------------------------------------------------------------

export type MapNodeState = 'future' | 'running' | 'done';

/**
 * Card state at time position `t` (DD-16): `future` before `f`; `running` within `[f, l]`, or at
 * "now" while live for an unfinished node with `t ≥ f`; `done` otherwise. Replay (`live` false)
 * never uses the "not finished" clause. A node without activity is `done`.
 */
export function stateAt(
  node: Pick<MapNode, 'f' | 'l' | 'finished'>,
  t: number,
  opts: { live: boolean; atNow: boolean },
): MapNodeState {
  if (node.f === null) return 'done';
  if (t < node.f) return 'future';
  if (node.l !== null && t <= node.l) return 'running';
  if (opts.live && opts.atNow && !node.finished) return 'running';
  return 'done';
}

export interface MapCounters {
  /** `t − sessionStart`, ≥ 0. */
  elapsedMs: number;
  costSoFar: number;
  costTotal: number;
  agentsStarted: number;
  agentsTotal: number;
  calls: number;
  failed: number;
}

/** Header counters at time position `t` (DD-16). */
export function countersAt(model: SessionMapModel, t: number): MapCounters {
  let costSoFar = 0;
  let calls = 0;
  let failed = 0;
  let agentsStarted = 0;
  const count = (n: MapNode): void => {
    for (const c of n.costEvents) if (c.t <= t) costSoFar += c.cost;
    for (const e of n.events) {
      if (e.t === null || e.t > t) continue;
      calls++;
      if (e.failed) failed++;
    }
  };
  count(model.main);
  for (const a of model.agents) {
    count(a);
    if (a.f !== null && a.f <= t) agentsStarted++;
  }
  return {
    elapsedMs:
      model.sessionStart !== null ? Math.max(0, t - model.sessionStart) : 0,
    costSoFar,
    costTotal: model.treeCost,
    agentsStarted,
    agentsTotal: model.agents.length,
    calls,
    failed,
  };
}

export type HighlightMode = 'none' | 'top' | 'failed';

/**
 * Agents to keep highlighted (everything else is dimmed): the top `TOP_N_HIGHLIGHT` agents by
 * cost (ties by id), or every agent with a failed call. `null` for `none` = nothing dimmed.
 */
export function highlightSet(
  model: Pick<SessionMapModel, 'agents'>,
  mode: HighlightMode,
): ReadonlySet<string> | null {
  if (mode === 'none') return null;
  if (mode === 'failed') {
    return new Set(model.agents.filter((a) => a.failures > 0).map((a) => a.id));
  }
  const top = model.agents
    .slice()
    .sort((a, b) => b.cost - a.cost || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, TOP_N_HIGHLIGHT);
  return new Set(top.map((a) => a.id));
}

export type AgentOrder = 'start' | 'cost';

/**
 * Sorted copy of a sibling list: `start` = by first activity ascending (no activity last),
 * `cost` = by cost descending; ties by start, then id.
 */
export function orderAgents<T extends Pick<MapNode, 'id' | 'f' | 'cost'>>(
  agents: readonly T[],
  order: AgentOrder,
): T[] {
  const byId = (a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return agents.slice().sort((a, b) => {
    if (order === 'cost') {
      return b.cost - a.cost || compareStart(a.f, b.f) || byId(a, b);
    }
    return compareStart(a.f, b.f) || byId(a, b);
  });
}

/** One card row of a column: the agent and its nesting depth. */
export interface MapColumnRow {
  node: MapAgentNode;
  depth: number;
}

/** A column flattened depth-first, each sibling group sorted by {@link orderAgents}. */
export function columnRows(
  column: MapColumn,
  order: AgentOrder,
): MapColumnRow[] {
  const rows: MapColumnRow[] = [];
  const walk = (nodes: readonly MapAgentNode[], depth: number): void => {
    for (const n of orderAgents(nodes, order)) {
      rows.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(column.roots, 0);
  return rows;
}
