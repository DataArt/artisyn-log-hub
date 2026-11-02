/**
 * Gathers everything the All views map is built from into one `NavTreeInput` (DD-10, DD-11):
 * the repositories and teams the viewer can open (the same query keys `AppLeftNav` and
 * `TeamAccordion` keep warm), the signed-in user, the help index, the report and Analytics view
 * catalogs, the question table and the rail context.
 *
 * The rail (FR-E3) comes from the URL (`teamId`, `repoId`, `session` — the page the map was
 * opened from, or a pick on the map); without any of them it falls back to the last visit in
 * Recent (`fromRecent`), else it stays empty ("choose…").
 *
 * Nothing is fetched for the session context: what is known about the rail session (its owner,
 * whether it has advisor advice) is read from session lists already in the query cache.
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router-dom';
import {
  fetchMyRepositories,
  fetchTeamRepositories,
  fetchTeams,
} from '../../api';
import { useAuth } from '../../context/AuthContext';
import { helpNav } from '../../help/articles';
import type { RepositorySession } from '../../../models/repositories';
import type { Team } from '../../../models/teams';
import type { TabVisibilityContext } from '../../tab-ids';
import { VIEW_OPTIONS } from '../repository/analytics/analytics-state';
import { REPORT_CATEGORIES } from '../repository/reports/report-catalog';
import {
  EMPTY_MAP_RECENT,
  filterMapRecent,
  readMapRecent,
  type MapRecent,
} from './map-recent';
import { NAV_QUESTIONS } from './nav-questions';
import {
  dedupeRepos,
  type NavContext,
  type NavRepo,
  type NavTeam,
  type NavTreeInput,
} from './nav-tree';

const EMPTY_TEAMS: Team[] = [];

/** The rail context read from the URL; an absent or malformed value is `undefined`. */
export interface MapRailParams {
  teamId?: number;
  repoId?: number;
  sessionId?: string;
}

/** The effective rail context. */
export interface MapRail extends MapRailParams {
  /** Taken from the last visit (Recent), not from the URL. */
  fromRecent: boolean;
}

