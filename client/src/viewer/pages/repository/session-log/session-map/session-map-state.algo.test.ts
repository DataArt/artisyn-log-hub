/**
 * Table test for `buildSessionMapState` and `toParseInputs` against the rows of
 * docs/algorithm-examples/session-map-state.json (rules: docs/knowledgebase/algorithms/
 * session-map-state.md). Rows with `input.build` build a state from a manifest and assembled
 * logs; rows with `input.parse` derive the parse inputs of a state.
 */
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import type {
  SessionLiveness,
  SessionLogLine,
  SessionLogPart,
  SessionLogPartsManifest,
  SessionLogsData,
  SubagentStats,
} from '../../../../api';
import type { WorkflowRun } from '../../../../../models/workflows';
import {
  buildSessionMapState,
  emptyMapState,
  toParseInputs,
  type SessionMapState,
  type SessionMapSubagent,
} from './session-map-state';

// Vite would transform the .cjs loader as ESM; node's own require loads it as-is.
const loader: typeof import('../../../../../../../scripts/algo-docs/load-examples.cjs') =
  createRequire(import.meta.url)(
    '../../../../../../../scripts/algo-docs/load-examples.cjs',
  );

/** A manifest as the rows write it: parts with only the fields a row needs. */
interface ManifestSpec {
  parts: (Pick<SessionLogPart, 'sessionId' | 'logType'> &
    Partial<SessionLogPart>)[];
  /** Sub-agent `sessionId` → `inputTokens` (the other stats fields are 0). */
  stats?: Record<string, number>;
  /** The runs' `toolUseId`s. */
  workflows?: string[];
  liveness?: SessionLiveness;
  serverTime?: string;
  /** An older server: no `liveness` and no `serverTime` at all. */
  omitLiveness?: boolean;
}

interface StateInput {
  build?: {
    manifest: ManifestSpec;
    logs: Pick<SessionLogsData, 'main' | 'subagents'>;
    receivedAt: number;
  };
  parse?: { main?: SessionLogLine[]; subagents?: SessionMapSubagent[] };
}

interface StateExpected {
  main?: SessionLogLine[];
  subagents?: SessionMapSubagent[];
  stats?: Record<string, number>;
  workflows?: string[];
  liveness?: SessionLiveness;
  serverTime?: string;
  receivedAt?: number;
  subagentLogs?: Record<string, SessionLogLine[]>;
  agentParentMap?: Record<string, string | null>;
  workflowRunIds?: Record<string, string>;
  agentDescriptions?: Record<string, string>;
}

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

function toManifest(spec: ManifestSpec): SessionLogPartsManifest {
  const manifest: SessionLogPartsManifest = {
    parts: spec.parts.map((p) => ({
      rev: 'r1',
      parentSessionId: null,
      agentDescription: null,
      workflowPhase: null,
      workflowRunId: null,
      ...p,
    })),
    subagentStats: Object.fromEntries(
      Object.entries(spec.stats ?? {}).map(([k, v]) => [k, stat(v)]),
    ),
    rootStats: null,
    workflows: (spec.workflows ?? []).map(run),
    turnEndAdvisor: null,
    sessionAttribution: {
      enabled: false,
      attributes: [],
      values: null,
      evaluatedWatermark: null,
      currentWatermark: null,
      lastRun: null,
    },
    harnessSnapshot: null,
    derivedLagging: false,
  };
  if (spec.omitLiveness) return manifest;
  return {
    ...manifest,
    liveness: spec.liveness ?? {
      hasOtel: false,
      live: false,
      lastActivityAt: null,
    },
    serverTime: spec.serverTime ?? '2026-11-24T10:00:00.000Z',
  };
}

function toLogs(
  logs: Pick<SessionLogsData, 'main' | 'subagents'>,
  manifest: SessionLogPartsManifest,
): SessionLogsData {
  return {
    main: logs.main,
    subagents: logs.subagents,
    subagentStats: manifest.subagentStats,
    rootStats: null,
    workflows: manifest.workflows,
  };
}

/** The state as the rows write it, only the keys `expected` lists. */
function view(state: SessionMapState, keys: string[]): Record<string, unknown> {
  const full: Record<string, unknown> = {
    main: state.main,
    subagents: state.subagents,
    stats: Object.fromEntries(
      Object.entries(state.subagentStats).map(([k, v]) => [k, v.inputTokens]),
    ),
    workflows: state.workflows.map((w) => w.toolUseId),
    liveness: state.liveness,
    serverTime: state.serverTime,
    receivedAt: state.receivedAt,
  };
  return Object.fromEntries(keys.map((k) => [k, full[k]]));
}

const rows = loader.loadExamples<StateInput, StateExpected>(
  'session-map-state',
);

it.each(rows)('$id', ({ input, expected }) => {
  if (input.parse) {
    const out = toParseInputs({
      ...emptyMapState,
      main: input.parse.main ?? [],
      subagents: input.parse.subagents ?? [],
    });
    expect({
      main: out.main,
      subagentLogs: Object.fromEntries(out.subagentLogs),
      agentParentMap: Object.fromEntries(out.agentParentMap),
      workflowRunIds: Object.fromEntries(out.workflowRunIds),
      agentDescriptions: Object.fromEntries(out.agentDescriptions),
    }).toEqual(expected);
    return;
  }
  if (!input.build) throw new Error('row has neither build nor parse');
  const manifest = toManifest(input.build.manifest);
  const out = buildSessionMapState(
    manifest,
    toLogs(input.build.logs, manifest),
    input.build.receivedAt,
  );
  expect(view(out, Object.keys(expected))).toEqual(expected);
});
