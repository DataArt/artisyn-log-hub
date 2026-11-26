import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';
import {
  OTEL_TAG_MAX_PAIRS,
  TAG_NOISY_VALUES_PER_SESSION,
} from './otel/otel-facts.constants';
import { topAncestorIdsSql } from './session-tree.sql';
import { tagGroupLabels } from './tag-filter.sql';

/**
 * Read side of `session_tags` (2026-11-24 otel-session-tags): the `tags` arrays on session rows
 * and the session detail, the detail's `tagNoise`, and the repository-scoped discovery / legacy
 * `contexts` reads. Tags live on the ROOT session; a sub-agent reads its root's tags.
 */

/** One tag of a session, as returned on session rows and the session detail. */
export interface SessionTag {
  key: string;
  value: string;
  source: 'otel' | 'config';
}

/** FR-10: the junk-tag verdict of one session, derived at read time (never stored). */
export interface SessionTagNoise {
  /** Keys with more than `TAG_NOISY_VALUES_PER_SESSION` distinct values in the session. */
  noisyKeys: { key: string; values: number }[];
  /** The session holds `OTEL_TAG_MAX_PAIRS` `otel` pairs — later pairs were not stored. */
  atLimit: boolean;
}

/** The discovery response of `GET :repoId/session-tags/values`. */
export interface SessionTagValuesResponse {
  tags: Record<string, { value: string; sessionCount: number }[]>;
  noisyKeys: string[];
}

interface RawTagRow {
  node_id: string | number;
  key: string;
  value: string;
  source: string;
}

/**
 * Every tag row of each given session's root, keyed by the GIVEN id (a sub-agent id maps to
 * its root's rows). One round trip for the whole batch; sessions without tags are absent.
 */
async function loadRawTagRows(
  db: DrizzleDb,
  sessionRowIds: readonly number[],
): Promise<Map<number, SessionTag[]>> {
  const result = new Map<number, SessionTag[]>();
  if (sessionRowIds.length === 0) return result;
  const idsArray = sql`${`{${[...new Set(sessionRowIds)].join(',')}}`}::bigint[]`;
  const rows = await db.execute(sql`
    WITH RECURSIVE ${topAncestorIdsSql(idsArray)}
    SELECT t.id AS node_id, st.key, st.value, st.source
    FROM top_ancestors t
    JOIN session_tags st ON st.session_id = t.top_id
  `);
  for (const row of rows.rows as unknown as RawTagRow[]) {
    const nodeId = Number(row.node_id);
    const list = result.get(nodeId) ?? [];
    list.push({
      key: row.key,
      value: row.value,
      source: row.source === 'config' ? 'config' : 'otel',
    });
    result.set(nodeId, list);
  }
  return result;
}

/**
 * Each `(key, value)` once, sorted by key then value; a pair present under both sources
 * reports `otel`.
 */
export function dedupeSessionTags(rows: readonly SessionTag[]): SessionTag[] {
  const byPair = new Map<string, SessionTag>();
  for (const row of rows) {
    const id = JSON.stringify([row.key, row.value]);
    const existing = byPair.get(id);
    if (!existing || (existing.source !== 'otel' && row.source === 'otel')) {
      byPair.set(id, { key: row.key, value: row.value, source: row.source });
    }
  }
  return [...byPair.values()].sort((a, b) =>
    a.key === b.key
      ? a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : 0
      : a.key < b.key
        ? -1
        : 1,
  );
}

/** FR-10 verdict over one session's raw tag rows (both sources). */
export function computeTagNoise(rows: readonly SessionTag[]): SessionTagNoise {
  const valuesByKey = new Map<string, Set<string>>();
  let otelPairs = 0;
  for (const row of rows) {
    if (row.source === 'otel') otelPairs += 1;
    const values = valuesByKey.get(row.key) ?? new Set<string>();
    values.add(row.value);
    valuesByKey.set(row.key, values);
  }
  const noisyKeys = [...valuesByKey.entries()]
    .filter(([, values]) => values.size > TAG_NOISY_VALUES_PER_SESSION)
    .map(([key, values]) => ({ key, values: values.size }))
    .sort((a, b) => b.values - a.values || (a.key < b.key ? -1 : 1));
  return { noisyKeys, atLimit: otelPairs >= OTEL_TAG_MAX_PAIRS };
}

/** The deduped `tags` of each given session (its root's tags for a sub-agent). */
export async function loadSessionTagsByNode(
  db: DrizzleDb,
  sessionRowIds: readonly number[],
): Promise<Map<number, SessionTag[]>> {
  const raw = await loadRawTagRows(db, sessionRowIds);
  const result = new Map<number, SessionTag[]>();
  for (const [nodeId, rows] of raw) result.set(nodeId, dedupeSessionTags(rows));
  return result;
}

/** The session detail's `tags` and `tagNoise` for one session (root's tags for a sub-agent). */
export async function loadSessionTagDetail(
  db: DrizzleDb,
  sessionRowId: number,
): Promise<{ tags: SessionTag[]; tagNoise: SessionTagNoise }> {
  const raw =
    (await loadRawTagRows(db, [sessionRowId])).get(sessionRowId) ?? [];
  return { tags: dedupeSessionTags(raw), tagNoise: computeTagNoise(raw) };
}

/** The repository scope of a discovery / `contexts` read. */
export interface RepoTagScope {
  repoIds: number[];
  /** Team visible-users predicate on the `logs l` alias (`AND l.user_id = ANY(…)`), or empty. */
  ownerFilter: SQL;
  startDate?: Date;
  endDate?: Date;
  /** `undefined` = any branch, `''` = sessions without a branch (as the session list). */
  branch?: string;
  userEmail?: string;
}

