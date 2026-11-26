import { BadRequestException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The shared `tag=<key>[:<value>]` / `groupBy=tag:<key>` helper (2026-11-24
 * otel-session-tags), the session-tag twin of `attribute-filter.sql.ts`.
 *
 * Tags live in `session_tags`, always on the ROOT session of a tree, so every predicate here
 * takes the caller's root-session id column. Tag keys are free-form (they come from the user's
 * `OTEL_RESOURCE_ATTRIBUTES`), so nothing is validated against attribute definitions — only the
 * shape of the parameter.
 */

/** One tag filter: a key and the values it must have (`null` = any value of the key). */
export type TagFilter = { key: string; values: string[] | null };

/** The `groupBy=tag:<key>` bucket for sessions without the grouped key. */
export const UNTAGGED_GROUP = '__untagged__';

/** The display label of {@link UNTAGGED_GROUP}. */
export const UNTAGGED_GROUP_LABEL = '(untagged)';

/**
 * Parses every `tag=` query param. `tag=<key>` means "any value of the key",
 * `tag=<key>:<value>` one value; only the FIRST `:` splits, so a value may contain colons and a
 * key cannot. A trailing `tag=<key>:` (empty value) is read as `tag=<key>` — no tag ever has an
 * empty value. An empty key is a 400.
 *
 * Repeats of one key merge into one {@link TagFilter} (OR within the key); a key given both
 * with and without a value collapses to "any value", which already covers every listed value.
 * Keys keep their first-seen order.
 */
export function parseTagFilters(
  raw: string | string[] | undefined,
): TagFilter[] {
  const params = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const byKey = new Map<string, TagFilter>();

  for (const param of params) {
    const colon = param.indexOf(':');
    const key = colon === -1 ? param : param.slice(0, colon);
    const value = colon === -1 ? '' : param.slice(colon + 1);
    if (key === '') {
      throw new BadRequestException(
        `Invalid tag filter "${param}" — expected "<key>" or "<key>:<value>"`,
      );
    }

    const existing = byKey.get(key);
    if (value === '') {
      if (existing) existing.values = null;
      else byKey.set(key, { key, values: null });
      continue;
    }
    if (!existing) {
      byKey.set(key, { key, values: [value] });
    } else if (existing.values !== null && !existing.values.includes(value)) {
      existing.values.push(value);
    }
  }

  return [...byKey.values()];
}

/**
 * The combined `tag=` condition for one session-selection query: one `EXISTS` per key (AND
 * across keys), the key's values OR-ed inside it (`value IN (…)`), no value condition for
 * "any value". `rootSessionIdColumn` is the caller's root `sessions.id` column (e.g.
 * `sql\`s.id\`` in raw SQL, `sql\`${sessions.id}\`` in a drizzle query).
 *
 * Always returns a boolean SQL condition: `TRUE` when `filters` is empty, so it splices into
 * both `and(...)` and a raw `WHERE … AND (${cond})` without a guard.
 */
export function tagFilterSql(
  filters: TagFilter[],
  rootSessionIdColumn: SQL,
): SQL {
  if (filters.length === 0) return sql`TRUE`;

  const clauses = filters.map((filter) => {
    const valueCondition =
      filter.values === null || filter.values.length === 0
        ? sql``
        : sql` AND st.value IN (${sql.join(
            filter.values.map((v) => sql`${v}::text`),
            sql`, `,
          )})`;
    return sql`EXISTS (SELECT 1 FROM session_tags st WHERE st.session_id = ${rootSessionIdColumn} AND st.key = ${filter.key}::text${valueCondition})`;
  });

  return clauses.length === 1
    ? clauses[0]
    : sql`(${sql.join(clauses, sql` AND `)})`;
}

/**
 * `groupBy=tag:<key>` — the key, or `null` when `groupBy` is not the `tag:` form. The
 * degenerate `tag:` (empty key) is a 400. The key is not validated against anything: tag keys
 * are free-form.
 */
export function parseGroupByTagKey(groupBy: string | undefined): string | null {
  if (groupBy === undefined || !groupBy.startsWith('tag:')) return null;
  const key = groupBy.slice('tag:'.length);
  if (key === '') {
    throw new BadRequestException('groupBy=tag: requires a tag key');
  }
  return key;
}

/**
 * Set-returning SQL for one root session's `groupBy=tag:<key>` buckets (fan-out, like
 * `attrGroupKeysSql`): one row per distinct value of `key` on the session, or a single
 * {@link UNTAGGED_GROUP} row when the session has no such key. Embed as
 * `CROSS JOIN LATERAL (${tagGroupKeysSql(key, sql\`s.id\`)}) AS tag_group(group_key)`.
 * Values are deduped across sources (`otel` / `config`).
 */
export function tagGroupKeysSql(key: string, rootSessionIdColumn: SQL): SQL {
  return sql`
    SELECT DISTINCT tg.value AS group_key
      FROM session_tags tg
      WHERE tg.session_id = ${rootSessionIdColumn} AND tg.key = ${key}::text
    UNION ALL
    SELECT ${UNTAGGED_GROUP}::text AS group_key
      WHERE NOT EXISTS (
        SELECT 1 FROM session_tags tu
        WHERE tu.session_id = ${rootSessionIdColumn} AND tu.key = ${key}::text
      )
  `;
}

/**
 * TS twin of {@link tagGroupKeysSql} for call sites that bucket in TypeScript: the session's
 * distinct values of the grouped key, or `[UNTAGGED_GROUP]` when it has none.
 */
export function tagGroupLabels(values: readonly string[]): string[] {
  const distinct = [...new Set(values)];
  return distinct.length > 0 ? distinct : [UNTAGGED_GROUP];
}

/**
 * 400 when the grouped tag key is also filtered (`groupBy=tag:k` + `tag=k…`) — the same
 * redundant combination `assertNoGroupByAttrFilterConflict` rejects for attributes.
 */
export function assertNoGroupByTagFilterConflict(
  groupByKey: string | null,
  filters: TagFilter[],
): void {
  if (groupByKey === null) return;
  if (filters.some((f) => f.key === groupByKey)) {
    throw new BadRequestException(
      `Cannot combine groupBy=tag:${groupByKey} with a tag filter on the same key`,
    );
  }
}
