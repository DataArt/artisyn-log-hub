/**
 * Home's "Start from a question" widget (DD-12): question cards for one of the shown
 * repositories — the first entry by default, another one through the select — and "All views →"
 * to the map.
 */
import { useState } from 'react';
import { Lightbulb } from 'lucide-react';
import { Link } from 'react-router-dom';
import { routes } from '../../../hooks/useHashRoute';
import { HomeQuestionChips } from './HomeQuestionChips';
import { HomeEmpty, HomeWidget } from './HomeWidget';
import { shortRepoName } from './home-queries';
import { homeRepoKey, type UseHomeRepos } from './useHomeRepos';

export function HomeQuestions({ home }: { home: UseHomeRepos }) {
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const { shown, data } = home;
  const repo =
    shown.find((r) => homeRepoKey(r) === chosenKey) ?? shown[0] ?? null;

  return (
    <HomeWidget
      testId="home-questions"
      title="Start from a question"
      icon={Lightbulb}
      tone="violet"
      isLoading={home.isLoading}
      isError={home.isError}
      onRetry={home.refetch}
      action={
        <Link
          to={routes.map()}
          data-testid="home-questions-all-views"
          className="text-xs text-primary hover:underline"
        >
          All views →
        </Link>
      }
    >
      {repo === null ? (
        <HomeEmpty>Questions appear once a repository has sessions.</HomeEmpty>
      ) : (
        <div className="flex flex-col gap-3">
          {shown.length > 1 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              Repository
              <select
                data-testid="home-questions-repo"
                value={homeRepoKey(repo)}
                onChange={(e) => setChosenKey(e.target.value)}
                className="h-7 max-w-[280px] rounded-md border border-border bg-background px-2 text-xs text-foreground"
              >
                {shown.map((r) => (
                  <option key={homeRepoKey(r)} value={homeRepoKey(r)}>
                    {shortRepoName(r.repoUrl)}
                    {r.teamName ? ` (${r.teamName})` : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
          <HomeQuestionChips
            repo={repo}
            hasHook={data.get(homeRepoKey(repo))?.hook != null}
            recent={home.recent}
            variant="card"
            testIdPrefix="home-question"
          />
        </div>
      )}
    </HomeWidget>
  );
}
