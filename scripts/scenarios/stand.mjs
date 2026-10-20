// Lifecycle of one scenario stand process (impl-plan DD C1-C4).
//
// startStand({ mode }):
//   1. drops expired, labelled scn_* schemas (older than 6 h; labels in tmp/scenarios/schemas.json,
//      since pg_namespace carries no creation time);
//   2. CREATE SCHEMA scn_<mode>_<8 hex> and labels it;
//   3. picks a free port, prepares tmp/scenarios/run-<runId>/<mode>/ (no .env there);
//   4. spawns `node tmp/scenarios/stand/index.js` with the mode env from tests/scenarios/modes.ts —
//      the stand migrates its own schema via initializeDatabase + E2E_DB_SCHEMA;
//   5. waits for GET /health.
// stopStand(stand): killTree, then DROP SCHEMA ... CASCADE and the label is removed.
//
// coverage (SCENARIOS_COVERAGE=1, DD L1): the stand runs with NODE_V8_COVERAGE=
// tmp/coverage/scenarios-<runId>/<mode>/v8 and the coverage-flush.cjs preload; stopStand() asks it to
// flush (v8.takeCoverage) before the hard kill, and reportStandCoverage() turns the raw profiles into
// an istanbul coverage-final.json for server/src/** through the bundle's source map (ncc -s).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { killTree } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs';
import {
  DEFAULT_DATABASE_URL,
  DEFAULT_MAILPIT_SMTP,
  MODES,
  standEnv,
  standUrl,
} from '../../tests/scenarios/modes.ts';
import { ROOT, SCENARIOS_TMP, STAND_DIR } from './build-stand.mjs';

export const SCHEMA_LABELS_FILE = path.join(SCENARIOS_TMP, 'schemas.json');
export const ORPHAN_SCHEMA_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const HEALTH_TIMEOUT_MS = 120_000;
export const COVERAGE_ROOT = path.join(ROOT, 'tmp', 'coverage');
export const COVERAGE_FLUSH_TIMEOUT_MS = 15_000;
const COVERAGE_PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'coverage-flush.cjs');

const SCHEMA_NAME_RE = /^scn_[abc]_[0-9a-f]{8}$/;

/** OS variables the stand process inherits; everything app-related comes from standEnv(). */
const PASSTHROUGH_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'TZ',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
];

/** `scn_<mode>_<8 hex>` (DD C3). `randomHex` is injectable for tests. */
export function schemaName(mode, randomHex = () => crypto.randomBytes(4).toString('hex')) {
  if (!MODES[mode]) throw new Error(`Unknown stand mode "${mode}"`);
  const name = `scn_${mode}_${randomHex()}`;
  assertSchemaName(name);
  return name;
}

/** Schema names are interpolated into DDL, so only the exact generated shape is accepted. */
export function assertSchemaName(name) {
  if (!SCHEMA_NAME_RE.test(name)) throw new Error(`Refusing unexpected schema name "${name}"`);
}

/** Copies the OS essentials of `source` (case-insensitive keys, as on Windows). */
export function passthroughEnv(source = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && PASSTHROUGH_ENV.includes(key.toUpperCase())) out[key] = value;
  }
  return out;
}

