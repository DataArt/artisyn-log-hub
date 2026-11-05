/**
 * Read model of the OTEL Live view (2026-11-04 otel-live-view): `GET /api/v1/otel/live/status`
 * and `GET /api/v1/otel/live`. Both are user-wide — the caller's personal (No team) sessions plus
 * every team the caller belongs to, each team filtered by its resolved `TeamScope` (DD-4).
 *
 * Flow of a request: caller teams → candidate roots (live, plus retained, DD-5) → placements
 * (prompt masked per DD-11) → stored lifetime totals and agents (DD-22) → the pure
 * `buildOtelLiveTree` → the selected node's window figures (DD-7..DD-9) and the details panel
 * (DD-10). Every query is read-only; a GET never writes.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { DRIZZLE } from '../../database/database.constants';
import type { DrizzleDb } from '../../database/database.module';
import { RepositoriesService, type AuthUser } from '../repositories.service';
import { maskFirstPrompt, type TeamScope } from '../team-scope';
import { bucketStart5m, OTEL_BUCKET_MS } from './otel-classify';
import {
  loadOtelLiveAgents,
  loadOtelLiveBuckets,
  loadOtelLiveCalls,
  loadOtelLiveCandidateRoots,
  loadOtelLiveClaudeVersion,
  loadOtelLiveCostRate,
  loadOtelLiveFlows,
  loadOtelLiveEvents,
  loadOtelLiveLatency,
  loadOtelLivePlacements,
  loadOtelLiveRepoLabel,
  loadOtelLiveRootTotals,
  loadOtelLiveTeams,
  loadOtelLiveTopModels,
  loadOtelLiveTopTools,
} from './otel-live-read.sql';
import {
  buildOtelLiveTree,
  OTEL_LIVE_HOME_KEY,
  parseOtelLiveNodeKey,
  summarizeOtelLiveNode,
} from './otel-live-tree';
import {
  OTEL_LIVE_AGENT_CALLS_LIMIT,
  OTEL_LIVE_BREAKDOWN_AGENTS,
  OTEL_LIVE_RECENT_MS,
  OTEL_LIVE_WINDOW_MS,
} from './otel-live.constants';
import type {
  OtelLiveAgentFilter,
  OtelLiveDetails,
  OtelLiveNode,
  OtelLivePlacementRow,
  OtelLiveResponse,
  OtelLiveRetainedRepoLabel,
  OtelLiveScopeTeam,
  OtelLiveStatusResponse,
  OtelLiveTree,
  OtelLiveView,
  OtelLiveWindow,
  ParsedLiveKey,
} from './otel-live.types';

export interface OtelLiveQuery {
  /** Selected node key (DD-3); default `home`. */
  node: string;
  /** Details-panel node key, or undefined for no panel. */
  panel: string | undefined;
  /** Validated IANA zone, echoed back (FR-12). */
  tz: string;
}

/** Everything a live read loads before building the tree. */
interface LiveSnapshot {
  scopeTeams: OtelLiveScopeTeam[];
  placements: OtelLivePlacementRow[];
  tree: OtelLiveTree;
}

function uniqueSorted(ids: Iterable<number>): number[] {
  return [...new Set(ids)].sort((a, b) => a - b);
}

function parseKeyOrThrow(name: string, key: string): ParsedLiveKey {
  const parsed = parseOtelLiveNodeKey(key);
  if (parsed === null) {
    throw new BadRequestException(`${name} is not a valid live node key`);
  }
  return parsed;
}

function lastActivityMs(node: OtelLiveNode): number {
  const at = node.totals.lastActivityAt;
  const ms = at === null ? NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : 0;
}

