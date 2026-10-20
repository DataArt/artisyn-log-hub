import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  RepositorySession,
  SessionAttributionAttributeDef,
} from '../../../../models/repositories';
import { cn } from '../../../lib/cn';
import { localDayKey } from '../../../lib/format';
import { SessionItem, computeCostThresholds } from './session-list-helpers';

const dateFormatter = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

function sessionDateKey(session: RepositorySession): string {
  return localDayKey(session.endTime);
}

interface DateSectionProps {
  dateKey: string;
  sessions: RepositorySession[];
  isInitiallyOpen: boolean;
  selectedSession: RepositorySession | null;
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  attributeDefs?: SessionAttributionAttributeDef[];
}

export function DateSection({
  dateKey,
  sessions,
  isInitiallyOpen,
  selectedSession,
  onSelect,
  attributeDefs,
}: DateSectionProps) {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);

  const thresholds = useMemo(() => computeCostThresholds(sessions), [sessions]);

  const label = dateFormatter.format(new Date(dateKey + 'T00:00:00'));

  return (
    <div className="border-b border-border">
      <button
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-accent/50 transition-colors"
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <ChevronRight
          className={cn(
            'h-4 w-4 shrink-0 transition-transform',
            isOpen && 'rotate-90',
          )}
        />
        <span className="flex-1 truncate text-sm font-medium">{label}</span>
        <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {sessions.length}
        </span>
      </button>

      {isOpen &&
        sessions.map((session) => (
          <SessionItem
            key={session.sessionId}
            session={session}
            selected={selectedSession?.sessionId === session.sessionId}
            onSelect={onSelect}
            thresholds={thresholds}
            attributeDefs={attributeDefs}
          />
        ))}
    </div>
  );
}

export function groupSessionsByDate(
  sessions: RepositorySession[],
): { dateKey: string; sessions: RepositorySession[] }[] {
  const map = new Map<string, RepositorySession[]>();
  for (const s of sessions) {
    const key = sessionDateKey(s);
    const group = map.get(key);
    if (group) {
      group.push(s);
    } else {
      map.set(key, [s]);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([dateKey, group]) => ({ dateKey, sessions: group }));
}
