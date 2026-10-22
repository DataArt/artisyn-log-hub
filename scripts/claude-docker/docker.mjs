// Docker helpers for the sandbox launcher: one throwing sync runner (DD-2), container and volume
// queries/ops (all idempotent), the shared infra and per-sandbox DB helpers (Phase 2), the image
// hash/build (DD-12) and `docker run` of a sandbox container with the DD-7 mounts, the DD-8 env,
// the network and the port slot. Every docker call is a synchronous spawnSync.
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CONTAINER_ENV,
  CONTAINER_USER,
  DOCKER_NETWORK,
  IMAGE_FILES,
  IMAGE_HASH_LABEL,
  IMAGE_NAME,
  PORT_BASES,
  POSTGRES_CONTAINER,
  SANDBOX_LABEL,
  SANDBOX_TEST_TIMEOUT_SCALE,
  SHARED_LABEL,
  SHARED_VOLUMES,
  STATE_VERSION,
  TIMING,
  containerName,
  containerPaths,
  dbNames,
  resolvePaths,
  volumeNames,
} from './config.mjs';
import { hostGitIdentity, missingIdentityKeys } from './git.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describe(cmd, args) {
  return [cmd, ...(args || [])].join(' ');
}

/**
 * Synchronous spawn that throws on a spawn error or a non-zero exit (unless allowFail).
 * opts: { cwd, env, input, allowFail, inherit }
 *   inherit — stdio is the launcher's own terminal (for `docker build`, interactive exec);
 *             stdout/stderr are then not captured.
 * Returns { status, stdout, stderr }. The thrown error carries status, stdout and stderr.
 */