@Injectable()
export class OtelLiveReader {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDb,
    private readonly repositoriesService: RepositoriesService,
  ) {}

  /**
   * The caller's teams with their effective row filter (DD-4, DD-20): `visibleUserIds` when the
   * team's analytics are allowed, otherwise only the caller's own rows and a 🔒 team node.
   */
  async resolveScopeTeams(user: AuthUser): Promise<OtelLiveScopeTeam[]> {
    const teams = await loadOtelLiveTeams(this.db, user.id);
    return Promise.all(
      teams.map(async ({ teamId, teamName }): Promise<OtelLiveScopeTeam> => {
        const scope = await this.repositoriesService.resolveTeamScope(
          user,
          teamId,
        );
        return {
          teamId,
          teamName,
          userIds: scope.analyticsAllowed ? scope.visibleUserIds : [user.id],
          restricted: !scope.analyticsAllowed,
          scope,
        };
      }),
    );
  }

  /** Header status (DD-12): the same candidate / placement path as the tree, no retention. */
  async getStatus(user: AuthUser): Promise<OtelLiveStatusResponse> {
    const now = new Date();
    const { tree } = await this.loadSnapshot(user, now, [], [], []);
    const home = tree.resolve(OTEL_LIVE_HOME_KEY);
    const totals = home?.totals;
    const liveSessions = totals?.liveSessions ?? 0;
    return {
      live: liveSessions > 0,
      liveSessions,
      liveAgents: totals?.liveAgents ?? 0,
      costUsdMicros: totals?.costUsdMicros ?? '0',
    };
  }

  /** The live tree, the selected node's view and the details panel (API changes section). */
  async getLive(
    user: AuthUser,
    query: OtelLiveQuery,
  ): Promise<OtelLiveResponse> {
    const now = new Date();
    const nodeKey = parseKeyOrThrow('node', query.node);
    const panelKey =
      query.panel === undefined ? null : parseKeyOrThrow('panel', query.panel);
    const retainedKeys = panelKey === null ? [nodeKey] : [nodeKey, panelKey];

    // DD-5: only session / agent keys name roots.
    const retainedRootIds = uniqueSorted(
      retainedKeys
        .filter((k) => k.type === 'session' || k.type === 'agent')
        .flatMap((k) => (k.rootId === undefined ? [] : [k.rootId])),
    );

    const scopeTeams = await this.resolveScopeTeams(user);
    const retainedRepoLabels = await this.loadRetainedRepoLabels(
      user.id,
      scopeTeams,
      retainedKeys,
    );
    const { placements, tree } = await this.loadSnapshot(
      user,
      now,
      retainedRootIds,
      retainedKeys,
      retainedRepoLabels,
      scopeTeams,
      // The tree also lists recently ended sessions, greyed; the header status does not.
      OTEL_LIVE_RECENT_MS,
    );

    const home = tree.resolve(OTEL_LIVE_HOME_KEY);
    const selected = tree.resolve(query.node) ?? home;
    if (selected === null) {
      // The tree always carries home; this only guards the type.
      throw new BadRequestException('node is not available');
    }

    const windowTo = new Date(bucketStart5m(now).getTime() + OTEL_BUCKET_MS);
    const window: OtelLiveWindow = {
      from: new Date(windowTo.getTime() - OTEL_LIVE_WINDOW_MS),
      to: windowTo,
    };

    const panelNode =
      query.panel === undefined ? null : tree.resolve(query.panel);
    const [view, details] = await Promise.all([
      this.buildView(tree, selected, now, window),
      panelNode === null
        ? Promise.resolve(null)
        : this.buildDetails(
            user,
            tree,
            panelNode,
            placements,
            scopeTeams,
            window,
          ),
    ]);

    return {
      generatedAt: now.toISOString(),
      tz: query.tz,
      windowFrom: window.from.toISOString(),
      windowTo: window.to.toISOString(),
      selected: selected.key,
      nodes: tree.nodes.filter((n) => n.inTree),
      view,
      details,
    };
  }

  // ── Loading ───────────────────────────────────────────────────────────────────────────

  /** Candidates → placements (masked, DD-11) → totals and agents → tree. */
  private async loadSnapshot(
    user: AuthUser,
    now: Date,
    retainedRootIds: number[],
    retainedKeys: ParsedLiveKey[],
    retainedRepoLabels: OtelLiveRetainedRepoLabel[],
    knownScopeTeams?: OtelLiveScopeTeam[],
    recentMs?: number,
  ): Promise<LiveSnapshot> {
    const [scopeTeams, candidates] = await Promise.all([
      knownScopeTeams === undefined
        ? this.resolveScopeTeams(user)
        : Promise.resolve(knownScopeTeams),
      loadOtelLiveCandidateRoots(this.db, now, retainedRootIds, recentMs),
    ]);
    const rawPlacements = await loadOtelLivePlacements(
      this.db,
      user.id,
      scopeTeams,
      candidates.map((c) => c.rootId),
    );
    const scopeByTeam = new Map<number, TeamScope>(
      scopeTeams.map((t) => [t.teamId, t.scope]),
    );
    const placements = rawPlacements.map((p) => {
      const scope = p.teamId === null ? undefined : scopeByTeam.get(p.teamId);
      return scope === undefined
        ? p
        : {
            ...p,
            firstPrompt: maskFirstPrompt(
              scope,
              user.id,
              p.userId,
              p.firstPrompt,
            ),
          };
    });
    const placedRootIds = uniqueSorted(placements.map((p) => p.rootId));
    const [rootTotals, agents] = await Promise.all([
      loadOtelLiveRootTotals(this.db, placedRootIds),
      loadOtelLiveAgents(this.db, placedRootIds),
    ]);
    const tree = buildOtelLiveTree({
      now,
      scopeTeams,
      candidates,
      placements,
      rootTotals,
      agents,
      retainedKeys,
      retainedRepoLabels,
    });
    return { scopeTeams, placements, tree };
  }

  /**
   * Labels of the retained repo keys (DD-5). A qualified key asks for its own placement; an
   * unqualified one for every caller team (and No team), so the tree can take the first
   * placement that the caller may see. A null label drops the key (DD-3 fallback).
   */
  private async loadRetainedRepoLabels(
    callerId: number,
    scopeTeams: OtelLiveScopeTeam[],
    retainedKeys: ParsedLiveKey[],
  ): Promise<OtelLiveRetainedRepoLabel[]> {
    const wanted = new Map<string, { teamId: number | null; repoId: number }>();
    for (const k of retainedKeys) {
      if (k.type !== 'repo' || k.repoId === undefined) continue;
      const repoId = k.repoId;
      let teams: (number | null)[];
      if (k.qualified) {
        teams = [k.noteam === true ? null : (k.teamId ?? null)];
      } else {
        teams = [...scopeTeams.map((t) => t.teamId), null];
      }
      for (const teamId of teams) {
        if (teamId !== null && !scopeTeams.some((t) => t.teamId === teamId)) {
          continue;
        }
        wanted.set(`${teamId ?? 'noteam'}:${repoId}`, { teamId, repoId });
      }
    }
    const labels = await Promise.all(
      [...wanted.values()].map(async ({ teamId, repoId }) => {
        const label = await loadOtelLiveRepoLabel(
          this.db,
          callerId,
          teamId,
          repoId,
        );
        return label === null ? null : { teamId, repoId, label };
      }),
    );
    return labels.filter((l): l is OtelLiveRetainedRepoLabel => l !== null);
  }

  // ── View (DD-7, DD-8, DD-9) ───────────────────────────────────────────────────────────

  private agentFilterOf(node: OtelLiveNode): OtelLiveAgentFilter | undefined {
    return node.type === 'agent' &&
      node.rootId !== null &&
      node.agentKey !== null
      ? { rootId: node.rootId, agentKey: node.agentKey }
      : undefined;
  }

  /** Every agent node of a session placement (ended ones too), newest activity first. */
  private sessionAgents(
    tree: OtelLiveTree,
    session: OtelLiveNode,
  ): OtelLiveNode[] {
    return tree.nodes
      .filter(
        (n) =>
          n.type === 'agent' &&
          n.parentKey === session.key &&
          n.repoId === session.repoId,
      )
      .sort((a, b) => lastActivityMs(b) - lastActivityMs(a));
  }

  private async buildView(
    tree: OtelLiveTree,
    selected: OtelLiveNode,
    now: Date,
    window: OtelLiveWindow,
  ): Promise<OtelLiveView> {
    const rootIds = tree.rootIdsOf(selected.key);
    const agent = this.agentFilterOf(selected);
    const [buckets, latency, costPerMinUsdMicros, calls, flows] =
      await Promise.all([
        loadOtelLiveBuckets(this.db, rootIds, window, agent),
        loadOtelLiveLatency(this.db, rootIds, window, agent),
        loadOtelLiveCostRate(this.db, rootIds, now, agent),
        agent === undefined
          ? Promise.resolve(null)
          : loadOtelLiveCalls(this.db, agent, OTEL_LIVE_AGENT_CALLS_LIMIT),
        // The sankey: parents by root × model, a session by model × agent, none for an agent.
        selected.type === 'agent'
          ? Promise.resolve([])
          : loadOtelLiveFlows(
              this.db,
              rootIds,
              window,
              selected.type === 'session',
            ),
      ]);

    let breakdown: OtelLiveNode[];
    let moreAgents = 0;
    if (selected.type === 'agent') {
      breakdown = [];
    } else if (selected.type === 'session') {
      const agents = this.sessionAgents(tree, selected);
      breakdown = agents.slice(0, OTEL_LIVE_BREAKDOWN_AGENTS);
      moreAgents = Math.max(0, agents.length - breakdown.length);
    } else {
      breakdown = tree.childrenOf(selected.key);
    }

    return {
      costPerMinUsdMicros,
      buckets,
      latency,
      hasSpans: latency.length > 0,
      breakdown,
      moreAgents,
      calls,
      distinctFootnote: tree.distinctFootnote(selected.key),
      flows,
    };
  }

  // ── Details (DD-10, DD-11) ────────────────────────────────────────────────────────────

  private async buildDetails(
    user: AuthUser,
    tree: OtelLiveTree,
    node: OtelLiveNode,
    placements: OtelLivePlacementRow[],
    scopeTeams: OtelLiveScopeTeam[],
    window: OtelLiveWindow,
  ): Promise<OtelLiveDetails> {
    const details: OtelLiveDetails = {
      key: node.key,
      type: node.type,
      live: node.live,
      liveUsers: null,
      longestRunningMs: null,
      topUsers: null,
      topModels: null,
      topRepos: null,
      userEmail: null,
      startedAt: null,
      claudeVersion: null,
      firstPrompt: null,
      attributesMasked: false,
      agents: null,
      model: null,
      topTools: null,
      events: null,
      calls: null,
    };

    if (node.type !== 'session' && node.type !== 'agent') {
      const summary = summarizeOtelLiveNode(tree, node.key);
      details.topUsers = summary.topUsers;
      details.liveUsers = summary.liveUsers;
      details.longestRunningMs = summary.longestRunningMs;
      details.topRepos = summary.topRepos;
      details.topModels = await loadOtelLiveTopModels(
        this.db,
        tree.rootIdsOf(node.key),
        window,
      );
      return details;
    }

    const rootId = node.rootId;
    if (rootId === null) {
      return details;
    }
    const placement = placements.find(
      (p) => p.rootId === rootId && p.teamId === node.teamId,
    );
    const teamScope =
      node.teamId === null
        ? undefined
        : scopeTeams.find((t) => t.teamId === node.teamId)?.scope;
    // DD-11: a team-no-prompts caller sees no tool names on another member's session. A row
    // whose owner is unknown is masked rather than leaked, as in `maskFirstPrompt`.
    const masked =
      teamScope !== undefined &&
      teamScope.visibility === 'team-no-prompts' &&
      placement?.userId !== user.id;

    const agent = this.agentFilterOf(node);
    details.userEmail = node.userEmail;
    details.startedAt = placement?.startedAt ?? null;
    details.attributesMasked = masked;

    if (node.type === 'session') {
      const [claudeVersion, topTools, events] = await Promise.all([
        loadOtelLiveClaudeVersion(this.db, rootId),
        masked
          ? Promise.resolve(null)
          : loadOtelLiveTopTools(this.db, rootId, window),
        loadOtelLiveEvents(this.db, rootId),
      ]);
      details.claudeVersion = claudeVersion;
      // Already masked per DD-11 when the placements were loaded.
      details.firstPrompt = placement?.firstPrompt ?? null;
      details.agents = this.sessionAgents(tree, node).slice(
        0,
        OTEL_LIVE_BREAKDOWN_AGENTS,
      );
      details.topTools = topTools;
      details.events = masked
        ? events.map((e) => (e.kind === 'tool' ? { ...e, label: null } : e))
        : events;
      return details;
    }

    // Agent node.
    const [topModels, topTools, events, calls] = await Promise.all([
      loadOtelLiveTopModels(this.db, [rootId], window, agent),
      masked
        ? Promise.resolve(null)
        : loadOtelLiveTopTools(this.db, rootId, window, agent),
      loadOtelLiveEvents(this.db, rootId, agent),
      agent === undefined
        ? Promise.resolve(null)
        : loadOtelLiveCalls(this.db, agent, OTEL_LIVE_AGENT_CALLS_LIMIT),
    ]);
    details.model = topModels[0]?.model ?? null;
    details.topTools = topTools;
    details.events = masked
      ? events.map((e) => (e.kind === 'tool' ? { ...e, label: null } : e))
      : events;
    details.calls = calls;
    return details;
  }
}
