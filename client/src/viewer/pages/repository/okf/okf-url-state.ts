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
 * | `okfArticle` | KB article path whose drill-down is open | the tab overview |
 * | `okfAgent` | session OKF tab only: the selected agent (tree filter + trail) | no agent |
 *
 * `okfArticle` is not a filter: it is kept out of `OKF_PARAM_KEYS`, so `writeOkfFilters` leaves
 * it alone and a filter change keeps the drill-down open. Leaving the tab still drops it, since
 * `setMainTab` removes every `okf*` param.
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

const OKF_ARTICLE_PARAM = 'okfArticle';

/** The KB article whose drill-down is open, or `null` for the tab overview. */
export function okfArticleFromParams(p: URLSearchParams): string | null {
  return p.get(OKF_ARTICLE_PARAM) || null;
}

/**
 * A copy of `p` with the drill-down article set to `path`; `null` (or an empty path) clears it.
 * The filter params are left untouched.
 */
export function writeOkfArticle(
  p: URLSearchParams,
  path: string | null,
): URLSearchParams {
  const next = new URLSearchParams(p);
  if (path) next.set(OKF_ARTICLE_PARAM, path);
  else next.delete(OKF_ARTICLE_PARAM);
  return next;
}

/** A copy of `p` without the drill-down article (back to the tab overview). */
export function clearOkfArticle(p: URLSearchParams): URLSearchParams {
  return writeOkfArticle(p, null);
}

/**
 * The session OKF tab's selected agent (package 3): it narrows the KB tree to the agent's reads
 * and opens its trail in section B. An `okf*` param, so leaving the repo's OKF context drops it;
 * `setSessionTab` drops it when the session leaves its OKF tab, and selecting another session
 * drops it too.
 */
export const OKF_AGENT_PARAM = 'okfAgent';

/** The agent selected on the session OKF tab, or `null`. */
export function okfAgentFromParams(p: URLSearchParams): string | null {
  return p.get(OKF_AGENT_PARAM) || null;
}

/** A copy of `p` with the session OKF tab's agent set to `agentId` (`null` clears it). */
export function writeOkfAgent(
  p: URLSearchParams,
  agentId: string | null,
): URLSearchParams {
  const next = new URLSearchParams(p);
  if (agentId) next.set(OKF_AGENT_PARAM, agentId);
  else next.delete(OKF_AGENT_PARAM);
  return next;
}

/**
 * A copy of `p` that opens session `sessionId` on its OKF tab with agent `agentId`'s trail —
 * the repo OKF drill-down's links. Like the OTEL tab's "open session", the repo tab (`mtab`)
 * and its `okf*` filters are left, `tu` is dropped.
 */
export function okfSessionTrailParams(
  p: URLSearchParams,
  sessionId: string,
  agentId: string,
): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of [...next.keys()]) {
    if (key.startsWith('okf')) next.delete(key);
  }
  next.delete('mtab');
  next.delete('tu');
  next.set('session', sessionId);
  next.set('tab', 'okf');
  next.set(OKF_AGENT_PARAM, agentId);
  return next;
}

/** `sfocus` value that scrolls Settings → Analysis to the OKF thresholds card. */
export const OKF_THRESHOLDS_FOCUS = 'okf-thresholds';

/**
 * A copy of `p` that opens Settings → Analysis focused on the OKF thresholds card
 * (`mtab=settings&stab=analysis&sfocus=okf-thresholds`). Search params, not a URL hash: the app
 * uses a hash router, so the hash holds the route. Like `setMainTab`, it drops the session
 * selection and every `okf*` param (the repo OKF tab's filters); the card drops `sfocus` once it
 * has scrolled into view.
 */
export function okfThresholdsSettingsParams(
  p: URLSearchParams,
): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of [...next.keys()]) {
    if (key.startsWith('okf')) next.delete(key);
  }
  for (const key of ['session', 'tab', 'lens', 'tu']) next.delete(key);
  next.set('mtab', 'settings');
  next.set('stab', 'analysis');
  next.set('sfocus', OKF_THRESHOLDS_FOCUS);
  return next;
}

/**
 * A copy of `p` that opens the repository OKF tab (`mtab=okf`) from a session's OKF tab — the
 * same params `setMainTab('okf')` writes: the session selection (`session`, `tab`, `lens`, `tu`)
 * is dropped; the tab's own `okf*` filters are kept (none are set from a session view).
 */
export function okfRepoTabParams(p: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(p);
  for (const key of ['session', 'tab', 'lens', 'tu', OKF_AGENT_PARAM]) {
    next.delete(key);
  }
  next.set('mtab', 'okf');
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