export function readSchemaLabels(file = SCHEMA_LABELS_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function writeSchemaLabels(labels, file = SCHEMA_LABELS_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(labels, null, 2)}\n`, 'utf8');
}

function updateLabels(file, mutate) {
  const labels = readSchemaLabels(file);
  mutate(labels);
  writeSchemaLabels(labels, file);
}

/** Labelled schemas whose createdAt is older than maxAgeMs (or unreadable). */
export function selectExpiredSchemas(labels, now = Date.now(), maxAgeMs = ORPHAN_SCHEMA_MAX_AGE_MS) {
  return Object.entries(labels)
    .filter(([name, label]) => {
      if (!SCHEMA_NAME_RE.test(name)) return false;
      const created = Date.parse(label && label.createdAt);
      return !Number.isFinite(created) || now - created > maxAgeMs;
    })
    .map(([name]) => name)
    .sort();
}

/**
 * Drops every expired labelled schema through `query(sql)` and removes its label. Unlabelled
 * scn_* schemas are left alone: their age is unknown and they may belong to a live run.
 * Returns the dropped names.
 */
export async function dropExpiredSchemas({ query, labelsFile = SCHEMA_LABELS_FILE, now = Date.now(), maxAgeMs }) {
  const expired = selectExpiredSchemas(readSchemaLabels(labelsFile), now, maxAgeMs);
  for (const name of expired) {
    await query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
    updateLabels(labelsFile, (labels) => {
      delete labels[name];
    });
  }
  return expired;
}

/** Where a coverage stand writes: raw V8 profiles in `v8/`, the c8 report next to them (DD L1). */
export function standCoverageDir(runId, mode, root = COVERAGE_ROOT) {
  return path.join(root, `scenarios-${runId}`, mode);
}

/** A port the OS reports free right now (listen(0), then close). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function withPool(databaseUrl, fn) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await fn((sql) => pool.query(sql));
  } finally {
    await pool.end();
  }
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n');
  } catch {
    return '(no log)';
  }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(url, child, logFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Stand exited (${child.exitCode ?? child.signalCode}) before /health answered.\n${tail(logFile)}`);
    }
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err.message;
    }
    await delay(250);
  }
  throw new Error(`Stand did not answer ${url}/health within ${timeoutMs} ms (${lastError}).\n${tail(logFile)}`);
}

/**
 * Starts a stand for `mode`. Returns { mode, url, port, schema, runId, runDir, logFile, pid, child }.
 * On any failure after CREATE SCHEMA the process is killed and the schema dropped before rethrowing.
 */
