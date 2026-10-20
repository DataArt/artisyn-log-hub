// Pure state shape, defaults and derivation logic for RepositoryAnalytics.tsx.
// Split out of RepositoryAnalytics.tsx (component-size split) — no JSX here,
// so this stays a plain .ts module rather than .tsx.

export interface AnalyticsState {
  range: '1d' | '2d' | '3d' | '1w' | '2w' | '1m' | 'custom';
  customFrom?: string;
  customTo?: string;
  // Widened to accept `attr:<key>` — grouping by a
  // resolved session attribution definition, alongside the existing branch/user options.
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  branches: string[];
  users: string[];
  view:
    | 'work-time'
    | 'cost'
    | 'files'
    | 'vision'
    | 'mcp'
    | 'productivity'
    | 'log-lines'
    | 'cache-read-ratio'
    // Backed by its own endpoint (analytics/change-surface), bucketed
    // server-side. Its branch in AnalyticsChartArea.tsx returns before the shared
    // timeline payload is consulted.
    | 'change-surface'
    // Table views backed by their own endpoints, rendered by UsageAnalyticsPanel.
    // Every value added here must also be added to the `av` whitelist in analytics-url.ts,
    // or it silently falls back to `work-time` on reload.
    | 'tools'
    | 'tokens'
    | 'productivity-counters'
    | 'active-sessions';
  layout: 'vertical' | 'horizontal';
}

export const DEFAULT_STATE: AnalyticsState = {
  range: '1d',
  groupBy: 'none',
  branches: [],
  users: [],
  view: 'work-time',
  layout: 'vertical',
};

export const VIEW_OPTIONS: {
  value: AnalyticsState['view'];
  label: string;
  description: string;
}[] = [
  {
    value: 'work-time',
    label: 'Work Time',
    description: 'Total autonomous agent work time per session',
  },
  {
    value: 'cost',
    label: 'Cost',
    description: 'Total API cost per session per hour',
  },
  {
    value: 'files',
    label: 'Files & Tools',
    description: 'Code files, bytes read, edits and lines changed per session',
  },
  {
    value: 'vision',
    label: 'Vision',
    description: 'Images examined and total image bytes per session',
  },
  {
    value: 'mcp',
    label: 'MCP Invocations',
    description: 'Total MCP tool calls per session',
  },
  {
    value: 'productivity',
    label: 'Productivity',
    description: 'Lines and cost efficiency per autonomous hour',
  },
  {
    value: 'log-lines',
    label: 'Log Lines',
    description: 'Number of JSONL records in the Claude session log',
  },
  {
    value: 'cache-read-ratio',
    label: 'Cache Read Ratio',
    description:
      'Share of input context served from cache instead of rewritten',
  },
  {
    value: 'change-surface',
    label: 'Change Surface',
    description:
      "How widely a session's file changes spread across folders and modules",
  },
  {
    value: 'tools',
    label: 'Tool Analytics',
    description:
      'Every tool ranked by calls, with success rate, unresolved calls and duration',
  },
  {
    value: 'tokens',
    label: 'Token Breakdown',
    description:
      'Input, output and cache tokens with the TTL and service-tier splits',
  },
  {
    value: 'productivity-counters',
    label: 'Productivity Counters',
    description:
      'Diff-based lines added and removed, commits and pull requests',
  },
  {
    value: 'active-sessions',
    label: 'Active Sessions',
    description: 'Sessions in the selected range, most recently active first',
  },
];

export function deriveStartEnd(state: AnalyticsState): {
  startDate: string | undefined;
  endDate: string | undefined;
} {
  const now = new Date();
  const msPerHour = 60 * 60 * 1000;

  switch (state.range) {
    case '1d': {
      const start = new Date(now.getTime() - 24 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case '2d': {
      const start = new Date(now.getTime() - 48 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case '3d': {
      const start = new Date(now.getTime() - 72 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case '1w': {
      const start = new Date(now.getTime() - 7 * 24 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case '2w': {
      const start = new Date(now.getTime() - 14 * 24 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case '1m': {
      const start = new Date(now.getTime() - 30 * 24 * msPerHour);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    case 'custom': {
      if (!state.customFrom || !state.customTo) {
        return { startDate: undefined, endDate: undefined };
      }
      // Parse as LOCAL midnight/end-of-day, then convert to UTC for the API.
      // Without a timezone suffix, new Date() treats the string as local time.
      return {
        startDate: new Date(`${state.customFrom}T00:00:00`).toISOString(),
        endDate: new Date(`${state.customTo}T23:59:59`).toISOString(),
      };
    }
    default:
      return { startDate: undefined, endDate: undefined };
  }
}
