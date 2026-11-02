/**
 * The repository entries of Home (DD-13) and their per-entry data.
 *
 * Visible repositories = `['my-repos']` ∪ the repositories of the viewer's teams
 * (`['teams']` → `['team-repos', teamId]`, rows with `repositoryId != null`), deduplicated by
 * repository id — a personal entry wins over a team entry. The query keys are the ones
 * `AppLeftNav` / `TeamAccordion` keep warm, so Home usually renders them from cache.
 *
 * Order: the last Recent visit (DD-15) newest first, then `repoUrl` ascending. No API returns the
 * last activity of every repository, so this is not a true activity order; the shown last
 * activity comes from the hook state of the shown entries and the list is never re-sorted after
 * it loads (it would jump). The first `HOME_REPO_LIMIT` entries are shown; `showAll` expands the
 * list in place.
 *
 * Per shown entry (and only for shown entries — "Show all" turns the queries on for the newly
 * shown ones), all with `staleTime: HOME_STALE_TIME_MS`:
 * - the executive summary for the week window (session count and cost), key
 *   `homeSummaryKey(...)` — the This week widget reuses it;
 * - hook status from `['hook-repos']` (the viewer's own repositories only — a team-only
 *   repository has no hook status);
 * - `['hook-state', repoId]` only when the repository is in `['hook-repos']` (last activity).
 */

import { useCallback, useMemo, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  fetchExecutiveSummaryReport,
  fetchHookRepositories,
  fetchHookState,
  fetchMyRepositories,
  fetchTeamRepositories,
  fetchTeams,
} from '../../../api';
import type { ExecutiveSummaryReportData } from '../../../../models/repositories';
import type {
  HookRepositorySummary,
  HookStateDetail,
} from '../../../../models/hook-state';
import type { Team } from '../../../../models/teams';
import { routes } from '../../../hooks/useHashRoute';
import {
  filterRecentVisits,
  lastRepoVisit,
  type RecentVisits,
} from '../../../lib/recent-visits';
import { useRecentVisits } from '../../../lib/useRecentVisits';
import { weekWindow, type WeekWindow } from '../../../lib/week-window';
import { useAuth } from '../../../context/AuthContext';
import { teamWideAccess } from '../../../tab-ids';

export const HOME_REPO_LIMIT = 10;
export const HOME_STALE_TIME_MS = 60_000;

const EMPTY_TEAMS: Team[] = [];
const EMPTY_HOOK_REPOS: HookRepositorySummary[] = [];

export interface HomeRepo {
  repoId: number;
  /** Set for a repository the viewer sees only through a team. */
  teamId?: number;
  teamName?: string;
  repoUrl: string;
  /** The repository's base path: `routes.repo(id)` or `routes.teamRepo(teamId, id)`. */
  basePath: string;
  /**
   * Whether the viewer reaches the repository's team-wide data (the executive summary): always
   * for a personal entry, `teamWideAccess` for a team entry. A plain member of a `restricted`
   * team gets 403 there, so Home does not ask and shows "—".
   */
  teamWide: boolean;
  /** Last Recent visit (epoch ms), 0 when never visited in this browser. */
  lastVisit: number;
}