export async function startStand({
  mode,
  runId = `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`,
  databaseUrl = process.env.DATABASE_URL || DEFAULT_DATABASE_URL,
  mailpitSmtp = process.env.MAILPIT_SMTP || DEFAULT_MAILPIT_SMTP,
  coverage = process.env.SCENARIOS_COVERAGE === '1',
  standDir = STAND_DIR,
  labelsFile = SCHEMA_LABELS_FILE,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
} = {}) {
  if (!MODES[mode]) throw new Error(`Unknown stand mode "${mode}"`);
  const entry = path.join(standDir, 'index.js');
  if (!fs.existsSync(entry)) throw new Error(`${entry} not found — run scripts/scenarios/build-stand.mjs first`);

  const schema = schemaName(mode);
  await withPool(databaseUrl, async (query) => {
    const dropped = await dropExpiredSchemas({ query, labelsFile });
    if (dropped.length) process.stderr.write(`[stand] dropped expired schemas: ${dropped.join(', ')}\n`);
    await query(`CREATE SCHEMA "${schema}"`);
  });
  updateLabels(labelsFile, (labels) => {
    labels[schema] = { createdAt: new Date().toISOString(), mode, runId };
  });

  let child = null;
  try {
    const port = await freePort();
    const url = standUrl(port);
    const runDir = path.join(SCENARIOS_TMP, `run-${runId}`, mode);
    fs.mkdirSync(runDir, { recursive: true });
    const env = {
      ...passthroughEnv(),
      ...standEnv({
        mode,
        port,
        databaseUrl,
        schema,
        runDir,
        joinPath: path.join,
        sessionSecret: mode === 'b' ? crypto.randomBytes(48).toString('hex') : undefined,
        mailpitSmtp,
      }),
    };
    let coverageDir = null;
    if (coverage) {
      coverageDir = standCoverageDir(runId, mode);
      fs.rmSync(coverageDir, { recursive: true, force: true });
      fs.mkdirSync(path.join(coverageDir, 'v8'), { recursive: true });
      env.NODE_V8_COVERAGE = path.join(coverageDir, 'v8');
      env.STAND_COVERAGE_FLUSH_FILE = path.join(coverageDir, 'flush');
    }
    const nodeArgs = coverage ? ['--require', COVERAGE_PRELOAD, entry] : [entry];

    const logFile = path.join(runDir, 'stand.log');
    const log = fs.openSync(logFile, 'w');
    try {
      child = spawn(process.execPath, nodeArgs, {
        cwd: runDir,
        env,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', log, log],
      });
    } finally {
      fs.closeSync(log);
    }
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await waitForHealth(url, child, logFile, healthTimeoutMs);
    return { mode, url, port, schema, runId, runDir, logFile, pid: child.pid, child, databaseUrl, labelsFile, coverageDir };
  } catch (err) {
    if (child) await stopProcess(child);
    await dropSchema(databaseUrl, schema, labelsFile).catch(() => {});
    throw err;
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  killTree(child.pid);
  await Promise.race([exited, delay(10_000)]);
}

async function dropSchema(databaseUrl, schema, labelsFile) {
  assertSchemaName(schema);
  await withPool(databaseUrl, (query) => query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`));
  updateLabels(labelsFile, (labels) => {
    delete labels[schema];
  });
}

/**
 * Asks a coverage stand to write its V8 profile now (coverage-flush.cjs) and waits for the answer.
 * Returns true once the profile is on disk; false when the stand is gone or did not answer in time.
 */
export async function flushStandCoverage(stand, timeoutMs = COVERAGE_FLUSH_TIMEOUT_MS) {
  if (!stand || !stand.coverageDir) return false;
  const child = stand.child;
  if (child && (child.exitCode !== null || child.signalCode !== null)) return false;
  const flushFile = path.join(stand.coverageDir, 'flush');
  const doneFile = `${flushFile}.done`;
  if (fs.existsSync(doneFile)) return true;
  fs.writeFileSync(flushFile, `${new Date().toISOString()}\n`, 'utf8');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(doneFile)) {
      const answer = fs.readFileSync(doneFile, 'utf8').trim();
      if (answer !== 'ok') process.stderr.write(`[stand] coverage flush failed: ${answer}\n`);
      return answer === 'ok';
    }
    await delay(100);
  }
  process.stderr.write(`[stand] coverage flush timed out after ${timeoutMs} ms\n`);
  return false;
}

/** c8 arguments that turn a stand's raw V8 profiles into json + json-summary reports for server/src. */
export function c8ReportArgs(coverageDir) {
  return [
    'report',
    '--temp-directory', path.join(coverageDir, 'v8'),
    '--report-dir', path.join(coverageDir, 'report'),
    '--reporter', 'json',
    '--reporter', 'json-summary',
    '--exclude-after-remap',
    '--include', 'server/src/**',
    '--exclude', '**/*.spec.ts',
    '--exclude', '**/*.e2e-spec.ts',
  ];
}

/**
 * Runs `c8 report` over a stopped coverage stand (cwd = repo root, so the include globs are
 * repo-relative). Returns the path of the coverage-final.json it wrote.
 */
export function reportStandCoverage(coverageDir, { root = ROOT } = {}) {
  const c8Cli = path.join(root, 'node_modules', 'c8', 'bin', 'c8.js');
  if (!fs.existsSync(c8Cli)) throw new Error(`${c8Cli} not found — run npm install in the repo root`);
  const res = spawnSync(process.execPath, [c8Cli, ...c8ReportArgs(coverageDir)], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(`c8 report failed (${res.status ?? res.signal}): ${(res.stderr || res.stdout || '').trim()}`);
  }
  return path.join(coverageDir, 'report', 'coverage-final.json');
}

/** Kills the stand's process tree, then drops its schema (DD C3). Safe to call twice. */
export async function stopStand(stand) {
  if (!stand) return;
  if (stand.coverageDir) await flushStandCoverage(stand);
  if (stand.child) await stopProcess(stand.child);
  else killTree(stand.pid);
  await dropSchema(stand.databaseUrl, stand.schema, stand.labelsFile);
}
