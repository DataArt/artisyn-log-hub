/**
 * The question chips / cards of one Home repository (DD-12): every non-map-only
 * `NAV_QUESTIONS` entry, built for that repository. "Is my hook healthy?" is listed only for a
 * repository in `['hook-repos']` (DD-13 "Hook links") — a team-only repository has no hook view.
 */
import { CircleHelp } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { RecentVisits } from '../../../lib/recent-visits';
import { NAV_QUESTIONS, type NavQuestion } from '../../map/nav-questions';
import { useMapActivate } from '../../map/useMapActivate';
import type { HomeRepo } from './useHomeRepos';

export function homeQuestionsFor(hasHook: boolean): readonly NavQuestion[] {
  return NAV_QUESTIONS.filter(
    (q) => !q.mapOnly && (q.id !== 'hook' || hasHook),
  );
}

export interface HomeQuestionChipsProps {
  repo: HomeRepo;
  hasHook: boolean;
  recent: RecentVisits;
  /** `chip` — small rounded chips (repo entries); `card` — larger cards (Questions widget). */
  variant?: 'chip' | 'card';
  testIdPrefix: string;
}

export function HomeQuestionChips({
  repo,
  hasHook,
  recent,
  variant = 'chip',
  testIdPrefix,
}: HomeQuestionChipsProps) {
  const { openTarget } = useMapActivate();
  const open = (q: NavQuestion) =>
    openTarget(
      q.build(
        { repoId: repo.repoId, teamId: repo.teamId },
        recent.sessions,
        new Date(),
      ),
    );
  return (
    <div
      className={cn(
        variant === 'chip'
          ? 'flex flex-wrap gap-1.5'
          : 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-2',
      )}
    >
      {homeQuestionsFor(hasHook).map((q) => (
        <button
          key={q.id}
          type="button"
          data-testid={`${testIdPrefix}-${q.id}`}
          title={q.description}
          onClick={() => open(q)}
          className={cn(
            'text-left hover:bg-accent',
            variant === 'chip'
              ? 'rounded-full border border-border px-2.5 py-0.5 text-xs'
              : 'flex flex-col gap-1 rounded-md border border-border p-3 text-sm',
          )}
        >
          {variant === 'chip' ? (
            q.label
          ) : (
            <>
              <span className="flex items-center gap-1.5 font-medium">
                <CircleHelp
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                {q.label}
              </span>
              <span className="text-xs text-muted-foreground">
                {q.description}
              </span>
            </>
          )}
        </button>
      ))}
    </div>
  );
}
