/**
 * Table test for the Session Map model against the rows of
 * docs/algorithm-examples/session-map-model.json (rules: docs/knowledgebase/algorithms/
 * session-map-model.md). `input.op` picks the function: tool family / failed call, per-call cost,
 * timeline, the whole model built from transcripts, grouping, card state, header counters,
 * highlight and order.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type { SessionLogLine, SubagentStats } from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import type {
  ModelPricingEntry,
  ModelPricingMap,
} from '../../../../../models/pricing';
import { parseSessionLogs } from '../log-parser';
import type { ToolCallStatus } from '../types';
import {
  emptyMapState,
  toParseInputs,
  type SessionMapSubagent,
} from './session-map-delta-merge';
import {
  buildSessionMapModel,
  buildTimeline,
  countersAt,
  groupAgents,
  highlightSet,
  isFailedCall,
  orderAgents,
  perCallCosts,
  stateAt,
  toolFamily,
  type AgentOrder,
  type GroupAgentInput,
  type HighlightMode,
  type MapAgentNode,
  type MapCounters,
  type MapNodeState,
  type SessionMapModel,
} from './session-map-model';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

/** Prices in USD per million tokens; every other rate is 0. */
type PriceSpec = Record<string, { in: number; out: number }>;

interface CostEventSpec {
  at: string;
  cost: number;
  toolUseId?: string;
}

interface CallSpec {
  t: number | null;
  failed?: boolean;
}

interface NodeSpec {
  id?: string;
  f?: number | null;
  l?: number | null;
  cost?: number;
  failures?: number;
  events?: CallSpec[];
  costEvents?: { t: number; cost: number }[];
}

interface RunSpec {
  toolUseId: string;
  name: string;
  status: WorkflowRun['status'];
  wfId: string | null;
}

type ModelInput =
  | { op: 'family'; names: string[] }
  | { op: 'failed'; statuses: ToolCallStatus[] }
  | {
      op: 'perCall';
      lines: SessionLogLine[];
      total: number;
      pricing: PriceSpec;
      fallbackModel: string | null;
      firstAt: string | null;
    }
  | {
      op: 'timeline';
      nodes: NodeSpec[];
      start: number;
      end: number;
    }
  | {
      op: 'model';
      main: SessionLogLine[];
      subagents: SessionMapSubagent[];
      stats: Record<string, { model: string; inputTokens: number }>;
      pricing: PriceSpec;
      /** Unprefixed agent id -> description, added to the parse inputs' `agentDescriptions`. */
      agentDescriptions?: Record<string, string>;
    }
  | { op: 'group'; agents: GroupAgentInput[]; workflows: RunSpec[] }
  | {
      op: 'state';
      node: { f: number | null; l: number | null; finished: boolean };
      t: number;
      live: boolean;
      atNow: boolean;
    }
  | {
      op: 'counters';
      main: NodeSpec;
      agents: NodeSpec[];
      sessionStart: number;
      treeCost: number;
      t: number;
    }
  | { op: 'highlight'; mode: HighlightMode; agents: NodeSpec[] }
  | { op: 'order'; order: AgentOrder; agents: NodeSpec[] };

interface ModelExpected {
  families?: string[];
  failed?: boolean[];
  events?: CostEventSpec[];
  binCount?: number;
  lastCumulative?: number;
  tickStepMin?: number;
  ticks?: number[];
  mainCost?: number;
  agentCosts?: Record<string, number>;
  treeCost?: number;
  costAtEnd?: number;
  columns?: { key: string; label: string; rootIds: string[] }[];
  nested?: Record<string, string>;
  state?: MapNodeState;
  counters?: Partial<MapCounters>;
  ids?: string[] | null;
  /** Agent id -> node label; checked only when present. */
  labels?: Record<string, string>;
}

/** Cost comparisons tolerate float rounding. */
const TOL = 1e-9;

function pricingOf(spec: PriceSpec): ModelPricingMap {
  const map: ModelPricingMap = {};
  for (const [model, p] of Object.entries(spec)) {
    const entry: ModelPricingEntry = {
      priceIn: p.in,
      priceOut: p.out,
      priceCacheR: 0,
      priceCacheW5m: 0,
      priceCacheW1h: 0,
      priceWebSearch: 0,
      charsPerToken: null,
      contextLength: null,
    };
    map[model] = entry;
  }
  return map;
}

function emptyFamilies(): MapAgentNode['familyCounts'] {
  return { explore: 0, edit: 0, shell: 0, mcp: 0, orch: 0, other: 0 };
}

/** A map node with the spec's fields and neutral defaults for everything else. */
function agentNode(spec: NodeSpec): MapAgentNode {
  const id = spec.id ?? 'n';
  return {
    id,
    kind: 'agent',
    label: id,
    model: null,
    cost: spec.cost ?? 0,
    share: 0,
    familyCounts: emptyFamilies(),
    topTools: [],
    calls: spec.events?.length ?? 0,
    failures: spec.failures ?? 0,
    peakContext: null,
    contextLength: null,
    f: spec.f ?? null,
    l: spec.l ?? null,
    finished: false,
    events: (spec.events ?? []).map((e) => ({
      t: e.t,
      name: 'Read',
      family: 'explore',
      failed: e.failed ?? false,
      call: {
        name: 'Read',
        input: {},
        section: 'file',
        status: e.failed ? 'error' : 'success',
      },
    })),
    costEvents: spec.costEvents ?? [],
    sessionId: `agent-${id}`,
    parentId: null,
    workflowRunId: null,
    columnKey: 'direct',
    depth: 0,
    children: [],
  };
}

