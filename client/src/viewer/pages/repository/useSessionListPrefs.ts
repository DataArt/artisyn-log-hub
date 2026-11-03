import { useState } from 'react';
import { type ViewMode } from './session-list/SessionListPanel';

/**
 * The session list's per-browser preferences: the view mode (all repos) and whether hook
 * sessions are hidden (per repo, hidden by default), kept in `localStorage`.
 */
export function useSessionListPrefs(repoId: number) {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const stored = localStorage.getItem(
      'artisyn:sessionViewMode',
    ) as ViewMode | null;
    return stored ?? 'branch';
  });

  function handleViewModeChange(mode: ViewMode) {
    localStorage.setItem('artisyn:sessionViewMode', mode);
    setViewMode(mode);
  }

  const [hideHookSessions, setHideHookSessions] = useState<boolean>(() => {
    const stored = localStorage.getItem(
      `artisyn:repo-${repoId}-hideHookSessions`,
    );
    return stored !== null ? stored === 'true' : true;
  });

  function handleHideHookSessionsChange(value: boolean) {
    localStorage.setItem(
      `artisyn:repo-${repoId}-hideHookSessions`,
      String(value),
    );
    setHideHookSessions(value);
  }

  return {
    viewMode,
    handleViewModeChange,
    hideHookSessions,
    handleHideHookSessionsChange,
  };
}
