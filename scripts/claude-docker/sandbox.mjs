// Sandbox lifecycle for the launcher (DD-16): create-or-start, wait for the in-container markers,
// open a Claude session or a shell, stop, list and remove. Phase 2: shared Postgres infra, two
// per-sandbox DBs, a 127.0.0.1 port slot and the provisioning readiness wait; state `v: 2`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  MARKERS,
  CONTAINER_USER,
  STATE_VERSION,
  TIMING,
  assertOwnWorktree,
  containerName,
  containerPaths,
  dbNames,
  protectedBranchError,
  readyTimeoutS,
  resolvePaths,
  setupTimeoutS,
  staleAfterMs,
  validateName,
  volumeNames,
  worktreePath,
} from './config.mjs';
import {
  assertDocker,
  containerLogsTail,
  containerRemove,
  containerStart,
  containerStartedAtMs,
  containerState,
  containerStop,
  dbExists,
  dbSize,
  docker,
  dropDb,
  ensureDb,
  ensureImage,
  ensureInfra,
  liveSessions,
  postgresReady,
  publishedHostPorts,
  runContainer,
  stopDevStack,
  volumeExists,
  volumeRemove,
  warnIfStaleImage,
} from './docker.mjs';
import {
  addWorktree,
  assertGitVersion,
  branchExists,
  currentBranch,
  deleteBranch as deleteGitBranch,
  isLocalBranch,
  isMerged,
  missingIdentityKeys,
  pendingWork,
  removeWorktree,
  worktreePrune,
} from './git.mjs';
import {
  allocateSlot,
  deleteState,
  listStates,
  probePort,
  readState,
  touchActivity,
  withLock,
  writeState,
} from './state.mjs';

/** The state version this launcher writes and runs (Phase 2). A `v: 1` (PoC) state is refused (DD-1). */
export const PHASE = STATE_VERSION;

/** The generated worktree `server/.env` (DD-16); DATABASE_URL comes from the container env. */
const SERVER_ENV_TEXT = 'AUTH_MODE=none\nCOOKIE_SECURE=false\nPORT=3000\n';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error whose message is shown to the user as is (no stack), with an exit code. */
export class LauncherError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function flagsText(branch, from) {
  const parts = [`--branch ${branch}`];
  if (from) parts.push(`--from ${from}`);
  return parts.join(' ');
}

/**
 * The FR-W7 re-launch rules for an existing state (DD-16 table), checked under the lock before
 * any change. Returns the notes to print; throws a LauncherError on a mismatch.
 */
function checkRelaunch(name, state, opts) {
  const notes = [];
  if (state.v !== PHASE) {
    throw new LauncherError(
      `${name} has a v${state.v} state file that this launcher (v${PHASE}) cannot run; ` +
        `run --remove ${name} and create it again`,
    );
  }
  const branchDiffers = opts.branch !== undefined && opts.branch !== state.branch;
  const fromDiffers = opts.from !== undefined && opts.from !== (state.from ?? undefined);
  if (branchDiffers || fromDiffers) {
    throw new LauncherError(
      `${name} was created with ${flagsText(state.branch, state.from)}; drop the flags or use another name`,
    );
  }
  if (opts.branch !== undefined || opts.from !== undefined) {
    notes.push(`note: ${[opts.branch !== undefined && '--branch', opts.from !== undefined && '--from'].filter(Boolean).join('/')} ignored: matches state`);
  }
  return notes;
}

/**
 * Creates the worktree and the state for a new sandbox (DD-5 base, DD-4 fields). `slot` is the
 * { slot, ports } chosen by allocateSlot() under the same lock.
 */
