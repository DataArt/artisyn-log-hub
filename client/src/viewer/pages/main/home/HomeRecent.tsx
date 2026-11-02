/**
 * Home's Recent widget (DD-15): the sessions and repositories the viewer opened last in this
 * browser, already filtered against the repositories the viewer can see now (`useHomeRepos`).
 * A line opens the repository through its current route (personal or team), so a visit recorded
 * through a team the viewer has since left still opens the repository they can see.
 */
import { Link } from 'react-router-dom';
import { FolderGit2, History, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatRelativeDate } from '../../../../lib/format';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import { shortRepoName, withSearch } from './home-queries';
import { HOME_TONES } from './home-tones';
import type { HomeRepo, UseHomeRepos } from './useHomeRepos';

/** Pairs each visit with the visible repository it belongs to; drops the others. */
function withRepo<T extends { repoId: number }>(
  visits: readonly T[],
  byId: ReadonlyMap<number, HomeRepo>,
): { visit: T; repo: HomeRepo }[] {
  const out: { visit: T; repo: HomeRepo }[] = [];
  for (const visit of visits) {
    const repo = byId.get(visit.repoId);
    if (repo) out.push({ visit, repo });
  }
  return out;
}

export function HomeRecent({ home }: { home: UseHomeRepos }) {
  const byId = new Map<number, HomeRepo>(home.repos.map((r) => [r.repoId, r]));
  const sessions = withRepo(home.recent.sessions, byId);
  const repos = withRepo(home.recent.repos, byId);

  return (
    <HomeWidget
      testId="home-recent"
      title="Recent"
      icon={History}
      tone="slate"
      isLoading={home.isLoading}
      isError={home.isError}
      onRetry={home.refetch}
    >
      {sessions.length === 0 && repos.length === 0 ? (
        <HomeEmpty>Repositories and sessions you open show up here.</HomeEmpty>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {sessions.length > 0 && (
            <ul className="flex flex-col gap-1" aria-label="Recent sessions">
              {sessions.map(({ visit: s, repo }) => {
                const search: Record<string, string> = { session: s.sessionId };
                if (s.tab !== 'summary') search.tab = s.tab;
                return (
                  <li
                    key={s.sessionId}
                    className="flex min-w-0 items-center gap-2"
                  >
                    <MessageSquare
                      className={cn('size-3.5 shrink-0', HOME_TONES.slate.icon)}
                      aria-hidden
                    />
                    <Link
                      to={withSearch(repo.basePath, search)}
                      data-testid={`home-recent-session-${s.sessionId}`}
                      title={s.label || s.sessionId}
                      className="min-w-0 truncate hover:underline"
                    >
                      {s.label || s.sessionId.slice(0, 8)}
                    </Link>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {shortRepoName(repo.repoUrl)} ·{' '}
                      {formatRelativeDate(new Date(s.at))}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {repos.length > 0 && (
            <ul
              className="flex flex-wrap gap-x-3 gap-y-1"
              aria-label="Recent repositories"
            >
              {repos.map(({ visit: r, repo }) => {
                return (
                  <li key={r.repoId}>
                    <Link
                      to={repo.basePath}
                      data-testid={`home-recent-repo-${r.repoId}`}
                      title={repo.repoUrl}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 hover:underline',
                        HOME_TONES.sky.badge,
                      )}
                    >
                      <FolderGit2 className="size-3" aria-hidden />
                      {shortRepoName(repo.repoUrl)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </HomeWidget>
  );
}
