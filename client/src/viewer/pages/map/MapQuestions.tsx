/**
 * "Start from a question" on top of the All views map: one button per question leaf. A question
 * needs a repository; without one in the rail it is greyed and a click opens the repository
 * picker (the page handles it). While filtering, non-matching questions are dimmed.
 */
import { CircleHelp } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { NavFilterResult, NavNode } from './nav-tree';
import { HighlightedText } from './MapTreeRow';

export interface MapQuestionsProps {
  questions: readonly NavNode[];
  query: string;
  filter: NavFilterResult | null;
  onActivate: (node: NavNode) => void;
}

export function MapQuestions({
  questions,
  query,
  filter,
  onActivate,
}: MapQuestionsProps) {
  if (questions.length === 0) return null;
  const matches = new Set(filter?.matches ?? []);
  return (
    <section
      aria-labelledby="map-questions-title"
      className="flex flex-col gap-2"
    >
      <h2
        id="map-questions-title"
        className="text-sm font-medium text-muted-foreground"
      >
        Start from a question
      </h2>
      <div className="flex flex-wrap gap-2">
        {questions.map((q) => {
          const greyed = q.target === undefined;
          const dimmed = filter !== null && !matches.has(q.id);
          return (
            <button
              key={q.id}
              type="button"
              data-testid={`map-node-${q.id}`}
              aria-disabled={greyed || undefined}
              title={greyed ? 'Choose a repository first' : q.description}
              onClick={() => onActivate(q)}
              className={cn(
                'flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm hover:bg-accent',
                greyed && 'text-muted-foreground',
                dimmed && 'opacity-45',
              )}
            >
              <CircleHelp
                className="size-3.5 text-muted-foreground"
                aria-hidden
              />
              <HighlightedText text={q.label} query={filter ? query : ''} />
              {greyed && (
                <span className="text-xs text-primary">
                  choose a repository ▸
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