function createSandbox(name, opts, slot, paths) {
  const branch = opts.branch ?? name;
  const create = !branchExists(branch);
  if (!create && opts.from !== undefined) {
    throw new LauncherError(`branch ${branch} already exists; --from applies only to a new branch`);
  }
  let base = null;
  if (create) {
    if (opts.from !== undefined) base = isLocalBranch(opts.from) ? opts.from.replace(/^refs\/heads\//, '') : null;
    else base = currentBranch(paths.repoRoot);
  }
  const wt = worktreePath(name, paths);
  let createdFrom;
  try {
    ({ createdFrom } = addWorktree({ wt, branch, from: opts.from, create }));
  } catch (err) {
    if (err.gitRefusal) throw new LauncherError(err.message);
    throw err;
  }
  const now = new Date().toISOString();
  const state = {
    v: PHASE,
    name,
    branch,
    branchCreated: create,
    base,
    from: opts.from ?? null,
    createdFrom,
    slot: slot.slot,
    ports: { ...slot.ports },
    worktree: wt,
    createdAt: now,
    lastActivity: now,
  };
  // Written right after the worktree so a later failure (DB, image) leaves a sandbox that a
  // re-launch resumes instead of a "worktree without state".
  writeState(state, paths);
  process.stdout.write(
    `created sandbox ${name}: ${create ? 'new' : 'existing'} branch ${branch}` +
      `${base ? ` (base ${base})` : ''}, worktree ${wt}, port slot ${slot.slot}\n`,
  );
  return state;
}

/** Writes the worktree's git-ignored `server/.env` (DD-16) unless it already exists. */
function ensureServerEnv(worktree) {
  const file = path.join(worktree, 'server', '.env');
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, SERVER_ENV_TEXT, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`wrote ${file}\n`);
  return true;
}

/** Creates both sandbox databases when they are missing (idempotent). */
function ensureSandboxDbs(name) {
  for (const db of dbNames(name)) {
    if (ensureDb(db).created) process.stdout.write(`created database ${db}\n`);
  }
}

/**
 * FR-W7 "kept port not bindable": before (re)starting an existing sandbox, every host port of its
 * state must be bindable on 127.0.0.1 or already published by this very container. Fails naming
 * the port(s); never re-allocates.
 */
async function assertKeptPortsUsable(state) {
  const published = publishedHostPorts(state.name);
  const blocked = [];
  for (const [key, port] of Object.entries(state.ports || {})) {
    if (published.has(port)) continue;
    if (!(await probePort(port))) blocked.push(`${key} ${port}`);
  }
  if (blocked.length > 0) {
    throw new LauncherError(
      `${state.name} keeps host port${blocked.length === 1 ? '' : 's'} ${blocked.join(', ')} (127.0.0.1), ` +
        `which ${blocked.length === 1 ? 'is' : 'are'} in use by another process; free ${blocked.length === 1 ? 'it' : 'them'} ` +
        'and retry (ports are never re-allocated)',
    );
  }
}

/**
 * Refuses (before anything is created or started) a sandbox whose branch is listed in
 * .claude/claude-isolation.json: a new one asked to use it, or an existing one already on it.
 */
function assertBranchAllowed(name, branch, paths) {
  let err;
  try {
    err = protectedBranchError(branch, paths);
  } catch (e) {
    throw new LauncherError(e.message);
  }
  if (err) throw new LauncherError(`refusing to start ${name}: ${err}`);
}

/** Common prerequisites of every command that starts a container. */
export function checkPrerequisites() {
  assertGitVersion();
  assertDocker();
}

/**
 * DD-16 steps 1-7: prerequisites, name; under the lock the shared infra (compose up + pg_isready),
 * the re-launch rules, worktree creation, the worktree `server/.env`, both DBs, the port slot and
 * the v2 state; then the image, `docker run`/`docker start`/nothing (kept ports checked first), the
 * entrypoint marker and the provisioning readiness wait (non-fatal on timeout).
 * opts: { branch, from }. Resolves the sandbox state.
 */
