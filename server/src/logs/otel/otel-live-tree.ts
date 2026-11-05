// Pure tree algorithm of the OTEL Live view (2026-11-04 otel-live-view): node-key grammar
// (DD-3) and the home → team / No team → repo → session → agent tree built from the rows the
// live SQL returns (DD-4 placement, DD-5 retention, DD-6 totals, DD-2 agent liveness, DD-9).
// No DB, no clock: `now` comes in with the input. Algorithm doc:
// docs/knowledgebase/algorithms/otel-live-tree.md.

import { OTEL_SESSION_ENDED_MS } from './otel-facts.constants';
import {
  OTEL_LIVE_PROMPT_EXCERPT_CHARS,
  OTEL_LIVE_RECENT_MS,
  OTEL_LIVE_TOP_N,
} from './otel-live.constants';
import type {
  OtelLiveAgentRow,
  OtelLiveNode,
  OtelLiveNodeSummary,
  OtelLiveNodeType,
  OtelLivePlacementRow,
  OtelLiveRootTotalsRow,
  OtelLiveScopeTeam,
  OtelLiveTopUser,
  OtelLiveTotals,
  OtelLiveTree,
  OtelLiveTreeInput,
  ParsedLiveKey,
} from './otel-live.types';

export const OTEL_LIVE_HOME_KEY = 'home';
export const OTEL_LIVE_NOTEAM_KEY = 'noteam';

/** Largest value of a Postgres `int` id. */
const MAX_INT_ID = 2_147_483_647;
/** `otel_agent_totals.agent_key` is varchar(255). */
const MAX_AGENT_KEY_LENGTH = 255;

// ── Key grammar (DD-3) ──────────────────────────────────────────────────────────────────

function parseId(raw: string): number | null {
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  return id <= MAX_INT_ID ? id : null;
}

/**
 * Parses a live node key (DD-3). The placement suffix is split at the last `@`; agent ids at the
 * first two `:`. Returns null for a malformed key (→ 400 at the route).
 */
export function parseOtelLiveNodeKey(key: string): ParsedLiveKey | null {
  if (key === OTEL_LIVE_HOME_KEY) {
    return { type: 'home', qualified: false };
  }
  if (key === OTEL_LIVE_NOTEAM_KEY) {
    return { type: 'noteam', noteam: true, qualified: false };
  }
  const colon = key.indexOf(':');
  if (colon <= 0) {
    return null;
  }
  const prefix = key.slice(0, colon);
  const rest = key.slice(colon + 1);
  if (prefix === 'team') {
    const teamId = parseId(rest);
    return teamId === null ? null : { type: 'team', teamId, qualified: false };
  }
  if (prefix !== 'repo' && prefix !== 'session' && prefix !== 'agent') {
    return null;
  }

  let body = rest;
  const placement: Pick<ParsedLiveKey, 'teamId' | 'noteam' | 'qualified'> = {
    qualified: false,
  };
  const at = rest.lastIndexOf('@');
  if (at >= 0) {
    const suffix = rest.slice(at + 1);
    body = rest.slice(0, at);
    if (suffix === OTEL_LIVE_NOTEAM_KEY) {
      placement.noteam = true;
    } else {
      const teamId = parseId(suffix);
      if (teamId === null) {
        return null;
      }
      placement.teamId = teamId;
    }
    placement.qualified = true;
  }

  if (prefix === 'repo') {
    const repoId = parseId(body);
    return repoId === null ? null : { type: 'repo', repoId, ...placement };
  }
  if (prefix === 'session') {
    const rootId = parseId(body);
    return rootId === null ? null : { type: 'session', rootId, ...placement };
  }
  const sep = body.indexOf(':');
  if (sep <= 0) {
    return null;
  }
  const rootId = parseId(body.slice(0, sep));
  const agentKey = body.slice(sep + 1);
  if (
    rootId === null ||
    agentKey.length === 0 ||
    agentKey.length > MAX_AGENT_KEY_LENGTH
  ) {
    return null;
  }
  return { type: 'agent', rootId, agentKey, ...placement };
}

