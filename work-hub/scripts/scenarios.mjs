// Work Hub scenario stand (plan D14): `npm run test:scenarios -- --mode a|b|c [--grep <tag>]`
// (from work-hub/).
//
//   1. builds the web (production) and `cargo build --release`;
//   2. builds the default image when missing and the fake-agent image
//      `artisyn-work-hub-fake-agent:test` (tests/fake-agent/);
//   3. creates schema `whs_<mode>_<8 hex>`;
//   4. starts the release server on a free 127.0.0.1 port with
//      WORK_HUB_DEFAULT_IMAGE=artisyn-work-hub-fake-agent:test, WORK_HUB_INSTANCE=whs-<8 hex> and
//      the mode env (a: none/test · b: password-confirm/production + Mailpit · c: password/test);
//   5. waits for GET /health;
//   6. runs Playwright (tests/playwright.config.ts, project mode-<x>, plus --grep);
//   7. cleans up: drops its own schema and removes only the Docker containers, volumes and images
//      labelled with its own instance, then checks that none is left.
//
// While Playwright runs, a control endpoint on 127.0.0.1 (WH_STAND_CONTROL_URL) answers
// `POST /restart-server`: the server process is stopped and started again on the same port with
// the same env, and the call returns after /health answers.
//
// Flags:
//   --mode a|b|c      required
//   --grep <text>     passed to Playwright (e.g. "@S-WH-02")
//   --stand-only      start the stand, wait for /health, stop and clean up (no Playwright)
//   --no-build        skip step 1 (use the existing web/dist and target/release binary)
//
// Env: WORK_HUB_TEST_DATABASE_URL (default postgresql://postgres:pw@localhost:5432/postgres),
// MAILPIT_URL (default http://localhost:8025) and MAILPIT_SMTP (default localhost:1025) — the
// root tests/scenarios/docker-compose.yml provides both. Docker must be running.
//
// The server runs with its working directory in tmp/work-hub-scenarios/run-<hex>/ (no .env
// there or above it, so a developer's work-hub/.env never leaks into the stand) and its data dir
// below it; a stand.json there records the run so that a later run can clean up after a crash.
//
// Unlike the repo's other CLI scripts this one is asynchronous: it must keep the server process
// and the control endpoint alive while Playwright runs. It uses Node built-ins plus `pg` (a
// devDependency of work-hub/, as in Log Hub's scenario runner).
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const WORK_HUB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(WORK_HUB, '..');
const STAND_TMP = path.join(REPO_ROOT, 'tmp', 'work-hub-scenarios');
const isWindows = process.platform === 'win32';

const DEFAULT_DATABASE_URL = 'postgresql://postgres:pw@localhost:5432/postgres';
const DEFAULT_MAILPIT_URL = 'http://localhost:8025';
const DEFAULT_MAILPIT_SMTP = 'localhost:1025';
const FAKE_AGENT_IMAGE = 'artisyn-work-hub-fake-agent:test';
const DEFAULT_IMAGE_NAME = 'artisyn-work-hub-default';
const HEALTH_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 15_000;
const MODES = ['a', 'b', 'c'];
const SCHEMA_RE = /^whs_[abc]_[0-9a-f]{8}$/;
const INSTANCE_RE = /^whs-[0-9a-f]{8}$/;
const EMAIL_DOMAIN = 'arrakis.test';

/** OS variables the server inherits; everything Work Hub reads comes from modeEnv(). */
const PASSTHROUGH_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'LANG', 'TZ',
  'DOCKER_HOST', 'DOCKER_CERT_PATH', 'DOCKER_TLS_VERIFY', 'RUST_LOG', 'RUST_BACKTRACE',
];

function log(text) {
  process.stderr.write(`scenarios: ${text}\n`);
}

