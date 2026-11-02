// Writes docs/knowledgebase/db_state.sql: the current database schema as plain DDL.
//
//   npm run db:state            regenerate the file
//   npm run db:state -- --check exit 1 when the committed file is stale
//
// It creates a throw-away database next to the one DATABASE_URL points at (env, else server/.env),
// migrates it with the server's own `npm run migrate` (the same initializeDatabase() the server runs
// at startup), reads the public schema from the Postgres catalog and drops the database again.
// Table and column comments come from `COMMENT ON` in the migrations and are rendered as `--` lines.
// Run it after every new migration and commit the result.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'server');
const OUT = path.join(ROOT, 'docs', 'knowledgebase', 'db_state.sql');
const JOURNAL = path.join(SERVER, 'drizzle', 'migrations', 'meta', '_journal.json');
const TEMP_DB = 'loghub_db_state';

function readEnvFile(file) {
  const vars = {};
  if (!fs.existsSync(file)) return vars;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    vars[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return vars;
}

function withDatabase(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

async function adminQuery(baseUrl, sql) {
  const client = new pg.Client({ connectionString: withDatabase(baseUrl, 'postgres') });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

function migrate(url) {
  // A fixed command string (no argument array) is safe with the shell npm needs on Windows.
  const res = spawnSync('npm run migrate', {
    cwd: SERVER,
    env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'development' },
    encoding: 'utf8',
    shell: true,
  });
  if (res.status !== 0) {
    throw new Error(`npm run migrate failed:\n${res.stdout}\n${res.stderr}`);
  }
}

const q = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const comment = (text, indent) =>
  text.split(/\r?\n/).map((l) => `${indent}-- ${l}`.trimEnd()).join('\n');

async function readSchema(url) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const enums = (await client.query(`
      SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
      FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public' GROUP BY t.typname ORDER BY t.typname`)).rows;
    const tables = (await client.query(`
      SELECT c.oid, c.relname AS name, obj_description(c.oid, 'pg_class') AS comment
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY c.relname`)).rows;
    const columns = (await client.query(`
      SELECT a.attrelid AS oid, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
        a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS default_expr,
        a.attidentity AS identity, a.attgenerated AS generated,
        col_description(a.attrelid, a.attnum) AS comment
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attrelid, a.attnum`)).rows;
    const constraints = (await client.query(`
      SELECT con.conrelid AS oid, con.conname AS name, con.contype AS type,
        pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con JOIN pg_namespace n ON n.oid = con.connamespace
      -- contype 'n' (Postgres 18+) repeats NOT NULL, which the column line already shows
      WHERE n.nspname = 'public' AND con.conrelid <> 0 AND con.contype <> 'n'
      ORDER BY con.conrelid, CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2 ELSE 3 END,
        con.conname`)).rows;
    const indexes = (await client.query(`
      SELECT i.indrelid AS oid, pg_get_indexdef(i.indexrelid) AS def, ic.relname AS name
      FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = ic.relnamespace
      WHERE n.nspname = 'public'
        AND NOT EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = i.indexrelid)
      ORDER BY i.indrelid, ic.relname`)).rows;
    return { enums, tables, columns, constraints, indexes };
  } finally {
    await client.end();
  }
}

function columnSql(col, table) {
  let type = col.type;
  let def = col.default_expr;
  // A sequence-backed default is what `serial` / `bigserial` declared; show it that way.
  const seq = `nextval('${table}_${col.name}_seq'::regclass)`;
  if (def === seq && (type === 'integer' || type === 'bigint')) {
    type = type === 'integer' ? 'serial' : 'bigserial';
    def = null;
  }
  let sql = `${q(col.name)} ${type}`;
  if (col.identity === 'a') sql += ' GENERATED ALWAYS AS IDENTITY';
  else if (col.identity === 'd') sql += ' GENERATED BY DEFAULT AS IDENTITY';
  if (col.generated === 's') sql += ` GENERATED ALWAYS AS (${def}) STORED`;
  else if (def !== null) sql += ` DEFAULT ${def}`;
  if (col.not_null && !type.endsWith('serial')) sql += ' NOT NULL';
  return sql;
}

function render(schema, latestMigration) {
  const out = [
    '-- Current database schema (public), generated by `npm run db:state` — do not edit by hand.',
    `-- Migrated up to: ${latestMigration}. Source of truth: server/drizzle/migrations/*.sql.`,
    '-- Comments come from COMMENT ON in the migrations; add one when a table or column is not',
    '-- obvious from its name and type.',
    '',
  ];
  for (const e of schema.enums) {
    out.push(`CREATE TYPE ${q(e.name)} AS ENUM (${e.labels.map((l) => `'${l}'`).join(', ')});`);
  }
  if (schema.enums.length) out.push('');
  const byOid = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.oid)) m.set(r.oid, []);
      m.get(r.oid).push(r);
    }
    return m;
  };
  const cols = byOid(schema.columns);
  const cons = byOid(schema.constraints);
  const idx = byOid(schema.indexes);
  for (const t of schema.tables) {
    if (t.comment) out.push(comment(t.comment, ''));
    const lines = [];
    for (const c of cols.get(t.oid) ?? []) {
      lines.push({ comment: c.comment, sql: columnSql(c, t.name) });
    }
    for (const c of cons.get(t.oid) ?? []) {
      lines.push({ comment: null, sql: `CONSTRAINT ${q(c.name)} ${c.def}` });
    }
    out.push(`CREATE TABLE ${q(t.name)} (`);
    lines.forEach((l, i) => {
      if (l.comment) out.push(comment(l.comment, '  '));
      out.push(`  ${l.sql}${i < lines.length - 1 ? ',' : ''}`);
    });
    out.push(');');
    for (const i of idx.get(t.oid) ?? []) {
      out.push(`${i.def.replace(/ ON public\./, ' ON ').replace(/ USING btree /, ' ')};`);
    }
    out.push('');
  }
  return out.join('\n');
}

async function main() {
  const check = process.argv.includes('--check');
  const baseUrl = process.env.DATABASE_URL || readEnvFile(path.join(SERVER, '.env')).DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is not set (env or server/.env)');
  const journal = JSON.parse(fs.readFileSync(JOURNAL, 'utf8'));
  const latest = journal.entries[journal.entries.length - 1].tag;
  const tempUrl = withDatabase(baseUrl, TEMP_DB);

  await adminQuery(baseUrl, `DROP DATABASE IF EXISTS ${TEMP_DB}`);
  await adminQuery(baseUrl, `CREATE DATABASE ${TEMP_DB}`);
  let sql;
  try {
    migrate(tempUrl);
    sql = render(await readSchema(tempUrl), latest);
  } finally {
    await adminQuery(baseUrl, `DROP DATABASE IF EXISTS ${TEMP_DB}`);
  }

  if (check) {
    const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== sql) {
      process.stderr.write(`${path.relative(ROOT, OUT)} is stale — run \`npm run db:state\`\n`);
      process.exit(1);
    }
    process.stdout.write(`${path.relative(ROOT, OUT)} is up to date (${latest})\n`);
    return;
  }
  fs.writeFileSync(OUT, sql, 'utf8');
  process.stdout.write(`wrote ${path.relative(ROOT, OUT)} (${latest}, ${Buffer.byteLength(sql)} bytes)\n`);
}

main().catch((err) => {
  process.stderr.write(`db-state: ${err.message}\n`);
  process.exit(1);
});
