import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type {
  RepositorySession,
  SessionAttributionAttributeDef,
} from '../../../../models/repositories';
import { cn } from '../../../lib/cn';
import { SessionItem, computeCostThresholds } from './session-list-helpers';

interface UserSectionProps {
  userEmail: string;
  sessions: RepositorySession[];
  isInitiallyOpen: boolean;
  selectedSession: RepositorySession | null;
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  attributeDefs?: SessionAttributionAttributeDef[];
}

export function UserSection({
  userEmail,
  sessions,
  isInitiallyOpen,
  selectedSession,
  onSelect,
  attributeDefs,
}: UserSectionProps) {
  const [isOpen, setIsOpen] = useState(isInitiallyOpen);

  const thresholds = useMemo(() => computeCostThresholds(sessions), [sessions]);

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
        <span className="flex-1 truncate font-mono text-sm font-medium">
          {userEmail}
        </span>
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

export function groupSessionsByUser(
  sessions: RepositorySession[],
): { userEmail: string; sessions: RepositorySession[] }[] {
  const map = new Map<string, RepositorySession[]>();
  for (const s of sessions) {
    const key = s.userEmail ?? '(unknown)';
    const group = map.get(key);
    if (group) {
      group.push(s);
    } else {
      map.set(key, [s]);
    }
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([userEmail, group]) => ({ userEmail, sessions: group }));
}
