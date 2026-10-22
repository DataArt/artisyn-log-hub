#!/usr/bin/env node
// Scenario-suite runner, `npm run test:scenarios` (impl-plan DD C7, C8, C14).
//
//   1. preflight (DD C8; exit 2 with a readable message);
//   2. fingerprint the dev DB (`public` schema of DATABASE_URL: tables + count(*) each) and
//      server/src/public/static (content hash + mtimes) — DD C14;
//   3. build the stand (skipped when its input hash is current, or with --skip-build);
//   4. for each selected mode: startStand → playwright -c playwright.scenarios.config.ts
//      --project mode-<x> [--project corpus on the mode-A stand] (STAND_URL / STAND_MODE / STAND_SCHEMA / STAND_RUN_DIR in env) → stopStand.
//      Mode B runs in two passes on two fresh stands, because login backoff counts per IP and
//      every scenario comes from 127.0.0.1 (DD C2): `--grep-invert @backoff`, then `--grep @backoff`
//      (the second pass is skipped when no test carries the tag);
//   5. step `contract`: `npm run test:contract` in server/ (impl-plan DD C7, F1) — the API <-> DB
//      contract jest project. It builds no stand and needs no Mailpit or browser; it gets the
//      runner's DATABASE_URL and creates/drops its own `contract_<uuid>` schema;
//   6. fingerprint again; any difference fails the run.
//
// Steps: `scenarios`, `corpus` and `contract` (all by default). `corpus` (the session corpus of
// tests/corpus/, impl-plan DD I1–I3) always runs on the mode-A stand: in the same pass as `mode-a`
// when both are selected, otherwise in a pass of its own. `--only contract` skips the stand build.
//
// Usage: node scripts/scenarios/run.mjs [--mode a,b,c] [--grep <re>] [--skip-build] [--only scenarios,corpus,contract]
// Exit codes: 0 all green, 1 a step failed or the dev DB/static changed, 2 usage/preflight error.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { DEFAULT_DATABASE_URL, DEFAULT_MAILPIT_URL, STAND_MODES, parseModes } from '../../tests/scenarios/modes.ts';
import { ROOT, buildStand } from './build-stand.mjs';
import { preflightOrExit, redactUrl } from './preflight.mjs';
import { reportStandCoverage, startStand, stopStand } from './stand.mjs';

export const USAGE_EXIT_CODE = 2;
export const AVAILABLE_STEPS = ['scenarios', 'corpus', 'contract'];
/** Steps named in DD C7 but not wired yet; asking for one is an error. */
export const PLANNED_STEPS = [];
export const CORPUS_PROJECT = 'corpus';
export const CONFIG_FILE = 'playwright.scenarios.config.ts';
export const STATIC_DIR = path.join(ROOT, 'server', 'src', 'public', 'static');
export const BACKOFF_TAG = '@backoff';

const PLAYWRIGHT_CLI = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
export const SERVER_DIR = path.join(ROOT, 'server');

/** Parses the runner's argv. Throws with a usage message on anything unknown. */
export function parseArgs(argv) {
  const opts = { modes: [...STAND_MODES], grep: null, skipBuild: false, only: [...AVAILABLE_STEPS] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = arg.startsWith('--') && eq !== -1 ? arg.slice(0, eq) : arg;
    const value = () => {
      const v = eq !== -1 && arg.startsWith('--') ? arg.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '') throw new Error(`${name} requires a value`);
      return v;
    };
    switch (name) {
      case '--mode':
        opts.modes = parseModes(value());
        if (opts.modes.length === 0) throw new Error('--mode selects no mode');
        break;
      case '--grep':
        opts.grep = value();
        break;
      case '--skip-build':
        opts.skipBuild = true;
        break;
      case '--only':
        opts.only = parseSteps(value());
        break;
      default:
        throw new Error(`Unknown argument "${arg}"`);
    }
  }
  return opts;
}

/** `--only` list → steps; a step that is planned but not wired yet is an error, too (DD C7). */
export function parseSteps(list) {
  const steps = [...new Set(list.split(',').map((s) => s.trim()).filter(Boolean))];
  if (steps.length === 0) throw new Error('--only selects no step');
  for (const s of steps) {
    if (PLANNED_STEPS.includes(s)) throw new Error(`Step "${s}" is not available yet (available: ${AVAILABLE_STEPS.join(', ')})`);
    if (!AVAILABLE_STEPS.includes(s)) throw new Error(`Unknown step "${s}" (available: ${AVAILABLE_STEPS.join(', ')})`);
  }
  return steps;
}

