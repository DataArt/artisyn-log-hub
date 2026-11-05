import { useEffect } from 'react';
import type { RepositorySession } from '../../../../models/repositories';

/**
 * Opens a collapsible session group (by date, by user) when it holds the selected session, so a
 * session opened by a link is visible in the list rather than hidden in a collapsed group. Runs
 * once per selection: the user can still collapse the group afterwards.
 */
export function useOpenOnSelection(
  sessions: readonly RepositorySession[],
  selectedSession: RepositorySession | null,
  setIsOpen: (open: boolean) => void,
): void {
  const selectedId = selectedSession?.sessionId ?? null;
  const holdsSelected =
    selectedId !== null && sessions.some((s) => s.sessionId === selectedId);
  useEffect(() => {
    if (holdsSelected) setIsOpen(true);
  }, [selectedId, holdsSelected, setIsOpen]);
}
