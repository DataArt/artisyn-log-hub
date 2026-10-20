// Native chart-data transforms built directly from the parsed session model
// (`ParsedSession` / `PromptTurn`). These feed the Gantt, Agent-tree and
// Tool-heatmap renderers. No `Trace` model and no `SelectionContext` —
// everything the charts need is derived from what the log parser already
// captures, plus model pricing for cost.
//
// Fidelity notes (data the parser does not capture today):
//  - Per-turn cost is DERIVED from the turn token breakdown × model pricing.
//  - Tool-call error flags are NOT recorded, so the heatmap has no error dots.

import type { ModelPricingMap } from '../../../../../models/pricing';
import type { WorkflowRun } from '../../../../../models/workflows';
import { computeCost } from '../../../../lib/format';
import {
  buildChildrenByParentMap,
  parseSessionLogs,
  stripAgentPrefix,
} from '../log-parser';
import type {
  AgentActivation,
  ParsedSession,
  PromptTurn,
  TokenBreakdown,
} from '../types';

/** Per-agent log files keyed by agentId (the `agent-` prefix already stripped). */
export type SubagentLogsMap = Map<string, Record<string, unknown>[]>;

// --- Output shapes (consumed by the renderers) ---

/**
 * A sub-segment rendered inside a block's bar, positioned by fraction of the
 * bar's width (0–1). Used to show an agent's inner steps, and the main lane's
 * "waiting on children" span.
 */
export interface TimelineSegment {
  /** Left edge as a fraction (0–1) of the parent bar's width. */
  startFrac: number;
  /** Width as a fraction (0–1) of the parent bar's width. */
  widthFrac: number;
  label: string;
  kind: 'step' | 'waiting';
}

export interface TimelineBlock {
  turnId: string;
  agentLabel: string;
  laneIndex: number;
  startOffset: number;
  durationMs: number;
  rawDurationMs: number;
  toolCallCount: number;
  /** `null` when the block's model has no pricing row — never `0`. */
  cost: number | null;
  model?: string;
  /** Inner steps / waiting overlay drawn within this bar (relative fractions). */
  segments?: TimelineSegment[];
}

export interface UserMarker {
  offset: number;
  content: string;
  isCommand: boolean;
}

export interface TimelineLane {
  index: number;
  label: string;
  isBackground: boolean;
}

export interface TimelineData {
  blocks: TimelineBlock[];
  userMarkers: UserMarker[];
  lanes: TimelineLane[];
  totalDurationMs: number;
}

export interface HeatmapCell {
  /** 0-based column index (a step: the primary agent or a sub-agent). */
  turnIndex: number;
  toolName: string;
  count: number;
}

export interface HeatmapData {
  cells: HeatmapCell[];
  toolNames: string[];
  /** Number of columns (= number of steps). */
  turnCount: number;
  /** Per-column labels (step names), index-aligned to the column index. */
  columnLabels: string[];
}

export interface AgentNode {
  agentId: string;
  slug: string;
  prompt: string;
  model: string;
  isBackground: boolean;
  isGroup: boolean; // synthetic "parallel group" container
  /** Synthetic "workflow run" node — a real unit of work, not just a visual grouping. */
  isWorkflow?: boolean;
  /**
   * `null` when nothing under this node could be priced (unknown model). A group/workflow
   * node sums only its priced children and stays `null` if none of them were priced.
   */
  totalCost: number | null;
  totalDurationMs: number;
  turnCount: number;
  inputTokens: number;
  outputTokens: number;
  children: AgentNode[];
}

// --- Shared helpers ---

function emptyBreakdown(): TokenBreakdown {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearchRequests: 0,
    inputFast: 0,
    outputFast: 0,
  };
}

/**
 * Per-turn cost derived from its token breakdown and the session model price, or `null`
 * when the cost is not knowable — no breakdown, no model, or no `model_pricing` row for it.
 *
 * `null`, never `0`: a $0 point is a claim that the turn was free, which drags every
 * cost average down and draws an unpriced session's cost line flat along the axis. Recharts
 * breaks a line on `null` with its default `connectNulls={false}`, so an unpriced turn
 * renders as an honest gap in the series instead.
 */
function turnCost(
  breakdown: TokenBreakdown | null | undefined,
  model: string | undefined,
  pricing: ModelPricingMap | null | undefined,
): number | null {
  if (!breakdown || !model || !pricing) return null;
  const entry = pricing[model];
  if (!entry) return null;
  return computeCost(breakdown, entry);
}

