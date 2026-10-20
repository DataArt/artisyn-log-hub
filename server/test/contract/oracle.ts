// The contract suite's independent SQL oracle (docs/qaa-overview/scenarios/05 §2.2).
//
// A plain `pg.Pool` pinned to the run's `contract_<uuid>` schema, plus raw-SQL helpers. By design
// nothing here — and nothing in registry/** — imports from src/** (types excepted): no drizzle, no
// service code, no schema mapping. The ORM and the business logic therefore cannot "agree" with the
// test on the same mistake.
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

/** Anything that can run a parameterised query: the pool or one checked-out client. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * Tables every snapshot ignores: the migration journal and the express-session store, which a
 * login (the suite's own way of getting a cookie) and every authenticated request touch.
 */
export const VOLATILE_TABLES: readonly string[] = [
  '__drizzle_migrations',
  'auth_sessions',
];

/** The schema this run's global setup created; refuses anything that is not a contract schema. */
export function contractSchema(): string {
  const schema = process.env.E2E_DB_SCHEMA;
  if (!schema || !/^contract_[0-9a-f]{32}$/.test(schema)) {
    throw new Error(
      `E2E_DB_SCHEMA is "${schema ?? ''}", not a contract_<uuid> schema — ` +
        'run the suite with `npm run test:contract` (from server/), whose global setup creates it.',
    );
  }
  return schema;
}

let pool: Pool | undefined;

/** The oracle pool. Its search_path is the contract schema ONLY, never `public`. */
export function oraclePool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      options: `-c search_path=${contractSchema()}`,
      max: 4,
    });
  }
  return pool;
}

/** Runs one SQL statement through the oracle and returns its rows. */
export async function q<R extends QueryResultRow = Record<string, unknown>>(
  sql: string,
  args: unknown[] = [],
): Promise<R[]> {
  const res = await oraclePool().query<R>(sql, args);
  return res.rows;
}

/** Runs `fn` inside one transaction on a dedicated client; rolls back on error. */
export async function inOracleTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await oraclePool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Ends the oracle pool; call from the spec's `afterAll`. */
export async function closeOracle(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = undefined;
    await p.end();
  }
}

/** Double-quotes an identifier taken from the catalog. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Every base table of the contract schema, sorted, `VOLATILE_TABLES` excluded. */
export async function schemaTables(
  db: Queryable = oraclePool(),
): Promise<string[]> {
  const { rows } = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'
      ORDER BY table_name`,
    [contractSchema()],
  );
  return rows
    .map((r) => r.table_name)
    .filter((t) => !VOLATILE_TABLES.includes(t));
}

/** Per-table `count(*)` and an md5 over every row's text form. */
export type SchemaChecksum = Record<string, { rows: number; md5: string }>;

/**
 * Cheap whole-schema fingerprint (05 §2.5 "unchanged: all other tables"): two equal checksums
 * mean no row was inserted, deleted or changed anywhere outside `VOLATILE_TABLES`.
 */
export async function schemaChecksum(
  tables?: readonly string[],
  db: Queryable = oraclePool(),
): Promise<SchemaChecksum> {
  const names = tables ?? (await schemaTables(db));
  const out: SchemaChecksum = {};
  for (const name of names) {
    const { rows } = await db.query<{ n: string; h: string }>(
      `SELECT count(*)::text AS n,
              md5(coalesce(string_agg(t::text, '|' ORDER BY t::text), '')) AS h
         FROM ${ident(name)} t`,
    );
    out[name] = { rows: Number(rows[0].n), md5: rows[0].h };
  }
  return out;
}

/** Names of the tables whose checksum differs between two snapshots. */
export function changedTables(
  before: SchemaChecksum,
  after: SchemaChecksum,
): string[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .filter((n) => {
      const a = before[n];
      const b = after[n];
      return !a || !b || a.rows !== b.rows || a.md5 !== b.md5;
    })
    .sort();
}

/** Primary-key columns of `table` (empty when it has none). */
export async function primaryKeyColumns(
  table: string,
  db: Queryable = oraclePool(),
): Promise<string[]> {
  const { rows } = await db.query<{ attname: string }>(
    `SELECT a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
      WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
      ORDER BY array_position(i.indkey::int2[], a.attnum)`,
    [contractSchema(), table],
  );
  return rows.map((r) => r.attname);
}

/** Every row of `table` as plain JSON objects (via `to_jsonb`, so values are comparable). */
export async function tableRows(
  table: string,
  db: Queryable = oraclePool(),
): Promise<Record<string, unknown>[]> {
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `SELECT to_jsonb(t) AS r FROM ${ident(table)} t ORDER BY t::text`,
  );
  return rows.map((row) => row.r);
}