function placementSuffix(parsed: ParsedLiveKey): string {
  if (!parsed.qualified) {
    return '';
  }
  return parsed.noteam === true || parsed.teamId === undefined
    ? `@${OTEL_LIVE_NOTEAM_KEY}`
    : `@${parsed.teamId}`;
}

/** Formats a parsed key back into its string (canonical when `qualified`), DD-3. */
export function formatOtelLiveNodeKey(parsed: ParsedLiveKey): string {
  switch (parsed.type) {
    case 'home':
      return OTEL_LIVE_HOME_KEY;
    case 'noteam':
      return OTEL_LIVE_NOTEAM_KEY;
    case 'team':
      return `team:${parsed.teamId ?? ''}`;
    case 'repo':
      return `repo:${parsed.repoId ?? ''}${placementSuffix(parsed)}`;
    case 'session':
      return `session:${parsed.rootId ?? ''}${placementSuffix(parsed)}`;
    case 'agent':
      return `agent:${parsed.rootId ?? ''}:${parsed.agentKey ?? ''}${placementSuffix(parsed)}`;
  }
}

function placedKey(
  type: 'repo' | 'session',
  id: number,
  teamId: number | null,
): string {
  return formatOtelLiveNodeKey(
    teamId === null
      ? { type, repoId: id, rootId: id, noteam: true, qualified: true }
      : { type, repoId: id, rootId: id, teamId, qualified: true },
  );
}

function agentNodeKey(
  rootId: number,
  agentKey: string,
  teamId: number | null,
): string {
  return formatOtelLiveNodeKey(
    teamId === null
      ? { type: 'agent', rootId, agentKey, noteam: true, qualified: true }
      : { type: 'agent', rootId, agentKey, teamId, qualified: true },
  );
}

function teamNodeKey(teamId: number | null): string {
  return teamId === null ? OTEL_LIVE_NOTEAM_KEY : `team:${teamId}`;
}

// ── Totals (DD-6) ───────────────────────────────────────────────────────────────────────

interface Sums {
  cost: bigint;
  input: bigint;
  output: bigint;
  cacheRead: bigint;
  cacheWrite: bigint;
  calls: number;
}

