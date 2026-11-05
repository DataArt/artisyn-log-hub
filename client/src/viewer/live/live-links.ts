/**
 * Link targets of the Live view (2026-11-04 otel-live-view, DD-16). Built from the ids the server
 * sends on every node; the client never parses node keys. Each target is a new pathname plus its
 * own search, so navigating drops `?live=` and the modal closes.
 */
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import type { OtelLiveNode } from '../../models/otel-live';
import { routes } from '../hooks/useHashRoute';

export interface LiveLinkTarget {
  pathname: string;
  search: string;
  /** Router state, e.g. the team page's initial tab (team tabs have no URL param). */
  state?: { teamTab: 'otel' };
}

/** The repository page of a repo id: the team repo page under a team, the own repo otherwise. */
function repoPath(teamId: number | null, repoId: number): string {
  return teamId !== null
    ? routes.teamRepo(teamId, repoId)
    : routes.repo(repoId);
}

/** "Open session ↗": the session on its repository page; null when an id is missing. */
export function liveSessionTarget(node: OtelLiveNode): LiveLinkTarget | null {
  if (node.type !== 'session' || node.repoId === null || !node.sessionUuid) {
    return null;
  }
  const q = new URLSearchParams({ session: node.sessionUuid });
  return {
    pathname: repoPath(node.teamId, node.repoId),
    search: `?${q.toString()}`,
  };
}

/** "Open OTEL tab ↗" of a repo or team node; null for every other node type. */
export function liveOtelTabTarget(node: OtelLiveNode): LiveLinkTarget | null {
  if (node.type === 'repo' && node.repoId !== null) {
    const q = new URLSearchParams({ mtab: 'otel' });
    return {
      pathname: repoPath(node.teamId, node.repoId),
      search: `?${q.toString()}`,
    };
  }
  if (node.type === 'team' && node.teamId !== null) {
    return {
      pathname: routes.team(node.teamId),
      search: '',
      state: { teamTab: 'otel' },
    };
  }
  return null;
}

/** Navigates to a Live link target (a page change, so the modal closes with `live` dropped). */
export function useOpenLiveTarget(): (target: LiveLinkTarget) => void {
  const navigate = useNavigate();
  return useCallback(
    (target: LiveLinkTarget) => {
      void navigate(
        { pathname: target.pathname, search: target.search },
        target.state ? { state: target.state } : undefined,
      );
    },
    [navigate],
  );
}