export async function createOrStart(name, opts = {}, paths = resolvePaths()) {
  checkPrerequisites();
  const nameError = validateName(name);
  if (nameError) throw new LauncherError(`invalid sandbox name "${name}": ${nameError}`, 2);
  const missing = missingIdentityKeys();
  if (missing.length > 0) {
    throw new LauncherError(
      `host git ${missing.join(' and ')} is empty; set it with: git config --global ${missing[0]} "…"`,
    );
  }
  assertBranchAllowed(name, readState(name, paths)?.branch ?? opts.branch ?? name, paths);

  const state = await withLock(async () => {
    const existing = readState(name, paths);
    const wtExists = fs.existsSync(worktreePath(name, paths));
    if (existing && !wtExists) {
      throw new LauncherError(`worktree missing; run --remove ${name} or --prune`);
    }
    if (!existing && wtExists) {
      throw new LauncherError(`worktree without state; run --remove ${name} or --prune`);
    }
    let s;
    if (existing) {
      for (const note of checkRelaunch(name, existing, opts)) process.stdout.write(`${note}\n`);
      s = existing;
    }
    process.stdout.write('checking shared infra (log-hub-postgres)…\n');
    try {
      await ensureInfra(paths);
    } catch (err) {
      throw new LauncherError(err.message);
    }
    if (!s) {
      const slot = await allocateSlot(listStates(paths));
      s = createSandbox(name, opts, slot, paths);
    }
    ensureServerEnv(s.worktree || worktreePath(name, paths));
    ensureSandboxDbs(name);
    return s;
  }, paths);

  ensureImage({ rebuild: false }, paths);
  warnIfStaleImage(name, paths);

  const cs = containerState(name);
  if (cs !== 'running') await assertKeptPortsUsable(state);
  if (cs === 'missing') {
    process.stdout.write(`starting container ${containerName(name)}…\n`);
    runContainer(state, PHASE, paths);
  } else if (cs === 'stopped') {
    process.stdout.write(`starting stopped container ${containerName(name)}…\n`);
    containerStart(name);
  }
  await waitForMarker(name, MARKERS.entrypointDone, setupTimeoutS());
  await waitForReadiness(name);
  return state;
}

/**
 * After entrypoint-done: waits for /run/dev/provisioned up to CLAUDE_DOCKER_READY_TIMEOUT_S. On a
 * timeout it prints `devctl status`, the `devctl logs` hint and a telemetry warning, and returns
 * false so the session still opens. Resolves true when provisioned.
 */
export async function waitForReadiness(name) {
  const timeoutS = readyTimeoutS();
  const ready = await waitForMarker(name, MARKERS.provisioned, timeoutS, { failOnTimeout: false });
  if (ready) return true;
  const c = containerName(name);
  const status = docker(['exec', '-u', CONTAINER_USER, c, 'devctl', 'status', 'all'], { allowFail: true });
  const text = `${status.stdout}${status.stderr}`.trim();
  process.stderr.write(
    `warning: ${c} is not provisioned after ${timeoutS} s (${MARKERS.provisioned} is missing).\n` +
      `devctl status:\n${text ? text.replace(/^/gm, '  ') : '  (no output)'}\n` +
      `hint: inspect the services with devctl logs <server|client> (inside the sandbox; Ctrl+C to leave)\n` +
      'warning: telemetry upload is off until provisioning completes; the session opens anyway.\n',
  );
  return false;
}

/** The sandbox's host URLs from its state ports, or null when the state has no ports. */
export function sandboxUrls(state) {
  const p = state?.ports;
  if (!p) return null;
  return {
    app: `http://localhost:${p.client}`,
    api: `http://localhost:${p.server}`,
    mailpit: `http://localhost:${p.mailpit}`,
  };
}

/** Prints `app … · api … · mailpit …` for the sandbox (nothing when the state has no ports). */
export function printUrls(name, paths = resolvePaths()) {
  const urls = sandboxUrls(readState(name, paths));
  if (!urls) return;
  process.stdout.write(`${name}: app ${urls.app} · api ${urls.api} · mailpit ${urls.mailpit}\n`);
}

// ---------------------------------------------------------------------------------------------
// --serve, --reset (Phase 2, CLI only)
// ---------------------------------------------------------------------------------------------

/**
 * `--serve <name>`: createOrStart without a session (creates the sandbox when it does not exist
 * yet), waits for the markers like a session launch and prints the URLs. Returns the exit code.
 */
export async function serve(name, paths = resolvePaths()) {
  await createOrStart(name, {}, paths);
  printUrls(name, paths);
  process.stdout.write(
    `${containerName(name)} is serving; open Claude with: scripts/claude-docker.ps1 ${name} · ` +
      `stop it with: scripts/claude-docker.ps1 --stop ${name}\n`,
  );
  return 0;
}

/**
 * `--reset <name>`: refuses while Claude sessions are live; rebuilds the image (`docker build`
 * with the layer cache), then `docker rm -f` and `docker run` again from the kept state. The
 * volumes (node_modules, plugins), both DBs, the worktree and the port slot are kept. Waits for
 * the markers and prints the URLs. Returns the exit code.
 */
