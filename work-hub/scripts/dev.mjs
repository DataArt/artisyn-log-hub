// Inline development mode (plan D15): runs the Work Hub server (`cargo run`, port 3100, reading
// work-hub/.env) and the Vite dev server (port 5180, /api proxied to 3100) side by side.
// Usage: npm run dev (from work-hub/). Open http://localhost:5180.
//
// Ctrl+C (SIGINT), SIGTERM or SIGHUP stops both; when either child exits on its own, the other one
// is stopped too and this script exits with the first child's exit code.
//
// The file is .mjs because work-hub/package.json is "type": "module". Unlike the other scripts it
// cannot be synchronous: two long-running children have to run at the same time, so it uses
// `spawn` with exit handlers. Only Node built-ins are used.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workHubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

/** @type {{ name: string, child: import('node:child_process').ChildProcess }[]} */
const children = [];
let stopping = false;
let exitCode = 0;

function log(text) {
  process.stderr.write(`dev: ${text}\n`);
}

/** Kills a child and its whole process tree (cargo → server, bun → vite). */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (isWindows) {
    // process.kill on Windows ends only the direct child; taskkill /T also ends its descendants.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    // Children are started detached, each in its own process group: a negative pid signals the group.
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function stopAll(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const { child } of children) killTree(child);
}

function start(name, command, args, cwd) {
  log(`starting ${name}: ${command} ${args.join(' ')} (in ${path.relative(workHubDir, cwd) || '.'})`);
  const child = spawn(command, args, {
    cwd,
    stdio: 'inherit',
    // POSIX: own process group so the whole tree can be signalled. Windows: no console of its own.
    detached: !isWindows,
    windowsHide: true,
  });
  child.on('error', (err) => {
    log(`${name} failed to start: ${err.message}`);
    stopAll(1);
  });
  child.on('exit', (code, signal) => {
    if (!stopping) {
      log(`${name} exited (${signal ?? `code ${code}`}); stopping the rest`);
      stopAll(code === null || code === 0 ? 1 : code);
    }
    if (children.every((c) => c.child.exitCode !== null || c.child.signalCode !== null)) {
      process.exit(exitCode);
    }
  });
  children.push({ name, child });
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    log(`${sig} received; stopping`);
    stopAll(0);
  });
}

try {
  // The web side runs Vite's own CLI under this Node (`bun run dev` would do the same): no shell
  // is needed, and it also works where `bun` is only an npm .cmd shim on Windows, which spawn
  // cannot start without a shell.
  const webDir = path.join(workHubDir, 'web');
  const viteCli = path.join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteCli)) {
    throw new Error(`${path.relative(workHubDir, viteCli)} not found: run "bun install" in web/ first`);
  }
  start('server', 'cargo', ['run', '-p', 'work-hub-server'], workHubDir);
  start('web', process.execPath, [viteCli], webDir);
  log('open http://localhost:5180 (Vite; /api is proxied to the server on 3100)');
} catch (err) {
  log(`error: ${err.message}`);
  stopAll(1);
  process.exit(1);
}
