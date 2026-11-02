/**
 * Query definitions and small helpers the Home widgets share, so two widgets that need the same
 * data use the same TanStack Query key and nothing is fetched twice (DD-13 "Requests"):
 * - `['home-sessions', repoId, teamId|null]` — the repository's session list (Needs attention's
 *   advisor lines, Pinned's favorite sessions);
 * - `['home-tool-errors', repoId, teamId|null, fromDate, toDate]` — the failed tool-call total of
 *   the week (Needs attention).
 */
import { formatCostUsd } from '../../../../lib/format';
import { fetchRepositorySessions, fetchToolCalls } from '../../../api';
import type { WeekWindow } from '../../../lib/week-window';
import type { Pin } from '../../../lib/home-pins';
import { VIEW_OPTIONS } from '../../repository/analytics/analytics-state';
import { findReport } from '../../repository/reports/report-catalog';
import { HOME_STALE_TIME_MS, type HomeRepo } from './useHomeRepos';

export function homeSessionsQuery(repo: Pick<HomeRepo, 'repoId' | 'teamId'>) {
  return {
    queryKey: ['home-sessions', repo.repoId, repo.teamId ?? null] as const,
    queryFn: () => fetchRepositorySessions(repo.repoId, repo.teamId),
    staleTime: HOME_STALE_TIME_MS,
  };
}

export function homeToolErrorsQuery(
  repo: Pick<HomeRepo, 'repoId' | 'teamId'>,
  week: WeekWindow,
) {
  return {
    queryKey: [
      'home-tool-errors',
      repo.repoId,
      repo.teamId ?? null,
      week.fromDate,
      week.toDate,
    ] as const,
    queryFn: () =>
      fetchToolCalls(repo.repoId, {
        teamId: repo.teamId,
        status: 'error',
        from: week.from,
        to: week.to,
        pageSize: 1,
      }),
    staleTime: HOME_STALE_TIME_MS,
  };
}

/** `path?search` for a router `Link` / `navigate`. */
export function withSearch(
  path: string,
  search: Record<string, string>,
): string {
  const qs = new URLSearchParams(search).toString();
  return qs ? `${path}?${qs}` : path;
}

/** A short repository name for a Home line: the last two path segments of the URL. */
export function shortRepoName(repoUrl: string): string {
  const parts = repoUrl
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .filter(Boolean);
  return parts.slice(-2).join('/') || repoUrl;
}

/** What a pin opens and how it reads, for the repository it points to. */
export function pinLine(
  pin: Pin,
  repo: HomeRepo,
): { label: string; to: string } {
  const name = shortRepoName(repo.repoUrl);
  if (pin.kind === 'view' && pin.view) {
    const [kind, id] = pin.view.split(':');
    if (kind === 'analytics') {
      const view = VIEW_OPTIONS.find((v) => v.value === id);
      return {
        label: `${name} › Analytics › ${view?.label ?? id}`,
        to: withSearch(repo.basePath, { mtab: 'analytics', av: id }),
      };
    }
    if (kind === 'report') {
      return {
        label: `${name} › Reports › ${findReport(id)?.title ?? id}`,
        to: withSearch(repo.basePath, { mtab: 'reports', report: id }),
      };
    }
  }
  return { label: name, to: repo.basePath };
}

/** A week's cost for a Home line: `$0.00` for no spend (not "<$0.01"), else `formatCostUsd`. */
export function homeCost(value: number): string {
  return value === 0 ? '$0.00' : formatCostUsd(value);
}