export async function reset(name, paths = resolvePaths()) {
  assertValidName(name);
  checkPrerequisites();
  const state = readState(name, paths);
  if (!state) {
    throw new LauncherError(`no sandbox named ${name}; create it with: scripts/claude-docker.ps1 ${name}`);
  }
  if (state.v !== PHASE) {
    throw new LauncherError(
      `${name} has a v${state.v} state file that this launcher (v${PHASE}) cannot run; ` +
        `run --remove ${name} and create it again`,
    );
  }
  if (!fs.existsSync(worktreePath(name, paths))) {
    throw new LauncherError(`worktree missing; run --remove ${name} or --prune`);
  }
  assertBranchAllowed(name, state.branch, paths);
  const sessions = liveSessions(name);
  if (sessions > 0) {
    throw new LauncherError(
      `${name} has ${plural(sessions, 'live Claude session')}; close ${sessions === 1 ? 'it' : 'them'} ` +
        `(or run --stop ${name} --force) before --reset`,
    );
  }
  process.stdout.write('checking shared infra (log-hub-postgres)…\n');
  try {
    await ensureInfra(paths);
  } catch (err) {
    throw new LauncherError(err.message);
  }
  // Built before the container is removed, so a failing build leaves the sandbox as it was.
  ensureImage({ rebuild: true }, paths);
  const c = containerName(name);
  if (containerState(name) !== 'missing') {
    process.stdout.write(`removing ${c} (volumes, databases and worktree are kept)…\n`);
    stopDevStack(name);
    containerRemove(name);
  }
  await assertKeptPortsUsable(state);
  process.stdout.write(`starting container ${c}…\n`);
  runContainer(state, PHASE, paths);
  await waitForMarker(name, MARKERS.entrypointDone, setupTimeoutS());
  await waitForReadiness(name);
  printUrls(name, paths);
  process.stdout.write(`reset ${name}\n`);
  return 0;
}

/**
 * Polls `stat -c %Y <marker>` in the container once per second, printing one progress line per
 * second, until it exists and is not older than the container's current run. Throws when the container stops. After timeoutS seconds it throws, or
 * with { failOnTimeout: false } resolves false. Resolves true once the marker exists.
 */
export async function waitForMarker(name, marker, timeoutS, { failOnTimeout = true } = {}) {
  const c = containerName(name);
  const started = Date.now();
  const tty = Boolean(process.stdout.isTTY);
  const label = marker.split('/').pop();
  const clear = () => {
    if (tty) process.stdout.write('\r\x1b[K');
  };
  // A marker older than the container's current run is a leftover of the run before a
  // `docker stop` + `docker start`, seen before the re-run entrypoint deleted it: not ready yet.
  const runStartedS = Math.floor((containerStartedAtMs(name) ?? 0) / 1000);
  for (;;) {
    const res = docker(['exec', c, 'stat', '-c', '%Y', marker], { allowFail: true });
    const mtimeS = Number(res.stdout.trim());
    if (res.status === 0 && Number.isFinite(mtimeS) && mtimeS >= runStartedS) {
      clear();
      return true;
    }
    const elapsed = Math.floor((Date.now() - started) / 1000);
    if (containerState(name) !== 'running') {
      clear();
      const logs = containerLogsTail(name);
      throw new LauncherError(
        `container ${c} stopped while waiting for ${label}${logs ? `; its last log lines:\n${logs}` : ''}`,
      );
    }
    if (elapsed >= timeoutS) {
      clear();
      if (!failOnTimeout) return false;
      throw new LauncherError(
        `${c} did not reach ${label} within ${timeoutS} s; see docker logs ${c}`,
      );
    }
    const line = `waiting for ${c}: ${label} (${elapsed}s / ${timeoutS}s)`;
    process.stdout.write(tty ? `\r\x1b[K${line}` : `${line}\n`);
    await sleep(TIMING.markerPollMs);
  }
}

/**
 * Prints the sandbox URLs, then opens a Claude session in the running sandbox:
 *   docker exec -it -u dev -w <cwt> log-hub-dev-<name> claude --dangerously-skip-permissions [passthrough]
 * with the launcher's terminal; lastActivity is updated before and after. Returns claude's exit code.
 */
