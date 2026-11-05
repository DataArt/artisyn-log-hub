/**
 * Share page of the Live chart carousel (2026-11-05 follow-up): how the cost / tokens of the
 * sessions under the selected node split by team, by repository and by user. Built on the client
 * from the tree (`nodes`): the DISTINCT session roots below the selected node, each with its
 * lifetime totals. A root placed under several teams or repos counts once, under its first
 * placement in display order, so every pie adds up to the same total.
 */
import type { OtelLiveNode, OtelLiveTotals } from '../../models/otel-live';
import { liveNodeLabel } from './LiveTree';

export type LiveShareMetric = 'cost' | 'tokens';

export interface LiveShareSlice {
  key: string;
  /** Short legend text (a repository's last path segment). */
  label: string;
  /** Full name for the hover hint (a repository's URL). */
  title: string;
  value: number;
}

export interface LiveShareDimension {
  id: 'team' | 'repo' | 'user';
  title: string;
  /** Distinct teams / repositories / users with a value (before folding into "Other"). */
  count: number;
  slices: LiveShareSlice[];
}

/** The top this many slices (by value) are shown; the rest fold into one "Other" slice. */
export const LIVE_SHARE_TOP = 10;

const PARENT_TYPES: ReadonlySet<OtelLiveNode['type']> = new Set([
  'home',
  'team',
  'noteam',
  'repo',
]);

function totalsValue(t: OtelLiveTotals, metric: LiveShareMetric): number {
  if (metric === 'cost') return Number(t.costUsdMicros) || 0;
  return (
    (Number(t.inputTokens) || 0) +
    (Number(t.outputTokens) || 0) +
    (Number(t.cacheReadTokens) || 0) +
    (Number(t.cacheWriteTokens) || 0)
  );
}

/** `https://github.com/org/repo.git` → `repo`: the part that tells legend rows apart. */
function shortRepoLabel(url: string): string {
  const last = url.replace(/\/+$/, '').split('/').pop() ?? '';
  return last.replace(/\.git$/i, '') || url;
}

interface RootPlacement {
  session: OtelLiveNode;
  team: OtelLiveNode | null;
  repo: OtelLiveNode | null;
}

/** First in-tree placement of every DISTINCT root under `selectedKey`, in display order. */
function rootsUnder(
  nodes: readonly OtelLiveNode[],
  selectedKey: string,
): RootPlacement[] {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const seen = new Set<number>();
  const out: RootPlacement[] = [];
  for (const n of nodes) {
    if (n.type !== 'session' || !n.inTree || n.rootId === null) continue;
    if (seen.has(n.rootId)) continue;
    let team: OtelLiveNode | null = null;
    let repo: OtelLiveNode | null = null;
    let under = n.key === selectedKey;
    const visited = new Set([n.key]);
    let cur = n;
    while (cur.parentKey !== null) {
      const parent = byKey.get(cur.parentKey);
      if (!parent || visited.has(parent.key)) break;
      visited.add(parent.key);
      if (parent.key === selectedKey) under = true;
      if (parent.type === 'repo') repo = parent;
      if (parent.type === 'team' || parent.type === 'noteam') team = parent;
      cur = parent;
    }
    if (!under) continue;
    seen.add(n.rootId);
    out.push({ session: n, team, repo });
  }
  return out;
}

function toSlices(
  acc: ReadonlyMap<string, LiveShareSlice>,
  top: number,
): LiveShareSlice[] {
  const sorted = [...acc.values()]
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  if (sorted.length <= top) return sorted;
  const head = sorted.slice(0, top);
  const rest = sorted.slice(top);
  head.push({
    key: '__other__',
    label: `Other (${rest.length})`,
    title: `${rest.length} more`,
    value: rest.reduce((s, x) => s + x.value, 0),
  });
  return head;
}

/**
 * The three share pies (team, repository, user) of the selected node; null when the node is a
 * session or agent, or nothing under it has a value for `metric`.
 */
export function buildLiveShare(
  nodes: readonly OtelLiveNode[],
  selected: OtelLiveNode,
  metric: LiveShareMetric,
  top: number = LIVE_SHARE_TOP,
): LiveShareDimension[] | null {
  if (!PARENT_TYPES.has(selected.type)) return null;
  const team = new Map<string, LiveShareSlice>();
  const repo = new Map<string, LiveShareSlice>();
  const user = new Map<string, LiveShareSlice>();
  const add = (
    acc: Map<string, LiveShareSlice>,
    key: string,
    label: string,
    value: number,
    title: string = label,
  ) => {
    const s = acc.get(key) ?? { key, label, title, value: 0 };
    s.value += value;
    acc.set(key, s);
  };

  for (const p of rootsUnder(nodes, selected.key)) {
    const v = totalsValue(p.session.totals, metric);
    if (v <= 0) continue;
    if (p.team) add(team, p.team.key, liveNodeLabel(p.team), v);
    if (p.repo) {
      const id = p.repo.repoId === null ? p.repo.key : `repo:${p.repo.repoId}`;
      const url = liveNodeLabel(p.repo);
      add(repo, id, shortRepoLabel(url), v, url);
    }
    const email = p.session.userEmail ?? '';
    add(user, email, email || '(unknown)', v);
  }

  const dim = (
    id: LiveShareDimension['id'],
    title: string,
    acc: ReadonlyMap<string, LiveShareSlice>,
  ): LiveShareDimension => ({
    id,
    title,
    count: [...acc.values()].filter((x) => x.value > 0).length,
    slices: toSlices(acc, top),
  });
  const dims = [
    dim('team', 'By team', team),
    dim('repo', 'By repository', repo),
    dim('user', 'By user', user),
  ];
  return dims.some((d) => d.slices.length > 0) ? dims : null;
}
