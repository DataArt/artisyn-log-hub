#!/usr/bin/env node
// Warm scenario stand for iterations, `npm run test:scenarios -- --dev ...` (the final run keeps the
// built stand of build-stand.mjs).
//
// A long-running supervisor that keeps an unbundled build of the app up to date from the sources:
//   - server: `tsc --watch` of server/tsconfig.build.json into server/dist-scn — a sibling of the
//     dev server's server/dist, so every `__dirname`-relative path the server resolves
//     (../../drizzle/migrations, ../../hook, ../public/static) works exactly as in `start:dev`;
//   - client: `vite build --watch` into server/dist-scn/public (served by ServeStaticModule), then
//     precompress after every build; the in-app help is generated once at start;
//   - installer: build-hooks-installer.js --static-dir server/dist-scn/public/static at start and
//     again whenever hook/.claude/telemetry_tool or artisyn-hooks-installer/src changes;
//   - build.origin.json next to build-info.js (officialRelease: true, like the built stand).
// The state of each part goes to tmp/scenarios/dev-stand/status.json; the runner waits on it and
// then starts a stand from server/dist-scn/main.js per pass (fresh schema, like the built stand).
//
// Usage: node scripts/scenarios/dev-stand.mjs            run the supervisor (foreground)
//        node scripts/scenarios/dev-stand.mjs --stop     stop a running supervisor
//        node scripts/scenarios/dev-stand.mjs --status   print status.json
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { killTree } from '../../.claude/skills/big-prod-e2e-test/scripts/lib/proc.mjs';
import { ROOT, SCENARIOS_TMP } from './build-stand.mjs';

const require = createRequire(import.meta.url);

export const DEV_STAND_DIR = path.join(SCENARIOS_TMP, 'dev-stand');
export const DEV_STATUS_FILE = path.join(DEV_STAND_DIR, 'status.json');
export const DEV_LOG_FILE = path.join(DEV_STAND_DIR, 'supervisor.log');
/** The unbundled server build; must sit directly under server/ (see the header). */
export const DEV_OUT_DIR = path.join(ROOT, 'server', 'dist-scn');
export const DEV_ENTRY = 'main.js';
export const DEV_PARTS = ['server', 'client', 'installer'];

/** Inputs per part, for the runner's "is this build newer than my last edit?" check. */
export const DEV_PART_INPUTS = {
  server: [path.join(ROOT, 'server', 'src')],
  client: [path.join(ROOT, 'client', 'src'), path.join(ROOT, 'client', 'index.html')],
  installer: [path.join(ROOT, 'hook', '.claude', 'telemetry_tool'), path.join(ROOT, 'artisyn-hooks-installer', 'src')],
};

const PUBLIC_DIR = path.join(DEV_OUT_DIR, 'public');
const STATIC_DIR = path.join(PUBLIC_DIR, 'static');

export function readDevStatus(file = DEV_STATUS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The running supervisor's status, or null when none runs. */
export function liveDevStatus() {
  const status = readDevStatus();
  return status && isPidAlive(status.pid) ? status : null;
}

// ---------------------------------------------------------------------------------------------
// supervisor

const status = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  outDir: DEV_OUT_DIR,
  parts: Object.fromEntries(DEV_PARTS.map((p) => [p, { state: 'starting', buildStartedAt: null, builtAt: null, errors: 0, message: null }])),
};

