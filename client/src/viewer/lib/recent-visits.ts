/**
 * Recent visits (DD-15): the repositories and sessions the viewer opened last, stored per user in
 * this browser under `recent-visits` (`artisyn:<userId>:recent-visits`).
 *
 * Stored value: `{v:1, repos:[{repoId, teamId?, at}], sessions:[{repoId, teamId?, sessionId, tab,
 * label, at}]}` — `at` is epoch ms. At most `RECENT_REPO_LIMIT` repositories plus
 * `RECENT_SESSION_LIMIT` sessions, newest first, deduplicated by repository id / session id.
 *
 * Pure: no React, no storage. The hook (`useRecentVisits.ts`) reads and writes through
 * `user-storage.ts`. The map's read-only parser (`pages/map/map-recent.ts`) reads the same shape.
 */

import { SESSION_TABS, type SessionTab } from '../tab-ids';

export const RECENT_REPO_LIMIT = 10;
export const RECENT_SESSION_LIMIT = 10;
/** The longest session label kept (a first prompt can be very long). */
export const RECENT_LABEL_MAX = 120;

export interface RecentRepoVisit {
  repoId: number;
  teamId?: number;
  at: number;
}

export interface RecentSessionVisit {
  repoId: number;
  teamId?: number;
  sessionId: string;
  tab: SessionTab;
  label: string;
  at: number;
}

export interface RecentVisits {
  v: 1;
  repos: RecentRepoVisit[];
  sessions: RecentSessionVisit[];
}

export const EMPTY_RECENT_VISITS: RecentVisits = {
  v: 1,
  repos: [],
  sessions: [],
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

function visitTime(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function withTeam<T extends object>(
  base: T,
  teamId: number | undefined,
): T & { teamId?: number } {
  return teamId !== undefined ? { ...base, teamId } : base;
}

/** Shortens a label to `RECENT_LABEL_MAX` characters on one line. */
export function recentLabel(text: string | null | undefined): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > RECENT_LABEL_MAX
    ? `${flat.slice(0, RECENT_LABEL_MAX - 1)}…`
    : flat;
}

/**
 * Parses a stored value. An unknown `v` or a non-object returns `undefined`; malformed entries
 * are skipped; the result is sorted newest first, deduplicated and capped.
 */
export function parseRecentVisits(raw: unknown): RecentVisits | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const repos: RecentRepoVisit[] = [];
  for (const r of Array.isArray(raw.repos) ? raw.repos : []) {
    if (!isRecord(r)) continue;
    const repoId = positiveInt(r.repoId);
    if (repoId === undefined) continue;
    repos.push(
      withTeam({ repoId, at: visitTime(r.at) }, positiveInt(r.teamId)),
    );
  }
  const sessions: RecentSessionVisit[] = [];
  for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
    if (!isRecord(s)) continue;
    const repoId = positiveInt(s.repoId);
    const sessionId = typeof s.sessionId === 'string' ? s.sessionId.trim() : '';
    if (repoId === undefined || !sessionId) continue;
    const tab = SESSION_TABS.find((t) => t === s.tab) ?? 'summary';
    sessions.push(
      withTeam(
        {
          repoId,
          sessionId,
          tab,
          label: typeof s.label === 'string' ? recentLabel(s.label) : '',
          at: visitTime(s.at),
        },
        positiveInt(s.teamId),
      ),
    );
  }
  return normalise({ v: 1, repos, sessions });
}

function normalise(visits: RecentVisits): RecentVisits {
  const repos = [...visits.repos].sort((a, b) => b.at - a.at);
  const sessions = [...visits.sessions].sort((a, b) => b.at - a.at);
  const seenRepos = new Set<number>();
  const seenSessions = new Set<string>();
  return {
    v: 1,
    repos: repos
      .filter((r) => !seenRepos.has(r.repoId) && seenRepos.add(r.repoId))
      .slice(0, RECENT_REPO_LIMIT),
    sessions: sessions
      .filter(
        (s) => !seenSessions.has(s.sessionId) && seenSessions.add(s.sessionId),
      )
      .slice(0, RECENT_SESSION_LIMIT),
  };
}

/** Records a repository open: moves (or adds) it to the front. */
export function addRepoVisit(
  visits: RecentVisits,
  visit: { repoId: number; teamId?: number },
  at: number,
): RecentVisits {
  const entry = withTeam({ repoId: visit.repoId, at }, visit.teamId);
  return normalise({
    ...visits,
    repos: [entry, ...visits.repos.filter((r) => r.repoId !== visit.repoId)],
  });
}

/**
 * Records a session (or session tab) visit: moves (or adds) it to the front, keeping the last
 * known label when the new one is empty. Also counts as a visit of its repository.
 */
export function addSessionVisit(
  visits: RecentVisits,
  visit: {
    repoId: number;
    teamId?: number;
    sessionId: string;
    tab: SessionTab;
    label?: string | null;
  },
  at: number,
): RecentVisits {
  const previous = visits.sessions.find((s) => s.sessionId === visit.sessionId);
  const label = recentLabel(visit.label) || previous?.label || '';
  const entry = withTeam(
    {
      repoId: visit.repoId,
      sessionId: visit.sessionId,
      tab: visit.tab,
      label,
      at,
    },
    visit.teamId,
  );
  return addRepoVisit(
    {
      ...visits,
      sessions: [
        entry,
        ...visits.sessions.filter((s) => s.sessionId !== visit.sessionId),
      ],
    },
    visit,
    at,
  );
}

/** Removes a session (its open failed: `SessionNotFoundState`). */
export function removeSessionVisit(
  visits: RecentVisits,
  sessionId: string,
): RecentVisits {
  if (!visits.sessions.some((s) => s.sessionId === sessionId)) return visits;
  return {
    ...visits,
    sessions: visits.sessions.filter((s) => s.sessionId !== sessionId),
  };
}

/** Keeps the entries of repositories the viewer can currently see. */
export function filterRecentVisits(
  visits: RecentVisits,
  visibleRepoIds: ReadonlySet<number>,
): RecentVisits {
  return {
    v: 1,
    repos: visits.repos.filter((r) => visibleRepoIds.has(r.repoId)),
    sessions: visits.sessions.filter((s) => visibleRepoIds.has(s.repoId)),
  };
}

/** The last visit time of a repository (its own visit or one of its sessions'), 0 if none. */
export function lastRepoVisit(visits: RecentVisits, repoId: number): number {
  let at = 0;
  for (const r of visits.repos) if (r.repoId === repoId && r.at > at) at = r.at;
  for (const s of visits.sessions)
    if (s.repoId === repoId && s.at > at) at = s.at;
  return at;
}
