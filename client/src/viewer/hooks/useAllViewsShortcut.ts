/**
 * The doors to the All views map (DD-18, FR-E7).
 *
 * - `useOpenAllViews()` returns the callback the top-nav "All views" button and Ctrl/Cmd+K use:
 *   it opens `#/map` with the rail prefilled from the current route (team, repository, session)
 *   and `state.from` set to the page it was opened from, so Esc / Back can return there. On the
 *   map itself it only focuses the filter.
 * - `useAllViewsShortcut()` is mounted once in `AppShell`: a capture-phase `window` keydown
 *   listener for Ctrl/Cmd+K (no Alt, no Shift), which works inside text inputs too and suppresses
 *   the browser's own Ctrl+K. No other key is handled.
 */
import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { routes, type MapRouteParams } from './useHashRoute';

/** Dispatched on `window` when a door is used while the map is open: the map focuses its filter. */
export const MAP_FOCUS_FILTER_EVENT = 'loghub:map-focus-filter';

/** The router state the map is opened with. */
export interface MapOpenState {
  /** Path and search of the page the map was opened from. */
  from: string;
}

export function isMapOpenState(v: unknown): v is MapOpenState {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { from?: unknown }).from === 'string'
  );
}

const TEAM_REPO_RE = /^\/teams\/(\d+)\/repos\/(\d+)\/?$/;
const TEAM_RE = /^\/teams\/(\d+)\/?$/;
const REPO_RE = /^\/repos\/(\d+)(?:\/hook-state)?\/?$/;

function toId(v: string): number | undefined {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** The map rail context of a route (`routes.team`, `routes.repo`, `routes.teamRepo`, …). */
export function mapParamsFromLocation(
  pathname: string,
  search: string,
): MapRouteParams {
  const session = new URLSearchParams(search).get('session')?.trim();
  let m = TEAM_REPO_RE.exec(pathname);
  if (m) {
    return {
      teamId: toId(m[1]),
      repoId: toId(m[2]),
      ...(session ? { session } : {}),
    };
  }
  m = REPO_RE.exec(pathname);
  if (m) {
    const isSessionView = !pathname.includes('/hook-state');
    return {
      repoId: toId(m[1]),
      ...(session && isSessionView ? { session } : {}),
    };
  }
  m = TEAM_RE.exec(pathname);
  if (m) return { teamId: toId(m[1]) };
  return {};
}

export function useOpenAllViews(): () => void {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(() => {
    if (location.pathname === routes.map()) {
      window.dispatchEvent(new Event(MAP_FOCUS_FILTER_EVENT));
      return;
    }
    const state: MapOpenState = {
      from: location.pathname + location.search,
    };
    void navigate(
      routes.map(mapParamsFromLocation(location.pathname, location.search)),
      { state },
    );
  }, [navigate, location.pathname, location.search]);
}

export function useAllViewsShortcut(): void {
  const open = useOpenAllViews();
  // The listener is added once; it always calls the latest callback.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.altKey &&
        !e.shiftKey &&
        typeof e.key === 'string' &&
        e.key.toLowerCase() === 'k'
      ) {
        e.preventDefault();
        openRef.current();
      }
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () =>
      window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, []);
}
