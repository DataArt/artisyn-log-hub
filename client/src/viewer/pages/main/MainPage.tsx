/**
 * Home (`#/main`, FR-F0–F7): a two-column grid at `lg+` — repository entries and questions on
 * the left; Needs attention, This week, Pinned and Recent on the right — one column below.
 * The page shell and every widget card render at once; each widget shows its own skeleton,
 * error line and Retry while its data loads. With no repositories and no teams, Get started
 * replaces the empty sections.
 */
import { Link } from 'react-router-dom';
import { routes } from '../../hooks/useHashRoute';
import { HomeGetStarted } from './home/HomeGetStarted';
import { HomeNeedsAttention } from './home/HomeNeedsAttention';
import { HomePinned } from './home/HomePinned';
import { HomeQuestions } from './home/HomeQuestions';
import { HomeRecent } from './home/HomeRecent';
import { HomeRepoEntries } from './home/HomeRepoEntries';
import { HomeThisWeek } from './home/HomeThisWeek';
import { useHomeRepos } from './home/useHomeRepos';

export function MainPage() {
  const home = useHomeRepos();
  const nothingYet =
    !home.isLoading &&
    !home.isError &&
    home.total === 0 &&
    home.teams.length === 0;

  return (
    <div className="h-full overflow-y-auto" data-testid="home-page">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 p-4 md:p-6">
        <header className="flex items-baseline gap-4">
          <h1 className="text-lg font-semibold">Home</h1>
          <Link
            to={routes.map()}
            className="text-sm text-primary hover:underline"
          >
            All views →
          </Link>
        </header>
        {nothingYet ? (
          <div className="max-w-2xl">
            <HomeGetStarted />
          </div>
        ) : (
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <HomeRepoEntries home={home} />
              <HomeQuestions home={home} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <HomeNeedsAttention home={home} />
              <HomeThisWeek home={home} />
              <HomePinned home={home} />
              <HomeRecent home={home} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