/**
 * Playwright passes for one mode. Each pass gets its own fresh stand. `grep` is the user's
 * --grep (or null); the backoff pass must match both it and the tag, hence the lookaheads.
 * With `corpus`, the mode-A pass also runs the `corpus` project (DD C7: `--project mode-a --project corpus`).
 */
export function modePasses(mode, grep = null, { corpus = false } = {}) {
  const project = `mode-${mode}`;
  const base = grep ? ['--grep', grep] : [];
  if (mode === 'a' && corpus) return [{ label: mode, projects: [project, CORPUS_PROJECT], args: base }];
  if (mode !== 'b') return [{ label: mode, projects: [project], args: base }];
  const backoffGrep = grep ? `(?=.*${BACKOFF_TAG}\\b)(?=.*(?:${grep}))` : `${BACKOFF_TAG}\\b`;
  return [
    { label: 'b-main', projects: [project], args: [...base, '--grep-invert', `${BACKOFF_TAG}\\b`] },
    { label: 'b-backoff', projects: [project], args: ['--grep', backoffGrep], skipWhenEmpty: true },
  ];
}

/**
 * Every stand pass of a run as `{ mode, pass }`: the scenario passes of each selected mode, the
 * corpus joined to the mode-A pass — or, when `scenarios` or mode A is not selected, a corpus-only
 * pass on a mode-A stand of its own.
 */
export function standPasses({ modes, grep = null, only }) {
  const scenarios = only.includes('scenarios');
  const corpus = only.includes('corpus');
  const out = [];
  if (scenarios) {
    for (const mode of modes) {
      for (const pass of modePasses(mode, grep, { corpus: corpus && mode === 'a' })) out.push({ mode, pass });
    }
  }
  if (corpus && !(scenarios && modes.includes('a'))) {
    out.push({ mode: 'a', pass: { label: 'corpus', projects: [CORPUS_PROJECT], args: grep ? ['--grep', grep] : [] } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// DD C14 fingerprints

/** `{ tables: [name, count][] }` of the `public` schema; `null` when it has no tables. */
export async function dbFingerprint(databaseUrl) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
    );
    const tables = [];
    for (const { table_name: name } of rows) {
      const quoted = `"public"."${name.replace(/"/g, '""')}"`;
      const res = await client.query(`SELECT count(*)::bigint AS n FROM ${quoted}`);
      tables.push([name, String(res.rows[0].n)]);
    }
    return { tables };
  } finally {
    await client.end().catch(() => {});
  }
}

/** Content hash and per-file mtimes of every file under `dir` (missing dir → `{ missing: true }`). */
export function dirFingerprint(dir) {
  if (!fs.existsSync(dir)) return { missing: true };
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(dir);
  files.sort();
  const hash = crypto.createHash('sha256');
  const mtimes = {};
  for (const file of files) {
    const rel = path.relative(dir, file).split(path.sep).join('/');
    const content = fs.readFileSync(file);
    hash.update(rel).update('\0').update(String(content.length)).update('\0').update(content);
    mtimes[rel] = fs.statSync(file).mtimeMs;
  }
  return { hash: hash.digest('hex'), mtimes };
}

/** Human-readable differences between two fingerprints of the same kind; empty when equal. */
export function diffFingerprints(label, before, after) {
  const a = JSON.stringify(before);
  const b = JSON.stringify(after);
  if (a === b) return [];
  const out = [];
  if (before && after && Array.isArray(before.tables) && Array.isArray(after.tables)) {
    const mb = new Map(before.tables);
    const ma = new Map(after.tables);
    for (const name of new Set([...mb.keys(), ...ma.keys()])) {
      if (mb.get(name) !== ma.get(name)) {
        out.push(`${label}: ${name} ${mb.has(name) ? `rows ${mb.get(name)}` : 'absent'} -> ${ma.has(name) ? `rows ${ma.get(name)}` : 'absent'}`);
      }
    }
  } else if (before && after && before.mtimes && after.mtimes) {
    for (const rel of new Set([...Object.keys(before.mtimes), ...Object.keys(after.mtimes)])) {
      if (before.mtimes[rel] !== after.mtimes[rel]) out.push(`${label}: ${rel} changed (mtime or presence)`);
    }
    if (before.hash !== after.hash && out.length === 0) out.push(`${label}: content hash changed`);
  }
  if (out.length === 0) out.push(`${label}: ${a} -> ${b}`);
  return out;
}

async function takeFingerprints(databaseUrl) {
  return { db: await dbFingerprint(databaseUrl), staticDir: dirFingerprint(STATIC_DIR) };
}

const STATIC_LABEL = 'server/src/public/static';

/**
 * Like `diffFingerprints` for a directory, but ignores mtimes: empty when the same files hold the
 * same bytes. Used around the contract step, which rewrites a static file with identical content.
 */
export function contentDrift(label, before, after) {
  const strip = (fp) => (fp && fp.mtimes ? { hash: fp.hash, files: Object.keys(fp.mtimes).sort() } : fp);
  if (JSON.stringify(strip(before)) === JSON.stringify(strip(after))) return [];
  return diffFingerprints(label, before, after);
}

// ---------------------------------------------------------------------------------------------
// Playwright

function playwrightArgs(pass, extra = []) {
  const projects = pass.projects.flatMap((p) => ['--project', p]);
  return [PLAYWRIGHT_CLI, 'test', '-c', CONFIG_FILE, ...projects, ...pass.args, ...extra];
}

/** Number of tests a pass would run (`playwright test --list`); does not need a stand. */
export function countTests(pass) {
  const res = spawnSync(process.execPath, playwrightArgs(pass, ['--list', '--reporter=json', '--pass-with-no-tests']), {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, STAND_REPORT_LABEL: `${pass.label}-list` },
  });
  if (res.error) throw new Error(`playwright --list failed to run: ${res.error.message}`);
  let report;
  try {
    report = JSON.parse(res.stdout);
  } catch {
    throw new Error(`playwright --list exited ${res.status} without a JSON report:\n${(res.stderr || res.stdout).slice(-2000)}`);
  }
  let count = 0;
  const visit = (suite) => {
    for (const spec of suite.specs || []) count += (spec.tests || []).length;
    for (const child of suite.suites || []) visit(child);
  };
  for (const suite of report.suites || []) visit(suite);
  return count;
}