function parseArgs(argv) {
  const opts = { mode: null, grep: null, standOnly: false, build: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} requires a value`);
      return v;
    };
    if (a === '--mode') opts.mode = value();
    else if (a.startsWith('--mode=')) opts.mode = a.slice('--mode='.length);
    else if (a === '--grep') opts.grep = value();
    else if (a.startsWith('--grep=')) opts.grep = a.slice('--grep='.length);
    else if (a === '--stand-only') opts.standOnly = true;
    else if (a === '--no-build') opts.build = false;
    else throw new Error(`unknown argument "${a}"`);
  }
  if (!MODES.includes(opts.mode)) throw new Error('--mode a|b|c is required');
  return opts;
}

function readCrateVersion() {
  const text = fs.readFileSync(path.join(WORK_HUB, 'server', 'Cargo.toml'), 'utf8');
  let inPackage = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inPackage = line === '[package]';
      continue;
    }
    const m = inPackage ? /^version\s*=\s*"([^"]+)"/.exec(line) : null;
    if (m) return m[1];
  }
  throw new Error('no [package] version in server/Cargo.toml');
}

/** Runs a command to completion with inherited stdio; throws on a non-zero exit. */
function run(cmd, args, { cwd = WORK_HUB } = {}) {
  log(`$ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with exit code ${r.status}`);
}

/** `docker <args>` → trimmed stdout; throws with stderr on failure. */
function docker(args, { allowFail = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0 && !allowFail) {
    throw new Error(`docker ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  }
  return { ok: r.status === 0, stdout: (r.stdout || '').trim() };
}