/**
 * Sums a mix of priced and unpriced costs: only the priced ones contribute, and the result
 * is `null` when nothing was priced at all. Coercing the `null`s to `0` instead would report
 * an unpriced sub-tree as a genuine $0.0000 rollup.
 */
function sumPricedCosts(costs: (number | null)[]): number | null {
  let total = 0;
  let anyPriced = false;
  for (const cost of costs) {
    if (cost == null) continue;
    total += cost;
    anyPriced = true;
  }
  return anyPriced ? total : null;
}

function truncateContent(content: string | undefined, max = 60): string {
  if (!content) return '';
  const line = content.split('\n')[0] ?? '';
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1)}…`;
}

/** First-line text of a user turn — used for timeline markers. */
function userTurnText(turn: PromptTurn): string {
  const content = turn.userEvent.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b.type === 'text' && b.text);
    return textBlock?.text ?? '';
  }
  return '';
}

/** Total tool calls a turn issued, across every category the parser tracks. */
export function turnToolCallCount(turn: PromptTurn): number {
  return (
    turn.toolCalls.length +
    turn.skills.length +
    turn.files.length +
    turn.images.length +
    turn.agentActivations.length
  );
}

/** Map of tool-name → count for a single turn (drives the heatmap). */
function turnToolCounts(turn: PromptTurn): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (name: string, n = 1) =>
    counts.set(name, (counts.get(name) ?? 0) + n);

  for (const t of turn.toolCalls) add(t.name);
  for (const f of turn.files) add(f.tool);
  if (turn.skills.length > 0) add('Skill', turn.skills.length);
  for (const img of turn.images) add(img.toolName);
  if (turn.agentActivations.length > 0)
    add('Agent', turn.agentActivations.length);
  return counts;
}

// --- Agent activation enrichment ---

/**
 * Resolved view of an agent activation, enriched from its per-agent log file
 * when available. Falls back to the activation's own reported values otherwise.
 */
export interface ResolvedAgent {
  agentId: string;
  /** Human label for the agent (description, falling back to `agent-<id>`). */
  label: string;
  durationMs: number;
  /** Epoch ms of the agent's start (for ordering / overlap detection). */
  startMs?: number;
  /** Epoch ms of the agent's end. */
  endMs?: number;
  toolCallCount: number;
  /** Inner tool-name → count, aggregated across the agent's turns. */
  toolCounts: Map<string, number>;
  tokens: TokenBreakdown;
  inputTokens: number;
  outputTokens: number;
  model: string | undefined;
  /** Parsed inner turns (empty when no subagent log is available). */
  innerTurns: PromptTurn[];
  /** Nested agent activations discovered inside the subagent log. */
  nestedActivations: AgentActivation[];
}

/**
 * Build inner-step segments for an agent, positioned as fractions of the
 * agent's [startMs, endMs] span. Each inner turn (a user→assistant cycle in the
 * agent's own log) becomes one "step" segment. Returns [] when timing is
 * unavailable so the bar renders solid.
 */
function innerStepSegments(agent: ResolvedAgent): TimelineSegment[] {
  if (
    agent.startMs === undefined ||
    agent.endMs === undefined ||
    agent.innerTurns.length === 0
  ) {
    return [];
  }
  const agentStart = agent.startMs;
  const span = agent.endMs - agentStart;
  if (span <= 0) return [];

  const segments: TimelineSegment[] = [];
  agent.innerTurns.forEach((t, i) => {
    const ts = t.userEvent.timestamp ? Date.parse(t.userEvent.timestamp) : NaN;
    if (Number.isNaN(ts)) return;
    const startFrac = clamp01((ts - agentStart) / span);
    const dur = t.workTimeMs ?? 0;
    const widthFrac = clamp01(dur / span);
    segments.push({
      startFrac,
      widthFrac,
      label: `Step ${i + 1}`,
      kind: 'step',
    });
  });
  return segments;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Min user-event ts and max assistant ts across a parsed (sub)session. */
function logTimeSpan(turns: PromptTurn[]): {
  startMs?: number;
  endMs?: number;
} {
  let startMs: number | undefined;
  let endMs: number | undefined;
  for (const t of turns) {
    const ts = t.userEvent.timestamp ? Date.parse(t.userEvent.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (startMs === undefined || ts < startMs) startMs = ts;
      const end = t.workTimeMs ? ts + t.workTimeMs : ts;
      if (endMs === undefined || end > endMs) endMs = end;
    }
  }
  return { startMs, endMs };
}

/** Sum two token breakdowns. */
function addBreakdown(a: TokenBreakdown, b: TokenBreakdown): TokenBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
    inputFast: a.inputFast + b.inputFast,
    outputFast: a.outputFast + b.outputFast,
  };
}

/**
 * Merges the DB-authoritative parent-map children of `agentId` into a
 * transcript-derived `nestedActivations` list, deduped by `agentId`. Children
 * known only via the parent map (no matching `tool_result` in the parent's
 * own transcript — the sub-agent nesting bug) are appended as minimal stubs; their own
 * data is resolved later via `subagentLogsMap` when `resolveAgent` visits them.
 */
function mergeParentMapChildren(
  agentId: string,
  nestedActivations: AgentActivation[],
  childrenByParent: Map<string, string[]> | undefined,
): AgentActivation[] {
  const childIds = childrenByParent?.get(agentId);
  if (!childIds || childIds.length === 0) return nestedActivations;
  const seen = new Set(nestedActivations.map((a) => a.agentId));
  const merged = [...nestedActivations];
  for (const childId of childIds) {
    if (seen.has(childId)) continue;
    seen.add(childId);
    merged.push({ agentId: childId, prompt: '' });
  }
  return merged;
}

/**
 * Resolve an `AgentActivation` into chart-ready data by parsing its subagent
 * log (when present) for inner tool counts, per-agent turn timing and tokens.
 * When no log is available, falls back to the activation's reported values and
 * marks a single synthetic `Agent` tool count.
 *
 * `childrenByParent` (built once by the caller via `buildChildrenByParentMap`)
 * supplies DB-authoritative children that a same-transcript `tool_result`
 * match may have missed (background-launched agents whose completion arrived
 * after the parent's own transcript ended) — merged into `nestedActivations`
 * in both branches below so callers keep discovering the full subtree.
 */
function resolveAgent(
  activation: AgentActivation,
  subagentLogsMap: SubagentLogsMap | undefined,
  fallbackModel: string | undefined,
  childrenByParent?: Map<string, string[]>,
): ResolvedAgent {
  const label = activation.description ?? `agent-${activation.agentId}`;
  const logs = subagentLogsMap?.get(activation.agentId);

  if (logs) {
    const parsed = parseSessionLogs(logs, { isSubagent: true });
    const toolCounts = new Map<string, number>();
    let toolCallCount = 0;
    let tokens = emptyBreakdown();
    const nestedActivations: AgentActivation[] = [];

    for (const t of parsed.turns) {
      for (const [name, n] of turnToolCounts(t)) {
        toolCounts.set(name, (toolCounts.get(name) ?? 0) + n);
      }
      toolCallCount += turnToolCallCount(t);
      if (t.tokenBreakdown) tokens = addBreakdown(tokens, t.tokenBreakdown);
      nestedActivations.push(...t.agentActivations);
    }

    // Don't double-count nested agents as a flat `Agent` bucket — they get their
    // own columns/lanes/nodes via nestedActivations.
    toolCounts.delete('Agent');

    // Prefer the activation's completion timing (anchored to the main session
    // clock); fall back to the subagent log's own span.
    const span = logTimeSpan(parsed.turns);
    const startMs = activation.startMs ?? span.startMs;
    const endMs = activation.endMs ?? span.endMs;
    const durationMs =
      activation.durationMs ??
      (startMs !== undefined && endMs !== undefined
        ? endMs - startMs
        : (parsed.summary.totalWorkTimeMs ?? 0));

    return {
      agentId: activation.agentId,
      label,
      durationMs,
      startMs,
      endMs,
      toolCallCount,
      toolCounts,
      tokens:
        tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite
          ? tokens
          : (activation.tokens ?? emptyBreakdown()),
      inputTokens: tokens.input || activation.tokens?.input || 0,
      outputTokens: tokens.output || activation.tokens?.output || 0,
      model: parsed.summary.model ?? fallbackModel,
      innerTurns: parsed.turns,
      nestedActivations: mergeParentMapChildren(
        activation.agentId,
        nestedActivations,
        childrenByParent,
      ),
    };
  }

  // No subagent log — fall back to activation-reported values.
  const tokens = activation.tokens ?? emptyBreakdown();
  return {
    agentId: activation.agentId,
    label,
    durationMs: activation.durationMs ?? 0,
    startMs: activation.startMs,
    endMs: activation.endMs,
    toolCallCount: 0,
    toolCounts: new Map([['Agent', 1]]),
    tokens,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    model: fallbackModel,
    innerTurns: [],
    nestedActivations: mergeParentMapChildren(
      activation.agentId,
      [],
      childrenByParent,
    ),
  };
}

// --- Workflow node resolution (shared by agentTree/toolHeatmap) ---

/**
 * Builds an `AgentNode[]` forest restricted to exactly the given bare `agentIds` (the `agent-`
 * prefix already stripped), mirroring `buildAgentNodesForIds`'s
 * restricted-nesting rule: roots are ids whose parent (per `agentParentMap`) falls OUTSIDE the
 * given set. Each id is resolved via the shared `resolveAgent` (same cost/duration/model
 * enrichment every other agent step gets) from a minimal stub activation, since workflow agents
 * have no `Task` tool_use activation of their own to source one from.
 */
function buildWorkflowAgentNodes(
  agentIds: string[],
  agentParentMap: Map<string, string | null> | undefined,
  subagentLogsMap: SubagentLogsMap | undefined,
  fallbackModel: string | undefined,
  pricing: ModelPricingMap | null | undefined,
  childrenByParent: Map<string, string[]> | undefined,
): AgentNode[] {
  const idSet = new Set(agentIds);
  const nodeMap = new Map<string, AgentNode>();

  for (const agentId of agentIds) {
    if (nodeMap.has(agentId)) continue; // guard against duplicate ids in the input list
    const resolved = resolveAgent(
      { agentId, prompt: '' },
      subagentLogsMap,
      fallbackModel,
      childrenByParent,
    );
    nodeMap.set(agentId, {
      agentId: resolved.agentId,
      slug: resolved.label,
      prompt: '',
      model: resolved.model ?? fallbackModel ?? '',
      isBackground: false,
      isGroup: false,
      totalCost: turnCost(
        resolved.tokens,
        resolved.model ?? fallbackModel,
        pricing,
      ),
      totalDurationMs: resolved.durationMs,
      turnCount: Math.max(1, resolved.innerTurns.length),
      inputTokens: resolved.inputTokens,
      outputTokens: resolved.outputTokens,
      children: [],
    });
  }

  const roots: AgentNode[] = [];
  for (const agentId of agentIds) {
    const node = nodeMap.get(agentId);
    if (!node) continue;
    const parentId = agentParentMap?.get(agentId);
    const parentNode =
      parentId && idSet.has(parentId) ? nodeMap.get(parentId) : undefined;
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/** Wraps a resolved workflow-agent forest in the workflow's own purple `AgentNode`. */
function buildWorkflowNode(wf: WorkflowRun, children: AgentNode[]): AgentNode {
  return {
    agentId: `workflow-${wf.toolUseId}`,
    slug: wf.name,
    prompt: '',
    model: '',
    isBackground: false,
    isGroup: false,
    isWorkflow: true,
    totalCost: sumPricedCosts(children.map((n) => n.totalCost)),
    totalDurationMs:
      wf.durationMs ?? children.reduce((s, n) => s + n.totalDurationMs, 0),
    turnCount: children.length,
    inputTokens: children.reduce((s, n) => s + n.inputTokens, 0),
    outputTokens: children.reduce((s, n) => s + n.outputTokens, 0),
    children,
  };
}

/** Recursively collects every real (non-group, non-workflow) agentId in an `AgentNode` forest. */
function collectAgentIds(nodes: AgentNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (!node.isGroup && !node.isWorkflow) into.add(node.agentId);
    collectAgentIds(node.children, into);
  }
}

// --- Step collection (the chart unit: a primary or sub-agent action) ---

/**
 * Flatten every agent activation across all turns into a single time-ordered
 * list (depth-first preserving nesting). Each entry keeps its nesting depth so
 * the tree can rebuild hierarchy while the timeline/heatmap treat them flat.
 */
function collectAgentSteps(
  session: ParsedSession,
  subagentLogsMap: SubagentLogsMap | undefined,
  childrenByParent?: Map<string, string[]>,
): ResolvedAgent[] {
  const model = session.summary.model;
  const out: ResolvedAgent[] = [];

  function walk(activation: AgentActivation) {
    const agent = resolveAgent(
      activation,
      subagentLogsMap,
      model,
      childrenByParent,
    );
    out.push(agent);
    for (const nested of agent.nestedActivations) walk(nested);
  }

  for (const turn of session.turns) {
    for (const activation of turn.agentActivations) walk(activation);
  }

  // Order by real start time; agents without timing keep insertion order.
  out.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
  return out;
}

/**
 * Two agents run in parallel when their [start, end] intervals overlap.
 * Groups a time-ordered list into runs of mutually-overlapping agents
 * (sequential singletons stay as length-1 groups).
 */
function clusterByOverlap(agents: ResolvedAgent[]): ResolvedAgent[][] {
  const groups: ResolvedAgent[][] = [];
  let current: ResolvedAgent[] = [];
  let clusterEnd = -Infinity;

  for (const agent of agents) {
    const start = agent.startMs ?? Infinity;
    const end = agent.endMs ?? agent.startMs ?? Infinity;
    if (current.length === 0 || start < clusterEnd) {
      current.push(agent);
      clusterEnd = Math.max(clusterEnd, end);
    } else {
      groups.push(current);
      current = [agent];
      clusterEnd = end;
    }
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

// --- Gap-compressed timeline (collapse idle gaps between turns) ---

const GAP_THRESHOLD_MS = 30_000;
const GAP_VISUAL_MS = 1_000;

interface TurnInterval {
  startMs: number;
  durationMs: number;
}

/**
 * Build a `compressedOffset(tsMs)` mapper that removes long idle gaps between
 * turn activity, and a per-turn duration cap (p95×3) so a single idle wait
 * (e.g. tool-approval) doesn't dominate the timeline.
 */
function buildTimeCompressor(intervals: TurnInterval[]) {
  const sorted = [...intervals].sort((a, b) => a.startMs - b.startMs);

  const rawDurations = sorted
    .map((i) => i.durationMs)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);

  let durationCap = Infinity;
  if (rawDurations.length > 5) {
    const p95 = rawDurations[Math.floor(rawDurations.length * 0.95)];
    durationCap = Math.max(p95 * 3, GAP_THRESHOLD_MS);
  }

  const cappedDuration = (d: number) => Math.min(d, durationCap);

  const gapRemovals: { beforeTs: number; removeMs: number }[] = [];
  let totalGapRemoved = 0;

  if (sorted.length > 1) {
    let coveredUntilMs =
      sorted[0].startMs + cappedDuration(sorted[0].durationMs);
    for (let i = 1; i < sorted.length; i++) {
      const thisStartMs = sorted[i].startMs;
      const uncoveredGap = thisStartMs - coveredUntilMs;
      if (uncoveredGap > GAP_THRESHOLD_MS) {
        totalGapRemoved += uncoveredGap - GAP_VISUAL_MS;
        gapRemovals.push({ beforeTs: thisStartMs, removeMs: totalGapRemoved });
      }
      const thisEndMs = thisStartMs + cappedDuration(sorted[i].durationMs);
      coveredUntilMs = Math.max(coveredUntilMs, thisEndMs);
    }
  }

  const sessionStartMs = sorted.length > 0 ? sorted[0].startMs : 0;

  function compressedOffset(tsMs: number): number {
    let gapToRemove = 0;
    for (const gap of gapRemovals) {
      if (tsMs >= gap.beforeTs) gapToRemove = gap.removeMs;
      else break;
    }
    return Math.max(0, tsMs - sessionStartMs - gapToRemove);
  }

  return { compressedOffset, cappedDuration };
}

function timestampMs(turn: PromptTurn): number {
  const ts = turn.userEvent.timestamp;
  return ts ? new Date(ts).getTime() : 0;
}

// --- 1. assistantTimeline (Gantt) ---

/**
 * Build a gap-compressed timeline keyed by STEPS (agent actions), not prompts.
 *
 * The "main" lane carries one block per prompt turn (positioned by its
 * timestamp). Each agent activation — primary or sub-agent — becomes its own
 * lane/block anchored at the agent's REAL start time (completion timestamp −
 * duration), sized by its real duration. This makes sequential agents step
 * across the timeline and overlapping agents stack in parallel, instead of all
 * piling at the parent prompt's offset.
 */
export function assistantTimeline(
  session: ParsedSession,
  pricing: ModelPricingMap | null | undefined,
  subagentLogsMap?: SubagentLogsMap,
  agentParentMap?: Map<string, string | null>,
): TimelineData {
  const turns = session.turns;
  const model = session.summary.model;
  const childrenByParent = agentParentMap
    ? buildChildrenByParentMap(agentParentMap)
    : undefined;
  const steps = collectAgentSteps(session, subagentLogsMap, childrenByParent);

  // Workflow-spawned agents have no `Task` tool_use activation of their own, so
  // `collectAgentSteps` (built from `turn.agentActivations`) never surfaces them —
  // add one step per linked workflow agent here, deduped against `steps` (design
  // decision 12 — defensive guard, mirrors agentTree()/toolHeatmap()), labeled
  // "<workflow name>:<agent label>" for the same reason as the Tool Heatmap
  // column labels. Re-sorted afterward since these can interleave with existing
  // steps by real start time.
  const includedStepIds = new Set(steps.map((s) => s.agentId));
  for (const turn of turns) {
    for (const wf of turn.workflows ?? []) {
      if (!wf.agentSessionIds || wf.agentSessionIds.length === 0) continue;
      for (const rawId of wf.agentSessionIds) {
        const agentId = stripAgentPrefix(rawId);
        if (includedStepIds.has(agentId)) continue;
        includedStepIds.add(agentId);
        const resolved = resolveAgent(
          { agentId, prompt: '' },
          subagentLogsMap,
          model,
          childrenByParent,
        );
        steps.push({ ...resolved, label: `${wf.name}:${resolved.label}` });
      }
    }
  }
  steps.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));

  // Compress over both prompt turns AND agent steps so real idle gaps collapse
  // while agent start offsets stay meaningful.
  const intervals: TurnInterval[] = [];
  for (const t of turns) {
    const ts = timestampMs(t);
    if (ts > 0) intervals.push({ startMs: ts, durationMs: t.workTimeMs ?? 0 });
  }
  for (const s of steps) {
    if (s.startMs !== undefined) {
      intervals.push({ startMs: s.startMs, durationMs: s.durationMs });
    }
  }

  const { compressedOffset, cappedDuration } = buildTimeCompressor(intervals);

  const blocks: TimelineBlock[] = [];
  const userMarkers: UserMarker[] = [];
  const lanes: TimelineLane[] = [
    { index: 0, label: 'main', isBackground: false },
  ];

  function addLane(label: string, isBackground: boolean): number {
    const index = lanes.length;
    lanes.push({ index, label, isBackground });
    return index;
  }

  for (const turn of turns) {
    const tsMs = timestampMs(turn);
    if (tsMs === 0) continue;
    const startMs = compressedOffset(tsMs);

    userMarkers.push({
      offset: startMs,
      content: truncateContent(userTurnText(turn)),
      isCommand: false,
    });

    const raw = turn.workTimeMs ?? 0;
    const capped = cappedDuration(raw);
    const dur = capped > 0 ? compressedOffset(tsMs + capped) - startMs : 0;

    blocks.push({
      turnId: `turn-${turn.index}`,
      agentLabel: 'main',
      laneIndex: 0,
      startOffset: startMs,
      durationMs: Math.max(dur, 2),
      rawDurationMs: raw,
      toolCallCount: turnToolCallCount(turn),
      cost: turnCost(turn.tokenBreakdown, model, pricing),
      model,
    });
  }

  // Fallback anchor (first prompt offset) for agents missing timing.
  const firstTurnOffset =
    turns.length > 0 ? compressedOffset(timestampMs(turns[0])) : 0;

  // One lane per agent step, placed at its real start offset.
  for (const agent of steps) {
    const laneIndex = addLane(agent.label, false);
    const startOffset =
      agent.startMs !== undefined
        ? compressedOffset(agent.startMs)
        : firstTurnOffset;
    const endOffset =
      agent.endMs !== undefined
        ? compressedOffset(agent.endMs)
        : startOffset + cappedDuration(agent.durationMs);
    const dur = Math.max(endOffset - startOffset, 2);

    const segments = innerStepSegments(agent);
    blocks.push({
      turnId: `agent-${agent.agentId}`,
      agentLabel: agent.label,
      laneIndex,
      startOffset,
      durationMs: dur,
      rawDurationMs: agent.durationMs,
      toolCallCount: agent.toolCallCount,
      cost: turnCost(agent.tokens, agent.model ?? model, pricing),
      model: agent.model ?? model,
      ...(segments.length > 0 && { segments }),
    });
  }

  // Mark the "waiting on children" span on each main-lane block: the range
  // [earliest child start, latest child end] that falls within that block,
  // expressed as fractions of the block's width.
  for (const block of blocks) {
    if (block.laneIndex !== 0) continue;
    const blockEnd = block.startOffset + block.durationMs;
    let waitStart = Infinity;
    let waitEnd = -Infinity;
    for (const agent of steps) {
      if (agent.startMs === undefined) continue;
      const s = compressedOffset(agent.startMs);
      const e =
        agent.endMs !== undefined
          ? compressedOffset(agent.endMs)
          : s + cappedDuration(agent.durationMs);
      // Only children overlapping this main block.
      if (e <= block.startOffset || s >= blockEnd) continue;
      waitStart = Math.min(waitStart, Math.max(s, block.startOffset));
      waitEnd = Math.max(waitEnd, Math.min(e, blockEnd));
    }
    if (waitEnd > waitStart && block.durationMs > 0) {
      const startFrac = clamp01(
        (waitStart - block.startOffset) / block.durationMs,
      );
      const widthFrac = clamp01((waitEnd - waitStart) / block.durationMs);
      if (widthFrac > 0) {
        block.segments = [
          ...(block.segments ?? []),
          {
            startFrac,
            widthFrac,
            label: 'Waiting on sub-agents',
            kind: 'waiting',
          },
        ];
      }
    }
  }

  let maxMs = 0;
  for (const b of blocks) maxMs = Math.max(maxMs, b.startOffset + b.durationMs);
  for (const m of userMarkers) maxMs = Math.max(maxMs, m.offset);

  return {
    blocks,
    userMarkers,
    lanes,
    totalDurationMs: maxMs,
  };
}

// --- 2. toolHeatmap ---

/**
 * Tool heatmap with one COLUMN PER STEP — the primary agent, then each
 * sub-agent activation ordered by real start time. Each column shows only that
 * step's own tools (the primary's directly-issued tools, or a sub-agent's inner
 * tools parsed from its log). This replaces the old "one column per prompt"
 * layout that collapsed every agent into a single column.
 */
export function toolHeatmap(
  session: ParsedSession,
  subagentLogsMap?: SubagentLogsMap,
  agentParentMap?: Map<string, string | null>,
): HeatmapData {
  const childrenByParent = agentParentMap
    ? buildChildrenByParentMap(agentParentMap)
    : undefined;
  const cells: HeatmapCell[] = [];
  const toolTotals = new Map<string, number>();
  const columnLabels: string[] = [];

  const pushColumn = (label: string, counts: Map<string, number>) => {
    const col = columnLabels.length;
    columnLabels.push(label);
    for (const [toolName, count] of counts) {
      if (count <= 0) continue;
      cells.push({ turnIndex: col, toolName, count });
      toolTotals.set(toolName, (toolTotals.get(toolName) ?? 0) + count);
    }
  };

  // Column 0: the primary agent's own directly-issued tools (across all turns),
  // including the `Agent` bucket so the primary's orchestration (how many
  // sub-agents it spawned) is visible even when it ran no other tools. Each
  // spawned sub-agent still gets its own column with its inner tools.
  const primaryCounts = new Map<string, number>();
  for (const turn of session.turns) {
    for (const [name, n] of turnToolCounts(turn)) {
      primaryCounts.set(name, (primaryCounts.get(name) ?? 0) + n);
    }
  }
  pushColumn('main', primaryCounts);

  // One column per agent step, ordered by start time. Tracks every included
  // agentId in a shared Set so workflow columns below don't double-render one
  // (defensive guard only, since workflow agents aren't
  // reachable via `turn.agentActivations` in practice).
  const includedAgentIds = new Set<string>();
  for (const agent of collectAgentSteps(
    session,
    subagentLogsMap,
    childrenByParent,
  )) {
    pushColumn(agent.label, agent.toolCounts);
    includedAgentIds.add(agent.agentId);
  }

  // One column per workflow agent, labeled "<workflow name>:<agent label>".
  for (const turn of session.turns) {
    for (const wf of turn.workflows ?? []) {
      if (!wf.agentSessionIds || wf.agentSessionIds.length === 0) continue;
      for (const rawId of wf.agentSessionIds) {
        const agentId = stripAgentPrefix(rawId);
        if (includedAgentIds.has(agentId)) continue;
        includedAgentIds.add(agentId);
        const resolved = resolveAgent(
          { agentId, prompt: '' },
          subagentLogsMap,
          session.summary.model,
          childrenByParent,
        );
        pushColumn(`${wf.name}:${resolved.label}`, resolved.toolCounts);
      }
    }
  }

  const toolNames = Array.from(toolTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);

  return {
    cells,
    toolNames,
    turnCount: columnLabels.length,
    columnLabels,
  };
}

// --- 3. agentTree ---

/**
 * Build the agent hierarchy from agent STEPS, using real start/end timing to
 * recover the mix of sequential and parallel runs. Steps whose time intervals
 * overlap are wrapped in a synthetic "N parallel" group; non-overlapping steps
 * appear as sequential siblings under the primary `main` root.
 */
export function agentTree(
  session: ParsedSession,
  pricing: ModelPricingMap | null | undefined,
  subagentLogsMap?: SubagentLogsMap,
  agentParentMap?: Map<string, string | null>,
): AgentNode {
  const model = session.summary.model;
  const childrenByParent = agentParentMap
    ? buildChildrenByParentMap(agentParentMap)
    : undefined;

  function fromAgent(agent: ResolvedAgent): AgentNode {
    // Nested sub-agents (discovered in this agent's log, plus any DB-authoritative
    // parent-map children merged in by `resolveAgent`) are themselves grouped by
    // overlap so deeper sequential/parallel structure is preserved.
    const nested = agent.nestedActivations.map((a) =>
      resolveAgent(a, subagentLogsMap, model, childrenByParent),
    );
    nested.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
    return {
      agentId: agent.agentId,
      slug: agent.label,
      prompt: '',
      model: agent.model ?? model ?? '',
      isBackground: false,
      isGroup: false,
      totalCost: turnCost(agent.tokens, agent.model ?? model, pricing),
      totalDurationMs: agent.durationMs,
      turnCount: Math.max(1, agent.innerTurns.length),
      inputTokens: agent.inputTokens,
      outputTokens: agent.outputTokens,
      children: groupByOverlap(nested),
    };
  }

  /** Cluster overlapping siblings into parallel groups; keep the rest flat. */
  function groupByOverlap(agents: ResolvedAgent[]): AgentNode[] {
    const out: AgentNode[] = [];
    for (const cluster of clusterByOverlap(agents)) {
      if (cluster.length === 1) {
        out.push(fromAgent(cluster[0]));
      } else {
        out.push(makeGroup(cluster.map(fromAgent)));
      }
    }
    return out;
  }

  function makeGroup(group: AgentNode[]): AgentNode {
    return {
      agentId: `group-${group.map((n) => n.agentId).join('-')}`,
      slug: `${group.length} parallel`,
      prompt: '',
      model: '',
      isBackground: false,
      isGroup: true,
      totalCost: sumPricedCosts(group.map((n) => n.totalCost)),
      totalDurationMs: group.reduce((s, n) => s + n.totalDurationMs, 0),
      turnCount: group.reduce((s, n) => s + n.turnCount, 0),
      inputTokens: group.reduce((s, n) => s + n.inputTokens, 0),
      outputTokens: group.reduce((s, n) => s + n.outputTokens, 0),
      children: group,
    };
  }

  // Top-level agents: only the directly-spawned (non-nested) activations from
  // the prompt turns, grouped into sequential/parallel by their real timing.
  const topAgents: ResolvedAgent[] = [];
  for (const turn of session.turns) {
    for (const activation of turn.agentActivations) {
      topAgents.push(
        resolveAgent(activation, subagentLogsMap, model, childrenByParent),
      );
    }
  }
  topAgents.sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
  const topChildren = groupByOverlap(topAgents);

  // Workflow nodes: one purple node per `turn.workflows` entry with a resolved
  // agent set, appended as top-level siblings (not clustered via
  // groupByOverlap — a workflow is its own unit of work, not a timing-based
  // parallel group). Deduped against everything already included via a shared
  // Set.
  const includedAgentIds = new Set<string>();
  collectAgentIds(topChildren, includedAgentIds);

  for (const turn of session.turns) {
    for (const wf of turn.workflows ?? []) {
      if (!wf.agentSessionIds || wf.agentSessionIds.length === 0) continue;
      const bareIds = wf.agentSessionIds
        .map(stripAgentPrefix)
        .filter((id) => !includedAgentIds.has(id));
      if (bareIds.length === 0) continue;
      const children = buildWorkflowAgentNodes(
        bareIds,
        agentParentMap,
        subagentLogsMap,
        model,
        pricing,
        childrenByParent,
      );
      for (const id of bareIds) includedAgentIds.add(id);
      topChildren.push(buildWorkflowNode(wf, children));
    }
  }

  // Only the priced turns are summed — an unpriced turn contributes nothing rather
  // than a fake $0, and a session with no priced turn at all reports `null`.
  const totalCost = sumPricedCosts(
    session.turns.map((t) => turnCost(t.tokenBreakdown, model, pricing)),
  );
  const breakdown = session.summary.tokenBreakdown;

  return {
    agentId: 'main',
    slug: 'main',
    prompt: '',
    model: model ?? '',
    isBackground: false,
    isGroup: false,
    totalCost,
    totalDurationMs: session.summary.totalWorkTimeMs,
    turnCount: session.summary.promptCount,
    inputTokens: breakdown.input,
    outputTokens: breakdown.output,
    children: topChildren,
  };
}

export function findAgentNode(
  root: AgentNode,
  agentId: string,
): AgentNode | null {
  if (root.agentId === agentId) return root;
  for (const child of root.children) {
    const found = findAgentNode(child, agentId);
    if (found) return found;
  }
  return null;
}
