import type { SessionTag } from '../../models/repositories';

/**
 * Session tags UI helpers (2026-11-24 otel-session-tags): the `tag=` URL / query param, the
 * client-side tag filter of the session list and the FR-10 noisy-key wording. Shared by every
 * screen that filters or groups by tag.
 */

/** One tag filter: a key with the values it accepts (OR), or `null` = any value of the key. */
export interface TagFilter {
  key: string;
  values: string[] | null;
}

/** URL / query param name of the repeatable tag filter (`tag=<key>` or `tag=<key>:<value>`). */
export const TAG_PARAM = 'tag';

/** Group key of the sessions without the grouped tag key (server contract `__untagged__`). */
export const UNTAGGED_GROUP = '__untagged__';
export const UNTAGGED_LABEL = '(untagged)';

/**
 * Parses repeated `tag=` values: `<key>` (any value) or `<key>:<value>`, split on the first `:`.
 * Values of one key merge (OR); a key-only entry makes the key "any value". Empty keys are
 * dropped (the server answers 400 on them). Key order follows first appearance.
 */
export function parseTagParams(raw: readonly string[]): TagFilter[] {
  const byKey = new Map<string, string[] | null>();
  for (const entry of raw) {
    const colon = entry.indexOf(':');
    const key = colon === -1 ? entry : entry.slice(0, colon);
    if (key === '') continue;
    if (colon === -1) {
      byKey.set(key, null);
      continue;
    }
    const value = entry.slice(colon + 1);
    const prev = byKey.get(key);
    if (prev === null) continue;
    const values = prev ?? [];
    if (!values.includes(value)) values.push(value);
    byKey.set(key, values);
  }
  return [...byKey].map(([key, values]) => ({ key, values }));
}

/** The repeated `tag=` values of a filter list — the inverse of {@link parseTagParams}. */
export function tagFiltersToParams(filters: readonly TagFilter[]): string[] {
  const out: string[] = [];
  for (const f of filters) {
    if (f.values === null) out.push(f.key);
    else for (const v of f.values) out.push(`${f.key}:${v}`);
  }
  return out;
}

/** AND across keys, OR within a key; a session without tags matches no filter. */
export function sessionMatchesTagFilters(
  tags: readonly SessionTag[] | undefined,
  filters: readonly TagFilter[],
): boolean {
  if (filters.length === 0) return true;
  const list = tags ?? [];
  return filters.every((f) =>
    list.some(
      (t) =>
        t.key === f.key && (f.values === null || f.values.includes(t.value)),
    ),
  );
}

/** The distinct values of one key on a session, in the server's order. */
export function tagValuesOf(
  tags: readonly SessionTag[] | undefined,
  key: string,
): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    if (t.key === key && !out.includes(t.value)) out.push(t.value);
  }
  return out;
}

/** Short summary of active filters for a trigger label, e.g. `feature=a|b, team=*`. */
export function describeTagFilters(filters: readonly TagFilter[]): string {
  return filters
    .map((f) => `${f.key}=${f.values === null ? '*' : f.values.join('|')}`)
    .join(', ');
}

/** FR-10 hint of a key noisy in one session. */
export function noisySessionKeyHint(key: string, values: number): string {
  return `Tag key "${key}" has ${values} values in this session — looks like a changing value; remove it from OTEL_RESOURCE_ATTRIBUTES.`;
}

/** FR-10 hint of a key noisy on some session in scope (pickers, header chips). */
export function noisyKeyHint(key: string): string {
  return `Tag key "${key}" has more than 10 values in a session — looks like a changing value; remove it from OTEL_RESOURCE_ATTRIBUTES.`;
}

/** FR-10 hint of a session that hit the per-session tag cap. */
export const TAG_LIMIT_HINT =
  'This session hit the 500-tag limit — later tags were not stored. Remove changing values from OTEL_RESOURCE_ATTRIBUTES.';

/** A `groupBy=tag:<key>` value (Analytics, Reports). */
export type TagGroupBy = `tag:${string}`;

const TAG_GROUP_PREFIX = 'tag:';

/** The tag key of a `tag:<key>` group-by value, or `null` for any other grouping. */
export function groupByTagKey(
  groupBy: string | null | undefined,
): string | null {
  if (groupBy == null || !groupBy.startsWith(TAG_GROUP_PREFIX)) return null;
  const key = groupBy.slice(TAG_GROUP_PREFIX.length);
  return key === '' ? null : key;
}

/**
 * Whether a grouping can count one session in several groups: a multi-value attribute
 * (`attr:<key>`) or a tag key (`tag:<key>`, fan-out per value).
 */
export function isFanOutGroupBy(groupBy: string | null | undefined): boolean {
  return (
    groupBy != null &&
    (groupBy.startsWith('attr:') || groupByTagKey(groupBy) !== null)
  );
}

/** Display label of a group key: the `__untagged__` sentinel reads "(untagged)". */
export function tagGroupLabel(group: string): string {
  return group === UNTAGGED_GROUP ? UNTAGGED_LABEL : group;
}

/**
 * Drops the filter on the grouped tag key — the server answers 400 when one key is both
 * grouped and filtered, so picking `tag:<key>` clears that key's filter.
 */
export function withoutGroupedTagKey(
  filters: readonly TagFilter[],
  groupBy: string | null | undefined,
): TagFilter[] {
  const key = groupByTagKey(groupBy);
  return key === null ? [...filters] : filters.filter((f) => f.key !== key);
}
