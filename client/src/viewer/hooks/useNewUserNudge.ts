import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Team } from '../../models/teams';
import { fetchMyRepositories, fetchTeams } from '../api';
import type { UserRepository } from '../api';
import { routes } from './useHashRoute';

/** Set once the nudge has fired, so it does not repeat in the same tab. */
const NUDGE_DONE_KEY = 'artisyn:newUserNudgeDone';

/**
 * A brand-new user: no repositories and no teams yet. Both queries are the ones
 * `AppLeftNav` already mounts, so reading them here costs no extra request.
 * Returns false while either is still loading — the nudge must not fire on an
 * empty cache.
 */
export function useIsNewUser(): boolean {
  const repos = useQuery<UserRepository[]>({
    queryKey: ['my-repos'],
    queryFn: fetchMyRepositories,
  });
  const teams = useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  return (
    repos.data !== undefined &&
    teams.data !== undefined &&
    repos.data.length === 0 &&
    teams.data.length === 0
  );
}

function isNudgeDone(): boolean {
  try {
    return sessionStorage.getItem(NUDGE_DONE_KEY) !== null;
  } catch {
    // Private mode / storage disabled — treat as "already nudged" rather than
    // nudging on every render.
    return true;
  }
}

function markNudgeDone(): void {
  try {
    sessionStorage.setItem(NUDGE_DONE_KEY, '1');
  } catch {
    // Nothing to do — the navigation below still happens exactly once because
    // this browser session cannot persist the flag anyway.
  }
}

/**
 * Sends a brand-new user to the API Keys page once per browser session, and
 * only from the default landing route — an explicit deep link is never
 * overridden. Called only from the consent-accepted branch, so it can never
 * fire while the consent screen is up.
 */
export function useNewUserNudge(): void {
  const isNewUser = useIsNewUser();
  const navigate = useNavigate();
  const location = useLocation();
  const onDefaultRoute = location.pathname === routes.main;

  useEffect(() => {
    if (!isNewUser || !onDefaultRoute || isNudgeDone()) return;
    markNudgeDone();
    void navigate(routes.apiKeys, { replace: true });
  }, [isNewUser, onDefaultRoute, navigate]);
}
