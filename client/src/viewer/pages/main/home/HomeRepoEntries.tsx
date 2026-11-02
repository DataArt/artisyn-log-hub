/**
 * Home's repository entries (DD-13): per shown repository its name, last activity (hook state),
 * sessions and cost of the week (executive summary), hook status, the question chips (DD-12),
 * "Open" and "All views of this repo". Every per-entry figure has its own placeholder, so an
 * entry renders at once and fills in. "Show all (N)" expands the list in place.
 */
import type { ReactNode } from 'react';
import { FolderGit2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { formatRelativeDate } from '../../../../lib/format';
import { routes } from '../../../hooks/useHashRoute';
import { Skeleton } from '../../../ui/skeleton';
import { HomeQuestionChips } from './HomeQuestionChips';
import { cn } from '@/lib/cn';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import { homeCost, shortRepoName } from './home-queries';
import { HOME_TONES } from './home-tones';
import {
  HOME_REPO_LIMIT,
  homeRepoKey,
  type HomeRepo,
  type HomeRepoData,
  type UseHomeRepos,
} from './useHomeRepos';

function Figure({
  pending,
  children,
}: {
  pending: boolean;
  children: ReactNode;
}) {
  return pending ? (
    <Skeleton className="inline-block h-4 w-14 align-middle" />
  ) : (
    <>{children}</>
  );
}

function HookStatus({ data }: { data: HomeRepoData | undefined }) {
  const hook = data?.hook ?? null;
  if (hook === null) return <span className="text-muted-foreground">—</span>;
  const attention = hook.outdated || hook.issueCount > 0;
  const parts: string[] = [];
  if (hook.issueCount > 0) {
    parts.push(`${hook.issueCount} issue${hook.issueCount === 1 ? '' : 's'}`);
  }
  if (hook.outdated) parts.push('outdated');
  const text = parts.length > 0 ? parts.join(', ') : 'healthy';
  // App-wide status colours: amber = needs attention, emerald = healthy.
  return (
    <Link
      to={routes.hookState(hook.id)}
      className={cn(
        'rounded-full px-1.5 ring-1 hover:underline',
        HOME_TONES[attention ? 'amber' : 'emerald'].badge,
      )}
    >
      {text}
    </Link>
  );
}

function RepoEntry({
  repo,
  data,
  home,
}: {
  repo: HomeRepo;
  data: HomeRepoData | undefined;
  home: UseHomeRepos;
}) {
  const summary = data?.summary;
  const hookState = data?.hookState;
  const lastActivity = hookState?.data?.lastActivity ?? null;
  return (
    <li
      data-testid={`home-repo-${repo.repoId}`}
      className="flex flex-col gap-2 border-b border-border pb-3 last:border-b-0 last:pb-0"
    >
      {/* Same grid as the widget header: the icon in a 28px (size-7) column, so its centre lines
          up with the header icon chip, and the text starting where the header title starts. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="inline-flex w-7 shrink-0 justify-center" aria-hidden>
          <FolderGit2 className={cn('size-4', HOME_TONES.sky.icon)} />
        </span>
        <Link
          to={repo.basePath}
          title={repo.repoUrl}
          data-testid={`home-repo-open-${repo.repoId}`}
          className="mr-1 truncate font-medium hover:underline"
        >
          {shortRepoName(repo.repoUrl)}
        </Link>
        {repo.teamName && (
          <span className="rounded bg-muted px-1.5 text-xs text-muted-foreground">
            {repo.teamName}
          </span>
        )}
        <Link
          to={routes.map({ repoId: repo.repoId, teamId: repo.teamId })}
          data-testid={`home-repo-all-views-${repo.repoId}`}
          className="ml-auto text-xs text-primary hover:underline"
        >
          All views of this repo
        </Link>
      </div>
      {/* Figures and questions start under the repository name (pl-9 = the 28px icon column + gap). */}
      <div className="flex flex-col gap-2 pl-9">
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Last activity</dt>
            <dd>
              <Figure pending={hookState?.isPending ?? false}>
                {lastActivity ? formatRelativeDate(lastActivity) : '—'}
              </Figure>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Sessions this week</dt>
            <dd data-testid={`home-repo-sessions-${repo.repoId}`}>
              <Figure pending={summary?.isPending ?? true}>
                {summary?.isError ? '—' : (summary?.data?.totalSessions ?? '—')}
              </Figure>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Cost this week</dt>
            <dd data-testid={`home-repo-cost-${repo.repoId}`}>
              <Figure pending={summary?.isPending ?? true}>
                {summary?.isError || !summary?.data
                  ? '—'
                  : homeCost(summary.data.totalCost)}
              </Figure>
            </dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted-foreground">Hook</dt>
            <dd>
              <HookStatus data={data} />
            </dd>
          </div>
        </dl>
        <HomeQuestionChips
          repo={repo}
          hasHook={data?.hook != null}
          recent={home.recent}
          testIdPrefix={`home-repo-question-${repo.repoId}`}
        />
      </div>
    </li>
  );
}

export function HomeRepoEntries({ home }: { home: UseHomeRepos }) {
  const { shown, total, showAll, setShowAll, data } = home;
  return (
    <HomeWidget
      testId="home-repos"
      title="Repositories"
      icon={FolderGit2}
      tone="sky"
      isLoading={home.isLoading}
      isError={home.isError}
      onRetry={home.refetch}
      skeletonLines={4}
    >
      {total === 0 ? (
        <HomeEmpty>No repositories yet.</HomeEmpty>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {shown.map((repo) => (
              <RepoEntry
                key={homeRepoKey(repo)}
                repo={repo}
                data={data.get(homeRepoKey(repo))}
                home={home}
              />
            ))}
          </ul>
          {total > HOME_REPO_LIMIT && (
            <button
              type="button"
              data-testid="home-repos-show-all"
              onClick={() => setShowAll(!showAll)}
              className="self-start text-xs text-primary hover:underline"
            >
              {showAll ? 'Show fewer' : `Show all (${total})`}
            </button>
          )}
        </>
      )}
    </HomeWidget>
  );
}
