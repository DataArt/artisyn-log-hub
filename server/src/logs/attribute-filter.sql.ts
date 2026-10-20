import { BadRequestException } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import type { SessionAttributionAttributeDef } from '../database/schema/index';

/**
 * The shared `attr=<key>:<op>:<value>` predicate helper.
 *
 * There is no single existing choke point for session selection in this codebase — five
 * independent call sites (raw Phase A SQL, `loadScopedRootSessions`, and several hand-built
 * drizzle queries in `repositories.controller.ts`) each need to splice the same fixed
 * per-operator SQL form into their own session-selection query. This module is that one
 * shared implementation, so every call site produces byte-identical predicates for the same
 * filter — required for the GIN index (`idx_session_attribution_values_gin`,
 * `jsonb_path_ops`) to actually get used where it can be.
 */

/** The fixed operator set — no other value is ever accepted. */
export const ATTRIBUTE_FILTER_OPERATORS = [
  'eq',
  'is',
  'any',
  'gte',
  'lte',
  'isnull',
  'unattributed',
] as const;

export type AttributeFilterOperator =
  (typeof ATTRIBUTE_FILTER_OPERATORS)[number];

/**
 * One parsed `attr=` query param. `value` stays the raw string from the query string —
 * `isnull`/`unattributed` carry it as `''` since neither operator needs one
 * (`attr=<key>:isnull` / `attr=<key>:unattributed` are valid with no third segment).
 */
export interface ParsedAttributeFilter {
  key: string;
  op: AttributeFilterOperator;
  value: string;
}

const OPERATORS_REQUIRING_VALUE: ReadonlySet<AttributeFilterOperator> = new Set(
  ['eq', 'is', 'any', 'gte', 'lte'],
);

/**
 * Parses every `attr=<key>:<op>[:<value>]` query param into `{key, op, value}`, validating
 * only shape and the operator set — NOT the operator against the
 * repository's resolved attribute definitions, which needs a DB round trip the parser
 * itself has no access to. Call {@link buildAttributeTypeLookup} +
 * {@link validateAttributeFilterTypes} once the resolved definitions are known (this is the
 * "later chunks' `400` checks" half of this module).
 *
 * The value may itself contain colons (e.g. an ISO timestamp) — only the first two colons
 * are treated as delimiters; everything after the second belongs to the value.
 */
export function parseAttributeFilters(
  rawParams: string[],
): ParsedAttributeFilter[] {
  return rawParams.map(parseOneAttributeFilter);
}

function parseOneAttributeFilter(raw: string): ParsedAttributeFilter {
  const firstColon = raw.indexOf(':');
  if (firstColon <= 0) {
    throw new BadRequestException(
      `Invalid attr filter "${raw}" — expected "<key>:<op>[:<value>]"`,
    );
  }

  const key = raw.slice(0, firstColon);
  const rest = raw.slice(firstColon + 1);
  const secondColon = rest.indexOf(':');
  const op = secondColon === -1 ? rest : rest.slice(0, secondColon);
  const value = secondColon === -1 ? '' : rest.slice(secondColon + 1);

  if (!(ATTRIBUTE_FILTER_OPERATORS as readonly string[]).includes(op)) {
    throw new BadRequestException(
      `Invalid attr filter operator "${op}" — must be one of ${ATTRIBUTE_FILTER_OPERATORS.join(', ')}`,
    );
  }

  const operator = op as AttributeFilterOperator;

  if (OPERATORS_REQUIRING_VALUE.has(operator) && value === '') {
    throw new BadRequestException(
      `attr filter "${key}:${operator}" requires a value`,
    );
  }

  return { key, op: operator, value };
}

/** attribute key -> its declared type, per the caller's resolved definitions. */
export type AttributeTypeLookup = ReadonlyMap<
  string,
  SessionAttributionAttributeDef['type']
>;

