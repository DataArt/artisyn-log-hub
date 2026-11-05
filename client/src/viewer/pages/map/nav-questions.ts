/**
 * "Start from a question": each question opens the view of a repository that answers it,
 * with the right preset (DD-12). Home's question chips and the All views map share this table.
 *
 * A pure module: no React, router or `api.ts` imports, so Node-side tooling (algorithm tests,
 * scenario helpers) can load it. Its only runtime imports are `routes` (an import-free module)
 * and `weekWindow`.
 */

import { routes } from '../../hooks/useHashRoute';
import { weekWindow } from '../../lib/week-window';
import type { NavTarget } from './nav-tree';

/** The repository a question is asked about. */
export interface NavQuestionRepoCtx {
  repoId: number;
  /** Set for a repository opened through a team. */
  teamId?: number;
}

/** A recently opened session (a structural subset of the Recent visits model). */
export interface NavQuestionRecentSession {
  repoId: number;
  sessionId: string;
}

export interface NavQuestion {
  id: 'expensive' | 'tools' | 'hook' | 'startup' | 'claude-md' | 'who-spent';
  label: string;
  /** What the opened view shows; the map's "What it answers" column. */
  description: string;
  synonyms: string[];
  /** Listed on the map only, never as a Home chip. */
  mapOnly?: boolean;
  /** The view that answers the question; `recent` is newest first. */
  build: (
    repo: NavQuestionRepoCtx,
    recent: readonly NavQuestionRecentSession[],
    now: Date,
  ) => NavTarget;
}

/** The repository's base path: the team route for a repository opened through a team. */
export function repoBasePath(repo: NavQuestionRepoCtx): string {
  return repo.teamId !== undefined
    ? routes.teamRepo(repo.teamId, repo.repoId)
    : routes.repo(repo.repoId);
}

function repoRoute(
  repo: NavQuestionRepoCtx,
  search: Record<string, string>,
): NavTarget {
  return { kind: 'route', path: repoBasePath(repo), search };
}

/**
 * A session question: the latest session of this repository the user opened, on the given tab and
 * lens; without one, the All views map filtered by `q`, where a session view opens its picker.
 */
function latestSessionOrMap(
  repo: NavQuestionRepoCtx,
  recent: readonly NavQuestionRecentSession[],
  view: { tab: string; lens: string },
  q: string,
): NavTarget {
  const last = recent.find((s) => s.repoId === repo.repoId);
  if (last) return repoRoute(repo, { session: last.sessionId, ...view });
  const search: Record<string, string> = { repoId: String(repo.repoId), q };
  if (repo.teamId !== undefined) search.teamId = String(repo.teamId);
  return { kind: 'route', path: routes.map(), search };
}

export const NAV_QUESTIONS: readonly NavQuestion[] = [
  {
    id: 'expensive',
    label: 'Why was this session expensive?',
    description:
      'Cost lens of the latest session: tokens and cost by model and tool.',
    synonyms: ['cost', 'spend', 'why', 'money'],
    build: (repo, recent) =>
      latestSessionOrMap(
        repo,
        recent,
        { tab: 'usage', lens: 'cost' },
        'expensive',
      ),
  },
  {
    id: 'tools',
    label: 'Which tools fail most?',
    description: 'Tools/MCP calls that failed in the last week.',
    synonyms: ['fail', 'failed', 'error', 'broken'],
    build: (repo, _recent, now) => {
      const w = weekWindow(now);
      return repoRoute(repo, {
        mtab: 'tools',
        tstatus: 'error',
        tfrom: w.fromDate,
        tto: w.toDate,
      });
    },
  },
  {
    id: 'hook',
    label: 'Is my hook healthy?',
    description: 'Hook state: version, last upload and issues.',
    synonyms: ['hook', 'healthy', 'install', 'status'],
    build: (repo) => ({ kind: 'route', path: routes.hookState(repo.repoId) }),
  },
  {
    id: 'startup',
    label: 'What context does Claude load at startup?',
    description: 'System context anatomy of the latest session.',
    synonyms: ['startup', 'loaded', 'context', 'system prompt'],
    build: (repo, recent) =>
      latestSessionOrMap(
        repo,
        recent,
        { tab: 'sysctx', lens: 'harness' },
        'startup',
      ),
  },
  {
    id: 'claude-md',
    label: 'Is my CLAUDE.md being used?',
    description: 'Reports › Harness usage over the last week.',
    synonyms: ['claude.md', 'used', 'instructions'],
    build: (repo, _recent, now) => {
      const w = weekWindow(now);
      return repoRoute(repo, {
        mtab: 'reports',
        report: 'harness-usage',
        startDate: w.fromDate,
        endDate: w.toDate,
      });
    },
  },
  {
    id: 'who-spent',
    label: 'Who spent how much this week?',
    description: 'Reports › Cost by user over the last week.',
    synonyms: ['who', 'spent', 'users', 'team', 'week'],
    mapOnly: true,
    build: (repo, _recent, now) => {
      const w = weekWindow(now);
      return repoRoute(repo, {
        mtab: 'reports',
        report: 'cost-by-user',
        startDate: w.fromDate,
        endDate: w.toDate,
      });
    },
  },
];
