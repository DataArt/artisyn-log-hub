/**
 * Tab ids of every tabbed screen, in tab-bar order.
 *
 * A pure module: no React, router, CSS or asset imports, so Node-side tooling (the scenario
 * tours and their meta-test) can load it without a bundler. The owning components keep their
 * own labels and key them by these ids; each rendered tab trigger carries
 * `data-testid="tab-<group>-<id>"` (see `PageTabs`' `testIdGroup` prop).
 */

/** Session detail pane tabs, mirrored into the `tab` URL param (group `session`). */
export const SESSION_TABS = [
  // The default landing tab; absent `tab` param means `summary`.
  'summary',
  'logs',
  // Every Bash command of the session tree (main + sub-agents), one per row; always shown.
  'bash',
  'info',
  // Legacy deep-link alias only: Call Tree moved into a Charts sub-tab, and the pane
  // redirects `tab=call-tree` to Charts. No trigger is rendered for it.
  'call-tree',
  'charts',
  // Transcript-derived usage analytics for this session.
  'usage',
  'raw-logs',
  // Turn-End Cost Advisor result; hidden unless the session has an advisor result.
  'advisor',
  // Which files/folders this session tree actually touched.
  'change-surface',
  // The session tree plus each session's harness elements.
  'harness-usage',
  // How the session tree read the repo's OKF knowledge bases.
  'okf',
] as const;

/** Repository view main tabs, mirrored into the `mtab` URL param (group `repo`). */
export const REPO_MAIN_TABS = [
  'sessions',
  'analytics',
  'reports',
  // How the repo's OKF knowledge bases were read over a period.
  'okf',
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
  'session-attribution',
  'maintenance',
  'import-export',
] as const;

/** Team detail page tabs (group `team`). */
export const TEAM_TABS = ['members', 'repositories', 'invitations'] as const;

/** API keys page tabs (group `apikeys`). */
export const API_KEYS_TABS = ['install', 'keys'] as const;

/** Session Charts sub-tabs (group `chart`). */
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