/**
 * Builds the key -> declared-type lookup used both to validate `attr=`/`groupBy=attr:<key>`
 * operators against declared types (this module) and by {@link isOrphanedValue} — the one
 * place resolved definitions get turned into an O(1)-lookup shape, so every consumer builds
 * it identically instead of re-implementing the `.find()` scan per call site.
 */
export function buildAttributeTypeLookup(
  resolvedDefinitions: SessionAttributionAttributeDef[],
): AttributeTypeLookup {
  return new Map(resolvedDefinitions.map((d) => [d.key, d.type]));
}

/** The one declared type each operator is valid for — `null` means "any type accepted". */
const OPERATOR_REQUIRED_TYPE: Record<
  AttributeFilterOperator,
  SessionAttributionAttributeDef['type'] | null
> = {
  eq: 'string',
  is: 'boolean',
  any: 'string[]',
  gte: 'number',
  lte: 'number',
  isnull: null,
  unattributed: null,
};

/**
 * Validates each filter's key/operator against the resolved definitions, `400`-rejecting an
 * unknown key or an operator/type mismatch (e.g. `eq` against a `boolean` attribute, which
 * must use `is` instead). `unattributed` is exempt from the key check entirely — it is a
 * session-wide "no attribution row at all" predicate, not bound to any one key
 * (the one form that inverts the wrapper).
 */
export function validateAttributeFilterTypes(
  filters: ParsedAttributeFilter[],
  typeLookup: AttributeTypeLookup,
): void {
  for (const filter of filters) {
    if (filter.op === 'unattributed') continue;

    const declaredType = typeLookup.get(filter.key);
    if (!declaredType) {
      throw new BadRequestException(`Unknown attribute key "${filter.key}"`);
    }

    const requiredType = OPERATOR_REQUIRED_TYPE[filter.op];
    if (requiredType !== null && requiredType !== declaredType) {
      throw new BadRequestException(
        `Attribute "${filter.key}" (type "${declaredType}") does not support operator "${filter.op}"`,
      );
    }
  }
}

/**
 * Parses+validates a raw string value against the numeric shape `gte`/`lte` need.
 */
function parseNumericFilterValue(filter: ParsedAttributeFilter): number {
  const parsed = Number(filter.value);
  if (!Number.isFinite(parsed)) {
    throw new BadRequestException(
      `attr filter "${filter.key}:${filter.op}" requires a numeric value, got "${filter.value}"`,
    );
  }
  return parsed;
}

/**
 * Parses+validates a raw string value against the boolean shape `is` needs — accepts only
 * the literal strings `"true"`/`"false"`, matching how a boolean attribute value round-trips
 * through a query string (there is no third boolean state at the filter level; `isnull`
 * covers "not determined").
 */
function parseBooleanFilterValue(filter: ParsedAttributeFilter): boolean {
  if (filter.value === 'true') return true;
  if (filter.value === 'false') return false;
  throw new BadRequestException(
    `attr filter "${filter.key}:${filter.op}" requires "true" or "false", got "${filter.value}"`,
  );
}

/**
 * The fixed per-operator predicate against the `session_attribution sa` alias.
 * Every form except `unattributed` (handled by the caller, see
 * {@link attributeFilterSql}) is meant to be embedded inside
 * `EXISTS (SELECT 1 FROM session_attribution sa WHERE sa.session_id = <col> AND <this>)`.
 */
