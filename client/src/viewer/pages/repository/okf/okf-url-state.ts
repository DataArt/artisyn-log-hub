/**
 * URL state of the repo OKF tab (DD-44). Every filter lives in an `okf*` search param so a
 * filtered view can be linked and survives a reload; `setMainTab` drops all of them when the
 * user leaves the tab.
 *
 * | Param | Meaning | Absent means |
 * |---|---|---|
 * | `okfFrom`, `okfTo` | date-only bounds (YYYY-MM-DD) | last 30 days |
 * | `okfBranches`, `okfUsers` | comma list, each item URI-encoded | all |
 * | `okfAttr` | raw `<key>:<op>[:<value>]`, repeatable | no attribute filter |
 * | `okfBundle` | bundle root | all bundles |
 * | `okfHeat` | `calls` | `bytes` |
 */
import type { SessionAttributionAttributeDef } from '../../../../models/repositories';
import { defaultDateRange } from '../reports/report-url';
import type { OkfHeatMetric } from '../session-log/okf/okf-tree';
import type { AttributeFilterSelection } from '../session-list/session-list-helpers';

export interface RepoOkfFilters {
  startDate: string;
  endDate: string;
  branches: string[];
  users: string[];
  attr: string[];
  bundle: string | null;
  heat: OkfHeatMetric;
}

const OKF_PARAM_KEYS = [
  'okfFrom',
  'okfTo',
  'okfBranches',
  'okfUsers',
  'okfAttr',
  'okfBundle',
  'okfHeat',
] as const;

function splitList(raw: string | null): string[] {
  return raw ? raw.split(',').filter(Boolean).map(decodeURIComponent) : [];
}

export function okfFiltersFromParams(p: URLSearchParams): RepoOkfFilters {
  const defaults = defaultDateRange();
  return {
    startDate: p.get('okfFrom') ?? defaults.startDate,
    endDate: p.get('okfTo') ?? defaults.endDate,
    branches: splitList(p.get('okfBranches')),
    users: splitList(p.get('okfUsers')),
    attr: p.getAll('okfAttr'),
    bundle: p.get('okfBundle') || null,
    heat: p.get('okfHeat') === 'calls' ? 'calls' : 'bytes',
  };
}

/** A copy of `p` with every `okf*` param rewritten from `f` (defaults are left out). */
export function writeOkfFilters(
  p: URLSearchParams,
  f: RepoOkfFilters,
): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of OKF_PARAM_KEYS) next.delete(key);
  next.set('okfFrom', f.startDate);
  next.set('okfTo', f.endDate);
  if (f.branches.length > 0) {
    next.set('okfBranches', f.branches.map(encodeURIComponent).join(','));
  }
  if (f.users.length > 0) {
    next.set('okfUsers', f.users.map(encodeURIComponent).join(','));
  }
  for (const a of f.attr) next.append('okfAttr', a);
  if (f.bundle) next.set('okfBundle', f.bundle);
  if (f.heat === 'calls') next.set('okfHeat', 'calls');
  return next;
}

/**
 * The session-list attribute selection as raw `attr=` values for the reports API. The operator
 * follows the attribute's declared type (`eq` string, `is` boolean, `any` string[]); a number
 * equality is `gte` + `lte` on the same value. `unattributed` is session-wide, but the parser
 * still wants a key in front of it, so the first definition's key is used.
 */
export function attrSelectionToParams(
  sel: AttributeFilterSelection | null,
  defs: readonly SessionAttributionAttributeDef[],
): string[] {
  if (!sel) return [];
  if (sel.kind === 'unattributed') {
    const key = defs[0]?.key;
    return key ? [`${key}:unattributed`] : [];
  }
  if (sel.kind === 'isnull') return [`${sel.key}:isnull`];
  const type = defs.find((d) => d.key === sel.key)?.type ?? 'string';
  const v = String(sel.value);
  if (type === 'boolean') return [`${sel.key}:is:${v}`];
  if (type === 'string[]') return [`${sel.key}:any:${v}`];
  if (type === 'number') return [`${sel.key}:gte:${v}`, `${sel.key}:lte:${v}`];
  return [`${sel.key}:eq:${v}`];
}

/** Inverse of {@link attrSelectionToParams}; anything it cannot read gives `null`. */
export function attrParamsToSelection(
  attr: readonly string[],
): AttributeFilterSelection | null {
  const first = attr[0];
  if (!first) return null;
  const [key, op, ...rest] = first.split(':');
  const value = rest.join(':');
  if (!key || !op) return null;
  if (op === 'unattributed') return { kind: 'unattributed' };
  if (op === 'isnull') return { kind: 'isnull', key };
  if (op === 'is') return { kind: 'value', key, value: value === 'true' };
  if (op === 'gte' || op === 'lte') {
    const n = Number(value);
    return Number.isFinite(n) ? { kind: 'value', key, value: n } : null;
  }
  if (op === 'eq' || op === 'any') return { kind: 'value', key, value };
  return null;
}

const SHORT_PATH_MAX_CHARS = 40;

/**
 * Path of a file relative to its bundle root, for compact lists. A long path keeps its tail
 * (the last two segments) — the file name is what tells the files apart.
 */
export function pathInBundle(bundle: string | null, path: string): string {
  const rel =
    bundle && path.startsWith(`${bundle}/`)
      ? path.slice(bundle.length + 1)
      : path;
  if (rel.length <= SHORT_PATH_MAX_CHARS) return rel;
  const parts = rel.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : rel;
}
