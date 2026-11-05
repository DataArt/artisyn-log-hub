/**
 * Table test for docs/knowledgebase/algorithms/otel-live-tree.md: every row of its rows file runs
 * against the real key grammar (`parseOtelLiveNodeKey` / `formatOtelLiveNodeKey`) and tree
 * builder (`buildOtelLiveTree`).
 */
import { loadExamples } from '../../../../scripts/algo-docs/load-examples.cjs';
import type { TeamScope } from '../team-scope';
import {
  buildOtelLiveTree,
  formatOtelLiveNodeKey,
  parseOtelLiveNodeKey,
} from './otel-live-tree';
import type {
  OtelLiveAgentRow,
  OtelLiveCandidate,
  OtelLiveNode,
  OtelLivePlacementRow,
  OtelLiveRetainedRepoLabel,
  OtelLiveRootTotalsRow,
  ParsedLiveKey,
} from './otel-live.types';

interface ScopeTeamInput {
  teamId: number;
  teamName: string;
  userIds: number[] | null;
  restricted: boolean;
}

type PlacementInput = Omit<OtelLivePlacementRow, 'sessionUuid' | 'startedAt'>;

type RootTotalsInput = Pick<
  OtelLiveRootTotalsRow,
  'rootId' | 'costUsdMicros' | 'calls' | 'firstEventAt' | 'lastActivityAt'
>;

type AgentInput = Pick<
  OtelLiveAgentRow,
  | 'rootId'
  | 'agentKey'
  | 'agentLabel'
  | 'costUsdMicros'
  | 'calls'
  | 'firstEventAt'
  | 'lastEventAt'
>;

type TreeInput = {
  kind: 'tree';
  now: string;
  scopeTeams: ScopeTeamInput[];
  candidates: OtelLiveCandidate[];
  placements: PlacementInput[];
  rootTotals: RootTotalsInput[];
  agents: AgentInput[];
  retainedKeys: string[];
  retainedRepoLabels: OtelLiveRetainedRepoLabel[];
};

type LiveTreeInput = { kind: 'key'; key: string } | TreeInput;

interface KeyExpected {
  parsed: ParsedLiveKey | null;
  formatted: string | null;
}

interface TreeExpected {
  nodes: Record<string, unknown>[];
  resolve?: Record<string, string | null>;
  rootIdsOf?: Record<string, number[]>;
  childrenOf?: Record<string, string[]>;
  distinctFootnote?: Record<string, boolean>;
}

const rows = loadExamples<LiveTreeInput, KeyExpected | TreeExpected>(
  'otel-live-tree',
);

/** The tree ignores the scope (the reader masks with it), so one fixed value serves every row. */
function scopeOf(team: ScopeTeamInput): TeamScope {
  return {
    accessMode: team.restricted ? 'restricted' : 'transparent',
    visibility: team.restricted ? 'own-only' : 'team-with-prompts',
    visibleUserIds: team.userIds,
    analyticsAllowed: !team.restricted,
    isTeamOwner: false,
    isManager: false,
    isAdlcTrainer: false,
  };
}

function parseOrThrow(key: string): ParsedLiveKey {
  const parsed = parseOtelLiveNodeKey(key);
  if (parsed === null) {
    throw new Error(`rows file: retained key ${key} is malformed`);
  }
  return parsed;
}

/** A node flattened to the fields the rows file names. */
function flatten(node: OtelLiveNode): Record<string, unknown> {
  return {
    key: node.key,
    type: node.type,
    parentKey: node.parentKey,
    label: node.label,
    live: node.live,
    inTree: node.inTree,
    restricted: node.restricted,
    cost: node.totals.costUsdMicros,
    calls: node.totals.calls,
    liveSessions: node.totals.liveSessions,
    liveAgents: node.totals.liveAgents,
    runningMs: node.totals.runningMs,
    firstEventAt: node.totals.firstEventAt,
    lastActivityAt: node.totals.lastActivityAt,
  };
}

function runTree(input: TreeInput, expected: TreeExpected): void {
  const tree = buildOtelLiveTree({
    now: new Date(input.now),
    scopeTeams: input.scopeTeams.map((t) => ({ ...t, scope: scopeOf(t) })),
    candidates: input.candidates,
    placements: input.placements.map((p) => ({
      ...p,
      sessionUuid: `uuid-${p.rootId}`,
      startedAt: null,
    })),
    rootTotals: input.rootTotals.map((r) => ({
      ...r,
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
    })),
    agents: input.agents.map((a) => ({
      ...a,
      inputTokens: '0',
      outputTokens: '0',
      cacheReadTokens: '0',
      cacheWriteTokens: '0',
    })),
    retainedKeys: input.retainedKeys.map(parseOrThrow),
    retainedRepoLabels: input.retainedRepoLabels,
  });

  // Each node is compared on the fields its expected entry lists; order and count are exact.
  const actual = tree.nodes.map(flatten);
  expect(actual.length).toBe(expected.nodes.length);
  expected.nodes.forEach((want, i) => {
    const got = actual[i] ?? {};
    const picked = Object.fromEntries(
      Object.keys(want).map((field) => [field, got[field]]),
    );
    expect({ index: i, ...picked }).toEqual({ index: i, ...want });
  });
  for (const [key, want] of Object.entries(expected.resolve ?? {})) {
    expect({ key, resolved: tree.resolve(key)?.key ?? null }).toEqual({
      key,
      resolved: want,
    });
  }
  for (const [key, want] of Object.entries(expected.rootIdsOf ?? {})) {
    expect({ key, rootIds: tree.rootIdsOf(key) }).toEqual({
      key,
      rootIds: want,
    });
  }
  for (const [key, want] of Object.entries(expected.childrenOf ?? {})) {
    expect({ key, children: tree.childrenOf(key).map((n) => n.key) }).toEqual({
      key,
      children: want,
    });
  }
  for (const [key, want] of Object.entries(expected.distinctFootnote ?? {})) {
    expect({ key, footnote: tree.distinctFootnote(key) }).toEqual({
      key,
      footnote: want,
    });
  }
}

function isKeyExpected(e: KeyExpected | TreeExpected): e is KeyExpected {
  return 'parsed' in e;
}

it.each(rows)('$id', ({ input, expected }) => {
  if (input.kind === 'key') {
    if (!isKeyExpected(expected)) {
      throw new Error('rows file: a key row needs expected.parsed');
    }
    const parsed = parseOtelLiveNodeKey(input.key);
    expect(parsed).toEqual(expected.parsed);
    expect(parsed === null ? null : formatOtelLiveNodeKey(parsed)).toBe(
      expected.formatted,
    );
    return;
  }
  if (isKeyExpected(expected)) {
    throw new Error('rows file: a tree row needs expected.nodes');
  }
  runTree(input, expected);
});