function attributeOperatorPredicate(filter: ParsedAttributeFilter): SQL {
  const { key, op } = filter;
  // Every bound parameter here is explicitly cast (`::text`/`::boolean`) — `jsonb_build_object`
  // and `to_jsonb` are variadic "any"-typed functions, so without a cast Postgres's extended
  // query protocol cannot determine a bound parameter's type at PARSE time and errors with
  // "could not determine data type of parameter $n" (only surfaces against a real connection,
  // never in a unit test that only renders SQL text/params — caught by this module's own
  // e2e coverage). `key` is cast everywhere for the same reason, even where an operator (`->`,
  // `->>`) could otherwise infer it, so every branch follows one consistent rule.
  switch (op) {
    case 'eq':
      return sql`sa.values @> jsonb_build_object(${key}::text, ${filter.value}::text)`;
    case 'is':
      return sql`sa.values @> jsonb_build_object(${key}::text, ${parseBooleanFilterValue(filter)}::boolean)`;
    case 'any':
      return sql`sa.values -> ${key}::text @> to_jsonb(${filter.value}::text)`;
    case 'gte':
      return sql`(sa.values ->> ${key}::text)::numeric >= ${parseNumericFilterValue(filter)}`;
    case 'lte':
      return sql`(sa.values ->> ${key}::text)::numeric <= ${parseNumericFilterValue(filter)}`;
    case 'isnull':
      return sql`(sa.values @> jsonb_build_object(${key}::text, NULL) OR sa.values -> ${key}::text = '[]'::jsonb)`;
    case 'unattributed':
      // Never reached — attributeFilterSql() special-cases `unattributed` before calling
      // this function, since it inverts the EXISTS wrapper instead of contributing a
      // per-key predicate inside it.
      throw new BadRequestException('"unattributed" has no per-key predicate');
    default:
      throw new BadRequestException(
        `Unsupported attribute filter operator: ${String(op)}`,
      );
  }
}

/**
 * Builds the combined `attr=` condition for one query's session-selection step, against
 * whatever `session_attribution.session_id`-comparable column the caller's own query
 * exposes for the outer `sessions` row — e.g. `sql\`s.id\`` in a raw Phase A query, or
 * `sql\`${sessions.id}\`` in a hand-built drizzle query. Returns `undefined` when `filters`
 * is empty, so callers can splice it in only when present (mirrors the optional-fragment
 * convention `scoped-sessions.sql.ts`'s `ownerFilter`/`branchFilter`/`userFilter` already
 * use, but as a bare boolean condition rather than a pre-fixed `AND ...` fragment, so it
 * composes with both `drizzle-orm`'s `and(...)` and a raw `WHERE ... AND (${cond})`).
 *
 * Same-key repeats are OR-ed inside one `EXISTS`; different keys are AND-ed as separate
 * `EXISTS` clauses. `unattributed` is the one operator that inverts the wrapper to
 * `NOT EXISTS` and is session-wide (ignores its own key) — it is AND-ed in alongside the
 * per-key `EXISTS` clauses, deduplicated to a single clause regardless of how many
 * `unattributed` filters were passed.
 */
export function attributeFilterSql(
  filters: ParsedAttributeFilter[],
  sessionIdColumn: SQL,
): SQL | undefined {
  if (filters.length === 0) return undefined;

  const keyedFilters = filters.filter((f) => f.op !== 'unattributed');
  const unattributedRequested = filters.some((f) => f.op === 'unattributed');

  const clauses: SQL[] = [];

  if (unattributedRequested) {
    clauses.push(
      sql`NOT EXISTS (SELECT 1 FROM session_attribution sa WHERE sa.session_id = ${sessionIdColumn})`,
    );
  }

  const filtersByKey = new Map<string, ParsedAttributeFilter[]>();
  for (const filter of keyedFilters) {
    const existing = filtersByKey.get(filter.key);
    if (existing) {
      existing.push(filter);
    } else {
      filtersByKey.set(filter.key, [filter]);
    }
  }

  for (const filtersForKey of filtersByKey.values()) {
    const predicates = filtersForKey.map(attributeOperatorPredicate);
    const combined =
      predicates.length === 1
        ? predicates[0]
        : sql`(${sql.join(predicates, sql` OR `)})`;
    clauses.push(
      sql`EXISTS (SELECT 1 FROM session_attribution sa WHERE sa.session_id = ${sessionIdColumn} AND ${combined})`,
    );
  }

  return clauses.length === 1 ? clauses[0] : sql.join(clauses, sql` AND `);
}