function writeStatus() {
  fs.mkdirSync(DEV_STAND_DIR, { recursive: true });
  const tmp = `${DEV_STATUS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(status, null, 2), 'utf8');
  fs.renameSync(tmp, DEV_STATUS_FILE);
}

function log(line) {
  process.stderr.write(`[dev-stand] ${line}\n`);
}

function setPart(part, patch) {
  Object.assign(status.parts[part], patch);
  writeStatus();
  log(`${part}: ${status.parts[part].state}${patch.message ? ` — ${patch.message}` : ''}`);
}

const children = new Set();

/** Spawns a long-running child; every complete stdout/stderr line goes to `onLine`. */
function spawnWatched(label, args, cwd, onLine) {
  const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        process.stderr.write(`[${label}] ${line}\n`);
        onLine(line);
      }
    });
  }
  child.on('exit', (code, signal) => {
    children.delete(child);
    log(`${label} exited (${code ?? signal}) — stopping the supervisor`);
    shutdown(1);
  });
  return child;
}

function runOnce(label, args, cwd) {
  const res = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (res.stdout) process.stderr.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) throw new Error(`${label}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${label}: exited with ${res.status ?? res.signal}`);
}

function startServerWatch() {
  const tsc = path.join(ROOT, 'server', 'node_modules', 'typescript', 'bin', 'tsc');
  const args = [
    tsc, '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput',
    '--outDir', DEV_OUT_DIR,
    '--declaration', 'false',
    '--tsBuildInfoFile', path.join(ROOT, 'tmp', '.tsbuildinfo-dev-stand'),
  ];
  spawnWatched('tsc', args, path.join(ROOT, 'server'), (line) => {
    if (/Starting (incremental )?compilation|File change detected/.test(line)) {
      setPart('server', { state: 'building', buildStartedAt: new Date().toISOString() });
      return;
    }
    const found = /Found (\d+) errors?\. Watching for file changes/.exec(line);
    if (found) {
      const errors = Number(found[1]);
      setPart('server', {
        state: 'ready',
        builtAt: new Date().toISOString(),
        errors,
        message: errors ? `${errors} type error(s) — the output is still emitted, see supervisor.log` : null,
      });
    }
  });
}

function startClientWatch() {
  runOnce('generate help', [path.join(ROOT, 'scripts', 'user-docs', 'generate-help.js')], ROOT);
  // Clean the client output once, keeping the installer's static/. The outDir is outside client/,
  // so vite does not empty it itself (its default for an outside outDir) and static/ survives.
  if (fs.existsSync(PUBLIC_DIR)) {
    for (const entry of fs.readdirSync(PUBLIC_DIR)) {
      if (entry !== 'static') fs.rmSync(path.join(PUBLIC_DIR, entry), { recursive: true, force: true });
    }
  }
  const clientDir = path.join(ROOT, 'client');
  const vite = path.join(clientDir, 'node_modules', 'vite', 'bin', 'vite.js');
  const precompress = path.join(clientDir, 'scripts', 'precompress.cjs');
  spawnWatched('vite', [vite, 'build', '--watch', '--outDir', PUBLIC_DIR], clientDir, (line) => {
    if (/build started/i.test(line)) {
      setPart('client', { state: 'building', buildStartedAt: new Date().toISOString() });
      return;
    }
    if (/built in \d/i.test(line)) {
      try {
        runOnce('precompress', [precompress, PUBLIC_DIR], ROOT);
        setPart('client', { state: 'ready', builtAt: new Date().toISOString(), errors: 0, message: null });
      } catch (err) {
        setPart('client', { state: 'failed', message: err.message });
      }
      return;
    }
    if (/error during build|\[vite\].*error/i.test(line)) setPart('client', { state: 'failed', message: line.trim() });
  });
}

function buildInstaller() {
  setPart('installer', { state: 'building', buildStartedAt: new Date().toISOString() });
  try {
    runOnce('build-hooks-installer', [path.join(ROOT, 'scripts', 'build-hooks-installer.js'), '--static-dir', STATIC_DIR], ROOT);
    setPart('installer', { state: 'ready', builtAt: new Date().toISOString(), errors: 0, message: null });
  } catch (err) {
    setPart('installer', { state: 'failed', message: err.message });
  }
}

function watchInstallerInputs() {
  let timer = null;
  const trigger = () => {
    clearTimeout(timer);
    // Mark it stale at once, so a runner started right after an edit waits for the rebuild.
    status.parts.installer.state = 'building';
    writeStatus();
    timer = setTimeout(buildInstaller, 500);
  };
  for (const dir of DEV_PART_INPUTS.installer) {
    fs.watch(dir, { recursive: true }, (event, name) => {
      if (name && /node_modules|__tests__/.test(String(name))) return;
      trigger();
    });
  }
}

function writeOrigin() {
  require(path.join(ROOT, 'scripts', 'build-origin.js')).writeBuildOrigin(path.join(DEV_OUT_DIR, 'common'), {
    branch: 'scenario-dev-stand',
    officialRelease: true,
  });
}

let stopping = false;
function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) killTree(child.pid);
  try {
    const current = readDevStatus();
    if (current && current.pid === process.pid) fs.rmSync(DEV_STATUS_FILE, { force: true });
  } catch {
    // best effort
  }
  process.exit(code);
}

function runSupervisor() {
  const running = liveDevStatus();
  if (running && running.pid !== process.pid) {
    log(`already running (pid ${running.pid}); status in ${DEV_STATUS_FILE}`);
    process.exit(0);
  }
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  writeStatus();
  process.on('SIGINT', () => shutdown(130));
  process.on('SIGTERM', () => shutdown(143));
  writeOrigin();
  buildInstaller();
  watchInstallerInputs();
  startServerWatch();
  startClientWatch();
  log(`running (pid ${process.pid}); out ${DEV_OUT_DIR}; stop with: node scripts/scenarios/dev-stand.mjs --stop`);
}

function stopSupervisor() {
  const running = liveDevStatus();
  if (!running) {
    process.stderr.write('[dev-stand] not running\n');
    return 0;
  }
  killTree(running.pid);
  fs.rmSync(DEV_STATUS_FILE, { force: true });
  process.stderr.write(`[dev-stand] stopped (pid ${running.pid})\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    if (args.includes('--stop')) process.exit(stopSupervisor());
    else if (args.includes('--status')) {
      const s = liveDevStatus();
      process.stdout.write(`${s ? JSON.stringify(s, null, 2) : 'not running'}\n`);
      process.exit(0);
    } else runSupervisor();
  } catch (err) {
    process.stderr.write(`dev-stand error: ${err.message}\n`);
    shutdown(1);
  }
}
