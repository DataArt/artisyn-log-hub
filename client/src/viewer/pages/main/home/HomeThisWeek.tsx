/**
 * Home's This week widget: the cost of the last 7 days per shown repository (the shared
 * executive-summary query of the repository entries, so nothing is fetched twice) and per team
 * — the sum of the per-repository executive summaries with `teamId` over the team's visible
 * repositories (`['team-repos', teamId]`, rows with a repository id). There is no team-wide
 * cost endpoint, so a team line waits for all of its repositories.
 */
import { useQueries } from '@tanstack/react-query';
import { Wallet } from 'lucide-react';
import { cn } from '@/lib/cn';
import { fetchTeamRepositories } from '../../../api';
import { useAuth } from '../../../context/AuthContext';
import { teamWideAccess } from '../../../tab-ids';
import { Skeleton } from '../../../ui/skeleton';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import { homeCost, shortRepoName } from './home-queries';
import { HOME_TONES } from './home-tones';
import {
  homeRepoKey,
  homeSummaryQuery,
  type UseHomeRepos,
} from './useHomeRepos';

function Amount({
  pending,
  error,
  value,
  max,
  testId,
}: {
  pending: boolean;
  error: boolean;
  value: number | undefined;
  /** Largest amount of the same table: the bar under the figure is `value / max` of its width. */
  max: number;
  testId: string;
}) {
  if (pending) return <Skeleton className="h-4 w-14" />;
  const known = !error && value !== undefined;
  const share = known && max > 0 ? Math.max(value / max, 0.04) : 0;
  return (
    <span className="flex flex-col items-end gap-0.5">
      <span data-testid={testId} className="tabular-nums">
        {known ? homeCost(value) : '—'}
      </span>
      {/* Blue = cost, as on the charts (ui-principles.md § Status colours). */}
      <span className="block h-1 w-16 rounded-full bg-blue-50" aria-hidden>
        <span
          className={cn('block h-1 rounded-full', HOME_TONES.blue.fill)}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </span>
    </span>
  );
}

/** The largest known amount of a list (0 when none is known yet). */
function maxOf(values: readonly (number | undefined)[]): number {
  return values.reduce<number>((m, v) => (v !== undefined && v > m ? v : m), 0);
}

export function HomeThisWeek({ home }: { home: UseHomeRepos }) {
  const { shown, data, teams, week } = home;
  const { user } = useAuth();
  // A plain member of a restricted team gets 403 on the team-wide executive summary, so
  // that team's line is not asked for and shows "—".
  const teamWide = teams.map((team) => teamWideAccess(team, user?.id));

  const teamRepoLists = useQueries({
    queries: teams.map((team) => ({
      queryKey: ['team-repos', team.id],
      queryFn: () => fetchTeamRepositories(team.id),
    })),
  });
  const teamRepoIds = teams.map((_, i) =>
    (teamRepoLists[i]?.data ?? []).flatMap((r) =>
      r.repositoryId === null ? [] : [r.repositoryId],
    ),
  );
  const flat = teams.flatMap((team, i) =>
    (teamWide[i] ? teamRepoIds[i] : []).map((repoId) => ({
      teamIndex: i,
      repoId,
      teamId: team.id,
    })),
  );
  const teamSummaries = useQueries({
    queries: flat.map((t) => homeSummaryQuery(t.repoId, t.teamId, week)),
  });
  const teamTotals = teams.map((team, i) => {
    if (!teamWide[i]) return { team, total: 0, pending: false, error: true };
    let total = 0;
    let pending = teamRepoLists[i]?.isPending ?? true;
    let error = teamRepoLists[i]?.isError ?? false;
    flat.forEach((t, j) => {
      if (t.teamIndex !== i) return;
      const q = teamSummaries[j];
      if (!q || q.isPending) pending = true;
      else if (q.isError) error = true;
      else total += q.data.totalCost;
    });
    return { team, total, pending, error };
  });
  const repoMax = maxOf(
    shown.map((repo) => data.get(homeRepoKey(repo))?.summary?.data?.totalCost),
  );
  const teamMax = maxOf(
    teamTotals.map((t) => (t.pending || t.error ? undefined : t.total)),
  );

  return (
    <HomeWidget
      testId="home-week"
      title="This week"
      icon={Wallet}
      tone="blue"
      isLoading={home.isLoading}
      isError={home.isError}
      onRetry={home.refetch}
    >
      {shown.length === 0 && teams.length === 0 ? (
        <HomeEmpty>No cost recorded yet.</HomeEmpty>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {shown.length > 0 && (
            <table className="w-full max-w-md">
              <caption className="pb-1 text-left text-xs font-medium uppercase text-muted-foreground">
                Cost per repository
              </caption>
              <tbody>
                {shown.map((repo) => {
                  const summary = data.get(homeRepoKey(repo))?.summary;
                  return (
                    <tr key={homeRepoKey(repo)}>
                      <td
                        className="max-w-0 truncate py-0.5 pr-3"
                        title={repo.repoUrl}
                      >
                        {shortRepoName(repo.repoUrl)}
                      </td>
                      <td className="w-20 py-0.5 text-right">
                        <Amount
                          pending={summary?.isPending ?? true}
                          error={summary?.isError ?? false}
                          value={summary?.data?.totalCost}
                          max={repoMax}
                          testId={`home-week-repo-${repo.repoId}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {teamTotals.length > 0 && (
            <table className="w-full max-w-md">
              <caption className="pb-1 text-left text-xs font-medium uppercase text-muted-foreground">
                Cost per team
              </caption>
              <tbody>
                {teamTotals.map(({ team, total, pending, error }) => (
                  <tr key={team.id}>
                    <td className="max-w-0 truncate py-0.5 pr-3">
                      {team.name}
                    </td>
                    <td className="w-20 py-0.5 text-right">
                      <Amount
                        pending={pending}
                        error={error}
                        value={total}
                        max={teamMax}
                        testId={`home-week-team-${team.id}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </HomeWidget>
  );
}