/** A per-entry query result, reduced to what a widget renders. */
export interface HomeEntryQuery<T> {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export interface HomeRepoData {
  summary: HomeEntryQuery<ExecutiveSummaryReportData>;
  /** The `['hook-repos']` row, or `null` when the repository is not one of the viewer's own. */
  hook: HookRepositorySummary | null;
  /** `undefined` data when there is no hook row (nothing is fetched then). */
  hookState: HomeEntryQuery<HookStateDetail>;
}

/** Shared executive-summary query key of Home (This week and the repo entries use it). */
export function homeSummaryKey(
  repoId: number,
  teamId: number | undefined,
  week: WeekWindow,
) {
  return [
    'home-exec-summary',
    repoId,
    teamId ?? null,
    week.fromDate,
    week.toDate,
  ] as const;
}

export function homeSummaryQuery(
  repoId: number,
  teamId: number | undefined,
  week: WeekWindow,
  enabled = true,
) {
  return {
    queryKey: homeSummaryKey(repoId, teamId, week),
    queryFn: () =>
      fetchExecutiveSummaryReport(repoId, {
        teamId,
        startDate: week.from,
        endDate: week.to,
      }),
    staleTime: HOME_STALE_TIME_MS,
    enabled,
  };
}

export function homeRepoKey(repo: Pick<HomeRepo, 'repoId' | 'teamId'>): string {
  return `${repo.repoId}:${repo.teamId ?? ''}`;
}

/** Orders entries per DD-13: last Recent visit desc, then repoUrl asc. Pure. */
export function orderHomeRepos(
  repos: readonly Omit<HomeRepo, 'lastVisit'>[],
  recent: RecentVisits,
): HomeRepo[] {
  return repos
    .map((r) => ({ ...r, lastVisit: lastRepoVisit(recent, r.repoId) }))
    .sort(
      (a, b) => b.lastVisit - a.lastVisit || a.repoUrl.localeCompare(b.repoUrl),
    );
}

function reduce<T>(q: {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => unknown;
}): HomeEntryQuery<T> {
  return {
    data: q.data,
    isPending: q.isPending,
    isError: q.isError,
    refetch: () => void q.refetch(),
  };
}

const IDLE: HomeEntryQuery<never> = {
  data: undefined,
  isPending: false,
  isError: false,
  refetch: () => undefined,
};

export interface UseHomeRepos {
  /** Every visible repository, ordered. */
  repos: HomeRepo[];
  /** The entries shown now (the first `HOME_REPO_LIMIT`, or all after "Show all"). */
  shown: HomeRepo[];
  total: number;
  showAll: boolean;
  setShowAll: (value: boolean) => void;
  /** Per shown entry, by `homeRepoKey`. */
  data: ReadonlyMap<string, HomeRepoData>;
  /** The viewer's teams (members only, as in the left nav). */
  teams: Team[];
  /** Recent visits filtered against the visible repositories. */
  recent: RecentVisits;
  /** The week window of this Home visit (fixed for the visit, so the presets do not move). */
  week: WeekWindow;
  /** The repository / team lists are still loading. */
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useHomeRepos(): UseHomeRepos {
  const [week] = useState(() => weekWindow(new Date()));
  const [showAll, setShowAll] = useState(false);
  const { recent: storedRecent } = useRecentVisits();
  const { user } = useAuth();
  const userId = user?.id;

  const myReposQuery = useQuery({
    queryKey: ['my-repos'],
    queryFn: fetchMyRepositories,
  });
  const teamsQuery = useQuery({ queryKey: ['teams'], queryFn: fetchTeams });
  const allTeams = teamsQuery.data ?? EMPTY_TEAMS;
  const teams = useMemo(
    () => allTeams.filter((t) => t.isMember !== false),
    [allTeams],
  );

  const teamRepos = useQueries({
    queries: teams.map((team) => ({
      queryKey: ['team-repos', team.id],
      queryFn: () => fetchTeamRepositories(team.id),
    })),
    combine: (results) => ({
      pending: results.some((q) => q.isPending),
      error: results.some((q) => q.isError),
      lists: results.map((q) => q.data),
      refetchAll: () => {
        for (const q of results) void q.refetch();
      },
    }),
  });

  const visible = useMemo<Omit<HomeRepo, 'lastVisit'>[]>(() => {
    const byId = new Map<number, Omit<HomeRepo, 'lastVisit'>>();
    for (const r of myReposQuery.data ?? []) {
      byId.set(r.id, {
        repoId: r.id,
        repoUrl: r.repoUrl,
        basePath: routes.repo(r.id),
        teamWide: true,
      });
    }
    teamRepos.lists.forEach((list, i) => {
      const team = teams[i];
      for (const r of list ?? []) {
        if (r.repositoryId === null || byId.has(r.repositoryId)) continue;
        byId.set(r.repositoryId, {
          repoId: r.repositoryId,
          teamId: r.teamId,
          teamName: team?.name,
          repoUrl: r.repoUrl,
          basePath: routes.teamRepo(r.teamId, r.repositoryId),
          teamWide: team === undefined || teamWideAccess(team, userId),
        });
      }
    });
    return [...byId.values()];
  }, [myReposQuery.data, teamRepos.lists, teams, userId]);

  const isLoading =
    myReposQuery.isPending || teamsQuery.isPending || teamRepos.pending;

  const recent = useMemo(
    () =>
      filterRecentVisits(storedRecent, new Set(visible.map((r) => r.repoId))),
    [storedRecent, visible],
  );

  // Ordered once the lists are in: later Recent writes (a visit from another tab) re-order only
  // on the next Home visit, so the list does not jump under the viewer.
  const [orderSnapshot, setOrderSnapshot] = useState<{
    visible: typeof visible;
    ordered: HomeRepo[];
  } | null>(null);
  let repos: HomeRepo[];
  if (isLoading) {
    repos = [];
  } else if (orderSnapshot !== null && orderSnapshot.visible === visible) {
    repos = orderSnapshot.ordered;
  } else {
    repos = orderHomeRepos(visible, recent);
    setOrderSnapshot({ visible, ordered: repos });
  }

  const shown = useMemo(
    () => (showAll ? repos : repos.slice(0, HOME_REPO_LIMIT)),
    [repos, showAll],
  );

  const hookReposQuery = useQuery({
    queryKey: ['hook-repos'],
    queryFn: fetchHookRepositories,
    staleTime: HOME_STALE_TIME_MS,
  });
  const hookRepos = hookReposQuery.data ?? EMPTY_HOOK_REPOS;
  const hookById = useMemo(
    () => new Map(hookRepos.map((h) => [h.id, h])),
    [hookRepos],
  );

  const summaries = useQueries({
    queries: shown.map((r) =>
      homeSummaryQuery(r.repoId, r.teamId, week, r.teamWide),
    ),
  });
  const hookStates = useQueries({
    queries: shown.map((r) => ({
      queryKey: ['hook-state', r.repoId],
      queryFn: () => fetchHookState(r.repoId),
      staleTime: HOME_STALE_TIME_MS,
      enabled: hookById.has(r.repoId),
    })),
  });

  const data = useMemo(() => {
    const out = new Map<string, HomeRepoData>();
    shown.forEach((r, i) => {
      const hook = hookById.get(r.repoId) ?? null;
      const summary = summaries[i];
      const hookState = hookStates[i];
      out.set(homeRepoKey(r), {
        summary: summary && r.teamWide ? reduce(summary) : IDLE,
        hook,
        hookState: hook !== null && hookState ? reduce(hookState) : IDLE,
      });
    });
    return out;
  }, [shown, hookById, summaries, hookStates]);

  const { refetch: refetchMyRepos } = myReposQuery;
  const { refetch: refetchTeams } = teamsQuery;
  const refetchTeamRepos = teamRepos.refetchAll;
  const refetch = useCallback(() => {
    void refetchMyRepos();
    void refetchTeams();
    refetchTeamRepos();
  }, [refetchMyRepos, refetchTeams, refetchTeamRepos]);

  return {
    repos,
    shown,
    total: repos.length,
    showAll,
    setShowAll,
    data,
    teams,
    recent,
    week,
    isLoading,
    isError: myReposQuery.isError || teamsQuery.isError || teamRepos.error,
    refetch,
  };
}
