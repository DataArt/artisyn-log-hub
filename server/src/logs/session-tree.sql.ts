import { sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '../database/database.module';

/**
 * Recursive descendant-session lookup.
 *
 * `sessions.parent_session_id` (varchar) now stores the TRUE immediate parent of a
 * sub-agent session — its spawning session/agent `session_id` string — rather than
 * always the root session. A 3+ level agent tree (root -> agent A -> agent B) means a
 * single-level `WHERE parent_session_id = X` match only finds direct children; it
 * misses grandchildren and deeper descendants. Every call site that needs "all
 * sub-agent sessions under this session, at any depth" must use this recursive
 * lookup instead.
 *
 * `parent_session_id` has no FK constraint and no cycle check, so the recursive
 * branch caps at `depth < 50` to guard against a corrupted/cyclic chain — without
 * this cap, an unguarded `UNION ALL` recursive CTE would loop indefinitely.
 */

/**
 * Returns a raw SQL fragment defining the `descendant_sessions` CTE body (without the
 * `WITH RECURSIVE` keyword or trailing comma), for embedding inside a larger
 * `WITH RECURSIVE <this>, other_cte AS (...), ...` clause. Postgres requires the
 * `RECURSIVE` keyword once for the whole `WITH` clause, so callers must prefix their
 * own `WITH` with `WITH RECURSIVE` when using this fragment.
 *
 * Each output row carries:
 * - `id` / `session_id` / `parent_session_id`: the descendant session's own columns
 * - `root_id`: the `sessions.id` (from `rootIdsArray`) this row descends from
 * - `depth`: 0 for the root rows themselves, 1 for direct children, 2 for
 *   grandchildren, etc.
 *
 * `rootIdsArray` must be a `sql` fragment producing a Postgres array of `sessions.id`
 * values (e.g. `sql\`${'{1,2,3}'}::bigint[]\``).
 */
export function descendantSessionsCte(rootIdsArray: SQL): SQL {
  return sql`descendant_sessions AS (
    SELECT id, session_id, parent_session_id, id AS root_id, 0 AS depth
    FROM sessions
    WHERE id = ANY(${rootIdsArray})
    UNION ALL
    SELECT s.id, s.session_id, s.parent_session_id, d.root_id, d.depth + 1
    FROM sessions s
    JOIN descendant_sessions d ON s.parent_session_id = d.session_id
    WHERE d.depth < 50
  )`;
}

interface DescendantRow {
  id: string | number;
  root_id: string | number;
}

/**
 * Plain TypeScript helper on top of {@link descendantSessionsCte} for call sites using
 * Drizzle query builders rather than raw SQL (e.g. the `sessions.service.ts` delete
 * cascade). Returns a map of root `sessions.id` -> all its descendant `sessions.id`
 * values at any depth (the root ids themselves are NOT included in their own value
 * array — only true descendants, i.e. `depth > 0`).
 *
 * Correct for the common zero-nesting case (returns an empty array per root) and for
 * mixed depths within the same batch of root ids.
 */
export async function getDescendantSessionIds(
  db: DrizzleDb,
  rootIds: number[],
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (rootIds.length === 0) {
    return map;
  }

  const idsLiteral = `{${rootIds.join(',')}}`;
  const idsArray = sql`${idsLiteral}::bigint[]`;

  const result = await db.execute(sql`
    WITH RECURSIVE ${descendantSessionsCte(idsArray)}
    SELECT id, root_id FROM descendant_sessions WHERE depth > 0
  `);

  for (const row of result.rows as unknown as DescendantRow[]) {
    const rootId = Number(row.root_id);
    const descendantId = Number(row.id);
    const existing = map.get(rootId);
    if (existing) {
      existing.push(descendantId);
    } else {
      map.set(rootId, [descendantId]);
    }
  }

  return map;
}