let activeChild = null;

function runPlaywright(pass, stand, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, playwrightArgs(pass), {
      cwd: ROOT,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ...env,
        STAND_URL: stand.url,
        STAND_MODE: stand.mode,
        STAND_SCHEMA: stand.schema,
        STAND_RUN_DIR: stand.runDir,
        STAND_REPORT_LABEL: pass.label,
      },
    });
    activeChild = child;
    child.on('error', (err) => {
      process.stderr.write(`[scenarios] playwright failed to start: ${err.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => {
      activeChild = null;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

/** The `contract` step: `npm run test:contract` in server/, with the runner's DATABASE_URL. */
export function contractCommand(databaseUrl) {
  return {
    command: 'npm run test:contract',
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  };
}

function runContract(databaseUrl) {
  const { command, cwd, env } = contractCommand(databaseUrl);
  process.stderr.write(`\n[scenarios] contract: ${command} (server/)\n`);
  return new Promise((resolve) => {
    // `shell: true` resolves npm / npm.cmd on every platform; the command is a fixed string.
    const child = spawn(command, { cwd, env, stdio: 'inherit', shell: true, windowsHide: true });
    activeChild = child;
    child.on('error', (err) => {
      process.stderr.write(`[scenarios] contract step failed to start: ${err.message}\n`);
      resolve({ label: 'contract', status: 'failed', code: 1 });
    });
    child.on('exit', (code, signal) => {
      activeChild = null;
      const exit = code ?? (signal ? 1 : 0);
      resolve({ label: 'contract', status: exit === 0 ? 'passed' : 'failed', code: exit });
    });
  });
}

// ---------------------------------------------------------------------------------------------

let activeStand = null;

async function runPass(pass, mode, env) {
  if (pass.skipWhenEmpty) {
    const n = countTests(pass);
    if (n === 0) {
      process.stderr.write(`[scenarios] ${pass.label}: no tests match, skipped\n`);
      return { label: pass.label, status: 'skipped', code: 0 };
    }
  }
  process.stderr.write(`\n[scenarios] ${pass.label}: starting stand (mode ${mode})\n`);
  let stand;
  try {
    stand = await startStand({ mode, databaseUrl: env.DATABASE_URL });
  } catch (err) {
    process.stderr.write(`[scenarios] ${pass.label}: stand failed to start: ${err.message}\n`);
    return { label: pass.label, status: 'stand-failed', code: 1 };
  }
  activeStand = stand;
  process.stderr.write(`[scenarios] ${pass.label}: stand ${stand.url} schema ${stand.schema} log ${stand.logFile}\n`);
  let code = 1;
  try {
    code = await runPlaywright(pass, stand, env);
  } finally {
    await stopStand(stand).catch((err) => {
      process.stderr.write(`[scenarios] ${pass.label}: stopStand failed: ${err.message}\n`);
      code = code || 1;
    });
    activeStand = null;
  }
  if (stand.coverageDir) {
    try {
      const report = reportStandCoverage(stand.coverageDir);
      process.stderr.write(`[scenarios] ${pass.label}: stand coverage ${report}\n`);
    } catch (err) {
      process.stderr.write(`[scenarios] ${pass.label}: stand coverage report failed: ${err.message}\n`);
      code = code || 1;
    }
  }
  return { label: pass.label, status: code === 0 ? 'passed' : 'failed', code };
}

function installSignalHandlers() {
  let stopping = false;
  const onSignal = (signal) => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`\n[scenarios] ${signal}: stopping\n`);
    if (activeChild) activeChild.kill();
    const done = () => process.exit(130);
    if (activeStand) stopStand(activeStand).then(done, done);
    else done();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// The database the runner (preflight, fingerprints, stand, contract step) uses. TEST_DATABASE_URL
// wins so a dev container can point tests at a test DB while its live DATABASE_URL stays on the
// dev DB; on the host neither is usually set and the default applies.
export function resolveRunnerDatabaseUrl(env = process.env) {
  return env.TEST_DATABASE_URL || env.DATABASE_URL || DEFAULT_DATABASE_URL;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`test:scenarios: ${err.message}\n` +
      'Usage: npm run test:scenarios -- [--mode a,b,c] [--grep <re>] [--skip-build] [--only scenarios,corpus,contract]\n');
    return USAGE_EXIT_CODE;
  }

  const databaseUrl = resolveRunnerDatabaseUrl();
  const env = { DATABASE_URL: databaseUrl, MAILPIT_URL: process.env.MAILPIT_URL || DEFAULT_MAILPIT_URL };
  const passes = standPasses(opts);
  const withScenarios = passes.length > 0;
  // The contract step needs only Postgres: no Mailpit, no browser, no stand.
  await preflightOrExit({
    modes: withScenarios ? [...new Set(passes.map((p) => p.mode))] : [],
    databaseUrl,
    mailpitUrl: env.MAILPIT_URL,
    browser: withScenarios,
  });
  installSignalHandlers();

  const before = await takeFingerprints(databaseUrl);
  process.stderr.write(
    `[scenarios] dev-state fingerprint taken: ${before.db.tables.length} public tables in ${redactUrl(databaseUrl)}, ` +
      `static ${before.staticDir.missing ? 'absent' : `${Object.keys(before.staticDir.mtimes).length} files`}\n`,
  );

  if (withScenarios && !opts.skipBuild) {
    try {
      buildStand();
    } catch (err) {
      process.stderr.write(`[scenarios] stand build failed: ${err.message}\n`);
      return 1;
    }
  }

  const results = [];
  for (const { mode, pass } of passes) results.push(await runPass(pass, mode, env));
  const staticDrift = [];
  let staticRef = before.staticDir;
  if (opts.only.includes('contract')) {
    // The contract suite boots AppModule from server/src, whose onApplicationBootstrap() rewrites
    // server/src/public/static/installer-version.json with the same content (exactly like the
    // server `npm run test`). So the stand passes are judged up to here by content AND mtime, and
    // the contract step by content only.
    const mid = dirFingerprint(STATIC_DIR);
    staticDrift.push(...diffFingerprints(STATIC_LABEL, staticRef, mid));
    results.push(await runContract(databaseUrl));
    staticDrift.push(...contentDrift(STATIC_LABEL, mid, dirFingerprint(STATIC_DIR)));
    staticRef = null;
  }

  const after = { db: await dbFingerprint(databaseUrl) };
  if (staticRef) staticDrift.push(...diffFingerprints(STATIC_LABEL, staticRef, dirFingerprint(STATIC_DIR)));
  const drift = [...diffFingerprints('dev DB public schema', before.db, after.db), ...staticDrift];

  process.stderr.write('\n[scenarios] summary\n');
  for (const r of results) process.stderr.write(`  ${r.label.padEnd(10)} ${r.status}\n`);
  if (drift.length) {
    process.stderr.write('[scenarios] FAIL: the run changed state outside the stand (DD C14):\n');
    for (const d of drift) process.stderr.write(`  - ${d}\n`);
  } else {
    process.stderr.write('  dev DB public schema and server/src/public/static unchanged\n');
  }
  return results.some((r) => r.code !== 0) || drift.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`test:scenarios error: ${err.stack || err.message}\n`);
      process.exit(1);
    },
  );
}
