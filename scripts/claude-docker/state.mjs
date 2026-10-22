// Sandbox state files, the launcher lock and port-slot allocation (DD-4).
// state.json lives at <worktreesDir>/.sandboxes/<name>/state.json and is always written atomically
// (tmp file + rename). The lock file <worktreesDir>/.sandboxes/.lock is created with 'wx' and holds
// {pid, at}; a lock older than the stale threshold is reported, never deleted automatically.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  MAX_SLOTS,
  TIMING,
  isStrictlyInside,
  portsForSlot,
  resolvePaths,
  sandboxStateDir,
  stateFilePath,
  validateName,
} from './config.mjs';

/** Reads a sandbox's state, or null when there is no state file. Throws on unparsable JSON. */
export function readState(name, paths = resolvePaths()) {
  const file = stateFilePath(name, paths);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`state file ${file} is not valid JSON: ${err.message}`);
  }
}

/** Writes a sandbox's state atomically: a tmp file next to it, then a rename over the target. */
export function writeState(state, paths = resolvePaths()) {
  if (!state || typeof state.name !== 'string') throw new Error('writeState: state.name is required');
  const dir = sandboxStateDir(state.name, paths);
  fs.mkdirSync(dir, { recursive: true });
  const file = stateFilePath(state.name, paths);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return state;
}

/**
 * Deletes a sandbox's state dir; tolerant of it being gone. sandboxStateDir() validates the name,
 * and the dir must be a direct child of the state dir, so nothing else can ever be removed here.
 */
export function deleteState(name, paths = resolvePaths()) {
  const dir = sandboxStateDir(name, paths);
  if (!isStrictlyInside(dir, paths.stateDir) || path.dirname(path.resolve(dir)) !== path.resolve(paths.stateDir)) {
    throw new Error(`refusing to delete ${dir}: not a sandbox state dir under ${paths.stateDir}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Names of all sandbox dirs under the state dir that hold a state.json (invalid names skipped). */
export function listStateNames(paths = resolvePaths()) {
  let entries;
  try {
    entries = fs.readdirSync(paths.stateDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && validateName(e.name) === null)
    .filter((e) => fs.existsSync(path.join(paths.stateDir, e.name, 'state.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * All readable states, sorted by name. A state file that cannot be parsed is reported on stderr
 * and skipped so one broken file never blocks the other sandboxes.
 */
export function listStates(paths = resolvePaths()) {
  const out = [];
  for (const name of listStateNames(paths)) {
    try {
      const s = readState(name, paths);
      if (s) out.push(s);
    } catch (err) {
      process.stderr.write(`warning: ${err.message}\n`);
    }
  }
  return out;
}

/** Bumps lastActivity to now and writes the state back; tolerant of the state being gone. */
export function touchActivity(name, paths = resolvePaths(), now = new Date()) {
  const s = readState(name, paths);
  if (!s) return null;
  s.lastActivity = now.toISOString();
  return writeState(s, paths);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeLock(lockFile) {
  try {
    const st = fs.statSync(lockFile);
    let holder = '';
    try {
      const info = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      holder = ` (pid ${info.pid}, since ${info.at})`;
    } catch {
      /* unreadable content: the age from mtime still applies */
    }
    return { ageMs: Date.now() - st.mtimeMs, holder };
  } catch {
    return null;
  }
}

/**
 * Runs fn() while holding the launcher lock. Retries every 200 ms for up to 30 s; a lock older
 * than 10 min is reported with its path (never auto-deleted). The lock is always released.
 */
export async function withLock(fn, paths = resolvePaths()) {
  const lockFile = paths.lockFile;
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + TIMING.lockGiveUpMs;
  let reportedStale = false;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const info = describeLock(lockFile);
    if (info && info.ageMs > TIMING.lockStaleReportMs && !reportedStale) {
      reportedStale = true;
      process.stderr.write(
        `warning: the launcher lock ${lockFile}${info.holder} is ${Math.round(info.ageMs / 60_000)} min old. ` +
          'If no other claude-docker command is running, delete that file by hand.\n',
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `could not take the launcher lock ${lockFile}${info?.holder ?? ''} within ${TIMING.lockGiveUpMs / 1000} s; ` +
          'another claude-docker command is running, or the file is left over from a crashed one (delete it by hand)',
      );
    }
    await sleep(TIMING.lockRetryMs);
  }
  try {
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

/** Resolves true when 127.0.0.1:<port> can be bound right now. */
export function probePort(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host, exclusive: true }, () => {
      srv.close(() => resolve(true));
    });
  });
}

/** Resolves the list of the slot's ports that cannot be bound (empty when all are free). */
export async function unbindablePorts(ports) {
  const busy = [];
  for (const port of Object.values(ports)) {
    if (!(await probePort(port))) busy.push(port);
  }
  return busy;
}

/**
 * Picks the lowest slot that no state claims and whose three ports all bind on 127.0.0.1.
 * Call it under withLock. Resolves { slot, ports }.
 */
export async function allocateSlot(states) {
  const claimed = new Set(
    (states || []).map((s) => s?.slot).filter((n) => Number.isInteger(n)),
  );
  for (let slot = 0; slot < MAX_SLOTS; slot++) {
    if (claimed.has(slot)) continue;
    const ports = portsForSlot(slot);
    if ((await unbindablePorts(ports)).length === 0) return { slot, ports };
  }
  throw new Error(`no free port slot among the first ${MAX_SLOTS}; remove unused sandboxes or free ports`);
}
