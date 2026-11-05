/**
 * Rows of the Live sankey (2026-11-05 follow-up). The server sends `view.flows` per root × model
 * (or model × agent for a session) over the 2 h window; the team, user, repository and session of
 * each root come from the tree `nodes` the same answer carries — the first placement of the root
 * under the selected node, so a root linked to two teams or repositories counts once.
 *
 * Columns by the selected node: Home model → team → user → session; a team model → user →
 * repository → session; No team model → repository → session; a repository model → user →
 * session (all weighted by cost); a session model → agent, weighted by tokens. An agent has none.
 */
import type {
  OtelLiveFlowRow,
  OtelLiveNode,
  OtelLiveNodeType,
} from '../../models/otel-live';
import type { FlowInputRow } from '../pages/repository/otel/otel-cost-flow-layout';
import { liveNodeLabel, liveSessionLines } from './LiveTree';

type Column = 'model' | 'team' | 'user' | 'repository' | 'session' | 'agent';

const COLUMN_LABELS: Record<Column, string> = {
  model: 'Model',
  team: 'Team',
  user: 'User',
  repository: 'Repository',
  session: 'Session',
  agent: 'Agent',
};

const COLUMNS: Partial<Record<OtelLiveNodeType, Column[]>> = {
  home: ['model', 'team', 'user', 'session'],
  team: ['model', 'user', 'repository', 'session'],
  noteam: ['model', 'repository', 'session'],
  repo: ['model', 'user', 'session'],
  session: ['model', 'agent'],
};

const UNKNOWN = '(unknown)';

export interface LiveFlowData {
  columnLabels: string[];
  rows: FlowInputRow[];
  /** 'tokens' for a session, 'cost' (USD) otherwise. */
  weight: 'cost' | 'tokens';
}

interface RootPlace {
  team: string;
  user: string;
  repository: string;
  session: string;
}

function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The first placement of every root below `selectedKey`, in tree order. */
function placesUnder(
  nodes: readonly OtelLiveNode[],
  selectedKey: string,
): Map<number, RootPlace> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const ancestors = (n: OtelLiveNode): OtelLiveNode[] => {
    const out: OtelLiveNode[] = [];
    let cur = n.parentKey === null ? undefined : byKey.get(n.parentKey);
    while (cur !== undefined) {
      out.push(cur);
      cur = cur.parentKey === null ? undefined : byKey.get(cur.parentKey);
    }
    return out;
  };
  const places = new Map<number, RootPlace>();
  const sessionLabels = new Set<string>();
  for (const n of nodes) {
    if (n.type !== 'session' || n.rootId === null || places.has(n.rootId)) {
      continue;
    }
    const up = ancestors(n);
    if (n.key !== selectedKey && !up.some((a) => a.key === selectedKey)) {
      continue;
    }
    const team = up.find((a) => a.type === 'team' || a.type === 'noteam');
    const repo = up.find((a) => a.type === 'repo');
    // A node is one label per column, so two sessions with the same prompt stay apart.
    let session = liveSessionLines(n)?.what ?? liveNodeLabel(n);
    if (sessionLabels.has(session)) session = `${session} (#${n.rootId})`;
    sessionLabels.add(session);
    places.set(n.rootId, {
      team: team === undefined ? UNKNOWN : liveNodeLabel(team),
      user: n.userEmail ?? UNKNOWN,
      repository: repo === undefined ? UNKNOWN : liveNodeLabel(repo),
      session,
    });
  }
  return places;
}

function agentName(row: OtelLiveFlowRow): string {
  if (row.agentKey === null) return 'utility calls';
  return row.agentLabel ?? row.agentKey;
}

/** The sankey of the selected node, or null when it has none (an agent, or an older server). */
export function buildLiveFlowData(
  flows: readonly OtelLiveFlowRow[] | undefined,
  nodes: readonly OtelLiveNode[],
  selected: OtelLiveNode,
): LiveFlowData | null {
  const columns = COLUMNS[selected.type];
  if (columns === undefined || flows === undefined) return null;
  const weight = selected.type === 'session' ? 'tokens' : 'cost';
  const places =
    selected.type === 'session' ? null : placesUnder(nodes, selected.key);
  const rows: FlowInputRow[] = [];
  for (const f of flows) {
    const place = places?.get(f.rootId);
    if (places !== null && place === undefined) continue;
    const values = columns.map((c) => {
      switch (c) {
        case 'model':
          return f.model === '' ? UNKNOWN : f.model;
        case 'agent':
          return agentName(f);
        default:
          return place?.[c] ?? UNKNOWN;
      }
    });
    const w =
      weight === 'tokens'
        ? toNumber(f.tokens)
        : toNumber(f.costUsdMicros) / 1e6;
    if (w <= 0) continue;
    rows.push({ values, weight: w, calls: f.calls, sessions: 1 });
  }
  return { columnLabels: columns.map((c) => COLUMN_LABELS[c]), rows, weight };
}