/**
 * The root sessions in a repository scope the caller may open — the session list's own root
 * predicate (artisyn log with a first prompt, a claude log, not deleted) plus the scope filters.
 * A CTE body selecting `id`.
 */
function scopedRootIdsSql(scope: RepoTagScope): SQL {
  const repoIdsLiteral = `{${scope.repoIds.join(',')}}`;
  const dateFilter =
    scope.startDate && scope.endDate
      ? sql`AND l.start_time >= ${scope.startDate} AND l.start_time <= ${scope.endDate}`
      : sql``;
  const branchFilter =
    scope.branch === undefined
      ? sql``
      : scope.branch === ''
        ? sql`AND (l.git_branch IS NULL OR l.git_branch = '')`
        : sql`AND l.git_branch = ${scope.branch}`;
  const userFilter = scope.userEmail
    ? sql`AND EXISTS (SELECT 1 FROM users u WHERE u.id = l.user_id AND u.email = ${scope.userEmail})`
    : sql``;
  return sql`
    SELECT DISTINCT s.id
    FROM sessions s
    INNER JOIN logs l ON l.session_id = s.id AND l.log_type = 'artisyn'
    INNER JOIN log_repositories lr ON lr.log_id = l.id
    WHERE lr.repo_id = ANY(${repoIdsLiteral}::int[])
      AND l.first_prompt IS NOT NULL
      AND s.deleted = false
      AND EXISTS (
        SELECT 1 FROM logs cl
        WHERE cl.session_id = l.session_id AND cl.log_type = 'claude'
      )
      ${scope.ownerFilter}
      ${dateFilter}
      ${branchFilter}
      ${userFilter}
  `;
}

interface DiscoveryRow {
  key: string;
  value: string;
  session_count: string | number;
  noisy: boolean;
}

/**
 * FR-8 discovery: every tag key on the root sessions in scope, each value with the number of
 * sessions carrying it (sorted by count, then value), plus the keys that are noisy on at least
 * one session in scope.
 */
export async function loadSessionTagValues(
  db: DrizzleDb,
  scope: RepoTagScope,
): Promise<SessionTagValuesResponse> {
  if (scope.repoIds.length === 0) return { tags: {}, noisyKeys: [] };
  const result = await db.execute(sql`
    WITH scoped AS (${scopedRootIdsSql(scope)}),
    pairs AS (
      SELECT DISTINCT st.session_id, st.key, st.value
      FROM session_tags st
      INNER JOIN scoped ON scoped.id = st.session_id
    ),
    noisy AS (
      SELECT DISTINCT key FROM (
        SELECT session_id, key FROM pairs
        GROUP BY session_id, key
        HAVING COUNT(*) > ${TAG_NOISY_VALUES_PER_SESSION}
      ) n
    )
    SELECT p.key, p.value, COUNT(*) AS session_count,
      (p.key IN (SELECT key FROM noisy)) AS noisy
    FROM pairs p
    GROUP BY p.key, p.value
    ORDER BY p.key, COUNT(*) DESC, p.value
  `);
  const tags: SessionTagValuesResponse['tags'] = {};
  const noisyKeys = new Set<string>();
  for (const row of result.rows as unknown as DiscoveryRow[]) {
    (tags[row.key] ??= []).push({
      value: row.value,
      sessionCount: Number(row.session_count),
    });
    if (row.noisy) noisyKeys.add(row.key);
  }
  return { tags, noisyKeys: [...noisyKeys].sort() };
}

/**
 * The legacy `GET :repoId/contexts` answer: each `(key, value)` of the root sessions in scope
 * once, sorted by key then value.
 */
export async function loadScopedTagPairs(
  db: DrizzleDb,
  scope: RepoTagScope,
): Promise<{ key: string; value: string }[]> {
  if (scope.repoIds.length === 0) return [];
  const result = await db.execute(sql`
    WITH scoped AS (${scopedRootIdsSql(scope)})
    SELECT DISTINCT st.key, st.value
    FROM session_tags st
    INNER JOIN scoped ON scoped.id = st.session_id
    ORDER BY st.key, st.value
  `);
  return (result.rows as unknown as { key: string; value: string }[]).map(
    (r) => ({ key: r.key, value: r.value }),
  );
}

/**
 * `groupBy=tag:<key>` buckets of each given ROOT session (fan-out): the session's distinct values
 * of `key` (deduped across sources), or `[UNTAGGED_GROUP]` when it has none. Every requested id
 * gets an entry. Used by the analytics / report services that group in TypeScript; the
 * raw-SQL path (work-time) uses `tagGroupKeysSql()` with the same rule.
 */
export async function loadTagGroupLabels(
  db: DrizzleDb,
  rootSessionRowIds: readonly number[],
  key: string,
): Promise<Map<number, string[]>> {
  const valuesById = new Map<number, string[]>();
  if (rootSessionRowIds.length > 0) {
    const idsLiteral = `{${rootSessionRowIds.join(',')}}`;
    const result = await db.execute(sql`
      SELECT DISTINCT st.session_id AS session_row_id, st.value
      FROM session_tags st
      WHERE st.session_id = ANY(${idsLiteral}::bigint[])
        AND st.key = ${key}::text
      ORDER BY st.session_id, st.value
    `);
    for (const row of result.rows as unknown as {
      session_row_id: string | number;
      value: string;
    }[]) {
      const id = Number(row.session_row_id);
      const existing = valuesById.get(id);
      if (existing) existing.push(row.value);
      else valuesById.set(id, [row.value]);
    }
  }
  const labels = new Map<number, string[]>();
  for (const id of rootSessionRowIds) {
    labels.set(id, tagGroupLabels(valuesById.get(id) ?? []));
  }
  return labels;
}