function lines(text) {
  return text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function freePort() {
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

function parseHostPort(value) {
  const idx = value.lastIndexOf(':');
  if (idx <= 0) throw new Error(`expected host:port, got "${value}"`);
  return { host: value.slice(0, idx), port: value.slice(idx + 1) };
}

async function withDb(databaseUrl, fn) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------------------------
// Preflight, build and images

async function preflight(opts, databaseUrl, mailpitUrl) {
  if (!docker(['version', '--format', '{{.Server.Version}}'], { allowFail: true }).ok) {
    throw new Error('Docker is not reachable: start Docker and try again');
  }
  try {
    await withDb(databaseUrl, (c) => c.query('SELECT 1'));
  } catch (err) {
    throw new Error(
      `Postgres at ${databaseUrl.replace(/:[^:@/]*@/, ':***@')} is not reachable (${err.message}); ` +
        'start it with: docker compose -f tests/scenarios/docker-compose.yml up -d (from the repo root)',
    );
  }
  if (opts.mode === 'b') {
    let ok = false;
    try {
      const res = await fetch(`${mailpitUrl}/api/v1/info`, { signal: AbortSignal.timeout(2000) });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `Mailpit at ${mailpitUrl} is not reachable (mode b needs it); start it with: ` +
          'docker compose -f tests/scenarios/docker-compose.yml up -d (from the repo root)',
      );
    }
  }
}

function build() {
  // `npm run build:web` chains with `cd … &&` and npm is a .cmd shim on Windows: it needs a
  // shell, so it is passed as one fixed command line (no arguments to concatenate).
  log('$ npm run build:web');
  const web = spawnSync('npm run build:web', { cwd: WORK_HUB, stdio: 'inherit', shell: true });
  if (web.error) throw web.error;
  if (web.status !== 0) throw new Error(`npm run build:web failed with exit code ${web.status}`);
  run('cargo', ['build', '--release', '-p', 'work-hub-server']);
}

function ensureImages(version) {
  const defaultTag = `${DEFAULT_IMAGE_NAME}:${version}`;
  if (!docker(['image', 'inspect', defaultTag], { allowFail: true }).ok) {
    log(`${defaultTag} is missing; building it`);
    run(process.execPath, [path.join(WORK_HUB, 'scripts', 'image.mjs')]);
  }
  run('docker', [
    'build', '--build-arg', `BASE_IMAGE=${defaultTag}`, '-t', FAKE_AGENT_IMAGE,
    path.join(WORK_HUB, 'tests', 'fake-agent'),
  ]);
}

// ---------------------------------------------------------------------------------------------
// Cleanup of one stand's objects (also used for stands left behind by a crashed run)

/** Removes every container, volume and image labelled with `instance`; returns what was left. */
function removeInstanceObjects(instance) {
  if (!INSTANCE_RE.test(instance)) throw new Error(`refusing to clean up unexpected instance "${instance}"`);
  const filters = ['--filter', 'label=artisyn.workhub=1', '--filter', `label=artisyn.workhub.instance=${instance}`];
  const containers = lines(docker(['ps', '-aq', ...filters]).stdout);
  if (containers.length > 0) docker(['rm', '-f', '-v', ...containers], { allowFail: true });
  const volumes = lines(docker(['volume', 'ls', '-q', ...filters]).stdout);
  if (volumes.length > 0) docker(['volume', 'rm', '-f', ...volumes], { allowFail: true });
  const images = [...new Set(lines(docker(['image', 'ls', '-q', ...filters]).stdout))];
  if (images.length > 0) docker(['rmi', '-f', ...images], { allowFail: true });
  return {
    containers: lines(docker(['ps', '-aq', ...filters]).stdout).length,
    volumes: lines(docker(['volume', 'ls', '-q', ...filters]).stdout).length,
    images: lines(docker(['image', 'ls', '-q', ...filters]).stdout).length,
  };
}

async function dropSchema(databaseUrl, schema) {
  if (!SCHEMA_RE.test(schema)) throw new Error(`refusing to drop unexpected schema "${schema}"`);
  return withDb(databaseUrl, async (c) => {
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    const left = await c.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
    return left.rowCount;
  });
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Cleans up stands whose runner process is gone (a crash or a hard kill of an earlier run). */
async function cleanupOrphans(databaseUrl) {
  if (!fs.existsSync(STAND_TMP)) return;
  for (const entry of fs.readdirSync(STAND_TMP, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^run-[0-9a-f]{8}$/.test(entry.name)) continue;
    const dir = path.join(STAND_TMP, entry.name);
    let info;
    try {
      info = JSON.parse(fs.readFileSync(path.join(dir, 'stand.json'), 'utf8'));
    } catch {
      continue;
    }
    if (isAlive(info.runnerPid)) continue;
    log(`cleaning up the stand left by an earlier run (${info.schema}, ${info.instance})`);
    if (isAlive(info.serverPid)) killPid(info.serverPid);
    removeInstanceObjects(info.instance);
    await dropSchema(info.databaseUrl || databaseUrl, info.schema);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function killPid(pid) {
  if (isWindows) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

// ---------------------------------------------------------------------------------------------
// The server process

function modeEnv(mode, { port, mailpitSmtp }) {
  const url = `http://localhost:${port}`;
  // One SESSION_SECRET per run in every mode: sessions must survive POST /restart-server.
  const common = {
    AUTH_RATE_LIMIT_POINTS: '1000',
    ADMIN_CONTACT_EMAIL: `admin@${EMAIL_DOMAIN}`,
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
  };
  if (mode === 'a') return { ...common, AUTH_MODE: 'none', WORK_HUB_ENV: 'test' };
  if (mode === 'c') return { ...common, AUTH_MODE: 'password', WORK_HUB_ENV: 'test' };
  const smtp = parseHostPort(mailpitSmtp);
  return {
    ...common,
    AUTH_MODE: 'password-confirm',
    WORK_HUB_ENV: 'production',
    SMTP_HOST: smtp.host,
    SMTP_PORT: smtp.port,
    SMTP_FROM: `noreply@${EMAIL_DOMAIN}`,
    PUBLIC_BASE_URL: url,
    COOKIE_SECURE: 'false',
  };
}

function serverEnv(stand) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && PASSTHROUGH_ENV.includes(key.toUpperCase())) env[key] = value;
  }
  return {
    ...env,
    HOST: '127.0.0.1',
    PORT: String(stand.port),
    DATABASE_URL: stand.databaseUrl,
    WORK_HUB_DB_SCHEMA: stand.schema,
    WORK_HUB_DATA_DIR: stand.dataDir,
    WORK_HUB_DEFAULT_IMAGE: FAKE_AGENT_IMAGE,
    WORK_HUB_INSTANCE: stand.instance,
    // Served from disk: a new hashed asset in web/dist does not always re-run rust-embed in an
    // incremental release build, and a stale embedded SPA would fail scenarios for no reason.
    WORK_HUB_STATIC_DIR: path.join(WORK_HUB, 'web', 'dist'),
    ...stand.modeEnv,
  };
}

function serverBinary() {
  return path.join(WORK_HUB, 'target', 'release', isWindows ? 'work-hub-server.exe' : 'work-hub-server');
}

function startServer(stand) {
  const logFd = fs.openSync(stand.logFile, 'a');
  fs.writeSync(logFd, `\n--- server start ${new Date().toISOString()} ---\n`);
  const child = spawn(serverBinary(), [], {
    cwd: stand.dir,
    env: serverEnv(stand),
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });
  fs.closeSync(logFd);
  child.on('error', (err) => log(`server failed to start: ${err.message}`));
  stand.server = child;
  stand.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  writeStandInfo(stand);
}

async function stopServer(stand) {
  const child = stand.server;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), STOP_TIMEOUT_MS));
  if ((await Promise.race([stand.exited, timeout])) === 'timeout') {
    killPid(child.pid);
    await stand.exited;
  }
}

