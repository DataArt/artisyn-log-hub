/**
 * The map's read-only view of the Recent visits list (DD-15, stored per user under
 * `recent-visits`): the rail falls back to the last visited repository / session, the session
 * picker lists the recent sessions of a repository and the question targets use the latest one.
 *
 * Only reads: the list is written by the repository view (Recent visits model). The parser is
 * lenient — a malformed entry is skipped, an unknown `v` reads as empty — and every result is
 * filtered against the repositories the viewer can currently see before it is used (FR-E3).
 * A pure module apart from `readMapRecent`, which goes through the try/catch storage helper.
 */

import { readUserItem } from '../../lib/user-storage';

export interface MapRecentRepo {
  repoId: number;
  teamId?: number;
  at: number;
}

export interface MapRecentSession {
  repoId: number;
  teamId?: number;
  sessionId: string;
  /** The session's first prompt (or another short label) as recorded on the visit. */
  label?: string;
  at: number;
}

export interface MapRecent {
  repos: MapRecentRepo[];
  sessions: MapRecentSession[];
}

export const EMPTY_MAP_RECENT: MapRecent = { repos: [], sessions: [] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
}

/** A visit time as epoch ms: a number, or an ISO string. */
function visitTime(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/** Parses a stored `recent-visits` value; newest first, malformed entries skipped. */
export function parseMapRecent(raw: unknown): MapRecent | undefined {
  if (!isRecord(raw) || raw.v !== 1) return undefined;
  const repos: MapRecentRepo[] = [];
  for (const r of Array.isArray(raw.repos) ? raw.repos : []) {
    if (!isRecord(r)) continue;
    const repoId = positiveInt(r.repoId);
    if (repoId === undefined) continue;
    const teamId = positiveInt(r.teamId);
    repos.push({
      repoId,
      ...(teamId !== undefined ? { teamId } : {}),
      at: visitTime(r.at),
    });
  }
  const sessions: MapRecentSession[] = [];
  for (const s of Array.isArray(raw.sessions) ? raw.sessions : []) {
    if (!isRecord(s)) continue;
    const repoId = positiveInt(s.repoId);
    const sessionId = typeof s.sessionId === 'string' ? s.sessionId.trim() : '';
    if (repoId === undefined || !sessionId) continue;
    const teamId = positiveInt(s.teamId);
    const label = typeof s.label === 'string' ? s.label : undefined;
    sessions.push({
      repoId,
      ...(teamId !== undefined ? { teamId } : {}),
      sessionId,
      ...(label ? { label } : {}),
      at: visitTime(s.at),
    });
  }
  repos.sort((a, b) => b.at - a.at);
  sessions.sort((a, b) => b.at - a.at);
  return { repos, sessions };
}

/** Keeps the entries of repositories the viewer can currently see. */
export function filterMapRecent(
  recent: MapRecent,
  visibleRepoIds: ReadonlySet<number>,
): MapRecent {
  return {
    repos: recent.repos.filter((r) => visibleRepoIds.has(r.repoId)),
    sessions: recent.sessions.filter((s) => visibleRepoIds.has(s.repoId)),
  };
}

/** The viewer's Recent visits as stored in this browser; empty without a user or storage. */
export function readMapRecent(userId: number | undefined): MapRecent {
  return (
    readUserItem(userId, 'recent-visits', parseMapRecent) ?? EMPTY_MAP_RECENT
  );
}
