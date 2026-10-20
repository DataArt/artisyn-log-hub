/**
 * time-shift.ts — moves a whole session tree back in time (impl-plan DD C5).
 *
 * Scenarios that need "old" data (retention, date-range filters, period reports) load a session
 * normally through the API and then shift it into the past here, instead of crafting timestamps
 * in fixture files.
 *
 * `shiftSessionTree(db, rootSessionId, deltaDays)`:
 *   1. collects every session of the tree — the root and, recursively, every session whose
 *      `parent_session_id` points at one already collected;
 *   2. for every base table of the stand's schema that has a `session_id` column, plus `sessions`
 *      itself, subtracts `deltaDays` days from every `timestamp` / `timestamptz` column of the
 *      tree's rows.
 *
 * The table list is read from `information_schema.columns`, never hard-coded, so a new
 * session-scoped table is shifted without touching this file. `session_id` is matched by its
 * type: an integer column holds `sessions.id`, a text column holds the string `sessions.session_id`.
 * Everything runs in one transaction on the `db` fixture's pool (its search_path is the stand's
 * schema, read here through `current_schema()`).
 */
import type { Pool, PoolClient } from 'pg';

const TIMESTAMP_TYPES = new Set(['timestamp without time zone', 'timestamp with time zone']);
const INTEGER_TYPES = new Set(['integer', 'bigint', 'smallint']);
const TEXT_TYPES = new Set(['character varying', 'text', 'character']);

export interface ShiftedTable {
  table: string;
  columns: string[];
  rows: number;
}

export interface ShiftResult {
  /** String ids (`sessions.session_id`) of the shifted tree, root first. */
  sessionIds: string[];
  /** Tables that had at least one timestamp column, with the rows updated in each. */
  tables: ShiftedTable[];
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  data_type: string;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function collectTree(client: PoolClient, rootSessionId: string): Promise<{ ids: number[]; sessionIds: string[] }> {
  const { rows } = await client.query<{ id: number; session_id: string; depth: number }>(
    `WITH RECURSIVE tree AS (
       SELECT id, session_id, 0 AS depth FROM sessions WHERE session_id = $1
       UNION
       SELECT s.id, s.session_id, t.depth + 1
         FROM sessions s JOIN tree t ON s.parent_session_id = t.session_id
        WHERE t.depth < 64 -- guards against a parent cycle
     )
     SELECT id, session_id, min(depth) AS depth FROM tree GROUP BY id, session_id ORDER BY depth, id`,
    [rootSessionId],
  );
  if (rows.length === 0) throw new Error(`shiftSessionTree: no session "${rootSessionId}" in the stand schema`);
  return { ids: rows.map((r) => r.id), sessionIds: rows.map((r) => r.session_id) };
}

/** Base tables of the current schema with their `session_id` type and timestamp columns. */
async function sessionScopedTables(client: PoolClient): Promise<Map<string, { sessionIdType: string | null; timestamps: string[] }>> {
  const { rows } = await client.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.data_type
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = current_schema()
        AND t.table_type = 'BASE TABLE'
        AND c.is_generated = 'NEVER'
      ORDER BY c.table_name, c.ordinal_position`,
  );
  const tables = new Map<string, { sessionIdType: string | null; timestamps: string[] }>();
  for (const row of rows) {
    let entry = tables.get(row.table_name);
    if (!entry) {
      entry = { sessionIdType: null, timestamps: [] };
      tables.set(row.table_name, entry);
    }
    if (row.column_name === 'session_id') entry.sessionIdType = row.data_type;
    if (TIMESTAMP_TYPES.has(row.data_type)) entry.timestamps.push(row.column_name);
  }
  return tables;
}

export interface ShiftOptions {
  /**
   * Tables to leave alone. For in-flight transport state whose age drives its own sweep — e.g.
   * `upload_queue`: an aged `partially_uploaded` row is expired by the partial-upload sweep, so a
   * scenario that wants retention (not the sweep) to remove it keeps the row's clock as it is.
   */
  excludeTables?: readonly string[];
}

/**
 * Shifts every timestamp of the session tree rooted at `rootSessionId` (the string
 * `sessions.session_id`) `deltaDays` days into the past. A negative `deltaDays` moves it forward.
 */
export async function shiftSessionTree(
  db: Pool,
  rootSessionId: string,
  deltaDays: number,
  { excludeTables = [] }: ShiftOptions = {},
): Promise<ShiftResult> {
  if (!Number.isFinite(deltaDays)) throw new Error(`shiftSessionTree: deltaDays must be a number, got ${deltaDays}`);
  const excluded = new Set(excludeTables);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const tree = await collectTree(client, rootSessionId);
    const tables = await sessionScopedTables(client);
    const shifted: ShiftedTable[] = [];

    for (const [table, { sessionIdType, timestamps }] of tables) {
      if (timestamps.length === 0 || excluded.has(table)) continue;
      let where: string;
      let param: number[] | string[];
      if (table === 'sessions') {
        where = 'id = ANY($2::int[])';
        param = tree.ids;
      } else if (sessionIdType && INTEGER_TYPES.has(sessionIdType)) {
        where = 'session_id = ANY($2::int[])';
        param = tree.ids;
      } else if (sessionIdType && TEXT_TYPES.has(sessionIdType)) {
        where = 'session_id = ANY($2::text[])';
        param = tree.sessionIds;
      } else {
        continue;
      }
      const sets = timestamps.map((c) => `${quoteIdent(c)} = ${quoteIdent(c)} - $1::float8 * interval '1 day'`).join(', ');
      const res = await client.query(`UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${where}`, [deltaDays, param]);
      shifted.push({ table, columns: timestamps, rows: res.rowCount ?? 0 });
    }

    await client.query('COMMIT');
    return { sessionIds: tree.sessionIds, tables: shifted };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