function toBig(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

function sumsOf(
  row: OtelLiveRootTotalsRow | OtelLiveAgentRow | undefined,
): Sums {
  if (row === undefined) {
    return {
      cost: 0n,
      input: 0n,
      output: 0n,
      cacheRead: 0n,
      cacheWrite: 0n,
      calls: 0,
    };
  }
  return {
    cost: toBig(row.costUsdMicros),
    input: toBig(row.inputTokens),
    output: toBig(row.outputTokens),
    cacheRead: toBig(row.cacheReadTokens),
    cacheWrite: toBig(row.cacheWriteTokens),
    calls: row.calls,
  };
}

function minIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function maxIso(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function spanMs(first: string | null, last: string | null): number {
  if (first === null || last === null) {
    return 0;
  }
  const ms = Date.parse(last) - Date.parse(first);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function totalsOf(
  sums: Sums,
  rest: Pick<
    OtelLiveTotals,
    | 'liveSessions'
    | 'liveAgents'
    | 'runningMs'
    | 'firstEventAt'
    | 'lastActivityAt'
  >,
): OtelLiveTotals {
  return {
    costUsdMicros: sums.cost.toString(),
    inputTokens: sums.input.toString(),
    outputTokens: sums.output.toString(),
    cacheReadTokens: sums.cacheRead.toString(),
    cacheWriteTokens: sums.cacheWrite.toString(),
    calls: sums.calls,
    ...rest,
  };
}

/** Per-root figures, computed once and shared by every placement of the root. */
interface RootFigures {
  rootId: number;
  live: boolean;
  sums: Sums;
  firstEventAt: string | null;
  lastActivityAt: string | null;
  runningMs: number;
  /** Agent keys of the root's live agents (DD-2). */
  liveAgentKeys: Set<string>;
}

/** Parent totals over DISTINCT roots (DD-6). */
function parentTotals(roots: Iterable<RootFigures>): OtelLiveTotals {
  const sums: Sums = {
    cost: 0n,
    input: 0n,
    output: 0n,
    cacheRead: 0n,
    cacheWrite: 0n,
    calls: 0,
  };
  let liveSessions = 0;
  let liveAgents = 0;
  let runningMs = 0;
  let firstEventAt: string | null = null;
  let lastActivityAt: string | null = null;
  for (const root of roots) {
    sums.cost += root.sums.cost;
    sums.input += root.sums.input;
    sums.output += root.sums.output;
    sums.cacheRead += root.sums.cacheRead;
    sums.cacheWrite += root.sums.cacheWrite;
    sums.calls += root.sums.calls;
    if (root.live) {
      liveSessions += 1;
      liveAgents += root.liveAgentKeys.size;
      runningMs = Math.max(runningMs, root.runningMs);
    }
    firstEventAt = minIso(firstEventAt, root.firstEventAt);
    lastActivityAt = maxIso(lastActivityAt, root.lastActivityAt);
  }
  return totalsOf(sums, {
    liveSessions,
    liveAgents,
    runningMs,
    firstEventAt,
    lastActivityAt,
  });
}

function compareByCostDesc(a: OtelLiveNode, b: OtelLiveNode): number {
  const ca = toBig(a.totals.costUsdMicros);
  const cb = toBig(b.totals.costUsdMicros);
  if (ca !== cb) {
    return ca > cb ? -1 : 1;
  }
  if (a.label !== b.label) {
    return a.label < b.label ? -1 : 1;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** Session label: `userEmail · ` plus the first 80 characters of the (masked) prompt (DD-20). */
export function otelLiveSessionLabel(
  userEmail: string,
  firstPrompt: string | null,
): string {
  const prompt =
    firstPrompt === null ? '' : firstPrompt.replace(/\s+/g, ' ').trim();
  const excerpt =
    prompt.length === 0
      ? 'prompt hidden'
      : Array.from(prompt).slice(0, OTEL_LIVE_PROMPT_EXCERPT_CHARS).join('');
  return `${userEmail} · ${excerpt}`;
}

// ── Tree (DD-4, DD-5, DD-6, DD-9) ───────────────────────────────────────────────────────

function emptyNode(
  key: string,
  type: OtelLiveNodeType,
  parentKey: string | null,
  label: string,
): OtelLiveNode {
  return {
    key,
    type,
    parentKey,
    label,
    live: false,
    inTree: true,
    restricted: false,
    teamId: null,
    repoId: null,
    rootId: null,
    sessionUuid: null,
    agentKey: null,
    userEmail: null,
    totals: parentTotals([]),
  };
}

/** One session placement under a repo node (a root may have several). */
interface SessionBranch {
  node: OtelLiveNode;
  agents: OtelLiveNode[];
}

interface RepoBranch {
  node: OtelLiveNode;
  rootIds: Set<number>;
  sessions: Map<number, SessionBranch>;
}

interface TeamBranch {
  node: OtelLiveNode;
  /** Position in the team order; No team sorts last. */
  order: number;
  rootIds: Set<number>;
  repos: Map<number, RepoBranch>;
}

function retainedAgentMatches(
  retained: ParsedLiveKey[],
  rootId: number,
  agentKey: string,
  teamId: number | null,
): boolean {
  return retained.some(
    (k) =>
      k.type === 'agent' &&
      k.rootId === rootId &&
      k.agentKey === agentKey &&
      (!k.qualified ||
        (teamId === null ? k.noteam === true : k.teamId === teamId)),
  );
}

/**
 * Builds the live tree from the live SQL rows (DD-20 input). Placements are kept only for
 * candidate roots and for teams in `scopeTeams` whose filter passes the row's user (DD-4; the SQL
 * already applies it). Retained team / No-team / repo keys keep their node and ancestors with zero
 * totals when nothing live remains (DD-5).
 */
export function buildOtelLiveTree(input: OtelLiveTreeInput): OtelLiveTree {
  const nowMs = input.now.getTime();
  const candidates = new Map<number, boolean>();
  for (const c of input.candidates) {
    candidates.set(c.rootId, (candidates.get(c.rootId) ?? false) || c.live);
  }
  const totalsByRoot = new Map<number, OtelLiveRootTotalsRow>();
  for (const row of input.rootTotals) {
    totalsByRoot.set(row.rootId, row);
  }
  const agentsByRoot = new Map<number, OtelLiveAgentRow[]>();
  for (const row of input.agents) {
    if (row.calls <= 0) {
      continue;
    }
    const list = agentsByRoot.get(row.rootId) ?? [];
    list.push(row);
    agentsByRoot.set(row.rootId, list);
  }

  const teamsSorted: OtelLiveScopeTeam[] = [...input.scopeTeams].sort((a, b) =>
    a.teamName !== b.teamName
      ? a.teamName < b.teamName
        ? -1
        : 1
      : a.teamId - b.teamId,
  );
  const scopeById = new Map<
    number,
    { team: OtelLiveScopeTeam; order: number }
  >();
  teamsSorted.forEach((team, order) =>
    scopeById.set(team.teamId, { team, order }),
  );

  // Root figures (DD-6 session totals, DD-2 agent liveness).
  const figures = new Map<number, RootFigures>();
  const figuresOf = (rootId: number): RootFigures => {
    const known = figures.get(rootId);
    if (known !== undefined) {
      return known;
    }
    const live = candidates.get(rootId) ?? false;
    const row = totalsByRoot.get(rootId);
    const firstEventAt = row?.firstEventAt ?? null;
    const lastActivityAt = row?.lastActivityAt ?? null;
    const liveAgentKeys = new Set<string>();
    if (live) {
      for (const agent of agentsByRoot.get(rootId) ?? []) {
        const last = Date.parse(agent.lastEventAt);
        if (Number.isFinite(last) && nowMs - last <= OTEL_SESSION_ENDED_MS) {
          liveAgentKeys.add(agent.agentKey);
        }
      }
    }
    const made: RootFigures = {
      rootId,
      live,
      sums: sumsOf(row),
      firstEventAt,
      lastActivityAt,
      runningMs: spanMs(firstEventAt, lastActivityAt),
      liveAgentKeys,
    };
    figures.set(rootId, made);
    return made;
  };

  const teams = new Map<number | null, TeamBranch>();
  const teamBranch = (teamId: number | null): TeamBranch | null => {
    const known = teams.get(teamId);
    if (known !== undefined) {
      return known;
    }
    let node: OtelLiveNode;
    let order: number;
    if (teamId === null) {
      node = emptyNode(
        OTEL_LIVE_NOTEAM_KEY,
        'noteam',
        OTEL_LIVE_HOME_KEY,
        'No team',
      );
      order = Number.MAX_SAFE_INTEGER;
    } else {
      const scoped = scopeById.get(teamId);
      if (scoped === undefined) {
        return null;
      }
      node = emptyNode(
        teamNodeKey(teamId),
        'team',
        OTEL_LIVE_HOME_KEY,
        scoped.team.teamName,
      );
      node.teamId = teamId;
      node.restricted = scoped.team.restricted;
      order = scoped.order;
    }
    const made: TeamBranch = {
      node,
      order,
      rootIds: new Set(),
      repos: new Map(),
    };
    teams.set(teamId, made);
    return made;
  };
  const repoBranch = (
    team: TeamBranch,
    teamId: number | null,
    repoId: number,
    label: string,
  ) => {
    const known = team.repos.get(repoId);
    if (known !== undefined) {
      return known;
    }
    const node = emptyNode(
      placedKey('repo', repoId, teamId),
      'repo',
      team.node.key,
      label,
    );
    node.teamId = teamId;
    node.repoId = repoId;
    const made: RepoBranch = { node, rootIds: new Set(), sessions: new Map() };
    team.repos.set(repoId, made);
    return made;
  };

  // DD-4 placement.
  for (const p of input.placements) {
    if (!candidates.has(p.rootId)) {
      continue;
    }
    if (p.teamId !== null) {
      const scoped = scopeById.get(p.teamId);
      if (
        scoped === undefined ||
        (scoped.team.userIds !== null &&
          !scoped.team.userIds.includes(p.userId))
      ) {
        continue;
      }
    }
    const team = teamBranch(p.teamId);
    if (team === null) {
      continue;
    }
    const repo = repoBranch(team, p.teamId, p.repoId, p.repoLabel);
    team.rootIds.add(p.rootId);
    repo.rootIds.add(p.rootId);
    if (!repo.sessions.has(p.rootId)) {
      repo.sessions.set(
        p.rootId,
        buildSession(p, repo.node.key, figuresOf(p.rootId)),
      );
    }
  }

  function buildSession(
    p: OtelLivePlacementRow,
    parentKey: string,
    fig: RootFigures,
  ): SessionBranch {
    const node = emptyNode(
      placedKey('session', p.rootId, p.teamId),
      'session',
      parentKey,
      otelLiveSessionLabel(p.userEmail, p.firstPrompt),
    );
    node.live = fig.live;
    node.teamId = p.teamId;
    node.repoId = p.repoId;
    node.rootId = p.rootId;
    node.sessionUuid = p.sessionUuid;
    node.userEmail = p.userEmail;
    node.totals = totalsOf(fig.sums, {
      liveSessions: fig.live ? 1 : 0,
      liveAgents: fig.liveAgentKeys.size,
      runningMs: fig.runningMs,
      firstEventAt: fig.firstEventAt,
      lastActivityAt: fig.lastActivityAt,
    });
    const agents: OtelLiveNode[] = [];
    for (const row of agentsByRoot.get(p.rootId) ?? []) {
      const live = fig.liveAgentKeys.has(row.agentKey);
      const agent = emptyNode(
        agentNodeKey(p.rootId, row.agentKey, p.teamId),
        'agent',
        node.key,
        row.agentLabel.length > 0 ? row.agentLabel : row.agentKey,
      );
      agent.live = live;
      // Ended agents stay in the tree, greyed, while their last call is recent (rule 15).
      const lastMs = Date.parse(row.lastEventAt);
      agent.inTree =
        live ||
        (Number.isFinite(lastMs) && nowMs - lastMs <= OTEL_LIVE_RECENT_MS) ||
        retainedAgentMatches(
          input.retainedKeys,
          p.rootId,
          row.agentKey,
          p.teamId,
        );
      agent.teamId = p.teamId;
      agent.repoId = p.repoId;
      agent.rootId = p.rootId;
      agent.sessionUuid = p.sessionUuid;
      agent.agentKey = row.agentKey;
      agent.userEmail = p.userEmail;
      agent.totals = totalsOf(sumsOf(row), {
        liveSessions: 0,
        liveAgents: live ? 1 : 0,
        runningMs: spanMs(row.firstEventAt, row.lastEventAt),
        firstEventAt: row.firstEventAt,
        lastActivityAt: row.lastEventAt,
      });
      agents.push(agent);
    }
    agents.sort(compareByCostDesc);
    return { node, agents };
  }

  // DD-5 retention of team / No-team / repo keys.
  const labelFor = (teamId: number | null, repoId: number): string | null =>
    input.retainedRepoLabels.find(
      (l) => l.teamId === teamId && l.repoId === repoId,
    )?.label ?? null;
  for (const k of input.retainedKeys) {
    if (k.type === 'team' && k.teamId !== undefined) {
      teamBranch(k.teamId);
    } else if (k.type === 'noteam') {
      teamBranch(null);
    } else if (k.type === 'repo' && k.repoId !== undefined) {
      const repoId = k.repoId;
      let targets: (number | null)[];
      if (k.qualified) {
        targets = [k.noteam === true ? null : (k.teamId ?? null)];
      } else {
        const placedSomewhere = [...teams.values()].some((t) =>
          t.repos.has(repoId),
        );
        targets = placedSomewhere
          ? []
          : [...teamsSorted.map((t) => t.teamId), null]
              .filter((teamId) => labelFor(teamId, repoId) !== null)
              .slice(0, 1);
      }
      for (const teamId of targets) {
        if (teamId !== null && !scopeById.has(teamId)) {
          continue;
        }
        const existing = teams.get(teamId)?.repos.get(repoId);
        if (existing !== undefined) {
          continue;
        }
        const label = labelFor(teamId, repoId);
        if (label === null) {
          continue;
        }
        const team = teamBranch(teamId);
        if (team !== null) {
          repoBranch(team, teamId, repoId, label);
        }
      }
    }
  }

  // Totals of the parents over DISTINCT roots, then display order.
  const rootSets = new Map<string, Set<number>>();
  const allRoots = new Set<number>();
  const orderedTeams = [...teams.values()].sort((a, b) => a.order - b.order);
  for (const team of orderedTeams) {
    team.node.totals = parentTotals([...team.rootIds].map(figuresOf));
    team.node.live = team.node.totals.liveSessions > 0;
    rootSets.set(team.node.key, team.rootIds);
    for (const id of team.rootIds) allRoots.add(id);
    for (const repo of team.repos.values()) {
      repo.node.totals = parentTotals([...repo.rootIds].map(figuresOf));
      repo.node.live = repo.node.totals.liveSessions > 0;
      rootSets.set(repo.node.key, repo.rootIds);
    }
  }
  const home = emptyNode(OTEL_LIVE_HOME_KEY, 'home', null, 'Home');
  home.totals = parentTotals([...allRoots].map(figuresOf));
  home.live = home.totals.liveSessions > 0;
  rootSets.set(home.key, allRoots);

  const nodes: OtelLiveNode[] = [home];
  for (const team of orderedTeams) {
    nodes.push(team.node);
    const repos = [...team.repos.values()].sort((a, b) =>
      compareByCostDesc(a.node, b.node),
    );
    for (const repo of repos) {
      nodes.push(repo.node);
      const sessions = [...repo.sessions.values()].sort((a, b) =>
        compareByCostDesc(a.node, b.node),
      );
      for (const session of sessions) {
        nodes.push(session.node, ...session.agents);
      }
    }
  }

  const inTreeNodes = nodes.filter((n) => n.inTree);
  const byKey = new Map<string, OtelLiveNode>();
  for (const node of inTreeNodes) {
    if (!byKey.has(node.key)) {
      byKey.set(node.key, node);
    }
  }

  const resolve = (key: string): OtelLiveNode | null => {
    const parsed = parseOtelLiveNodeKey(key);
    if (parsed === null) {
      return null;
    }
    if (
      parsed.qualified ||
      parsed.type === 'home' ||
      parsed.type === 'team' ||
      parsed.type === 'noteam'
    ) {
      return byKey.get(formatOtelLiveNodeKey(parsed)) ?? null;
    }
    // Unqualified repo / session / agent key: the first placement in display order (DD-3).
    return (
      inTreeNodes.find(
        (n) =>
          n.type === parsed.type &&
          (parsed.type === 'repo'
            ? n.repoId === parsed.repoId
            : n.rootId === parsed.rootId &&
              (parsed.type === 'session' || n.agentKey === parsed.agentKey)),
      ) ?? null
    );
  };

  const rootIdsOf = (key: string): number[] => {
    const node = resolve(key);
    if (node === null) {
      return [];
    }
    if (node.type === 'session' || node.type === 'agent') {
      return node.rootId === null ? [] : [node.rootId];
    }
    return [...(rootSets.get(node.key) ?? [])].sort((a, b) => a - b);
  };

  const childrenOf = (key: string): OtelLiveNode[] => {
    const node = resolve(key);
    if (node === null) {
      return [];
    }
    if (node.type === 'repo') {
      // Session keys may repeat under two repos of one team, so match the repo id too.
      return inTreeNodes.filter(
        (n) =>
          n.parentKey === node.key &&
          n.type === 'session' &&
          n.repoId === node.repoId,
      );
    }
    if (node.type === 'session') {
      const first = inTreeNodes.find(
        (n) => n.key === node.key && n.type === 'session',
      );
      return inTreeNodes.filter(
        (n) =>
          n.type === 'agent' &&
          n.parentKey === node.key &&
          n.repoId === first?.repoId,
      );
    }
    return inTreeNodes.filter((n) => n.parentKey === node.key);
  };

  const distinctFootnote = (key: string): boolean => {
    const node = resolve(key);
    if (node === null || node.type === 'session' || node.type === 'agent') {
      return false;
    }
    let cost = 0n;
    let calls = 0;
    for (const child of childrenOf(key)) {
      cost += toBig(child.totals.costUsdMicros);
      calls += child.totals.calls;
    }
    return toBig(node.totals.costUsdMicros) < cost || node.totals.calls < calls;
  };

  return { nodes, resolve, rootIdsOf, childrenOf, distinctFootnote };
}

// ── Details summary (DD-10) ─────────────────────────────────────────────────────────────

/**
 * Tree-derived details of a home / team / No-team / repo node: top users over DISTINCT roots,
 * distinct live users, the longest running live session and (team only) the top repos.
 */
export function summarizeOtelLiveNode(
  tree: OtelLiveTree,
  key: string,
): OtelLiveNodeSummary {
  const node = tree.resolve(key);
  if (node === null) {
    return { topUsers: [], liveUsers: 0, longestRunningMs: 0, topRepos: null };
  }
  const roots = new Set(tree.rootIdsOf(key));
  const sessions = new Map<number, OtelLiveNode>();
  for (const n of tree.nodes) {
    if (
      n.type === 'session' &&
      n.inTree &&
      n.rootId !== null &&
      roots.has(n.rootId)
    ) {
      if (!sessions.has(n.rootId)) {
        sessions.set(n.rootId, n);
      }
    }
  }
  const users = new Map<string, { liveSessions: number; cost: bigint }>();
  const liveUsers = new Set<string>();
  for (const s of sessions.values()) {
    const email = s.userEmail ?? '';
    const entry = users.get(email) ?? { liveSessions: 0, cost: 0n };
    entry.cost += toBig(s.totals.costUsdMicros);
    if (s.live) {
      entry.liveSessions += 1;
      liveUsers.add(email);
    }
    users.set(email, entry);
  }
  const topUsers: OtelLiveTopUser[] = [...users.entries()]
    .sort(([ea, a], [eb, b]) =>
      a.cost !== b.cost
        ? a.cost > b.cost
          ? -1
          : 1
        : ea < eb
          ? -1
          : ea > eb
            ? 1
            : 0,
    )
    .slice(0, OTEL_LIVE_TOP_N)
    .map(([email, u]) => ({
      email,
      liveSessions: u.liveSessions,
      costUsdMicros: u.cost.toString(),
    }));
  const topRepos =
    node.type === 'team'
      ? tree
          .childrenOf(node.key)
          .filter((c) => c.type === 'repo' && c.repoId !== null)
          .sort(compareByCostDesc)
          .slice(0, OTEL_LIVE_TOP_N)
          .map((c) => ({
            repoId: c.repoId ?? 0,
            label: c.label,
            costUsdMicros: c.totals.costUsdMicros,
          }))
      : null;
  return {
    topUsers,
    liveUsers: liveUsers.size,
    longestRunningMs: node.totals.runningMs,
    topRepos,
  };
}