/**
 * Nest's default query parser gives a single `?attr=x` as a bare
 * string and repeated `?attr=x&attr=y` as an array; every repeatable-query-param call site
 * across the analytics/report controllers normalizes through this one helper so both shapes
 * behave identically. (Originally defined locally in `repositories.controller.ts`; lifted
 * here so `usage-analytics.controller.ts`/`reports.controller.ts` can share it
 * instead of duplicating it a third and fourth time.)
 */
export function normalizeRepeatableParam(
  param: string | string[] | undefined,
): string[] {
  if (param === undefined) return [];
  return Array.isArray(param) ? param : [param];
}

/**
 * `groupBy=attr:<key>` widening — extracts `<key>` from a raw
 * `groupBy` query value, or `undefined` when it isn't the `attr:` form at all (including the
 * degenerate `"attr:"` with an empty key, which callers must still 400 on via
 * {@link assertKnownGroupByAttrKey}).
 */
export function parseGroupByAttrKey(
  groupBy: string | undefined,
): string | undefined {
  if (groupBy === undefined || !groupBy.startsWith('attr:')) return undefined;
  return groupBy.slice('attr:'.length);
}

/**
 * `400`s an unresolved `groupBy=attr:<key>` — either the degenerate empty key or a key absent
 * from the caller's resolved attribute definitions. A no-op when `attrKey` is `undefined` (groupBy wasn't the `attr:` form).
 */
export function assertKnownGroupByAttrKey(
  attrKey: string | undefined,
  resolvedDefinitions: SessionAttributionAttributeDef[],
): void {
  if (attrKey === undefined) return;
  if (attrKey === '' || !resolvedDefinitions.some((d) => d.key === attrKey)) {
    throw new BadRequestException(`Unknown attribute key "${attrKey}"`);
  }
}

/**
 * Extends the existing "cannot combine groupBy=X with an X filter" guard
 * (`groupBy=branch`+`branches=`, `groupBy=user`+`users=`) to `groupBy=attr:<key>` plus an
 * `attr=<key>:...` filter on that same key — grouping by a key while also filtering it down
 * to one bucket is the same redundant combination the branch/user guards already reject.
 * `unattributed` is exempt (it doesn't target `attrKey` specifically).
 */
export function assertNoGroupByAttrFilterConflict(
  attrKey: string | undefined,
  filters: ParsedAttributeFilter[],
): void {
  if (attrKey === undefined) return;
  if (filters.some((f) => f.key === attrKey && f.op !== 'unattributed')) {
    throw new BadRequestException(
      `Cannot combine groupBy=attr:${attrKey} with an attr filter on the same key`,
    );
  }
}

/**
 * The bucket labels for one session under `groupBy=attr:<key>` (fan-out
 * rule) — always returns at least one element, so callers fan a
 * session into one bucket per returned label (full session/row counted in each),
 * rather than folding multiple values into a single comma-joined bucket as this
 * function used to.
 *
 * - `['Unattributed']` when the session has no attribution row at all.
 * - `['Not determined']` when the row exists but this key is `null`/absent/orphaned
 *   (a deleted/retyped attribute's stale value never forms its own bucket), or
 *   when the value is an **empty** `string[]` (`[]`) — an empty array carries no actual value,
 *   consistent with the `isnull` filter operator already treating `[]` as null-equivalent.
 * - A single-element array with the value stringified, for `string`/`number`/`boolean`.
 * - One element per literal string, for a non-empty `string[]` value — this is the fan-out
 *   case: N elements in, N buckets out.
 */
export function attributeGroupLabels(
  key: string,
  values: Record<string, string | string[] | boolean | number | null> | null,
  resolvedDefinitions: SessionAttributionAttributeDef[],
): string[] {
  if (values === null) return ['Unattributed'];

  const raw = values[key];
  if (raw === undefined || raw === null) return ['Not determined'];
  if (isOrphanedValue(key, raw, resolvedDefinitions)) return ['Not determined'];

  if (Array.isArray(raw)) {
    return raw.length > 0 ? raw : ['Not determined'];
  }
  return [String(raw)];
}

