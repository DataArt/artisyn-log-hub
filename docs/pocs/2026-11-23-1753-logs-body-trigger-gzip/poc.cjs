'use strict';
// PoC for 2026-11-23-session-logs-streaming. Read-only against the dev DB:
// part A runs in a transaction on a TEMP table and rolls back; part B only SELECTs.
// Uses the server's own `pg` (async is unavoidable with it).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { createRequire } = require('module');

const repoRoot = path.resolve(__dirname, '../../..');
const serverRequire = createRequire(path.join(repoRoot, 'server', 'package.json'));
const { Client } = serverRequire('pg');

function readDbUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const env = fs.readFileSync(path.join(repoRoot, 'server', '.env'), 'utf8');
  const m = env.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error('DATABASE_URL not found');
  return m[1].trim().replace(/^['"]|['"]$/g, '');
}

const TRIGGER_SQL = `
CREATE TEMP SEQUENCE poc_rev_seq;
CREATE TEMP TABLE poc_logs (
  id serial PRIMARY KEY,
  session_id text NOT NULL,
  log_type text NOT NULL,
  body jsonb,
  body_sha256 text,
  body_rev bigint,
  body_gz bytea,
  body_gz_rev bigint,
  UNIQUE (session_id, log_type)
);
CREATE FUNCTION pg_temp.poc_logs_body_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.body_rev := nextval('poc_rev_seq');
  IF TG_OP = 'UPDATE' AND NEW.body_sha256 IS NOT DISTINCT FROM OLD.body_sha256 THEN
    NEW.body_sha256 := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poc_logs_body_guard BEFORE INSERT OR UPDATE OF body ON poc_logs
  FOR EACH ROW EXECUTE FUNCTION pg_temp.poc_logs_body_guard();
`;

async function partA(c) {
  const out = [];
  const row = async (label) => {
    const r = await c.query('SELECT body_sha256, body_rev, body_gz_rev FROM poc_logs WHERE session_id = $1', ['s1']);
    out.push(`${label}: ${JSON.stringify(r.rows[0])}`);
  };
  const upsert = `INSERT INTO poc_logs (session_id, log_type, body, body_sha256) VALUES ('s1','claude',$1::jsonb,$2)
    ON CONFLICT (session_id, log_type) DO UPDATE SET body = excluded.body, body_sha256 = excluded.body_sha256`;
  await c.query('BEGIN');
  await c.query(TRIGGER_SQL);
  await c.query(upsert, ['[1]', 'h1']); await row('insert with hash h1');
  await c.query(upsert, ['[1,2]', 'h2']); await row('ON CONFLICT update with new hash h2');
  await c.query("UPDATE poc_logs SET body = '[9]'::jsonb WHERE session_id = 's1'"); await row('UPDATE body without hash (zip import / old build)');
  await c.query("UPDATE poc_logs SET body_gz = '\\x00'::bytea, body_gz_rev = body_rev WHERE session_id = 's1'"); await row('UPDATE gz only (trigger must not fire)');
  await c.query(upsert, ['[9]', 'h3']); await row('upsert same body, new hash h3');
  await c.query('ROLLBACK');
  return out;
}

async function partB(c) {
  const top = await c.query(`SELECT id, log_type, pg_column_size(body) AS stored
    FROM logs WHERE log_type IN ('claude','claude-subagent','artisyn') AND body IS NOT NULL
    ORDER BY pg_column_size(body) DESC LIMIT 3`);
  const out = [];
  for (const t of top.rows) {
    const mem0 = process.memoryUsage().rss;
    const t0 = process.hrtime.bigint();
    const r = await c.query('SELECT body::text AS t FROM logs WHERE id = $1', [t.id]);
    const t1 = process.hrtime.bigint();
    const text = r.rows[0].t;
    const raw = Buffer.byteLength(text, 'utf8');
    const g0 = process.hrtime.bigint();
    const gz = zlib.gzipSync(text, { level: 6 });
    const g1 = process.hrtime.bigint();
    const back = zlib.gunzipSync(gz).toString('utf8');
    const rssDelta = process.memoryUsage().rss - mem0;
    out.push([
      `log_type=${t.log_type}`,
      `jsonb_stored=${t.stored}`,
      `text_bytes=${raw}`,
      `gzip6_bytes=${gz.length}`,
      `ratio=${(raw / gz.length).toFixed(2)}`,
      `read_ms=${Number(t1 - t0) / 1e6}`,
      `gzip_ms=${(Number(g1 - g0) / 1e6).toFixed(1)}`,
      `roundtrip_equal=${back === text}`,
      `rss_delta_mb=${(rssDelta / 1048576).toFixed(1)}`,
    ].join(' '));
  }
  return out;
}

async function main() {
  const c = new Client({ connectionString: readDbUrl() });
  await c.connect();
  try {
    process.stdout.write('A. trigger semantics\n' + (await partA(c)).join('\n') + '\n');
    process.stdout.write('B. largest local logs\n' + (await partB(c)).join('\n') + '\n');
  } finally {
    await c.end();
  }
}

main().catch((e) => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });
