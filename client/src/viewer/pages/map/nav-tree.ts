/**
 * The All views map model (DD-10, DD-11): every screen, tab, Analytics view, report, setting,
 * session tab (the charts included) and help article as one tree, plus the filter matcher.
 *
 * A pure module: no React, router or `api.ts` imports (only `routes`, which imports nothing, and
 * the pure tab registry), so Node-side tooling can load it. The caller gathers the data
 * (`useNavTreeInput`) and renders the nodes.
 */

import { routes } from '../../hooks/useHashRoute';
import {
  SESSION_GROUPS,
  tabsOf,
  teamWideAccess,
  type TabRow,
  type TabVisibilityContext,
} from '../../tab-ids';
import {
  repoBasePath,
  type NavQuestion,
  type NavQuestionRecentSession,
} from './nav-questions';

export type NavTarget =
  | {
      kind: 'route';
      path: string;
      search?: Record<string, string>;
      state?: Record<string, string>;
    }
  | { kind: 'help'; slug: string };

export interface NavNode {
  /** Stable path id, e.g. `repo:12/view:cost` (DD-10). */
  id: string;
  kind: 'container' | 'leaf';
  label: string;
  description: string;
  synonyms: string[];
  icon:
    | 'team'
    | 'repo'
    | 'session'
    | 'group'
    | 'tab'
    | 'report'
    | 'view'
    | 'help'
    | 'question';
  /** The context the node needs and the rail does not have yet: greyed, opens the picker. */
  needs?: 'team' | 'repo' | 'session';
  /** Why a data-gated node is greyed (e.g. no advisor result for this session). */
  greyReason?: string;
  /** Leaves only; absent while `needs` is unmet. */
  target?: NavTarget;
  /** Tab-bar decorations, shown only when already known (nothing is fetched for them). */
  count?: number;
  lock?: boolean;
  failureDot?: boolean;
  children?: NavNode[];
}

/** A team of the `['teams']` query, with the fields the visibility rule reads. */
export interface NavTeam {
  id: number;
  name: string;
  accessMode: string;
  ownerId: number;
  myIsManager: boolean;
}

/** A repository the viewer can open; `teamId` is set for a repository reached through a team. */
export interface NavRepo {
  id: number;
  label: string;
  teamId?: number;
}

export interface NavReportCategory {
  id: string;
  title: string;
  reports: {
    id: string;
    title: string;
    description: string;
    synonyms: string[];
  }[];
}

export interface NavAnalyticsView {
  value: string;
  label: string;
  description: string;
  synonyms: string[];
}

export interface NavHelpSection {
  section: string;
  articles: { slug: string; title: string }[];
}

/** The map's rail context: the team, repository and session it is scoped to. */
export interface NavContext {
  teamId?: number;
  repoId?: number;
  sessionId?: string;
  /** Owner of the context session; Raw Logs is listed only for the viewer's own session. */
  sessionUserId?: number;
  sessionCtx: TabVisibilityContext;
  /** Known Bash command count of the context session. */
  bashCount?: number;
  /** Known Tools/MCP failure state of the context session. */
  toolsFailure?: boolean;
}

export interface NavTreeInput {
  userId: number | undefined;
  teams: readonly NavTeam[];
  repos: readonly NavRepo[];
  context: NavContext;
  isAdmin: boolean;
  helpNav: readonly NavHelpSection[];
  reports: readonly NavReportCategory[];
  analyticsViews: readonly NavAnalyticsView[];
  questions: readonly NavQuestion[];
  /** Recent sessions, newest first (question targets use the latest one). */
  recentSessions: readonly NavQuestionRecentSession[];
  now: Date;
}

const ADVISOR_GREY_REASON = 'No advisor result for this session';

function container(
  id: string,
  label: string,
  icon: NavNode['icon'],
  children: NavNode[],
  extra: Partial<NavNode> = {},
): NavNode {
  return {
    id,
    kind: 'container',
    label,
    description: '',
    synonyms: [],
    icon,
    children,
    ...extra,
  };
}