async function waitHealth(stand) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stand.server.exitCode !== null) {
      throw new Error(`the server exited with code ${stand.server.exitCode}; see ${stand.logFile}`);
    }
    try {
      const res = await fetch(`${stand.url}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`GET /health did not answer within ${HEALTH_TIMEOUT_MS / 1000}s; see ${stand.logFile}`);
}

function writeStandInfo(stand) {
  const info = {
    runnerPid: process.pid,
    serverPid: stand.server ? stand.server.pid : null,
    mode: stand.mode,
    schema: stand.schema,
    instance: stand.instance,
    databaseUrl: stand.databaseUrl,
    port: stand.port,
  };
  fs.writeFileSync(path.join(stand.dir, 'stand.json'), `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Control endpoint

function startControl(stand) {
  let restarting = Promise.resolve();
  const srv = http.createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'POST' && req.url === '/restart-server') {
      req.resume();
      restarting = restarting.then(async () => {
        try {
          log('restart-server: stopping the server');
          await stopServer(stand);
          startServer(stand);
          await waitHealth(stand);
          log('restart-server: the server is up again');
          reply(200, { ok: true });
        } catch (err) {
          reply(500, { ok: false, error: err.message });
        }
      });
      return;
    }
    reply(404, { ok: false, error: 'not_found' });
  });
  return new Promise((resolve, reject) => {
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      stand.controlUrl = `http://127.0.0.1:${srv.address().port}`;
      resolve(srv);
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Playwright

function runPlaywright(stand, opts, mailpitUrl) {
  const cli = path.join(WORK_HUB, 'node_modules', '@playwright', 'test', 'cli.js');
  if (!fs.existsSync(cli)) throw new Error('@playwright/test is not installed: run "npm install" in work-hub/');
  const args = [cli, 'test', '--config', path.join(WORK_HUB, 'tests', 'playwright.config.ts'), '--project', `mode-${opts.mode}`];
  if (opts.grep) args.push('--grep', opts.grep);
  log(`$ playwright ${args.slice(2).join(' ')}`);
  const child = spawn(process.execPath, args, {
    cwd: WORK_HUB,
    stdio: 'inherit',
    env: {
      ...process.env,
      WH_STAND_URL: stand.url,
      WH_STAND_CONTROL_URL: stand.controlUrl,
      WH_STAND_MODE: stand.mode,
      WH_STAND_INSTANCE: stand.instance,
      WH_STAND_SCHEMA: stand.schema,
      WH_STAND_DATABASE_URL: stand.databaseUrl,
      WH_STAND_DATA_DIR: path.resolve(stand.dataDir),
      MAILPIT_URL: mailpitUrl,
    },
  });
  stand.playwright = child;
  return new Promise((resolve) => {
    child.on('error', (err) => {
      log(`playwright failed to start: ${err.message}`);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code === null ? 1 : code));
  });
}

// ---------------------------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.WORK_HUB_TEST_DATABASE_URL || DEFAULT_DATABASE_URL;
  const mailpitUrl = (process.env.MAILPIT_URL || DEFAULT_MAILPIT_URL).replace(/\/+$/, '');
  const mailpitSmtp = process.env.MAILPIT_SMTP || DEFAULT_MAILPIT_SMTP;

  await preflight(opts, databaseUrl, mailpitUrl);
  await cleanupOrphans(databaseUrl);
  if (opts.build) build();
  if (!fs.existsSync(serverBinary())) throw new Error(`${serverBinary()} not found: run without --no-build`);
  if (!fs.existsSync(path.join(WORK_HUB, 'web', 'dist', 'index.html'))) {
    throw new Error('web/dist is not built: run without --no-build');
  }
  ensureImages(readCrateVersion());

  const hex = crypto.randomBytes(4).toString('hex');
  const port = await freePort();
  const dir = path.join(STAND_TMP, `run-${hex}`);
  const stand = {
    mode: opts.mode,
    schema: `whs_${opts.mode}_${hex}`,
    instance: `whs-${hex}`,
    databaseUrl,
    port,
    url: `http://localhost:${port}`,
    dir,
    dataDir: path.join(dir, 'data'),
    logFile: path.join(dir, 'server.log'),
    modeEnv: modeEnv(opts.mode, { port, mailpitSmtp }),
    server: null,
    playwright: null,
    controlUrl: null,
  };
  fs.mkdirSync(stand.dataDir, { recursive: true });
  writeStandInfo(stand);

  let control = null;
  let cleaned = false;
  let exitCode = 1;
  const cleanup = async () => {
    if (cleaned) return true;
    cleaned = true;
    if (stand.playwright && stand.playwright.exitCode === null) killPid(stand.playwright.pid);
    if (control) control.close();
    await stopServer(stand);
    const left = removeInstanceObjects(stand.instance);
    const schemaLeft = await dropSchema(databaseUrl, stand.schema);
    const clean = left.containers + left.volumes + left.images + schemaLeft === 0;
    log(
      `cleanup: schema ${stand.schema} ${schemaLeft ? 'STILL EXISTS' : 'dropped'}; ` +
        `left with instance ${stand.instance}: ${left.containers} containers, ${left.volumes} volumes, ${left.images} images`,
    );
    fs.rmSync(stand.dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(stand.dir, 'stand.json'), { force: true });
    if (exitCode === 0) fs.rmSync(stand.dir, { recursive: true, force: true });
    else log(`server log kept: ${stand.logFile}`);
    return clean;
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      log(`${sig} received; cleaning up`);
      exitCode = 130;
      cleanup().finally(() => process.exit(130));
    });
  }

  try {
    await withDb(databaseUrl, (c) => c.query(`CREATE SCHEMA "${stand.schema}"`));
    log(`mode ${opts.mode}: schema ${stand.schema}, instance ${stand.instance}, ${stand.url}`);
    startServer(stand);
    await waitHealth(stand);
    log(`the stand is up at ${stand.url}`);
    if (opts.standOnly) {
      exitCode = 0;
    } else {
      control = await startControl(stand);
      log(`control endpoint: ${stand.controlUrl}`);
      exitCode = await runPlaywright(stand, opts, mailpitUrl);
    }
  } catch (err) {
    log(`error: ${err.message}`);
    exitCode = 1;
  }
  const clean = await cleanup();
  if (!clean && exitCode === 0) exitCode = 1;
  return exitCode;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`error: ${err.message}`);
    process.exit(1);
  },
);
