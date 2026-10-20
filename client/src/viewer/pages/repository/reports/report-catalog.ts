export type ReportId =
  | 'session-timeline'
  | 'work-time'
  | 'branch-summary'
  | 'cost-by-branch'
  | 'cost-by-user'
  | 'cache-read-ratio'
  | 'productivity'
  | 'executive-summary'
  // Usage reports. Each delegates to the same server service as its
  // `analytics/*` counterpart, so a report and its analytics view always agree.
  | 'tool-analytics'
  | 'token-usage'
  | 'productivity-counters'
  | 'active-sessions'
  // harness usage
  | 'harness-usage'
  // 2026-09-23 Claude Code version check
  | 'claude-version-usage'
  // change surface
  | 'change-surface'
  // AI Session Attribution
  | 'attribution-breakdown'
  | 'attribution-usage';

export type ReportCategoryId =
  | 'activity'
  | 'code'
  | 'cost'
  | 'productivity'
  | 'summary'
  | 'harness'
  | 'attribution';

export interface ReportDefinition {
  id: ReportId;
  title: string;
  supportsGroupBy: boolean;
  supportsBranchFilter: boolean;
  supportsUserFilter: boolean;
  // Group-by value shown the first time this report is opened (before any
  // explicit `groupBy` URL param exists) — e.g. "Cost by User" starts grouped
  // by user, even though the dropdown stays generic/editable.
  // Widened to accept `attr:<key>` for the 5
  // `supportsGroupBy: true` reports — no report's `defaultGroupBy` uses that form yet, but
  // the type must accept it so a later chunk's attribute-group-by UI can set it.
  defaultGroupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  /**
   * Whether this report's session population
   * honours the shared `attr=<key>:<op>:<value>` filter. `true` on exactly 15 reports (all 13
   * pre-existing reports plus the new `attribution-breakdown` and, later,
   * `claude-version-usage`); `false` only for
   * `attribution-usage`, whose population is evaluation runs (including `failed` ones with no
   * `values`), not sessions — an `attr=` filter would silently hide the very failures that
   * report exists to show.
   */
  supportsAttributeFilter: boolean;
}

export interface ReportCategory {
  id: ReportCategoryId;
  title: string;
  reports: ReportDefinition[];
}

// Static report tree — categories and reports. Every report is a printable
// PDF document (header + KPI table + chart/table) — see ReportDocumentShell.
// No API needed for the tree itself.
export const REPORT_CATEGORIES: ReportCategory[] = [
  {
    id: 'summary',
    title: 'Summary',
    reports: [
      {
        id: 'executive-summary',
        title: 'Executive Summary',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'activity',
    title: 'Activity',
    reports: [
      {
        id: 'session-timeline',
        title: 'Session Timeline',
        supportsGroupBy: true,
        supportsBranchFilter: true,
        supportsUserFilter: false,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'work-time',
        title: 'Work Time Distribution',
        supportsGroupBy: true,
        supportsBranchFilter: true,
        supportsUserFilter: false,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'tool-analytics',
        title: 'Tool Analytics',
        // These four aggregate over the whole filtered set and have no per-group
        // breakdown, so the groupBy control is hidden for them.
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'active-sessions',
        title: 'Active Sessions',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'code',
    title: 'Code',
    reports: [
      {
        id: 'branch-summary',
        title: 'Branch Summary',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: false,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        // Every figure is tree-scoped and each scope is its own
        // union recomputation on the server, so grouping by branch/user/attribute is
        // meaningful here even though the group rows deliberately do not sum to the
        // repo-level row (the report states that inline). No SCOPE toggle.
        id: 'change-surface',
        title: 'Change Surface',
        supportsGroupBy: true,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'cost',
    title: 'Cost',
    reports: [
      {
        id: 'cost-by-branch',
        title: 'Cost by Branch',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: false,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'cost-by-user',
        title: 'Cost by User',
        supportsGroupBy: true,
        supportsBranchFilter: false,
        supportsUserFilter: false,
        defaultGroupBy: 'user',
        supportsAttributeFilter: true,
      },
      {
        id: 'cache-read-ratio',
        title: 'Cache Read Ratio',
        supportsGroupBy: true,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'token-usage',
        title: 'Token Usage',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'productivity',
    title: 'Productivity',
    reports: [
      {
        id: 'productivity',
        title: 'Productivity',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: false,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'productivity-counters',
        title: 'Productivity Counters',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'harness',
    title: 'Harness',
    reports: [
      {
        id: 'harness-usage',
        title: 'Harness Usage',
        supportsGroupBy: true,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        // Per-user table only — each row already is a user, so no groupBy control.
        id: 'claude-version-usage',
        title: 'Claude Code Version Usage',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
    ],
  },
  {
    id: 'attribution',
    title: 'Attributes',
    reports: [
      {
        id: 'attribution-breakdown',
        title: 'Attribute Breakdown',
        // Already breaks every attribute down into its own section — a groupBy would be
        // redundant (see reports.controller.ts's getAttributionBreakdownReport comment).
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        supportsAttributeFilter: true,
      },
      {
        id: 'attribution-usage',
        title: 'Attribute Extraction Usage',
        supportsGroupBy: false,
        supportsBranchFilter: true,
        supportsUserFilter: true,
        defaultGroupBy: 'none',
        // The single exception: population is evaluation runs, not
        // sessions carrying resolved values, so `attr=` has nothing to apply to.
        supportsAttributeFilter: false,
      },
    ],
  },
];

export const ALL_REPORTS: ReportDefinition[] = REPORT_CATEGORIES.flatMap(
  (c) => c.reports,
);

export const DEFAULT_REPORT_ID: ReportId = ALL_REPORTS[0].id;

export function findReport(
  id: string | null | undefined,
): ReportDefinition | undefined {
  return ALL_REPORTS.find((r) => r.id === id);
}

export function findCategoryForReport(
  id: ReportId,
): ReportCategory | undefined {
  return REPORT_CATEGORIES.find((c) => c.reports.some((r) => r.id === id));
}
