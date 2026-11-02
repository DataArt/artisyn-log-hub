/**
 * Tab ids of every tabbed screen, in tab-bar order, and the tab registry (`TAB_REGISTRY`) that
 * gives each tab its label, description, synonyms and visibility rule.
 *
 * A pure module: no React, router, CSS or asset imports, so Node-side tooling (the scenario
 * tours and their meta-test) can load it without a bundler. Each rendered tab trigger carries
 * `data-testid="tab-<group>-<id>"` (see `PageTabs`' `testIdGroup` prop).
 *
 * The registry is the source of order; the `*_TABS` literal tuples mirror it (their types cannot
 * be derived from a runtime array) and `assertRegistryMatchesArrays()` checks both agree at load.
 */

/** Session detail pane tabs, mirrored into the `tab` URL param (group `session`). */
export const SESSION_TABS = [
  // --- overview ---
  // The default landing tab; absent `tab` param means `summary`.
  'summary',
  'info',
  // Transcript-derived usage analytics for this session.
  'usage',
  // Turn-End Cost Advisor result; hidden unless the session has an advisor result.
  'advisor',
  // --- transcript ---
  'logs',
  // Every Bash command of the session tree (main + sub-agents), one per row; always shown.
  'bash',
  'raw-logs',
  // --- cost & context ---
  // The seven session charts are plain session tabs (one level, no Charts sub-tab bar).
  'dashboard',
  'context-growth',
  'context-usage',
  'agent-tree',
  'timeline',
  'tool-heatmap',
  'call-tree',
  // Legacy deep-link alias only: the old Charts tab. The pane redirects `tab=charts` to the
  // chart the viewer last opened (Dashboard by default). No trigger is rendered for it.
  'charts',
  // Byte/token anatomy of the startup system context; always shown.
  'sysctx',
  // The session tree plus each session's harness elements.
  'harness-usage',
  // OTEL cost-over-time chart and trace waterfall of the session tree.
  'otel',
  // --- effects ---
  // Which files/folders this session tree actually touched.
  'change-surface',
  // This session tree's MCP and monitored CLI tool calls: the repo Tools/MCP tab, one session.
  'tools',
  // How the session tree read the repo's OKF knowledge bases.
  'okf',
] as const;

/** Repository view main tabs, mirrored into the `mtab` URL param (group `repo`). */
export const REPO_MAIN_TABS = [
  'sessions',
  'analytics',
  'reports',
  // Monitored CLI tools and MCP servers: calls, outputs and usefulness signals.
  'tools',
  // How the repo's OKF knowledge bases were read over a period.
  'okf',
  // OTEL cost over time, cost structure and hidden calls over a period.
  'otel',
  'settings',
] as const;

/** Admin page tabs, mirrored into the `tab` URL param (group `admin`). */
export const ADMIN_TABS = [
  'system-info',
  'all-repos',
  'all-teams',
  'all-users',
  'error-logs',
  'upload-queue',
  'data-retention',
  'auth',
  'model-pricing',
] as const;

/** Repository settings tabs, mirrored into the `stab` URL param (group `settings`). */
export const SETTINGS_TABS = [
  'display',
  'file-categories',
  'analysis',
  // The CLI tools the hook wraps (the Tools/MCP tab's "Monitored tools" button opens it).
  'monitored-tools',
  'session-attribution',
  'maintenance',
  'import-export',
] as const;

/** Team detail page tabs (group `team`). */
export const TEAM_TABS = [
  'members',
  'repositories',
  'invitations',
  // OTEL cost of every team repository; shown only to callers passing the analytics rule.
  'otel',
] as const;

/** API keys page tabs (group `apikeys`). */
export const API_KEYS_TABS = ['install', 'keys'] as const;

/**
 * The session tabs that are charts, in bar order — a subset of `SESSION_TABS` (they used to be
 * Charts sub-tabs). `SessionChartsTab` renders one of them; `tab=charts` reopens the last one.
 */
export const CHART_TABS = [
  'dashboard',
  'context-growth',
  'context-usage',
  'agent-tree',
  'timeline',
  'tool-heatmap',
  'call-tree',
] as const;

export type SessionTab = (typeof SESSION_TABS)[number];
export type RepoMainTab = (typeof REPO_MAIN_TABS)[number];
export type AdminTab = (typeof ADMIN_TABS)[number];
export type SettingsTab = (typeof SETTINGS_TABS)[number];
export type TeamTab = (typeof TEAM_TABS)[number];
export type ApiKeysTab = (typeof API_KEYS_TABS)[number];
export type ChartTab = (typeof CHART_TABS)[number];