export function run(cmd, args = [], opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: opts.inherit ? 'inherit' : [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  if (res.error) {
    const err = new Error(`${describe(cmd, args)} failed to run: ${res.error.message}`);
    err.code = res.error.code;
    throw err;
  }
  const out = { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  if (res.status !== 0 && !opts.allowFail) {
    const tail = (out.stderr || out.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    const err = new Error(`${describe(cmd, args)} exited with ${res.status ?? res.signal}${tail ? `:\n${tail}` : ''}`);
    err.status = res.status;
    err.stdout = out.stdout;
    err.stderr = out.stderr;
    throw err;
  }
  return out;
}

/** `docker <args>` through run(). */
export function docker(args, opts = {}) {
  return run('docker', args, opts);
}

function isNoSuchError(text) {
  return /no such (container|volume|object|image)|not found/i.test(text || '');
}

/** Throws a readable error unless the docker CLI is installed and the daemon answers. */
export function assertDocker() {
  let res;
  try {
    res = docker(['info', '--format', '{{.ServerVersion}}'], { allowFail: true });
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('docker was not found on PATH; install Docker Desktop and retry');
    throw err;
  }
  if (res.status !== 0 || !res.stdout.trim()) {
    const msg = (res.stderr || res.stdout).trim();
    throw new Error(`the Docker daemon is not reachable (is Docker Desktop running?)${msg ? `:\n${msg}` : ''}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------------------------

/** 'running' | 'stopped' | 'missing' for the sandbox's container. */
export function containerState(name) {
  const res = docker(['container', 'inspect', '--format', '{{.State.Running}}', containerName(name)], {
    allowFail: true,
  });
  if (res.status !== 0) {
    if (isNoSuchError(res.stderr)) return 'missing';
    throw new Error(`docker container inspect ${containerName(name)} failed: ${res.stderr.trim()}`);
  }
  return res.stdout.trim() === 'true' ? 'running' : 'stopped';
}

/** Number of live Claude sessions in the sandbox: the line count of `pgrep -x claude` (DD-16). */
export function liveSessions(name) {
  if (containerState(name) !== 'running') return 0;
  const res = docker(['exec', containerName(name), 'pgrep', '-x', 'claude'], { allowFail: true });
  // pgrep exits 1 when nothing matches.
  if (res.status === 1) return 0;
  if (res.status !== 0) {
    throw new Error(`cannot count Claude sessions in ${containerName(name)}: ${(res.stderr || res.stdout).trim()}`);
  }
  return res.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

/** `docker start` of a stopped sandbox container. */
export function containerStart(name) {
  docker(['start', containerName(name)]);
}

/**
 * `docker stop -t <timeoutS>` of the sandbox container; tolerant of it being stopped or gone.
 * Returns { stopped } (true only when a running container was stopped).
 */
export function containerStop(name, timeoutS = TIMING.dockerStopTimeoutS) {
  if (containerState(name) !== 'running') return { stopped: false };
  const res = docker(['stop', '-t', String(timeoutS), containerName(name)], { allowFail: true });
  if (res.status === 0) return { stopped: true };
  if (isNoSuchError(res.stderr)) return { stopped: false };
  throw new Error(`docker stop ${containerName(name)} failed: ${res.stderr.trim()}`);
}

/** `docker rm -f` of the sandbox container; tolerant of it being gone. Returns { removed }. */
export function containerRemove(name) {
  if (containerState(name) === 'missing') return { removed: false };
  const res = docker(['rm', '-f', containerName(name)], { allowFail: true });
  if (res.status === 0) return { removed: true };
  if (isNoSuchError(res.stderr)) return { removed: false };
  throw new Error(`docker rm -f ${containerName(name)} failed: ${res.stderr.trim()}`);
}

/**
 * Host ports the sandbox container currently publishes (`docker port`), as a Set of numbers.
 * Empty when the container is stopped or missing.
 */
export function publishedHostPorts(name) {
  const res = docker(['port', containerName(name)], { allowFail: true });
  const out = new Set();
  if (res.status !== 0) return out;
  // Lines look like `3000/tcp -> 127.0.0.1:3100`.
  for (const line of res.stdout.split(/\r?\n/)) {
    const m = /:(\d+)\s*$/.exec(line.trim());
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/**
 * When the container's current run started (`.State.StartedAt`) as epoch ms; null when it is
 * missing or the time is unparsable. Used to ignore markers left over from a previous run.
 */
export function containerStartedAtMs(name) {
  const res = docker(['container', 'inspect', '--format', '{{.State.StartedAt}}', containerName(name)], {
    allowFail: true,
  });
  if (res.status !== 0) return null;
  const ms = Date.parse(res.stdout.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Stops every in-container dev service (`devctl stop all`: server, client, mailpit, provisioning)
 * with their own grace period, before the container itself is stopped. Best effort: a running
 * container whose devctl fails is still stopped by `docker stop`. Returns the devctl output.
 */
export function stopDevStack(name) {
  if (containerState(name) !== 'running') return '';
  const res = docker(['exec', '-u', CONTAINER_USER, containerName(name), 'devctl', 'stop', 'all'], { allowFail: true });
  return `${res.stdout}${res.stderr}`.trim();
}

/** Last lines of the container's log (empty string when unavailable). */
export function containerLogsTail(name, lines = 40) {
  const res = docker(['logs', '--tail', String(lines), containerName(name)], { allowFail: true });
  return `${res.stdout}${res.stderr}`.trim();
}

// ---------------------------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------------------------

/** True when the named volume exists. */
export function volumeExists(volume) {
  return docker(['volume', 'inspect', volume], { allowFail: true }).status === 0;
}

/** Creates a named volume with the given labels ({key: value}) unless it already exists. */
export function volumeCreate(volume, labels = {}) {
  if (volumeExists(volume)) return { created: false };
  const args = ['volume', 'create'];
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  args.push(volume);
  docker(args);
  return { created: true };
}

/** `docker volume rm`; tolerant of the volume being gone. Returns { removed }. */
export function volumeRemove(volume) {
  const res = docker(['volume', 'rm', volume], { allowFail: true });
  if (res.status === 0) return { removed: true };
  if (isNoSuchError(res.stderr)) return { removed: false };
  throw new Error(`docker volume rm ${volume} failed: ${res.stderr.trim()}`);
}

// ---------------------------------------------------------------------------------------------
// Labelled resources and databases (prune, DD-6)
// ---------------------------------------------------------------------------------------------

function tabRows(text) {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => l.split('\t'));
}

/** All containers (any state) labelled `log-hub.sandbox`: [{ name, sandbox, state }]. */
export function listLabeledContainers() {
  const res = docker([
    'ps',
    '-a',
    '--filter',
    `label=${SANDBOX_LABEL}`,
    '--format',
    `{{.Names}}\t{{.Label "${SANDBOX_LABEL}"}}\t{{.State}}`,
  ]);
  return tabRows(res.stdout).map(([name, sandbox, state]) => ({ name, sandbox: sandbox ?? '', state: state ?? '' }));
}

/** All volumes labelled `log-hub.sandbox`: [{ name, sandbox }]. Shared caches carry no such label. */
export function listLabeledVolumes() {
  const res = docker([
    'volume',
    'ls',
    '--filter',
    `label=${SANDBOX_LABEL}`,
    '--format',
    `{{.Name}}\t{{.Label "${SANDBOX_LABEL}"}}`,
  ]);
  return tabRows(res.stdout).map(([name, sandbox]) => ({ name, sandbox: sandbox ?? '' }));
}

/** `docker rm -f <container>` by its real name; tolerant of it being gone. Returns { removed }. */
export function removeContainerByName(container) {
  const res = docker(['rm', '-f', container], { allowFail: true });
  if (res.status === 0) return { removed: true };
  if (isNoSuchError(res.stderr)) return { removed: false };
  throw new Error(`docker rm -f ${container} failed: ${res.stderr.trim()}`);
}

// ---------------------------------------------------------------------------------------------
// Shared infra and per-sandbox databases (Phase 2, "Database changes"), all through
// `docker exec log-hub-postgres`.
// ---------------------------------------------------------------------------------------------

/** The host compose file that owns log-hub-postgres and the log-hub-net network. */
export function composeFile(paths = resolvePaths()) {
  return path.join(paths.repoRoot, 'server', 'artisyn-log-run-local', 'docker-compose.yml');
}

/**
 * `docker compose -f server/artisyn-log-run-local/docker-compose.yml up -d --no-recreate`, then
 * polls `docker exec log-hub-postgres pg_isready -U postgres` once per second until it succeeds
 * (TIMING.infraHealthPollS). Throws a readable error on a compose failure or the timeout.
 */
export async function ensureInfra(paths = resolvePaths()) {
  const file = composeFile(paths);
  const up = docker(['compose', '-f', file, 'up', '-d', '--no-recreate'], { allowFail: true });
  if (up.status !== 0) {
    const tail = (up.stderr || up.stdout).trim().split(/\r?\n/).slice(-20).join('\n');
    throw new Error(`docker compose -f ${file} up -d --no-recreate failed${tail ? `:\n${tail}` : ''}`);
  }
  const deadline = Date.now() + TIMING.infraHealthPollS * 1000;
  let last = '';
  for (;;) {
    const res = docker(['exec', POSTGRES_CONTAINER, 'pg_isready', '-U', 'postgres'], { allowFail: true });
    if (res.status === 0) return;
    last = (res.stderr || res.stdout).trim();
    if (Date.now() >= deadline) {
      throw new Error(
        `${POSTGRES_CONTAINER} is not ready after ${TIMING.infraHealthPollS} s` +
          `${last ? ` (pg_isready: ${last})` : ''}; see docker logs ${POSTGRES_CONTAINER}`,
      );
    }
    await sleep(TIMING.markerPollMs);
  }
}

/**
 * True when log-hub-postgres is running and answers `pg_isready` right now (no compose, no wait).
 * Read-only callers (--list, the menu, the prune plan) use it to skip DB lookups instead of failing.
 */
export function postgresReady() {
  try {
    return docker(['exec', POSTGRES_CONTAINER, 'pg_isready', '-U', 'postgres'], { allowFail: true }).status === 0;
  } catch {
    return false;
  }
}

/** Database names are derived from validated sandbox names; refuse anything else before SQL. */
function assertDbName(db) {
  if (!/^log_hub_[a-z0-9_]+$/.test(db)) throw new Error(`refusing an unexpected database name: ${db}`);
}

function psql(sql) {
  return docker(['exec', POSTGRES_CONTAINER, 'psql', '-U', 'postgres', '-tAc', sql]).stdout.trim();
}

/** True when the database exists. */
export function dbExists(db) {
  assertDbName(db);
  return psql(`select 1 from pg_database where datname='${db}'`) === '1';
}

/** Creates the database unless it exists (`createdb -U postgres`). Returns { created }. */
export function ensureDb(db) {
  assertDbName(db);
  if (dbExists(db)) return { created: false };
  docker(['exec', POSTGRES_CONTAINER, 'createdb', '-U', 'postgres', db]);
  return { created: true };
}

/** `dropdb -U postgres --if-exists --force`; tolerant of the database being gone. */
export function dropDb(db) {
  assertDbName(db);
  docker(['exec', POSTGRES_CONTAINER, 'dropdb', '-U', 'postgres', '--if-exists', '--force', db]);
}

/** `pg_size_pretty(pg_database_size(db))`, e.g. `42 MB`; null when the database does not exist. */
export function dbSize(db) {
  assertDbName(db);
  const out = psql(`select pg_size_pretty(pg_database_size(datname)) from pg_database where datname='${db}'`);
  return out || null;
}

/**
 * Every database whose name starts with `log_hub_` in the shared cluster. Callers match these by
 * exact string equality against dbNames(<name>), never by pattern (DD-6).
 */
export function listSandboxDbs() {
  return psql("select datname from pg_database where datname like 'log\\_hub\\_%'")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------
// Image (DD-12)
// ---------------------------------------------------------------------------------------------

/** sha256 over IMAGE_FILES sorted, each fed as `relpath\0content` (the dockerignore included). */
export function imageHash(paths = resolvePaths()) {
  const h = crypto.createHash('sha256');
  for (const rel of [...IMAGE_FILES].sort()) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(path.join(paths.dockerDevDir, rel)));
  }
  return h.digest('hex');
}

/** The hash label of the local image, '' when the label is absent, null when there is no image. */
export function imageLabelHash() {
  const res = docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', IMAGE_NAME], { allowFail: true });
  if (res.status !== 0) {
    if (isNoSuchError(res.stderr)) return null;
    throw new Error(`docker image inspect ${IMAGE_NAME} failed: ${res.stderr.trim()}`);
  }
  let labels;
  try {
    labels = JSON.parse(res.stdout.trim() || 'null');
  } catch {
    labels = null;
  }
  const v = labels && typeof labels[IMAGE_HASH_LABEL] === 'string' ? labels[IMAGE_HASH_LABEL] : '';
  return v;
}

/** Printed before the very first build: it downloads Node, Claude, Chrome, Playwright, bun… */
export const FIRST_BUILD_NOTICE =
  `\n\x1b[33m⚠ Image ${IMAGE_NAME} not found — the first build takes ~20–30 min.\x1b[0m\n` +
  '  Later launches reuse it (seconds); a rebuild after docker-dev/ changes reuses the layer cache.\n\n';

/** True when the dev image has not been built yet (the first launch will build it). */
export function imageMissing() {
  try {
    return imageLabelHash() === null;
  } catch {
    return false;
  }
}

/**
 * Builds the image when it is missing, or always with { rebuild: true } (with the layer cache).
 * The build output goes to the terminal. Returns { built }.
 */
export function ensureImage({ rebuild = false } = {}, paths = resolvePaths()) {
  const missing = imageLabelHash() === null;
  if (!rebuild && !missing) return { built: false };
  if (missing) process.stdout.write(FIRST_BUILD_NOTICE);
  const hash = imageHash(paths);
  process.stdout.write(`building image ${IMAGE_NAME} (hash ${hash.slice(0, 12)})…\n`);
  docker(
    [
      'build',
      '-f',
      path.join(paths.dockerDevDir, 'Dockerfile'),
      '-t',
      IMAGE_NAME,
      '--label',
      `${IMAGE_HASH_LABEL}=${hash}`,
      paths.dockerDevDir,
    ],
    { inherit: true },
  );
  return { built: true };
}

/**
 * A normal launch never rebuilds: when the image's hash label differs from the current
 * docker-dev files, print a warning with the `--reset` hint. Returns true when stale.
 */
export function warnIfStaleImage(name, paths = resolvePaths()) {
  const label = imageLabelHash();
  if (label === null) return false;
  const current = imageHash(paths);
  if (label === current) return false;
  const target = name || '<name>';
  process.stderr.write(
    `warning: image ${IMAGE_NAME} was built from older docker-dev/ files ` +
      `(image ${label ? label.slice(0, 12) : 'unlabelled'}, files ${current.slice(0, 12)}).\n` +
      `         Run scripts/claude-docker.ps1 --reset ${target} to rebuild it and recreate the container.\n`,
  );
  return true;
}

// ---------------------------------------------------------------------------------------------
// docker run (DD-7, DD-8)
// ---------------------------------------------------------------------------------------------

/** One `--mount` CSV field; quoted when it holds a comma or a quote. */
function csvField(text) {
  return /[",]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function bindMount(source, target, readonly = false) {
  const parts = ['type=bind', `source=${source}`, `target=${target}`];
  if (readonly) parts.push('readonly');
  return ['--mount', parts.map(csvField).join(',')];
}

function volumeMount(volume, target) {
  return ['--mount', ['type=volume', `source=${volume}`, `target=${target}`].map(csvField).join(',')];
}

/** The DD-8 GIT_CONFIG_* env: four fixed keys plus the host identity. */
function gitConfigEnv(identity) {
  const pairs = [
    ['core.autocrlf', 'input'],
    ['core.filemode', 'false'],
    ['core.ignorecase', 'false'],
    ['worktree.useRelativePaths', 'true'],
    ['user.name', identity.name],
    ['user.email', identity.email],
  ];
  const env = { GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k;
    env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
  return env;
}

/** `postgresql://postgres:pw@localhost:5432/<db>` — localhost is the in-container socat (DD-13). */
function sandboxDbUrl(db) {
  return `postgresql://postgres:pw@localhost:5432/${db}`;
}

/** The three `-p 127.0.0.1:<host>:<container>` publishes of the state's port slot (DD-3). */
function portPublishes(ports) {
  const args = [];
  for (const key of Object.keys(PORT_BASES)) {
    const host = ports?.[key];
    if (!Number.isInteger(host)) throw new Error(`runContainer: the state has no ${key} port`);
    args.push('-p', `127.0.0.1:${host}:${PORT_BASES[key].container}`);
  }
  return args;
}

/**
 * Creates and starts the sandbox container (`docker run -d --init`) from its v2 state:
 * - name/hostname, the `log-hub.sandbox` label, `--network log-hub-net`;
 * - the three 127.0.0.1 port publishes of the state's slot;
 * - the DD-7 mounts (main `.git`, worktree, the shared Claude profile, the read-only host temp dir);
 * - the per-sandbox `-plugins` and five `nm-*` volumes (label `log-hub.sandbox=<name>`) and the
 *   three shared cache volumes (label `log-hub.shared=true`), each created first with its labels;
 * - the DD-8 Phase 1 + Phase 2 env.
 */
export function runContainer(state, phase = state?.v, paths = resolvePaths()) {
  const { name } = state;
  if (phase !== STATE_VERSION) {
    throw new Error(`runContainer: a v${phase} state is not supported by this launcher version (v${STATE_VERSION})`);
  }
  const identity = hostGitIdentity();
  const missing = missingIdentityKeys(identity);
  if (missing.length > 0) {
    throw new Error(`host git ${missing.join(' and ')} is empty; set it with git config --global ${missing[0]} "…"`);
  }

  fs.mkdirSync(paths.claudeHome, { recursive: true });
  const cp = containerPaths(name, paths);
  const vols = volumeNames(name);
  const label = `${SANDBOX_LABEL}=${name}`;
  for (const v of Object.values(vols)) volumeCreate(v, { [SANDBOX_LABEL]: name });
  for (const v of Object.values(SHARED_VOLUMES)) volumeCreate(v, { [SHARED_LABEL]: 'true' });

  const [db, testDb] = dbNames(name);
  const env = {
    [CONTAINER_ENV.SANDBOX_NAME]: name,
    [CONTAINER_ENV.SANDBOX_WORKTREE]: cp.worktree,
    [CONTAINER_ENV.CLAUDE_CONFIG_DIR]: cp.claudeHome,
    [CONTAINER_ENV.HOST_TEMP]: paths.hostTmp,
    ...gitConfigEnv(identity),
    [CONTAINER_ENV.ARTISYN_PROJECT_ROOT]: cp.worktree,
    [CONTAINER_ENV.DATABASE_URL]: sandboxDbUrl(db),
    [CONTAINER_ENV.TEST_DATABASE_URL]: sandboxDbUrl(testDb),
    [CONTAINER_ENV.LOG_HUB_VITE_HOST]: '0.0.0.0',
    [CONTAINER_ENV.SANDBOX_HOST_EMAIL]: identity.email,
    [CONTAINER_ENV.LOG_HUB_TEST_TIMEOUT_SCALE]: String(SANDBOX_TEST_TIMEOUT_SCALE),
  };

  const args = [
    'run',
    '-d',
    '--init',
    '--name',
    containerName(name),
    '--hostname',
    name,
    '--label',
    label,
    '--network',
    DOCKER_NETWORK,
    ...portPublishes(state.ports),
    ...bindMount(cp.hostGitDir, cp.gitDir),
    ...bindMount(cp.hostWorktree, cp.worktree),
    ...bindMount(paths.claudeHome, cp.claudeHome),
    ...bindMount(paths.hostTmp, cp.hostTmp, true),
    ...volumeMount(vols.plugins, cp.pluginsDir),
    ...volumeMount(vols.tmp, cp.tmp),
  ];
  for (const [key, target] of Object.entries(cp.nodeModules)) args.push(...volumeMount(vols[key], target));
  for (const [key, target] of Object.entries(cp.caches)) args.push(...volumeMount(SHARED_VOLUMES[key], target));
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(IMAGE_NAME);
  docker(args);
}