/**
 * Set-returning SQL form of {@link attributeGroupLabels}'s bucket-label rule, for the one call
 * site (`analytics/work-time`'s raw-SQL day-bucketed path) that buckets
 * entirely in SQL with no per-row TS pass to hook a TS-side fan-out into. Meant to be embedded
 * as `CROSS JOIN LATERAL (${attrGroupKeysSql(key, declaredType)}) AS attr_group(group_key)` —
 * one row per `jsonb_array_elements_text` element for a non-empty `string[]` value (the fan-out
 * case), exactly one row otherwise (today's scalar `CASE`, unchanged). Requires the same
 * `LEFT JOIN session_attribution attr_sa ON attr_sa.session_id = <col>` the caller's query
 * already needs for {@link attributeGroupLabels}'s old scalar-only form.
 */
export function attrGroupKeysSql(
  key: string,
  declaredType: SessionAttributionAttributeDef['type'],
): SQL {
  const rawValue = sql`(attr_sa.values -> ${key})`;
  const jsonbType =
    declaredType === 'string[]'
      ? 'array'
      : declaredType === 'string'
        ? 'string'
        : declaredType === 'number'
          ? 'number'
          : 'boolean';

  if (declaredType !== 'string[]') {
    const typedText = sql`(${rawValue} #>> '{}')`;
    return sql`SELECT CASE
      WHEN attr_sa.session_id IS NULL THEN 'Unattributed'
      WHEN ${rawValue} IS NULL OR jsonb_typeof(${rawValue}) = 'null' THEN 'Not determined'
      WHEN jsonb_typeof(${rawValue}) != ${jsonbType} THEN 'Not determined'
      ELSE COALESCE(${typedText}, 'Not determined')
    END AS group_key`;
  }

  return sql`
    SELECT 'Unattributed'::text AS group_key WHERE attr_sa.session_id IS NULL
    UNION ALL
    SELECT 'Not determined'::text AS group_key
      WHERE attr_sa.session_id IS NOT NULL
        AND (${rawValue} IS NULL OR jsonb_typeof(${rawValue}) = 'null' OR jsonb_typeof(${rawValue}) != ${jsonbType})
    UNION ALL
    SELECT 'Not determined'::text AS group_key
      WHERE attr_sa.session_id IS NOT NULL
        AND ${rawValue} IS NOT NULL
        AND jsonb_typeof(${rawValue}) = ${jsonbType}
        AND jsonb_array_length(${rawValue}) = 0
    UNION ALL
    SELECT elem AS group_key
      FROM jsonb_array_elements_text(${rawValue}) AS elem
      WHERE attr_sa.session_id IS NOT NULL
        AND jsonb_typeof(${rawValue}) = ${jsonbType}
        AND jsonb_array_length(${rawValue}) > 0
  `;
}

/**
 * Orphan detection — true iff `key` is absent from the resolved
 * definitions, or the stored JSON value's runtime type doesn't satisfy the currently
 * declared `type`. `null` always satisfies any type (it means "not determined", which every
 * declared type can carry). Applied server-side only, before a value ever reaches a
 * response: the Attribution Breakdown report's excluded-sessions count, `groupBy=attr:<key>`
 * bucketing, and `getRepositorySessions()`/`getSessionLogs()` both strip orphaned entries.
 */
export function isOrphanedValue(
  key: string,
  value: string | string[] | boolean | number | null,
  resolvedDefinitions: SessionAttributionAttributeDef[],
): boolean {
  if (value === null) {
    return !resolvedDefinitions.some((d) => d.key === key);
  }

  const declaredType = buildAttributeTypeLookup(resolvedDefinitions).get(key);
  if (!declaredType) return true;

  switch (declaredType) {
    case 'string':
      return typeof value !== 'string';
    case 'number':
      return typeof value !== 'number';
    case 'boolean':
      return typeof value !== 'boolean';
    case 'string[]':
      return !(
        Array.isArray(value) && value.every((v) => typeof v === 'string')
      );
    default:
      return true;
  }
}