function rowLeaf(
  id: string,
  row: TabRow,
  icon: NavNode['icon'],
  target: NavTarget | undefined,
  extra: Partial<NavNode> = {},
): NavNode {
  const node: NavNode = {
    id,
    kind: 'leaf',
    label: row.label,
    description: row.description,
    synonyms: row.synonyms,
    icon,
    ...extra,
  };
  if (target) node.target = target;
  return node;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function isVisible(row: TabRow, ctx: TabVisibilityContext): boolean {
  return row.visible === undefined || row.visible(ctx);
}

/** Personal entries win over team entries of the same repository. */
export function dedupeRepos(repos: readonly NavRepo[]): NavRepo[] {
  const byId = new Map<number, NavRepo>();
  for (const r of repos) {
    const seen = byId.get(r.id);
    if (!seen || (seen.teamId !== undefined && r.teamId === undefined)) {
      byId.set(r.id, r);
    }
  }
  return [...byId.values()];
}

function questionNodes(input: NavTreeInput): NavNode[] {
  const { repoId, teamId } = input.context;
  return input.questions.map((q) => {
    const node: NavNode = {
      id: `question:${q.id}`,
      kind: 'leaf',
      label: q.label,
      description: q.description,
      synonyms: q.synonyms,
      icon: 'question',
    };
    if (repoId === undefined) {
      node.needs = 'repo';
    } else {
      const repoTeam = input.repos.find(
        (r) => r.id === repoId && r.teamId !== undefined,
      )?.teamId;
      node.target = q.build(
        { repoId, teamId: teamId ?? repoTeam },
        input.recentSessions,
        input.now,
      );
    }
    return node;
  });
}

function teamNodes(input: NavTreeInput): NavNode[] {
  return input.teams.map((team) => {
    const ctx: TabVisibilityContext = {
      canSeeOtel: teamWideAccess(team, input.userId),
    };
    const leaves = tabsOf('team')
      .filter((r) => r.gate !== 'permission' || isVisible(r, ctx))
      .map((r) =>
        rowLeaf(`team:${team.id}/tab:${r.id}`, r, 'tab', {
          kind: 'route',
          path: routes.team(team.id),
          state: { teamTab: r.id },
        }),
      );
    return container(`team:${team.id}`, team.name, 'team', leaves);
  });
}

function sessionNodes(
  input: NavTreeInput,
  repo: NavRepo,
  repoPath: string,
): NavNode {
  const prefix = `repo:${repo.id}/session`;
  const ctx = input.context;
  const sessionId = ctx.repoId === repo.id ? ctx.sessionId : undefined;
  const hasSession = sessionId !== undefined;
  const sessionCtx: TabVisibilityContext = hasSession ? ctx.sessionCtx : {};
  const ownSession =
    hasSession &&
    input.userId !== undefined &&
    ctx.sessionUserId === input.userId;
  const needs: Partial<NavNode> = hasSession ? {} : { needs: 'session' };

  const groups = SESSION_GROUPS.map((g) => {
    const groupId = `${prefix}/group:${g.id}`;
    const leaves: NavNode[] = [];
    for (const row of tabsOf('session')) {
      if (row.group !== g.id) continue;
      // Raw Logs needs the viewer's own session: a team viewer's server-side permission is
      // unknown without fetching the logs, so the node is omitted.
      if (row.id === 'raw-logs') {
        if (!ownSession) continue;
      } else if (row.gate === 'permission' && !isVisible(row, sessionCtx)) {
        continue;
      }
      const id = `${groupId}/tab:${row.id}`;
      const extra: Partial<NavNode> = { ...needs };
      if (
        hasSession &&
        row.gate === 'data' &&
        !isVisible(row, sessionCtx) &&
        row.id === 'advisor'
      ) {
        extra.greyReason = ADVISOR_GREY_REASON;
      }
      if (row.id === 'raw-logs') extra.lock = true;
      if (row.id === 'bash' && hasSession && ctx.bashCount !== undefined) {
        extra.count = ctx.bashCount;
      }
      if (row.id === 'tools' && hasSession && ctx.toolsFailure === true) {
        extra.failureDot = true;
      }
      const target: NavTarget | undefined =
        hasSession && extra.greyReason === undefined
          ? {
              kind: 'route',
              path: repoPath,
              search: { session: sessionId, tab: row.id },
            }
          : undefined;
      leaves.push(rowLeaf(id, row, 'tab', target, extra));
    }
    return container(groupId, g.label, 'group', leaves, needs);
  }).filter((g) => (g.children ?? []).length > 0);

  const session = container(prefix, 'Session', 'session', groups, needs);
  return container(`repo:${repo.id}/sessions`, 'Sessions', 'group', [session]);
}

function repoNode(input: NavTreeInput, repo: NavRepo): NavNode {
  const team =
    repo.teamId !== undefined
      ? input.teams.find((t) => t.id === repo.teamId)
      : undefined;
  // Personal repos and repos of a team still loading see everything (RepositoryView's rule).
  const canSeeTeamWideTabs =
    team === undefined || teamWideAccess(team, input.userId);
  const ctx: TabVisibilityContext = { canSeeTeamWideTabs };
  const repoPath = repoBasePath({ repoId: repo.id, teamId: repo.teamId });
  const pre = `repo:${repo.id}`;
  const children: NavNode[] = [];

  for (const row of tabsOf('repo')) {
    if (row.gate === 'permission' && !isVisible(row, ctx)) continue;
    if (row.id === 'analytics') {
      children.push(
        container(
          `${pre}/analytics`,
          row.label,
          'tab',
          input.analyticsViews.map((v) => ({
            id: `${pre}/view:${v.value}`,
            kind: 'leaf',
            label: v.label,
            description: v.description,
            synonyms: v.synonyms,
            icon: 'view',
            target: {
              kind: 'route',
              path: repoPath,
              search: { mtab: 'analytics', av: v.value },
            },
          })),
          { description: row.description, synonyms: row.synonyms },
        ),
      );
    } else if (row.id === 'reports') {
      children.push(
        container(
          `${pre}/reports`,
          row.label,
          'tab',
          input.reports.map((cat) =>
            container(
              `${pre}/reports/${cat.id}`,
              cat.title,
              'group',
              cat.reports.map((rep) => ({
                id: `${pre}/report:${rep.id}`,
                kind: 'leaf',
                label: rep.title,
                description: rep.description,
                synonyms: rep.synonyms,
                icon: 'report',
                target: {
                  kind: 'route',
                  path: repoPath,
                  search: { mtab: 'reports', report: rep.id },
                },
              })),
            ),
          ),
          { description: row.description, synonyms: row.synonyms },
        ),
      );
    } else if (row.id === 'settings') {
      children.push(
        container(
          `${pre}/settings`,
          row.label,
          'tab',
          tabsOf('settings').map((s) =>
            rowLeaf(`${pre}/settings:${s.id}`, s, 'tab', {
              kind: 'route',
              path: repoPath,
              search: { mtab: 'settings', stab: s.id },
            }),
          ),
          { description: row.description, synonyms: row.synonyms },
        ),
      );
    } else {
      children.push(
        rowLeaf(`${pre}/tab:${row.id}`, row, 'tab', {
          kind: 'route',
          path: repoPath,
          search: { mtab: row.id },
        }),
      );
    }
  }

  children.push({
    id: `${pre}/hook-state`,
    kind: 'leaf',
    label: 'Hook state',
    description: 'Hook version, last upload and issues of this repository.',
    synonyms: ['hook', 'healthy', 'status', 'install'],
    icon: 'tab',
    target: { kind: 'route', path: routes.hookState(repo.id) },
  });
  children.push(sessionNodes(input, repo, repoPath));

  return container(pre, repo.label, 'repo', children);
}

/** The map tree in its top-level order (FR-E1). */
export function buildNavTree(input: NavTreeInput): NavNode[] {
  const tree: NavNode[] = [
    container(
      'questions',
      'Start from a question',
      'question',
      questionNodes(input),
    ),
    container('teams', 'Teams', 'team', teamNodes(input)),
    container(
      'repos',
      'Repositories',
      'repo',
      dedupeRepos(input.repos).map((r) => repoNode(input, r)),
    ),
    container(
      'apikeys',
      'API keys',
      'tab',
      tabsOf('apikeys').map((r) =>
        rowLeaf(`apikeys/tab:${r.id}`, r, 'tab', {
          kind: 'route',
          path: routes.apiKeys,
          state: { apiKeysTab: r.id },
        }),
      ),
    ),
  ];

  // Non-admins are redirected away from the whole admin page (AdminGuard), so the container is
  // listed only for admins.
  if (input.isAdmin) {
    tree.push(
      container(
        'admin',
        'Admin panel',
        'tab',
        tabsOf('admin').map((r) =>
          rowLeaf(`admin/tab:${r.id}`, r, 'tab', {
            kind: 'route',
            path: routes.admin,
            search: { tab: r.id },
          }),
        ),
      ),
    );
  }

  tree.push(
    container(
      'help',
      'Help',
      'help',
      input.helpNav.map((sec) => {
        const secId = `help/${slugify(sec.section)}`;
        return container(
          secId,
          sec.section,
          'help',
          sec.articles.map((a) => ({
            id: `${secId}/${a.slug}`,
            kind: 'leaf',
            label: a.title,
            description: `Help › ${sec.section}`,
            synonyms: a.slug.split('-').filter((w) => w.length > 0),
            icon: 'help',
            target: { kind: 'help', slug: a.slug },
          })),
        );
      }),
    ),
  );

  // Containers left empty (no teams, no repos) are dropped.
  return tree.filter((n) => (n.children ?? []).length > 0);
}

// ---------------------------------------------------------------------------
// Filter matcher (FR-E4)
// ---------------------------------------------------------------------------

export interface NavFilterResult {
  /** Ids of the matching leaves, in tree order. */
  matches: string[];
  /** Ids of the containers to expand so every match is shown. */
  expand: string[];
  /** Leaf count of the whole tree. */
  total: number;
  /** Leaf id → the synonym that matched a query word the label did not match. */
  synonymHit: Record<string, string>;
}

const WORD_SPLIT = /[^\p{L}\p{N}]+/u;
const SUBSTRING_MIN_CHARS = 3;

function fieldMatches(word: string, field: string): boolean {
  const lower = field.toLowerCase();
  if (lower.split(WORD_SPLIT).some((w) => w.startsWith(word))) return true;
  return word.length >= SUBSTRING_MIN_CHARS && lower.includes(word);
}

/**
 * Matches the leaves of `nodes` against `query`: every whitespace-separated word must match the
 * label, a synonym or the description (tried in that order), either as a prefix of a word in the
 * field or, from 3 chars on, as a substring of it. An empty query matches nothing.
 */
export function matchNavFilter(
  nodes: readonly NavNode[],
  query: string,
): NavFilterResult {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  const matches: string[] = [];
  const expand = new Set<string>();
  const synonymHit: Record<string, string> = {};
  let total = 0;

  const visit = (node: NavNode, ancestors: string[]): void => {
    if (node.kind === 'container') {
      const path = [...ancestors, node.id];
      for (const child of node.children ?? []) visit(child, path);
      return;
    }
    total += 1;
    if (words.length === 0) return;
    let hit: string | undefined;
    for (const word of words) {
      if (fieldMatches(word, node.label)) continue;
      const syn = node.synonyms.find((s) => fieldMatches(word, s));
      if (syn !== undefined) {
        hit ??= syn;
        continue;
      }
      if (fieldMatches(word, node.description)) continue;
      return;
    }
    matches.push(node.id);
    for (const a of ancestors) expand.add(a);
    if (hit !== undefined) synonymHit[node.id] = hit;
  };

  for (const n of nodes) visit(n, []);
  return { matches, expand: [...expand], total, synonymHit };
}
