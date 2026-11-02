/**
 * Home's Pinned widget (DD-17): the viewer's pins (repositories, Analytics views, reports) from
 * the `home.pins` user setting, each with an Unpin button, then the favorite sessions of the
 * shown repositories (`isFavorite` in the shared `['home-sessions', …]` lists — no endpoint lists
 * favorites across repositories). Pins of repositories the viewer cannot see now are hidden.
 */
import { useQueries } from '@tanstack/react-query';
import { Pin, Star, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { RepositorySession } from '../../../../models/repositories';
import { pinKey } from '../../../lib/home-pins';
import { useHomePins } from '../../../lib/useHomePins';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import {
  homeSessionsQuery,
  pinLine,
  shortRepoName,
  withSearch,
} from './home-queries';
import type { HomeRepo, UseHomeRepos } from './useHomeRepos';

interface Favorite {
  session: RepositorySession;
  repo: HomeRepo;
}

export function HomePinned({ home }: { home: UseHomeRepos }) {
  const { pins, toggle, isLoading, isError, refetch } = useHomePins();
  const sessionLists = useQueries({
    queries: home.shown.map((r) => homeSessionsQuery(r)),
  });

  const byId = new Map<number, HomeRepo>(home.repos.map((r) => [r.repoId, r]));
  const pinned = pins.flatMap((pin) => {
    const repo = byId.get(pin.repoId);
    return repo ? [{ pin, repo, ...pinLine(pin, repo) }] : [];
  });
  const favorites: Favorite[] = [];
  home.shown.forEach((repo, i) => {
    for (const session of sessionLists[i]?.data ?? []) {
      if (session.isFavorite) favorites.push({ session, repo });
    }
  });
  favorites.sort((a, b) =>
    b.session.startTime.localeCompare(a.session.startTime),
  );
  const favoritesPending = sessionLists.some((q) => q.isPending);

  return (
    <HomeWidget
      testId="home-pinned"
      title="Pinned"
      icon={Pin}
      tone="indigo"
      isLoading={isLoading || home.isLoading}
      isError={isError || home.isError}
      onRetry={() => {
        refetch();
        home.refetch();
      }}
    >
      {pinned.length === 0 && favorites.length === 0 ? (
        <HomeEmpty>
          {favoritesPending
            ? 'Loading favorite sessions…'
            : 'Pin a repository, an Analytics view or a report with the pin button, or star a session.'}
        </HomeEmpty>
      ) : (
        <ul className="flex flex-col gap-1 text-sm">
          {pinned.map(({ pin, label, to }) => (
            <li
              key={pinKey(pin)}
              className="group flex min-w-0 items-center gap-2"
            >
              <Link
                to={to}
                data-testid="home-pinned-item"
                className="min-w-0 truncate hover:underline"
              >
                {label}
              </Link>
              <button
                type="button"
                data-testid="home-pinned-unpin"
                aria-label={`Unpin ${label}`}
                title="Unpin"
                onClick={() => toggle(pin)}
                className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {favorites.map(({ session, repo }) => (
            <li
              key={session.sessionId}
              className="flex min-w-0 items-baseline gap-2"
            >
              <Star
                className="size-3.5 shrink-0 self-center fill-amber-400 text-amber-400"
                aria-label="Favorite session"
              />
              <Link
                to={withSearch(repo.basePath, { session: session.sessionId })}
                data-testid={`home-pinned-session-${session.sessionId}`}
                title={session.firstPrompt ?? session.sessionId}
                className="min-w-0 truncate hover:underline"
              >
                {session.firstPrompt?.trim() || session.sessionId.slice(0, 8)}
              </Link>
              <span className="shrink-0 text-xs text-muted-foreground">
                {shortRepoName(repo.repoUrl)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </HomeWidget>
  );
}
