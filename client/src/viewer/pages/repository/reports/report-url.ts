import type { ReportId } from './report-catalog';

export interface ReportParamsState {
  report: ReportId | null;
  startDate: string;
  endDate: string;
  // Widened to accept `attr:<key>` — parsing
  // support for that form lands in a later chunk alongside the attribute-group-by UI; this
  // type widening only keeps every consumer's own prop types compiling against it early.
  groupBy: 'none' | 'branch' | 'user' | `attr:${string}`;
  branches: string[];
  users: string[];
}

function formatDateOnly(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Default date range shown for a report that has never been generated: last 30 days.
export function defaultDateRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { startDate: formatDateOnly(start), endDate: formatDateOnly(end) };
}

// Builds ReportParamsState from the current URL search params. `fallbackGroupBy`
// is used only when no `groupBy` param is present (e.g. "Cost by User" defaults
// to grouped-by-user the first time it's opened, per its report-catalog entry).
export function reportParamsFromSearchParams(
  p: URLSearchParams,
  fallbackGroupBy: 'none' | 'branch' | 'user' | `attr:${string}` = 'none',
): ReportParamsState {
  const { startDate: defaultStart, endDate: defaultEnd } = defaultDateRange();
  const groupBy = p.get('groupBy');
  const branches = p.get('branches');
  // `rusers` (not `users`): the Sessions tab already owns the bare `users` key as its
  // `users=all` "show all users" toggle (`useRepositoryViewState.ts`). Reusing it here for
  // the report's user-filter CSV meant a report opened right after that toggle silently
  // inherited `users=all` as a filter list of one user literally named "all", 500ing every
  // report that applies it as a SQL filter.
  const users = p.get('rusers');
  return {
    report: (p.get('report') as ReportId | null) ?? null,
    startDate: p.get('startDate') ?? defaultStart,
    endDate: p.get('endDate') ?? defaultEnd,
    groupBy:
      groupBy === 'branch' || groupBy === 'user'
        ? groupBy
        : // The `attr:<key>` form round-trips through the URL — an empty key after the prefix falls
          // back like any other unrecognised value.
          groupBy != null && groupBy.startsWith('attr:') && groupBy.length > 5
          ? (groupBy as `attr:${string}`)
          : fallbackGroupBy,
    branches: branches ? branches.split(',').map(decodeURIComponent) : [],
    users: users ? users.split(',').map(decodeURIComponent) : [],
  };
}

// Converts the URL's date-only (YYYY-MM-DD) bounds into full ISO datetime bounds
// for the API — local midnight through local end-of-day, same conversion
// `RepositoryAnalytics.tsx`'s custom-range path uses for the `analytics/timeline` API.
export function toIsoDateBounds(
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string } {
  return {
    startDate: new Date(`${startDate}T00:00:00`).toISOString(),
    endDate: new Date(`${endDate}T23:59:59`).toISOString(),
  };
}

/**
 * Human-readable label for one raw `attr=<key>:<op>[:<value>]`
 * query value, used only to print the active attribute filter in `ReportDocumentHeader`
 * ("the active attribute filter is printed ... so a filtered export can never be mistaken
 * for an unfiltered one"). Purely presentational — the actual predicate is built
 * server-side (`attribute-filter.sql.ts`); this never re-derives or validates it.
 */
export function formatAttributeFilterLabel(raw: string): string {
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) return raw;
  const key = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  const op = secondColon === -1 ? rest : rest.slice(0, secondColon);
  const value = secondColon === -1 ? '' : rest.slice(secondColon + 1);
  switch (op) {
    case 'isnull':
      return `${key}: Not determined`;
    case 'unattributed':
      return `${key}: Unattributed`;
    case 'any':
      return `${key} contains "${value}"`;
    case 'is':
      return `${key} = ${value}`;
    case 'eq':
      return `${key} = "${value}"`;
    case 'gte':
      return `${key} ≥ ${value}`;
    case 'lte':
      return `${key} ≤ ${value}`;
    default:
      return raw;
  }
}

// Writes ReportParamsState fields into a URLSearchParams, keeping other params intact.
export function applyReportParamsToSearchParams(
  state: ReportParamsState,
  p: URLSearchParams,
): void {
  p.set('mtab', 'reports');
  if (state.report) p.set('report', state.report);
  else p.delete('report');
  p.set('startDate', state.startDate);
  p.set('endDate', state.endDate);
  if (state.groupBy !== 'none') p.set('groupBy', state.groupBy);
  else p.delete('groupBy');
  // Values are joined raw, not pre-encoded: URLSearchParams already
  // percent-encodes when serialized to a string, so calling encodeURIComponent
  // here first would double-encode (e.g. "dt@x.com" -> "dt%2540x.com" instead
  // of "dt%40x.com"). decodeURIComponent on read is a safe no-op either way.
  if (state.branches.length > 0) {
    p.set('branches', state.branches.join(','));
  } else {
    p.delete('branches');
  }
  if (state.users.length > 0) {
    p.set('rusers', state.users.join(','));
  } else {
    p.delete('rusers');
  }
}
