import { useCallback, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type { RepositorySession } from '../../../models/repositories';
import { type ViewMode } from './session-list/SessionListPanel';
import { type AnalyticsState } from './analytics/RepositoryAnalytics';
import { applyAnalyticsToParams } from './analytics/analytics-url';
import {
  REPO_MAIN_TABS,
  SESSION_TABS,
  type RepoMainTab,
  type SessionTab,
} from '../../tab-ids';

type MainTab = RepoMainTab;
/**
 * The session detail pane's tabs, mirrored into the `tab` URL param. Derived from
 * `SESSION_TABS` in `tab-ids.ts`; re-exported here for `SessionDetailPane` and
 * `RepositorySessionsPanel`, so there is one declaration and one place to extend.
 */
export type { SessionTab };

/**
 * Validates a raw `tab` URL param value against `SessionTab`.
 * `null` (param absent) and any unrecognized value both resolve to `'summary'` — this replaces
 * an unchecked cast that would otherwise let `?tab=bogus` fall through the pane's ternary chain
 * into the Info tab.
 */
export function parseSessionTab(raw: string | null): SessionTab {
  return raw !== null && (SESSION_TABS as readonly string[]).includes(raw)
    ? (raw as SessionTab)
    : 'summary';
}

export interface UseRepositoryViewStateOptions {
  repoId: number;
  teamId?: number;
  viewMode: ViewMode;
  onBranchSessionSelect: (sessionId: string, branch: string | null) => void;
  onRepoBranchReset: () => void;
}

/**
 * Manages URL-derived tab/param state, session/analytics navigation,
 * and query invalidation on repo change. The repo URL comes from `repoDetailQuery`
 * (`useRepositoryData`), never from another view's cached list (D4.8).
 */
export function useRepositoryViewState({
  repoId,
  teamId,
  viewMode,
  onBranchSessionSelect,
  onRepoBranchReset,
}: UseRepositoryViewStateOptions) {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const mainTab: MainTab = (() => {
    const m = searchParams.get('mtab');
    return m !== null && (REPO_MAIN_TABS as readonly string[]).includes(m)
      ? (m as MainTab)
      : 'sessions';
  })();

  const sessionId = searchParams.get('session') ?? undefined;

  const sessionTab: SessionTab = parseSessionTab(searchParams.get('tab'));

  const topN: number | null = searchParams.get('top')
    ? parseInt(searchParams.get('top')!, 10)
    : null;

  /**
   * Lifts the personal-repo "my sessions only" filter for this view.
   *
   * URL rather than localStorage — unlike `hideHookSessions` (a lasting per-repo preference) this
   * is a transient reveal, so it should be shareable in a link and reset on the next navigation.
   */
  const showAllUsers = searchParams.get('users') === 'all';

  // Invalidate stale queries when navigating to a different repo.
  useEffect(() => {
    void queryClient.invalidateQueries({
      queryKey: ['repo-sessions', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-summary', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-contexts', repoId, teamId],
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-branches', repoId, teamId],
      exact: true,
    });
    void queryClient.invalidateQueries({
      queryKey: ['repo-sessions-branch', repoId, teamId],
    });
    onRepoBranchReset();
  }, [repoId, teamId, queryClient, onRepoBranchReset]);

  function setMainTab(tab: MainTab) {
    const next = new URLSearchParams(searchParams);
    if (
      tab === 'analytics' ||
      tab === 'reports' ||
      tab === 'okf' ||
      tab === 'settings'
    ) {
      next.set('mtab', tab);
      next.delete('session');
      next.delete('tab');
    } else {
      next.delete('mtab');
    }
    // The repo OKF tab owns its `okf*` filter params (DD-44); leaving the tab drops them so
    // they never leak into another tab's URL.
    if (tab !== 'okf') {
      for (const key of [...next.keys()]) {
        if (key.startsWith('okf')) next.delete(key);
      }
    }
    setSearchParams(next, { replace: true });
  }

  function setSessionTab(tab: SessionTab) {
    const next = new URLSearchParams(searchParams);
    if (tab !== 'summary') next.set('tab', tab);
    else next.delete('tab');
    setSearchParams(next, { replace: true });
  }

  function setTopN(n: number | null) {
    const next = new URLSearchParams(searchParams);
    if (n != null) next.set('top', String(n));
    else next.delete('top');
    setSearchParams(next, { replace: true });
  }

  function setShowAllUsers(next: boolean) {
    const params = new URLSearchParams(searchParams);
    if (next) params.set('users', 'all');
    else params.delete('users');
    setSearchParams(params, { replace: true });
  }

  function handleSessionSelect(
    session: RepositorySession,
    viaAdvisorBadge?: boolean,
  ) {
    if (viewMode === 'branch') {
      onBranchSessionSelect(session.sessionId, session.gitBranch ?? null);
    }
    // Push — each selected session is its own history entry, so Back/Forward walks the
    // selections and the detail pane follows the URL.
    const next = new URLSearchParams(searchParams);
    next.set('session', session.sessionId);
    next.delete('mtab');
    // Only a direct click on the Advisor lightbulb badge jumps straight to the
    // Advisor tab. A normal row click just selects the session and leaves the
    // tab alone, same as any other session without advice.
    if (viaAdvisorBadge) next.set('tab', 'advisor');
    setSearchParams(next);
  }

  /** Clears the selected session (e.g. Close on the not-found pane) — no history entry. */
  function closeSession() {
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    next.delete('tab');
    setSearchParams(next, { replace: true });
  }

  function handleAnalyticsSessionClick(sid: string) {
    // Push — creates history entry so back returns to analytics.
    void navigate(
      teamId !== undefined
        ? `/teams/${teamId}/repos/${repoId}?session=${encodeURIComponent(sid)}`
        : `/repos/${repoId}?session=${encodeURIComponent(sid)}`,
    );
  }

  const handleAnalyticsStateChange = useCallback(
    (state: AnalyticsState) => {
      const next = new URLSearchParams(searchParams);
      const prevView = (searchParams.get('av') ??
        'work-time') as AnalyticsState['view'];
      const viewChanged = state.view !== prevView;
      applyAnalyticsToParams(state, next);
      setSearchParams(next, { replace: !viewChanged });
    },
    [searchParams, setSearchParams],
  );

  return {
    searchParams,
    sessionId,
    mainTab,
    sessionTab,
    topN,
    showAllUsers,
    setMainTab,
    setSessionTab,
    setTopN,
    setShowAllUsers,
    handleSessionSelect,
    closeSession,
    handleAnalyticsSessionClick,
    handleAnalyticsStateChange,
  };
}
