/**
 * Table test for `mergeSessionMapDelta` and `toParseInputs` against the rows of
 * docs/algorithm-examples/session-map-delta-merge.json (rules: docs/knowledgebase/algorithms/
 * session-map-delta-merge.md). Rows with `input.delta` merge one delta into `input.prev`; rows
 * with `input.parse` derive the parse inputs of a state.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type {
  SessionLogLine,
  SessionLogsDeltaLiveness,
  SubagentStats,
} from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import {
  emptyMapState,
  mergeSessionMapDelta,
  toParseInputs,
  type SessionLogsDeltaUpdate,
  type SessionMapState,
  type SessionMapSubagent,
} from './session-map-delta-merge';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

/** A state as the rows write it: stats as input-token counts, workflows as toolUseIds. */
interface StateSpec {
  rootArtisynLines?: SessionLogLine[];
  rootClaudeLines?: SessionLogLine[];
  subagents?: SessionMapSubagent[];
  stats?: Record<string, number>;
  workflows?: string[];
  cursor?: string;
  liveness?: SessionLogsDeltaLiveness;
  serverTime?: string;
}

interface DeltaSpec {
  rootArtisynLines?: SessionLogLine[];
  rootClaudeLines?: SessionLogLine[];
  subagentAppends?: SessionLogsDeltaUpdate['subagentAppends'];
  newSubagents?: SessionLogsDeltaUpdate['newSubagents'];
  stats?: Record<string, number>;
  workflows?: string[] | null;
  cursor?: string;
  liveness?: SessionLogsDeltaLiveness;
  serverTime?: string;
}

interface MergeInput {
  prev?: StateSpec | null;
  delta?: DeltaSpec;
  parse?: StateSpec;
}

interface MergeExpected {
  rootArtisynLines?: SessionLogLine[];
  rootClaudeLines?: SessionLogLine[];
  subagents?: SessionMapSubagent[];
  stats?: Record<string, number>;
  workflows?: string[];
  cursor?: string;
  liveness?: SessionLogsDeltaLiveness;
  serverTime?: string;
  main?: SessionLogLine[];
  subagentLogs?: Record<string, SessionLogLine[]>;
  agentParentMap?: Record<string, string | null>;
  workflowRunIds?: Record<string, string>;
  agentDescriptions?: Record<string, string>;
}

const DEFAULT_LIVENESS: SessionLogsDeltaLiveness = {
  hasOtel: false,
  live: false,
  lastActivityAt: null,
};

function stat(inputTokens: number): SubagentStats {
  return {
    model: null,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchRequests: 0,
    inputTokensFast: 0,
    outputTokensFast: 0,
  };
}

function run(toolUseId: string): WorkflowRun {
  return {
    taskId: null,
    toolUseId,
    name: toolUseId,
    args: null,
    status: 'completed',
    durationMs: null,
    agentCount: null,
    subagentTokens: null,
    toolUses: null,
    summary: null,
    findings: [],
    wfId: null,
    agentSessionIds: [],
  };
}

function toStats(
  spec: Record<string, number> = {},
): Record<string, SubagentStats> {
  return Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, stat(v)]));
}

function toState(spec: StateSpec): SessionMapState {
  return {
    ...emptyMapState,
    rootArtisynLines: spec.rootArtisynLines ?? [],
    rootClaudeLines: spec.rootClaudeLines ?? [],
    subagents: spec.subagents ?? [],
    subagentStats: toStats(spec.stats),
    workflows: (spec.workflows ?? []).map(run),
    cursor: spec.cursor ?? '',
    liveness: spec.liveness ?? DEFAULT_LIVENESS,
    serverTime: spec.serverTime ?? '',
  };
}

function toDelta(spec: DeltaSpec): SessionLogsDeltaUpdate {
  return {
    reload: false,
    rootArtisynLines: spec.rootArtisynLines ?? [],
    rootClaudeLines: spec.rootClaudeLines ?? [],
    subagentAppends: spec.subagentAppends ?? [],
    newSubagents: spec.newSubagents ?? [],
    subagentStats: toStats(spec.stats),
    workflows:
      spec.workflows === undefined || spec.workflows === null
        ? null
        : spec.workflows.map(run),
    liveness: spec.liveness ?? DEFAULT_LIVENESS,
    serverTime: spec.serverTime ?? '2026-11-01T10:00:00.000Z',
    cursor: spec.cursor ?? 'next',
  };
}

/** The state as the rows write it, only the keys `expected` lists. */
function view(state: SessionMapState, keys: string[]): Record<string, unknown> {
  const full: Record<string, unknown> = {
    rootArtisynLines: state.rootArtisynLines,
    rootClaudeLines: state.rootClaudeLines,
    subagents: state.subagents,
    stats: Object.fromEntries(
      Object.entries(state.subagentStats).map(([k, v]) => [k, v.inputTokens]),
    ),
    workflows: state.workflows.map((w) => w.toolUseId),
    cursor: state.cursor,
    liveness: state.liveness,
    serverTime: state.serverTime,
  };
  return Object.fromEntries(keys.map((k) => [k, full[k]]));
}

const rows = loader.loadExamples<MergeInput, MergeExpected>(
  'session-map-delta-merge',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.parse) {
    const out = toParseInputs(toState(input.parse));
    expect({
      main: out.main,
      subagentLogs: Object.fromEntries(out.subagentLogs),
      agentParentMap: Object.fromEntries(out.agentParentMap),
      workflowRunIds: Object.fromEntries(out.workflowRunIds),
      agentDescriptions: Object.fromEntries(out.agentDescriptions),
    }).toEqual(expected);
    return;
  }
  if (!input.delta) throw new Error('row has neither delta nor parse');
  const prev =
    input.prev === undefined || input.prev === null
      ? null
      : toState(input.prev);
  const out = mergeSessionMapDelta(prev, toDelta(input.delta), 0);
  expect(view(out, Object.keys(expected))).toEqual(expected);
});
