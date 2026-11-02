/**
 * The viewer's Recent visits (DD-15), keyed by the signed-in user id (FR-F2a).
 *
 * Reads and writes `recent-visits` through the try/catch per-user storage helper; without a user
 * nothing is read or written. Every mounted instance in this tab sees a write at once (a small
 * in-module subscriber list feeds `useSyncExternalStore`); another tab's write arrives through
 * the `storage` event. The list is NOT filtered here — callers filter it against the repositories
 * they can currently see (`filterRecentVisits`) before showing or using it.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../context/AuthContext';
import type { SessionTab } from '../tab-ids';
import {
  addRepoVisit,
  addSessionVisit,
  EMPTY_RECENT_VISITS,
  parseRecentVisits,
  removeSessionVisit,
  type RecentVisits,
} from './recent-visits';
import { readUserItem, userStorageKey, writeUserItem } from './user-storage';

type Listener = () => void;
const listeners = new Set<Listener>();
/** Parsed value per storage key, so `getSnapshot` stays referentially stable between writes. */
const cache = new Map<string, RecentVisits>();

function notify(): void {
  for (const l of listeners) l();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && !e.key.endsWith(':recent-visits')) return;
    cache.clear();
    listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function readVisits(userId: number | undefined): RecentVisits {
  const key = userStorageKey(userId, 'recent-visits');
  if (key === null) return EMPTY_RECENT_VISITS;
  const hit = cache.get(key);
  if (hit) return hit;
  const value =
    readUserItem(userId, 'recent-visits', parseRecentVisits) ??
    EMPTY_RECENT_VISITS;
  cache.set(key, value);
  return value;
}

function update(
  userId: number | undefined,
  change: (current: RecentVisits) => RecentVisits,
): void {
  const key = userStorageKey(userId, 'recent-visits');
  if (key === null) return;
  const current = readVisits(userId);
  const next = change(current);
  if (next === current) return;
  cache.set(key, next);
  writeUserItem(userId, 'recent-visits', next);
  notify();
}

export interface RecordSessionInput {
  repoId: number;
  teamId?: number;
  sessionId: string;
  tab: SessionTab;
  label?: string | null;
}

export interface UseRecentVisits {
  recent: RecentVisits;
  recordRepo: (repoId: number, teamId?: number) => void;
  recordSession: (visit: RecordSessionInput) => void;
  dropSession: (sessionId: string) => void;
}

export function useRecentVisits(): UseRecentVisits {
  const { user } = useAuth();
  const userId = user?.id;
  const recent = useSyncExternalStore(subscribe, () => readVisits(userId));

  const recordRepo = useCallback(
    (repoId: number, teamId?: number) =>
      update(userId, (v) => addRepoVisit(v, { repoId, teamId }, Date.now())),
    [userId],
  );
  const recordSession = useCallback(
    (visit: RecordSessionInput) =>
      update(userId, (v) => addSessionVisit(v, visit, Date.now())),
    [userId],
  );
  const dropSession = useCallback(
    (sessionId: string) =>
      update(userId, (v) => removeSessionVisit(v, sessionId)),
    [userId],
  );

  return useMemo(
    () => ({ recent, recordRepo, recordSession, dropSession }),
    [recent, recordRepo, recordSession, dropSession],
  );
}