function parseId(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

export function readMapRailParams(params: URLSearchParams): MapRailParams {
  const session = params.get('session')?.trim();
  return {
    teamId: parseId(params.get('teamId')),
    repoId: parseId(params.get('repoId')),
    sessionId: session ? session : undefined,
  };
}

/** The rail session as found in a cached `['repo-sessions', repoId, …]` list, if any. */
function findCachedSession(
  lists: [unknown, RepositorySession[] | undefined][],
  sessionId: string,
): RepositorySession | undefined {
  for (const [, list] of lists) {
    const hit = list?.find((s) => s.sessionId === sessionId);
    if (hit) return hit;
  }
  return undefined;
}

/** The rail taken from the last visit: the latest repository, its team and its latest session. */
function railFromRecent(recent: MapRecent, repos: readonly NavRepo[]): MapRail {
  const entry = recent.repos[0] ?? recent.sessions[0];
  if (!entry) return { fromRecent: false };
  const repoId = entry.repoId;
  const teamId =
    entry.teamId !== undefined &&
    repos.some((r) => r.id === repoId && r.teamId === entry.teamId)
      ? entry.teamId
      : undefined;
  const sessionId = recent.sessions.find((s) => s.repoId === repoId)?.sessionId;
  return { teamId, repoId, sessionId, fromRecent: true };
}

export interface NavTreeInputState {
  input: NavTreeInput;
  /** The rail context, unknown repository / team ids dropped once the lists loaded. */
  rail: MapRail;
  /** The repository and team lists are still loading. */
  loading: boolean;
  /** Every repository the viewer can open, deduplicated (personal entries win). */
  repos: NavRepo[];
  /**
   * Every entry before deduplication: a personal repository shared with a team appears once
   * personal and once per team, so team membership is read from here, not from `repos`.
   */
  repoEntries: NavRepo[];
  teams: NavTeam[];
  /** Recent visits, filtered against the visible repositories. */
  recent: MapRecent;
  /** Writes a new rail context into the URL (no history entry; `q` and router state kept). */
  setRail: (next: MapRailParams) => void;
}

export function useNavTreeInput(): NavTreeInputState {
  const { user } = useAuth();
  const userId = user?.id;
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // One "now" per map visit, so question presets do not change under the viewer.
  const [now] = useState(() => new Date());

  const myReposQuery = useQuery({
    queryKey: ['my-repos'],
    queryFn: fetchMyRepositories,
  });
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: fetchTeams });
  const teams = teamsQuery.data ?? EMPTY_TEAMS;
  // Teams the viewer belongs to (an admin's `['teams']` may list others, as in AppLeftNav).
  const myTeams = useMemo(
    () => teams.filter((t) => t.isMember !== false),
    [teams],
  );

  // `combine` keeps a stable result while the underlying query results do not change.
  const teamRepos = useQueries({
    queries: myTeams.map((team) => ({
      queryKey: ['team-repos', team.id],
      queryFn: () => fetchTeamRepositories(team.id),
    })),
    combine: (results) => ({
      pending: results.some((q) => q.isPending),
      lists: results.map((q) => q.data),
    }),
  });
  const teamReposPending = teamRepos.pending;
  const teamRepoLists = teamRepos.lists;

  const repos = useMemo<NavRepo[]>(() => {
    const out: NavRepo[] = (myReposQuery.data ?? []).map((r) => ({
      id: r.id,
      label: r.repoUrl,
    }));
    for (const list of teamRepoLists) {
      for (const r of list ?? []) {
        if (r.repositoryId === null) continue;
        out.push({ id: r.repositoryId, label: r.repoUrl, teamId: r.teamId });
      }
    }
    return out;
  }, [myReposQuery.data, teamRepoLists]);
  const uniqueRepos = useMemo(() => dedupeRepos(repos), [repos]);

  const navTeams = useMemo<NavTeam[]>(
    () =>
      myTeams.map((t) => ({
        id: t.id,
        name: t.name,
        accessMode: t.accessMode,
        ownerId: t.ownerId,
        myIsManager: t.myIsManager,
      })),
    [myTeams],
  );

  const loading =
    myReposQuery.isPending || teamsQuery.isPending || teamReposPending;

  // Read once per user per map visit; filtered against what the viewer can see right now.
  const storedRecent = useMemo(() => readMapRecent(userId), [userId]);
  const recent = useMemo<MapRecent>(
    () =>
      loading
        ? EMPTY_MAP_RECENT
        : filterMapRecent(storedRecent, new Set(repos.map((r) => r.id))),
    [loading, storedRecent, repos],
  );

  const rawRail = readMapRailParams(searchParams);
  const railTeamId = rawRail.teamId;
  const railRepoId = rawRail.repoId;
  const railSessionId = rawRail.sessionId;
  const urlHasRail =
    railTeamId !== undefined ||
    railRepoId !== undefined ||
    railSessionId !== undefined;

  const rail = useMemo<MapRail>(() => {
    if (!urlHasRail) {
      return loading ? { fromRecent: false } : railFromRecent(recent, repos);
    }
    if (loading)
      return {
        teamId: railTeamId,
        repoId: railRepoId,
        sessionId: railSessionId,
        fromRecent: false,
      };
    // Unknown values are ignored (API changes): a repository or team the viewer cannot open.
    const teamId =
      railTeamId !== undefined && navTeams.some((t) => t.id === railTeamId)
        ? railTeamId
        : undefined;
    const repoKnown =
      railRepoId !== undefined && repos.some((r) => r.id === railRepoId);
    const repoId = repoKnown ? railRepoId : undefined;
    return {
      teamId,
      repoId,
      sessionId: repoId !== undefined ? railSessionId : undefined,
      fromRecent: false,
    };
  }, [
    urlHasRail,
    loading,
    recent,
    navTeams,
    repos,
    railTeamId,
    railRepoId,
    railSessionId,
  ]);

  const setRail = useCallback(
    (next: MapRailParams) => {
      const params = new URLSearchParams(searchParams);
      const put = (key: string, value: string | number | undefined) => {
        if (value === undefined || value === '') params.delete(key);
        else params.set(key, String(value));
      };
      put('teamId', next.teamId);
      put('repoId', next.repoId);
      put('session', next.repoId !== undefined ? next.sessionId : undefined);
      // Keep `state.from`, so Esc / Back still return to the page the map was opened from.
      setSearchParams(params, { replace: true, state: location.state });
    },
    [searchParams, setSearchParams, location.state],
  );

  const context = useMemo<NavContext>(() => {
    const ctx: NavContext = {
      teamId: rail.teamId,
      repoId: rail.repoId,
      sessionId: rail.sessionId,
      sessionCtx: {},
    };
    if (rail.repoId === undefined || rail.sessionId === undefined) return ctx;
    const cached = findCachedSession(
      queryClient.getQueriesData<RepositorySession[]>({
        queryKey: ['repo-sessions', rail.repoId],
      }),
      rail.sessionId,
    );
    // Unknown advisor state is not greyed: the Advisor tab itself explains a missing result.
    const sessionCtx: TabVisibilityContext = {
      hasAdvisorResult: cached ? cached.hasAdvisorAdvice === true : true,
    };
    ctx.sessionCtx = sessionCtx;
    if (cached?.userId !== undefined) ctx.sessionUserId = cached.userId;
    return ctx;
  }, [rail, queryClient]);

  const input = useMemo<NavTreeInput>(
    () => ({
      userId,
      teams: navTeams,
      repos,
      context,
      isAdmin: user?.role === 'admin',
      helpNav,
      reports: REPORT_CATEGORIES,
      analyticsViews: VIEW_OPTIONS,
      questions: NAV_QUESTIONS,
      recentSessions: recent.sessions,
      now,
    }),
    [userId, navTeams, repos, context, user?.role, recent, now],
  );

  return {
    input,
    rail,
    loading,
    repos: uniqueRepos,
    repoEntries: repos,
    teams: navTeams,
    recent,
    setRail,
  };
}
