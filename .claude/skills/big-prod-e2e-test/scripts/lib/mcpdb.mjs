// S7's MCP target: a dedicated test database `big_test_mcp` with one `products` table on
// the developer's already-running local Postgres, plus the per-scenario MCP config that points the
// `@modelcontextprotocol/server-postgres` server at it.
//
// Strictly additive: the database is created only when missing, the table with IF NOT EXISTS and
// the seed rows with ON CONFLICT DO NOTHING. Nothing here ever drops, truncates or deletes.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  MCP_DB_NAME,
  MCP_DB_URL_ENV,
  MCP_SEED_ROWS,
  MCP_SERVER_NAME,
  MCP_SERVER_PKG,
  MCP_WARMUP_MS,
  REPO_ROOT,
} from './config.mjs';
import { runAsync } from './proc.mjs';

const CONNECT_TIMEOUT_MS = 10000;
const DB_NAME_RE = /^[a-z_][a-z0-9_]*$/;

/** `DATABASE_URL` from a dotenv text (quotes stripped), or null. */
export function databaseUrlFromEnvText(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?DATABASE_URL\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const v = m[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (v) return v;
  }
  return null;
}

/** The same server/credentials as `url`, with the database swapped for `dbName`. */
export function withDatabase(url, dbName = MCP_DB_NAME) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

/** `url` with its password replaced by `***`, for every log and report line. */
export function maskUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return String(url).replace(/\/\/([^:/@]+):[^@]*@/, '//$1:***@');
  }
}

/**
 * The admin connection URL: env BIG_TEST_MCP_PG_URL, else `DATABASE_URL` from the repo's own
 * `server/.env` (repo-relative, never a machine path). Throws with a hint when neither exists.
 */
export function resolveAdminUrl({ env = process.env, repoRoot = REPO_ROOT } = {}) {
  if (env[MCP_DB_URL_ENV]) return { url: env[MCP_DB_URL_ENV], source: `env ${MCP_DB_URL_ENV}` };
  const envFile = path.join(repoRoot, 'server', '.env');
  let text = '';
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch {
    /* handled below */
  }
  const url = databaseUrlFromEnvText(text);
  if (!url) {
    throw new Error(
      `no Postgres URL for the S7 MCP test database: set ${MCP_DB_URL_ENV} or DATABASE_URL in server/.env`,
    );
  }
  return { url, source: 'server/.env DATABASE_URL' };
}

/** `{ mcpServers: { big-test-pg: … } }` for `claude --mcp-config`. */
export function mcpServerConfig(dbUrl) {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: { command: 'npx', args: ['-y', MCP_SERVER_PKG, dbUrl] },
    },
  };
}

/** Writes a scenario's MCP config file (built by mcpServerConfig) and returns its path. */
export function writeSessionMcpConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

function loadPg() {
  const require = createRequire(path.join(REPO_ROOT, 'package.json'));
  return require('pg');
}

async function withClient(pg, url, fn) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Creates `big_test_mcp` (if missing), the `products` table (if missing) and the seed rows (if
 * missing). Resolves { url, masked, source, created, rows }.
 */
export async function ensureMcpDb({ env = process.env, repoRoot = REPO_ROOT, dbName = MCP_DB_NAME } = {}) {
  if (!DB_NAME_RE.test(dbName)) throw new Error(`invalid test database name "${dbName}"`);
  const { url: adminUrl, source } = resolveAdminUrl({ env, repoRoot });
  const url = withDatabase(adminUrl, dbName);
  const masked = maskUrl(url);
  const pg = loadPg();
  let created = false;
  try {
    await withClient(pg, adminUrl, async (c) => {
      const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
      if (r.rowCount === 0) {
        await c.query(`CREATE DATABASE ${dbName}`);
        created = true;
      }
    });
  } catch (err) {
    throw new Error(
      `cannot reach the local Postgres at ${maskUrl(adminUrl)} (${source}): ${err.message} — ` +
        `start the local Postgres or set ${MCP_DB_URL_ENV}`,
    );
  }
  const rows = await withClient(pg, url, async (c) => {
    await c.query(
      'CREATE TABLE IF NOT EXISTS products (id int PRIMARY KEY, name text NOT NULL, price numeric(10,2) NOT NULL)',
    );
    for (const row of MCP_SEED_ROWS) {
      await c.query('INSERT INTO products (id, name, price) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [
        row.id,
        row.name,
        row.price,
      ]);
    }
    const r = await c.query('SELECT count(*)::int AS n FROM products');
    return r.rows[0].n;
  });
  return { url, masked, source, created, rows };
}

/**
 * Downloads the MCP server package once before the sessions, so the first `claude -p` does not
 * spend its MCP connect window inside `npx -y`. The server exits when its stdin closes.
 */
export async function warmMcpServer(dbUrl, { cwd, env = process.env, logFile } = {}) {
  const res = await runAsync(`npx -y ${MCP_SERVER_PKG} "${dbUrl}"`, [], {
    cwd,
    env,
    input: '',
    shell: true,
    timeoutMs: MCP_WARMUP_MS,
    stdoutFile: logFile,
    stderrFile: logFile ? `${logFile}.stderr` : undefined,
  });
  return res;
}