/** The `data-testid` of a tab trigger: `tab-<group>-<id>`. */
export function tabTestId(group: string, id: string): string {
  return `tab-${group}-${id}`;
}

// ---------------------------------------------------------------------------
// Tab registry
// ---------------------------------------------------------------------------

/** The tabbed screen a registry row belongs to; equals the `data-testid` group. */
export type TabScope =
  | 'session'
  | 'repo'
  | 'settings'
  | 'admin'
  | 'team'
  | 'apikeys';

/**
 * The four groups of the session tabs: section headers of the "More ▾" menu and of the All views
 * map — not a level of the tab bar.
 */
export type SessionGroup =
  | 'overview'
  | 'transcript'
  | 'cost-context'
  | 'effects';

/** The session tab groups, in bar order, with their labels. */
export const SESSION_GROUPS: readonly { id: SessionGroup; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'transcript', label: 'Transcript' },
  { id: 'cost-context', label: 'Cost & context' },
  { id: 'effects', label: 'Effects' },
];

/** What a row's `visible` predicate may look at. Absent fields count as `false`. */
export interface TabVisibilityContext {
  hasAdvisorResult?: boolean;
  canSeeRawLogs?: boolean;
  canSeeTeamWideTabs?: boolean;
  canSeeOtel?: boolean;
  isAdmin?: boolean;
}

export interface TabRow {
  id: string;
  label: string;
  scope: TabScope;
  description: string;
  synonyms: string[];
  /** Session rows only. */
  group?: SessionGroup;
  /** Session rows that are charts (`CHART_TABS`). */
  chart?: true;
  /** Redirect-only row: never rendered, the target tab id is opened instead. */
  aliasOf?: string;
  /** Absent = always visible. */
  visible?: (ctx: TabVisibilityContext) => boolean;
  /** Why `visible` can be false: the viewer lacks a permission, or the data is missing. */
  gate?: 'permission' | 'data';
}

const hasAdvisorResult = (ctx: TabVisibilityContext): boolean =>
  ctx.hasAdvisorResult === true;
const canSeeRawLogs = (ctx: TabVisibilityContext): boolean =>
  ctx.canSeeRawLogs === true;
const canSeeTeamWideTabs = (ctx: TabVisibilityContext): boolean =>
  ctx.canSeeTeamWideTabs === true;
const canSeeOtel = (ctx: TabVisibilityContext): boolean =>
  ctx.canSeeOtel === true;
const isAdmin = (ctx: TabVisibilityContext): boolean => ctx.isAdmin === true;

/** Every tab of every scope. Within a scope, rows are in tab-bar order. */
export const TAB_REGISTRY: readonly TabRow[] = [
  // --- session (DD-2 group order: overview, transcript, cost & context, effects) ---
  {
    scope: 'session',
    id: 'summary',
    label: 'Summary',
    group: 'overview',
    description: 'The session at a glance and where to look next.',
    synonyms: ['overview', 'glance', 'start'],
  },
  {
    scope: 'session',
    id: 'info',
    label: 'Info',
    group: 'overview',
    description:
      'Who ran it, branch, models, sub-agents, workflows and their share of cost.',
    synonyms: ['details', 'metadata', 'sub-agents', 'workflows'],
  },
  {
    scope: 'session',
    id: 'usage',
    label: 'Statistics',
    group: 'overview',
    description:
      'Turns, tokens, tool calls and errors of this session, by model and tool.',
    synonyms: ['statistics', 'tokens', 'cost', 'usage', 'errors'],
  },
  {
    scope: 'session',
    id: 'advisor',
    label: 'Advisor',
    group: 'overview',
    description:
      'What the Turn-End Cost Advisor found and how much it could save.',
    synonyms: ['advice', 'savings', 'issues', 'cost'],
    visible: hasAdvisorResult,
    gate: 'data',
  },
  {
    scope: 'session',
    id: 'logs',
    label: 'Logs',
    group: 'transcript',
    description: 'The conversation turn by turn: prompts, replies, tool calls.',
    synonyms: ['transcript', 'conversation', 'turns', 'prompts'],
  },
  {
    scope: 'session',
    id: 'bash',
    label: 'Bash',
    group: 'transcript',
    description: 'Every shell command the session tree ran, with exit status.',
    synonyms: ['shell', 'commands', 'terminal', 'cli', 'fail'],
  },
  {
    scope: 'session',
    id: 'raw-logs',
    label: 'Raw Logs',
    group: 'transcript',
    description: 'The unfiltered uploaded log lines (only visible to you).',
    synonyms: ['raw', 'jsonl', 'source'],
    visible: canSeeRawLogs,
    gate: 'permission',
  },
  {
    scope: 'session',
    id: 'dashboard',
    label: 'Dashboard',
    group: 'cost-context',
    chart: true,
    description:
      'Key session charts on one screen: context growth, timeline, agent tree, tools.',
    synonyms: ['charts', 'graphs', 'dashboard', 'overview'],
  },
  {
    scope: 'session',
    id: 'context-growth',
    label: 'Context Growth',
    group: 'cost-context',
    chart: true,
    description: 'How the context window filled up turn by turn.',
    synonyms: ['context', 'window', 'growth', 'tokens', 'charts'],
  },
  {
    scope: 'session',
    id: 'context-usage',
    label: 'Context Usage',
    group: 'cost-context',
    chart: true,
    description: 'What the context is made of at its peak.',
    synonyms: ['context', 'composition', 'tokens', 'charts'],
  },
  {
    scope: 'session',
    id: 'agent-tree',
    label: 'Agent Tree',
    group: 'cost-context',
    chart: true,
    description: 'The main thread and its sub-agents as a tree.',
    synonyms: ['sub-agents', 'delegation', 'tree', 'charts'],
  },
  {
    scope: 'session',
    id: 'timeline',
    label: 'Timeline',
    group: 'cost-context',
    chart: true,
    description: 'When each agent worked, on one time axis.',
    synonyms: ['time', 'gantt', 'duration', 'charts'],
  },
  {
    scope: 'session',
    id: 'tool-heatmap',
    label: 'Tool Heatmap',
    group: 'cost-context',
    chart: true,
    description: 'Which tools were used when.',
    synonyms: ['tools', 'heatmap', 'frequency', 'charts'],
  },
  {
    scope: 'session',
    id: 'call-tree',
    label: 'Call Tree',
    group: 'cost-context',
    chart: true,
    description: 'Cost of every call in the session tree.',
    synonyms: ['cost', 'calls', 'expensive', 'spend', 'charts'],
  },
  {
    scope: 'session',
    id: 'charts',
    label: 'Charts',
    group: 'cost-context',
    aliasOf: 'dashboard',
    description: 'Key session charts on one screen.',
    synonyms: ['graphs'],
  },
  {
    scope: 'session',
    id: 'sysctx',
    label: 'System context anatomy',
    group: 'cost-context',
    description:
      'What Claude loads at startup and how many tokens each part costs.',
    synonyms: ['system prompt', 'startup', 'claude.md', 'context', 'loaded'],
  },
  {
    scope: 'session',
    id: 'harness-usage',
    label: 'Harness usage',
    group: 'cost-context',
    description:
      'Which skills, agents, hooks and MCP servers the session tree used.',
    synonyms: ['harness', 'skills', 'agents', 'hooks', 'mcp'],
  },
  {
    scope: 'session',
    id: 'otel',
    label: 'OTEL',
    group: 'cost-context',
    description:
      'OTEL cost over time and the trace waterfall of the session tree.',
    synonyms: ['telemetry', 'traces', 'cost', 'opentelemetry'],
  },
  {
    scope: 'session',
    id: 'change-surface',
    label: 'Change surface',
    group: 'effects',
    description: 'Which files and folders this session tree changed.',
    synonyms: ['files', 'diff', 'lines', 'changes', 'code impact'],
  },
  {
    scope: 'session',
    id: 'tools',
    label: 'Tools/MCP',
    group: 'effects',
    description:
      'MCP and monitored CLI tool calls of this session, with failures.',
    synonyms: ['mcp', 'tools', 'failed', 'errors', 'fail'],
  },
  {
    scope: 'session',
    id: 'okf',
    label: 'OKF',
    group: 'effects',
    description: "How the session tree read the repository's knowledge bases.",
    synonyms: ['knowledge base', 'kb', 'docs', 'okf'],
  },

  // --- repo ---
  {
    scope: 'repo',
    id: 'sessions',
    label: 'Sessions',
    description: 'Every session of the repository, by branch and date.',
    synonyms: ['list', 'history', 'sessions'],
  },
  {
    scope: 'repo',
    id: 'analytics',
    label: 'Analytics',
    description:
      'Charts across sessions over a period: work time, cost, tokens, tools.',
    synonyms: ['charts', 'trends', 'cost', 'time'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },
  {
    scope: 'repo',
    id: 'reports',
    label: 'Reports',
    description: 'Ready-made reports: executive summary, cost, code, harness.',
    synonyms: ['report', 'summary', 'export'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },
  {
    scope: 'repo',
    id: 'tools',
    label: 'Tools/MCP',
    description:
      'Monitored CLI tools and MCP servers: calls, outputs and failures.',
    synonyms: ['mcp', 'tools', 'failed', 'errors', 'fail'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },
  {
    scope: 'repo',
    id: 'okf',
    label: 'OKF',
    description: "How the repo's knowledge bases were read over a period.",
    synonyms: ['knowledge base', 'kb', 'docs'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },
  {
    scope: 'repo',
    id: 'otel',
    label: 'OTEL',
    description:
      'OTEL cost over time, cost structure and hidden calls over a period.',
    synonyms: ['telemetry', 'cost', 'traces'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },
  {
    scope: 'repo',
    id: 'settings',
    label: 'Settings',
    description:
      'Repository display, analysis, tools and maintenance settings.',
    synonyms: ['configure', 'options', 'preferences'],
    visible: canSeeTeamWideTabs,
    gate: 'permission',
  },

  // --- admin ---
  {
    scope: 'admin',
    id: 'system-info',
    label: 'System Info',
    description: 'Server version, database and runtime facts.',
    synonyms: ['version', 'server', 'about'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'all-repos',
    label: 'Repos',
    description: 'Every repository on this server.',
    synonyms: ['repositories', 'repos'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'all-teams',
    label: 'Teams',
    description: 'Every team on this server.',
    synonyms: ['teams', 'groups'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'all-users',
    label: 'Users',
    description: 'Every user, role and status.',
    synonyms: ['users', 'accounts', 'roles'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'error-logs',
    label: 'Error Logs',
    description: 'Server errors recorded recently.',
    synonyms: ['errors', 'failures', 'logs'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'upload-queue',
    label: 'Upload Queue',
    description: 'Uploads waiting or failing to be processed.',
    synonyms: ['queue', 'ingest', 'upload'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'data-retention',
    label: 'Data Retention',
    description: 'How long session data is kept and what was removed.',
    synonyms: ['retention', 'delete', 'purge'],
  },
  {
    scope: 'admin',
    id: 'auth',
    label: 'Auth',
    description: 'Authentication mode and sign-in settings.',
    synonyms: ['login', 'sso', 'password'],
    visible: isAdmin,
    gate: 'permission',
  },
  {
    scope: 'admin',
    id: 'model-pricing',
    label: 'Model Pricing',
    description: 'Model prices used to compute cost.',
    synonyms: ['price', 'cost', 'tokens'],
    visible: isAdmin,
    gate: 'permission',
  },

  // --- settings ---
  {
    scope: 'settings',
    id: 'display',
    label: 'Display',
    description: 'How sessions of this repository are shown.',
    synonyms: ['view', 'appearance'],
  },
  {
    scope: 'settings',
    id: 'file-categories',
    label: 'File Categories',
    description: 'Which paths count as code, docs, tests and so on.',
    synonyms: ['paths', 'categories', 'files'],
  },
  {
    scope: 'settings',
    id: 'analysis',
    label: 'Analysis',
    description: 'Which analyses run on uploaded sessions.',
    synonyms: ['advisor', 'analysis', 'rules'],
  },
  {
    scope: 'settings',
    id: 'monitored-tools',
    label: 'Monitored Tools',
    description: 'The CLI tools the hook wraps and reports.',
    synonyms: ['cli', 'wrap', 'tools'],
  },
  {
    scope: 'settings',
    id: 'session-attribution',
    label: 'Session Attributes',
    description: 'Session attributes extracted from prompts and branches.',
    synonyms: ['jira', 'ticket', 'attribution', 'attributes'],
  },
  {
    scope: 'settings',
    id: 'maintenance',
    label: 'Maintenance',
    description: 'Recompute and clean-up actions for this repository.',
    synonyms: ['recompute', 'cleanup', 'delete'],
  },
  {
    scope: 'settings',
    id: 'import-export',
    label: 'Import/Export',
    description: 'Move sessions of this repository between servers.',
    synonyms: ['export', 'import', 'backup', 'migrate'],
  },

  // --- team ---
  {
    scope: 'team',
    id: 'members',
    label: 'Members',
    description: 'Who is in the team and with which role.',
    synonyms: ['people', 'roles', 'users'],
  },
  {
    scope: 'team',
    id: 'repositories',
    label: 'Repositories',
    description: 'Repositories shared with the team.',
    synonyms: ['repos', 'projects'],
  },
  {
    scope: 'team',
    id: 'invitations',
    label: 'Invitations',
    description: 'Invitations sent and pending.',
    synonyms: ['invite', 'pending'],
  },
  {
    scope: 'team',
    id: 'otel',
    label: 'OTEL',
    description: 'OTEL cost of every team repository.',
    synonyms: ['telemetry', 'cost'],
    visible: canSeeOtel,
    gate: 'permission',
  },

  // --- apikeys ---
  {
    scope: 'apikeys',
    id: 'install',
    label: 'Install',
    description: 'How to install the hook in a repository.',
    synonyms: ['hook', 'setup', 'install', 'get started'],
  },
  {
    scope: 'apikeys',
    id: 'keys',
    label: 'API Keys',
    description: 'Your API keys for uploading sessions.',
    synonyms: ['token', 'key', 'secret'],
  },
];

/** The rendered rows of a scope, in bar order; redirect-only alias rows are dropped. */
export function tabsOf(scope: TabScope): TabRow[] {
  return TAB_REGISTRY.filter(
    (r) => r.scope === scope && r.aliasOf === undefined,
  );
}

/** The rendered rows of a scope that are visible in `ctx`. */
export function visibleTabs(
  scope: TabScope,
  ctx: TabVisibilityContext,
): TabRow[] {
  return tabsOf(scope).filter((r) => r.visible === undefined || r.visible(ctx));
}

/** The registry row of a tab, alias rows included. */
export function tabRow(scope: TabScope, id: string): TabRow | undefined {
  return TAB_REGISTRY.find((r) => r.scope === scope && r.id === id);
}

/** The team fields `teamWideAccess` reads (a structural subset of the `['teams']` rows). */
export interface TeamAccessFacts {
  accessMode: string;
  ownerId: number;
  myIsManager: boolean;
}

/**
 * Whether `userId` reaches a team's team-wide tabs (repo Analytics / Reports / Tools/MCP / OKF /
 * OTEL / Settings, the team OTEL tab): everyone in a non-`restricted` team, only the owner and
 * managers in a `restricted` one. The app admin role grants nothing here. A cosmetic layer over
 * the server's 403s, never the enforcement itself.
 */
export function teamWideAccess(
  team: TeamAccessFacts,
  userId: number | undefined,
): boolean {
  return (
    team.accessMode !== 'restricted' ||
    (userId !== undefined && team.ownerId === userId) ||
    team.myIsManager
  );
}

const TAB_ARRAYS: Record<TabScope, readonly string[]> = {
  session: SESSION_TABS,
  repo: REPO_MAIN_TABS,
  settings: SETTINGS_TABS,
  admin: ADMIN_TABS,
  team: TEAM_TABS,
  apikeys: API_KEYS_TABS,
};

/** `true` for a session tab that is a chart (`CHART_TABS`). */
export function isChartTab(tab: string): tab is ChartTab {
  return (CHART_TABS as readonly string[]).includes(tab);
}

/**
 * Throws when the registry rows of a scope (aliases included) and its `*_TABS` array differ in
 * content or order. Called at module load.
 */
export function assertRegistryMatchesArrays(): void {
  for (const scope of Object.keys(TAB_ARRAYS) as TabScope[]) {
    const fromRegistry = TAB_REGISTRY.filter((r) => r.scope === scope).map(
      (r) => r.id,
    );
    const fromArray = TAB_ARRAYS[scope];
    const same =
      fromRegistry.length === fromArray.length &&
      fromRegistry.every((id, i) => id === fromArray[i]);
    if (!same) {
      throw new Error(
        `tab-ids: registry rows of scope '${scope}' [${fromRegistry.join(', ')}] ` +
          `do not match its tab array [${fromArray.join(', ')}]`,
      );
    }
  }
}

assertRegistryMatchesArrays();