export function openSession(name, passthrough = [], paths = resolvePaths()) {
  printUrls(name, paths);
  return execInteractive(name, ['claude', '--dangerously-skip-permissions', ...passthrough], paths);
}

/**
 * `docker exec -it -u dev -w <cwt> log-hub-dev-<name> <command…>` with the launcher's terminal
 * (`-i` only when there is no TTY); lastActivity is updated before and after. Returns the exit code.
 */
function execInteractive(name, command, paths = resolvePaths()) {
  const cp = containerPaths(name, paths);
  touchActivity(name, paths);
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const args = ['exec', tty ? '-it' : '-i', '-u', CONTAINER_USER, '-w', cp.worktree, containerName(name), ...command];
  let res;
  try {
    res = spawnSync('docker', args, { stdio: 'inherit', windowsHide: false });
  } finally {
    touchActivity(name, paths);
  }
  if (res.error) throw new LauncherError(`docker exec failed to run: ${res.error.message}`);
  return res.status ?? 1;
}

// ---------------------------------------------------------------------------------------------
// --shell, --stop
// ---------------------------------------------------------------------------------------------

function assertValidName(name) {
  const nameError = validateName(name);
  if (nameError) throw new LauncherError(`invalid sandbox name "${name}": ${nameError}`, 2);
}

/**
 * `--shell <name>`: a bash shell in an existing sandbox as `dev` in the worktree. A stopped (or
 * missing) container is started first through the same path as a session (createOrStart), with
 * the same re-launch checks. lastActivity is updated before and after. Returns bash's exit code.
 */