function runOf(spec: RunSpec): WorkflowRun {
  return {
    taskId: null,
    toolUseId: spec.toolUseId,
    name: spec.name,
    args: null,
    status: spec.status,
    durationMs: null,
    agentCount: null,
    subagentTokens: null,
    toolUses: null,
    summary: null,
    findings: [],
    wfId: spec.wfId,
    agentSessionIds: [],
  };
}

function statsOf(
  spec: Record<string, { model: string; inputTokens: number }>,
): Record<string, SubagentStats> {
  return Object.fromEntries(
    Object.entries(spec).map(([k, s]) => [
      k,
      {
        model: s.model,
        inputTokens: s.inputTokens,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchRequests: 0,
        inputTokensFast: 0,
        outputTokensFast: 0,
      },
    ]),
  );
}

function expectClose(actual: number, expectedValue: number | undefined): void {
  expect(Math.abs(actual - (expectedValue ?? NaN))).toBeLessThan(TOL);
}

const rows = loader.loadExamples<ModelInput, ModelExpected>(
  'session-map-model',
);

it.each(rows)('$id', ({ input, expected }) => {
  switch (input.op) {
    case 'family':
      expect(input.names.map(toolFamily)).toEqual(expected.families);
      return;
    case 'failed':
      expect(input.statuses.map((status) => isFailedCall({ status }))).toEqual(
        expected.failed,
      );
      return;
    case 'perCall': {
      const events = perCallCosts(
        input.lines,
        input.total,
        pricingOf(input.pricing),
        input.fallbackModel,
        input.firstAt === null ? null : Date.parse(input.firstAt),
      );
      const want = expected.events ?? [];
      expect(events.length).toBe(want.length);
      events.forEach((e, i) => {
        expect(new Date(e.t).toISOString()).toBe(want[i].at);
        expect(e.toolUseId).toBe(want[i].toolUseId);
        expectClose(e.cost, want[i].cost);
      });
      return;
    }
    case 'timeline': {
      const tl = buildTimeline(
        input.nodes.map(agentNode),
        input.start,
        input.end,
      );
      expect(tl.bins.length).toBe(expected.binCount);
      expectClose(
        tl.bins[tl.bins.length - 1].cumulativeCost,
        expected.lastCumulative,
      );
      expect(tl.tickStepMin).toBe(expected.tickStepMin);
      expect(tl.ticks).toEqual(expected.ticks);
      return;
    }
    case 'model': {
      const pricing = pricingOf(input.pricing);
      const derived = toParseInputs({
        ...emptyMapState,
        rootClaudeLines: input.main,
        subagents: input.subagents,
        subagentStats: statsOf(input.stats),
        cursor: 'k',
      });
      const inputs = {
        ...derived,
        agentDescriptions: new Map([
          ...derived.agentDescriptions,
          ...Object.entries(input.agentDescriptions ?? {}),
        ]),
      };
      const parsed = parseSessionLogs(inputs.main, {
        subagentStats: inputs.subagentStats,
        workflows: inputs.workflows,
        subagentLogs: inputs.subagentLogs,
        pricing,
        harnessSnapshot: null,
      });
      const model: SessionMapModel = buildSessionMapModel(
        parsed,
        inputs,
        pricing,
      );
      expectClose(model.main.cost, expected.mainCost);
      const agentCosts = expected.agentCosts ?? {};
      expect(model.agents.map((a) => a.id).sort()).toEqual(
        Object.keys(agentCosts).sort(),
      );
      for (const a of model.agents) expectClose(a.cost, agentCosts[a.id]);
      if (expected.labels)
        expect(
          Object.fromEntries(model.agents.map((a) => [a.id, a.label])),
        ).toEqual(expected.labels);
      expectClose(model.treeCost, expected.treeCost);
      expect(model.sessionEnd).not.toBeNull();
      expectClose(
        countersAt(model, model.sessionEnd ?? 0).costSoFar,
        expected.costAtEnd,
      );
      const bins = model.timeline?.bins ?? [];
      expectClose(
        bins[bins.length - 1]?.cumulativeCost ?? NaN,
        expected.costAtEnd,
      );
      return;
    }
    case 'group': {
      const g = groupAgents(input.agents, input.workflows.map(runOf));
      expect(
        g.columns.map((c) => ({
          key: c.key,
          label: c.label,
          rootIds: c.rootIds,
        })),
      ).toEqual(expected.columns);
      expect(Object.fromEntries(g.nestedParent)).toEqual(expected.nested);
      return;
    }
    case 'state':
      expect(
        stateAt(input.node, input.t, { live: input.live, atNow: input.atNow }),
      ).toBe(expected.state);
      return;
    case 'counters': {
      const agents = input.agents.map(agentNode);
      const model: SessionMapModel = {
        main: { ...agentNode(input.main), id: 'main', kind: 'main' },
        agents,
        agentsById: new Map(agents.map((a) => [a.id, a])),
        columns: [],
        treeCost: input.treeCost,
        maxAgentCost: 0,
        sessionStart: input.sessionStart,
        sessionEnd: null,
        timeline: null,
        live: false,
      };
      const c = countersAt(model, input.t);
      const want = expected.counters ?? {};
      expectClose(c.costSoFar, want.costSoFar);
      expect({ ...c, costSoFar: want.costSoFar }).toEqual(want);
      return;
    }
    case 'highlight': {
      const set = highlightSet(
        { agents: input.agents.map(agentNode) },
        input.mode,
      );
      expect(set === null ? null : [...set].sort()).toEqual(expected.ids);
      return;
    }
    case 'order':
      expect(
        orderAgents(input.agents.map(agentNode), input.order).map((a) => a.id),
      ).toEqual(expected.ids);
      return;
  }
});