export async function shell(name, paths = resolvePaths()) {
  assertValidName(name);
  if (!readState(name, paths)) {
    throw new LauncherError(`no sandbox named ${name}; create it with: scripts/claude-docker.ps1 ${name}`);
  }
  await createOrStart(name, {}, paths);
  return execInteractive(name, ['bash'], paths);
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * `--stop <name> [--force]`: refuses while Claude sessions are live (naming the count) unless
 * force, then stops the whole dev stack: `devctl stop all` (server, client, mailpit, provisioning,
 * each with its grace period), then `docker stop -t 30` of the container (socat and anything left).
 * A later launch `docker start`s it, which runs the entrypoint again (markers reset, socat,
 * provisioning, `devctl start all`), so every service comes back. A stopped container is a no-op.
 * Returns the exit code.
 */
export function stop(name, { force = false } = {}, paths = resolvePaths()) {
  assertValidName(name);
  assertDocker();
  const cs = containerState(name);
  if (cs === 'missing') {
    if (!readState(name, paths)) throw new LauncherError(`no sandbox named ${name}`);
    process.stdout.write(`${containerName(name)} does not exist; nothing to stop\n`);
    return 0;
  }
  if (cs === 'stopped') {
    process.stdout.write(`${containerName(name)} is already stopped\n`);
    return 0;
  }
  const sessions = liveSessions(name);
  if (sessions > 0 && !force) {
    throw new LauncherError(
      `${name} has ${plural(sessions, 'live Claude session')}; close ${sessions === 1 ? 'it' : 'them'} ` +
        `or run --stop ${name} --force`,
    );
  }
  process.stdout.write(
    `stopping ${containerName(name)}${sessions > 0 ? ` (ending ${plural(sessions, 'live Claude session')})` : ''}…\n`,
  );
  const devctlOut = stopDevStack(name);
  if (devctlOut) process.stdout.write(`${devctlOut.replace(/^/gm, '  ')}\n`);
  containerStop(name, TIMING.dockerStopTimeoutS);
  process.stdout.write(
    `stopped ${containerName(name)} (server, client, mailpit and provisioning stopped with it; ` +
      'the next launch starts them again)\n',
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------
// --list (FR-E6)
// ---------------------------------------------------------------------------------------------

/** `5m ago`, `3h ago`, `2d ago` for an ISO time (`-` when absent or unparsable). */
export function formatAgo(iso, now = Date.now()) {
  const t = Date.parse(iso ?? '');
  if (Number.isNaN(t)) return '-';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

/** The pending-work text of a row (DD-5 display rules). */
export function pendingText(pending, base) {
  if (!pending) return '-';
  const { files, commits, merged, noCommits } = pending;
  if (files > 0 || commits > 0) {
    const parts = [];
    if (files > 0) parts.push(plural(files, 'changed file'));
    if (commits > 0) parts.push(plural(commits, 'unmerged commit'));
    return parts.join(' · ');
  }
  if (noCommits) return 'no changes, no commits';
  if (merged && base) return `merged into ${base}`;
  return 'clean';
}

/** The worktree's checked-out branch, or null when it is detached or not a git worktree. */
function worktreeBranch(wt) {
  try {
    return currentBranch(wt);
  } catch {
    return null;
  }
}

/** pendingWork() that reports a broken worktree on stderr and yields null instead of throwing. */
function safePendingWork(s) {
  try {
    return pendingWork(s);
  } catch (err) {
    process.stderr.write(`warning: ${s.name ?? s.worktree}: cannot read pending work: ${err.message.split('\n')[0]}\n`);
    return null;
  }
}

/** Worktree dirs (valid sandbox names holding a `.git` file) that have no state file. */
function stateLessWorktrees(stateNames, paths) {
  let entries;
  try {
    entries = fs.readdirSync(paths.worktreesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((e) => e.isDirectory() && !stateNames.has(e.name) && validateName(e.name) === null)
    .filter((e) => fs.existsSync(path.join(paths.worktreesDir, e.name, '.git')))
    .map((e) => e.name)
    .sort();
}

/**
 * One row per sandbox with the FR-E6 fields:
 *   { name, branch, base, state: running|stopped|missing|unknown, sessions (null when unknown),
 *     lastActivity (ISO), stale, pending {files, commits, merged, noCommits} | null, worktree,
 *     worktreeMissing, hasState,
 *     ports {server, client, mailpit} | null, urls {app, api, mailpit} | null (from the state),
 *     db (log_hub_<name_>), dbSize ('42 MB'; null when the DB or log-hub-postgres is not there) }
 * Worktree dirs without a state file are listed too (hasState false). When Docker is unreachable
 * the container fields are 'unknown' / null and a warning is printed once.
 */
export function listRows(paths = resolvePaths(), now = Date.now()) {
  let dockerOk = true;
  try {
    assertDocker();
  } catch (err) {
    dockerOk = false;
    process.stderr.write(`warning: ${err.message.split('\n')[0]}; container state is unknown\n`);
  }
  let staleMs = null;
  try {
    staleMs = staleAfterMs().ms;
  } catch (err) {
    process.stderr.write(`warning: ${err.message}\n`);
  }
  const containerInfo = (name) => {
    if (!dockerOk) return { state: 'unknown', sessions: null };
    const state = containerState(name);
    return { state, sessions: state === 'running' ? liveSessions(name) : 0 };
  };
  // DB sizes are read only when the shared Postgres already answers: listing never starts infra.
  const dbOk = dockerOk && postgresReady();
  const dbInfo = (name) => {
    const [db] = dbNames(name);
    if (!dbOk) return { db, dbSize: null };
    try {
      return { db, dbSize: dbSize(db) };
    } catch {
      return { db, dbSize: null };
    }
  };

  const states = listStates(paths);
  const rows = states.map((s) => {
    const worktree = s.worktree || worktreePath(s.name, paths);
    const worktreeMissing = !fs.existsSync(worktree);
    const last = Date.parse(s.lastActivity ?? '');
    return {
      name: s.name,
      branch: s.branch ?? null,
      base: s.base ?? null,
      ...containerInfo(s.name),
      lastActivity: s.lastActivity ?? null,
      stale: staleMs !== null && !Number.isNaN(last) && now - last > staleMs,
      pending: safePendingWork({ ...s, worktree }),
      worktree,
      worktreeMissing,
      hasState: true,
      ports: s.ports ? { ...s.ports } : null,
      urls: sandboxUrls(s),
      ...dbInfo(s.name),
    };
  });
  for (const name of stateLessWorktrees(new Set(states.map((s) => s.name)), paths)) {
    const worktree = worktreePath(name, paths);
    const branch = worktreeBranch(worktree);
    rows.push({
      name,
      branch,
      base: null,
      ...containerInfo(name),
      lastActivity: null,
      stale: false,
      pending: safePendingWork({ name, branch, base: null, worktree, createdFrom: null }),
      worktree,
      worktreeMissing: false,
      hasState: false,
      ports: null,
      urls: null,
      ...dbInfo(name),
    });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Phase 2 services text of a listRows() row (Visual/UX notes), or null when the row has no
 * ports (a worktree without state):
 *   running:  `app http://localhost:<client> · api :<server> · mailpit :<mailpit> · db log_hub_X <size>`
 *   else:     `ports <client> · <server> · <mailpit> (stopped)`
 */
export function servicesText(r) {
  const p = r?.ports;
  if (!p) return null;
  if (r.state !== 'running') return `ports ${p.client} · ${p.server} · ${p.mailpit} (stopped)`;
  const db = r.db ? ` · db ${r.db}${r.dbSize ? ` ${r.dbSize}` : ''}` : '';
  return `app http://localhost:${p.client} · api :${p.server} · mailpit :${p.mailpit}${db}`;
}

/** Pads every column to its widest cell; the last column is not padded. */
function alignTable(table) {
  const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
  return table
    .map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]))).join('  ').trimEnd())
    .join('\n');
}

/** `--list`: prints listRows() as an aligned table. Returns the exit code. */
export function printList(paths = resolvePaths()) {
  const rows = listRows(paths);
  if (rows.length === 0) {
    process.stdout.write(`no sandboxes (worktrees dir ${paths.worktreesDir})\n`);
    return 0;
  }
  const now = Date.now();
  const table = [
    ['NAME', 'BRANCH', 'BASE', 'STATE', 'SESSIONS', 'LAST ACTIVITY', 'PENDING', 'URLS / PORTS', 'DB', 'WORKTREE'],
  ];
  for (const r of rows) {
    let state = r.state;
    if (!r.hasState) state += ' (no state)';
    let urls = '-';
    if (r.urls && r.state === 'running') urls = `app ${r.urls.app} · api ${r.urls.api} · mailpit ${r.urls.mailpit}`;
    else if (r.ports) urls = `ports ${r.ports.client} · ${r.ports.server} · ${r.ports.mailpit} (stopped)`;
    table.push([
      r.name,
      r.branch ?? '-',
      r.base ?? '-',
      state,
      r.sessions === null ? '?' : String(r.sessions),
      `${formatAgo(r.lastActivity, now)}${r.stale ? ' (stale)' : ''}`,
      pendingText(r.pending, r.base),
      urls,
      r.dbSize ? `${r.db} ${r.dbSize}` : '-',
      `${r.worktree}${r.worktreeMissing ? ' (missing)' : ''}`,
    ]);
  }
  process.stdout.write(`${alignTable(table)}\n`);
  const orphans = rows.filter((r) => !r.hasState || r.worktreeMissing).map((r) => r.name);
  if (orphans.length > 0) {
    process.stdout.write(`\nincomplete sandboxes: ${orphans.join(', ')} — run --remove <name> or --prune\n`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// --remove (DD-16 order, FR-E1/E2)
// ---------------------------------------------------------------------------------------------

/**
 * The --remove pre-checks (DD-16): live sessions and uncommitted changes (unless force) and, with
 * deleteBranch, that the branch is merged into its base (unless force). Returns the pending list
 * (empty when removal may proceed).
 */
export function removeChecks(target, { force = false, deleteBranch = false } = {}) {
  if (force) return [];
  const pending = [];
  if (target.sessions > 0) {
    pending.push(`${plural(target.sessions, 'live Claude session')} in ${containerName(target.name)}`);
  }
  if (target.files > 0) {
    pending.push(`${plural(target.files, 'uncommitted change')} in ${target.worktree} (git status --porcelain)`);
  }
  if (deleteBranch && target.branch && branchExists(target.branch)) {
    if (!target.base) {
      pending.push(`branch ${target.branch} has no base branch to check it is merged`);
    } else if (!isMerged(target.branch, target.base)) {
      pending.push(`branch ${target.branch} is not merged into ${target.base}`);
    }
  }
  return pending;
}

/** What --remove would act on: state (may be null), branch/base, worktree and the counts. */
function removeTarget(name, paths) {
  const state = readState(name, paths);
  // Always the launcher's own path for <name>; a state file pointing elsewhere is refused, so an
  // edited state.json can never steer `git worktree remove --force` at another directory.
  const worktree = worktreePath(name, paths);
  if (state?.worktree) assertOwnWorktree(state.worktree, name, paths);
  const wtExists = fs.existsSync(worktree);
  const branch = state?.branch ?? (wtExists ? worktreeBranch(worktree) : null);
  const cs = containerState(name);
  const vols = Object.values(volumeNames(name));
  const existingVols = vols.filter((v) => volumeExists(v));
  return {
    name,
    state,
    branch,
    base: state?.base ?? null,
    worktree,
    wtExists,
    containerState: cs,
    volumes: vols,
    existingVols,
    sessions: cs === 'running' ? liveSessions(name) : 0,
    files: wtExists ? (safePendingWork({ name, branch, base: null, worktree, createdFrom: null })?.files ?? 0) : 0,
  };
}

/**
 * `--remove <name> [--force] [--delete-branch]` (DD-16, FR-E1/E2). All checks run first; when any
 * fails without force it throws a LauncherError listing what is pending and removes nothing. Then:
 * docker stop + rm; the nm-* and -plugins volumes; `dropdb --if-exists --force` of both DBs (the
 * shared infra is brought up first, before anything is removed, so the DBs never outlive their
 * sandbox); git worktree remove [--force] + git worktree prune; the state dir; with deleteBranch,
 * `git branch -d`. Every step tolerates the resource being gone, so an interrupted run can be
 * repeated. Returns the exit code (1 when git refused to delete the branch).
 */
export async function remove(name, { force = false, deleteBranch = false } = {}, paths = resolvePaths()) {
  assertValidName(name);
  assertDocker();
  return withLock(async () => {
    const t = removeTarget(name, paths);
    if (!t.state && !t.wtExists && t.containerState === 'missing' && t.existingVols.length === 0) {
      throw new LauncherError(`no sandbox named ${name}`);
    }
    const pending = removeChecks(t, { force, deleteBranch });
    if (pending.length > 0) {
      throw new LauncherError(
        `--remove ${name} refused; nothing was removed. Pending:\n` +
          `${pending.map((p) => `  - ${p}`).join('\n')}\n` +
          'Resolve them, or add --force to remove anyway (uncommitted changes are lost).',
      );
    }
    // The DBs live in the shared log-hub-postgres: make sure it answers before step 1, so a
    // compose failure removes nothing instead of leaving DBs no later prune could attribute.
    try {
      await ensureInfra(paths);
    } catch (err) {
      throw new LauncherError(`--remove ${name} needs log-hub-postgres to drop its databases; nothing was removed.\n${err.message}`);
    }

    const c = containerName(name);
    // 1. Stop and remove the container.
    if (t.containerState !== 'missing') {
      process.stdout.write(`stopping and removing ${c}…\n`);
      containerStop(name, TIMING.dockerStopTimeoutS);
      containerRemove(name);
    }
    // 2. Per-sandbox volumes (node_modules + plugin state); shared caches are never touched.
    for (const v of t.volumes) {
      if (volumeRemove(v).removed) process.stdout.write(`removed volume ${v}\n`);
    }
    // 3. Both databases (dropdb --if-exists --force).
    for (const db of dbNames(name)) {
      if (dbExists(db)) {
        dropDb(db);
        process.stdout.write(`dropped database ${db}\n`);
      }
    }
    // 4. Worktree.
    if (t.wtExists) {
      removeWorktree(assertOwnWorktree(t.worktree, name, paths), force);
      if (fs.existsSync(t.worktree)) {
        throw new LauncherError(
          `${t.worktree} is still there (not a registered git worktree?); remove it by hand, then re-run --remove ${name}`,
        );
      }
      process.stdout.write(`removed worktree ${t.worktree}\n`);
    }
    worktreePrune();
    // 5. State (releases the slot/ports).
    deleteState(name, paths);
    // 6. Branch.
    let exitCode = 0;
    if (deleteBranch && t.branch) {
      const res = deleteGitBranch(t.branch);
      if (res.deleted) process.stdout.write(`deleted branch ${t.branch}\n`);
      else if (!res.gone) {
        process.stderr.write(`warning: branch ${t.branch} was kept: ${res.message}\n`);
        exitCode = 1;
      }
    } else if (t.branch) {
      process.stdout.write(`kept branch ${t.branch}\n`);
    }
    process.stdout.write(`removed sandbox ${name}\n`);
    return exitCode;
  }, paths);
}
