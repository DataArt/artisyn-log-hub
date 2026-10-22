// Sandbox launcher configuration: the DD-3 names and constants, path resolution (DD-7), the name
// rule and the age parser. Everything here is pure except resolvePaths(), which asks git once for
// the repo root. No machine paths: all locations derive from git, process.env and os.tmpdir().
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------
// Constants (DD-3, DD-8, DD-12)
// ---------------------------------------------------------------------------------------------

/** Environment variables the launcher reads on the host. */
export const ENV = Object.freeze({
  WORKTREES_DIR: 'CLAUDE_DOCKER_WORKTREES_DIR',
  STALE_AFTER: 'CLAUDE_DOCKER_STALE_AFTER',
  SETUP_TIMEOUT_S: 'CLAUDE_DOCKER_SETUP_TIMEOUT_S',
  READY_TIMEOUT_S: 'CLAUDE_DOCKER_READY_TIMEOUT_S',
});

/** Environment variables the launcher sets inside the container (DD-8). */
export const CONTAINER_ENV = Object.freeze({
  SANDBOX_NAME: 'SANDBOX_NAME',
  SANDBOX_WORKTREE: 'SANDBOX_WORKTREE',
  CLAUDE_CONFIG_DIR: 'CLAUDE_CONFIG_DIR',
  HOST_TEMP: 'HOST_TEMP',
  ARTISYN_PROJECT_ROOT: 'ARTISYN_PROJECT_ROOT',
  DATABASE_URL: 'DATABASE_URL',
  TEST_DATABASE_URL: 'TEST_DATABASE_URL',
  LOG_HUB_VITE_HOST: 'LOG_HUB_VITE_HOST',
  SANDBOX_HOST_EMAIL: 'SANDBOX_HOST_EMAIL',
  LOG_HUB_TEST_TIMEOUT_SCALE: 'LOG_HUB_TEST_TIMEOUT_SCALE',
  // The sandbox's URLs as the user opens them on the host (published ports of its slot).
  SANDBOX_APP_URL: 'SANDBOX_APP_URL',
  SANDBOX_API_URL: 'SANDBOX_API_URL',
  SANDBOX_MAILPIT_URL: 'SANDBOX_MAILPIT_URL',
});

export const DEFAULT_STALE_AFTER = '7d';
export const DEFAULT_SETUP_TIMEOUT_S = 900;
export const DEFAULT_READY_TIMEOUT_S = 180;

export const IMAGE_NAME = 'log-hub-dev:latest';
export const IMAGE_HASH_LABEL = 'log-hub.dev-image-hash';
export const SANDBOX_LABEL = 'log-hub.sandbox';
export const SHARED_LABEL = 'log-hub.shared';
export const DOCKER_NETWORK = 'log-hub-net';
export const POSTGRES_CONTAINER = 'log-hub-postgres';

/** Shared cache volumes: labelled `log-hub.shared=true`, never removed. */
export const SHARED_VOLUMES = Object.freeze({
  npm: 'log-hub-dev-cache-npm',
  bun: 'log-hub-dev-cache-bun',
  playwright: 'log-hub-dev-cache-playwright',
});

/**
 * Files that make up the image build context (DD-12). Must equal the `!` entries of
 * docker-dev/Dockerfile.dockerignore; the image hash is computed over exactly this list.
 */
export const IMAGE_FILES = Object.freeze([
  'Dockerfile',
  'Dockerfile.dockerignore',
  'entrypoint.sh',
  'settings.template.json',
  'gitconfig',
  'CLAUDE.container.md',
  'devctl',
  'provision.mjs',
  'npx.cmd',
]);

/** In-container markers (both deleted at entrypoint start). */
export const MARKERS = Object.freeze({
  entrypointDone: '/run/dev/entrypoint-done',
  provisioned: '/run/dev/provisioned',
});

export const CONTAINER_USER = 'dev';
export const CONTAINER_CLAUDE_HOME = '/home/dev/.claude-home';
export const CONTAINER_PLUGINS_DIR = '/home/dev/.claude-home/plugins';
export const CONTAINER_HOST_TMP = '/host-tmp';
export const CONTAINER_WORK_ROOT = '/work';

/** Port mapping per slot n (all on 127.0.0.1): host base + 10n -> container port. */
export const PORT_BASES = Object.freeze({
  server: { host: 3100, container: 3000 },
  client: { host: 5200, container: 5173 },
  mailpit: { host: 8100, container: 8025 },
});
export const PORT_SLOT_STEP = 10;
export const MAX_SLOTS = 100;

/** Timing constants (DD-3). */
export const TIMING = Object.freeze({
  lockRetryMs: 200,
  lockGiveUpMs: 30_000,
  lockStaleReportMs: 10 * 60_000,
  dockerStopTimeoutS: 30,
  infraHealthPollS: 120,
  markerPollMs: 1000,
});

export const STATE_VERSION_POC = 1;
export const STATE_VERSION = 2;

export const MIN_GIT_VERSION = Object.freeze([2, 48, 0]);

// ---------------------------------------------------------------------------------------------
// Names (DD-3)
// ---------------------------------------------------------------------------------------------

export const NAME_MAX_LENGTH = 40;

/** Returns the error text for an invalid sandbox name, or null when the name is valid. */
export function validateName(name) {
  if (typeof name !== 'string' || name.length === 0) return 'a name is required';
  if (name.length > NAME_MAX_LENGTH) return `max ${NAME_MAX_LENGTH} characters`;
  if (!/^[a-z0-9-]+$/.test(name)) return 'only a-z, 0-9 and "-"';
  if (name.startsWith('-')) return 'must start with a-z or 0-9';
  if (name.endsWith('-test')) return 'must not end in -test';
  return null;
}

export function containerName(name) {
  return `log-hub-dev-${name}`;
}

/** Per-sandbox volume names, all labelled `log-hub.sandbox=<name>`. */
export function volumeNames(name) {
  const p = `log-hub-dev-${name}`;
  return {
    nmRoot: `${p}-nm-root`,
    nmClient: `${p}-nm-client`,
    nmServer: `${p}-nm-server`,
    nmHook: `${p}-nm-hook`,
    nmInstaller: `${p}-nm-installer`,
    plugins: `${p}-plugins`,
    tmp: `${p}-tmp`,
  };
}

/** Test timeouts are multiplied by this inside a sandbox (tests/timeout-scale.ts). */
export const SANDBOX_TEST_TIMEOUT_SCALE = 5;

/** Returns [main, test] database names; `-` becomes `_`. */
export function dbNames(name) {
  const main = `log_hub_${name.replace(/-/g, '_')}`;
  return [main, `${main}_test`];
}

/** Host ports for slot n. */
export function portsForSlot(slot) {
  const off = slot * PORT_SLOT_STEP;
  return {
    server: PORT_BASES.server.host + off,
    client: PORT_BASES.client.host + off,
    mailpit: PORT_BASES.mailpit.host + off,
  };
}

// ---------------------------------------------------------------------------------------------
// Ages
// ---------------------------------------------------------------------------------------------

const AGE_UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parses `15m`, `2h`, `7d` into milliseconds; returns null for anything else. */
export function parseAge(text) {
  const m = /^(\d+)(m|h|d)$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * AGE_UNIT_MS[m[2]];
}

/** The stale threshold in ms from CLAUDE_DOCKER_STALE_AFTER (default 7d); throws on bad syntax. */
export function staleAfterMs(env = process.env) {
  const raw = (env[ENV.STALE_AFTER] || '').trim() || DEFAULT_STALE_AFTER;
  const ms = parseAge(raw);
  if (ms === null) throw new Error(`${ENV.STALE_AFTER}=${raw} is not an age like 15m, 2h or 7d`);
  return { text: raw, ms };
}

function positiveIntEnv(env, key, fallback) {
  const raw = (env[key] || '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key}=${raw} must be a positive integer`);
  return n;
}

export function setupTimeoutS(env = process.env) {
  return positiveIntEnv(env, ENV.SETUP_TIMEOUT_S, DEFAULT_SETUP_TIMEOUT_S);
}

export function readyTimeoutS(env = process.env) {
  return positiveIntEnv(env, ENV.READY_TIMEOUT_S, DEFAULT_READY_TIMEOUT_S);
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Default worktrees dir relative to the repo root (git-ignored). */
export const DEFAULT_WORKTREES_SUBDIR = Object.freeze(['.worktrees']);
let cachedPaths = null;

/**
 * Resolves the main repo root (via git, so it is right even when called from a linked worktree),
 * the worktrees dir and the state dir. Memoized; pass { refresh: true } to recompute.
 */
export function resolvePaths({ env = process.env, refresh = false } = {}) {
  if (cachedPaths && !refresh) return cachedPaths;
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir'], {
    cwd: SCRIPT_DIR,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.error || res.status !== 0) {
    throw new Error(`cannot locate the repository root: ${(res.stderr || res.error?.message || '').trim()}`);
  }
  const [, commonDir] = res.stdout.trim().split(/\r?\n/);
  // The common dir of the main checkout is <repo>/.git; its parent is the main repo root, also
  // when the launcher itself runs from a linked worktree.
  const repoRoot = path.resolve(path.dirname(commonDir));
  const fromEnv = (env[ENV.WORKTREES_DIR] || '').trim();
  // Default: `<repo>/.worktrees`, inside the clone and git-ignored, so nothing is created next to
  // the repo, removing the clone removes its sandboxes, and the IDE shows the sandbox files.
  const defaultDir = path.join(repoRoot, ...DEFAULT_WORKTREES_SUBDIR);
  const worktreesDir = fromEnv ? path.resolve(fromEnv) : defaultDir;
  // The default is inside the repo by design; a custom dir must pass the safety check.
  if (fromEnv && !samePath(worktreesDir, defaultDir)) assertSafeWorktreesDir(worktreesDir, repoRoot);
  const stateDir = path.join(worktreesDir, '.sandboxes');
  cachedPaths = Object.freeze({
    repoRoot,
    gitDir: path.join(repoRoot, '.git'),
    worktreesDir,
    // The pre-2026-10-22 default (next to the repo); migrated by migrateLegacyLayout().
    legacyWorktreesDir: fromEnv ? null : path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}-worktrees`),
    stateDir,
    lockFile: path.join(stateDir, '.lock'),
    claudeHome: path.join(repoRoot, 'docker-dev', 'claude-home'),
    dockerDevDir: path.join(repoRoot, 'docker-dev'),
    hostTmp: os.tmpdir(),
  });
  return cachedPaths;
}

// ---------------------------------------------------------------------------------------------
// Deletion guards. The launcher removes directories (worktrees, state dirs); every such path must
// be a direct child of a launcher-owned dir, derived from a valid sandbox name — never a path read
// from a state file or a user-supplied root.
// ---------------------------------------------------------------------------------------------

function samePath(a, b, platform = process.platform) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `child` is strictly inside `parent` (not equal to it). */
export function isStrictlyInside(child, parent, platform = process.platform) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !samePath(child, parent, platform);
}

/**
 * Refuses a worktrees dir that is a filesystem root, the home dir or one of its ancestors, the
 * repo itself, inside the repo, or an ancestor of the repo: the launcher deletes sandbox dirs
 * under it, so it must be a dedicated folder.
 */
export function assertSafeWorktreesDir(worktreesDir, repoRoot, home = os.homedir()) {
  const wd = path.resolve(worktreesDir);
  const why = (reason) =>
    new Error(`refusing worktrees dir ${wd}: ${reason}; set ${ENV.WORKTREES_DIR} to a dedicated folder (default: <repo>-worktrees next to the repo)`);
  if (samePath(wd, path.parse(wd).root)) throw why('it is a filesystem root');
  if (samePath(wd, repoRoot) || isStrictlyInside(wd, repoRoot)) throw why('it is the repo or inside it');
  if (isStrictlyInside(repoRoot, wd)) throw why('it contains the repo');
  if (home && (samePath(wd, home) || isStrictlyInside(home, wd))) throw why('it is the home dir or contains it');
}

// ---------------------------------------------------------------------------------------------
// Protected branches (.claude/claude-isolation.json)
// ---------------------------------------------------------------------------------------------

export const ISOLATION_CONFIG = path.join('.claude', 'claude-isolation.json');

/**
 * Branches a sandbox must never run on, from `<repo>/.claude/claude-isolation.json`
 * (`{"protectedBranches": ["main"]}`). No file means no protection; a broken file throws, so a
 * typo never silently turns the protection off.
 */
export function protectedBranches(paths = resolvePaths()) {
  const file = path.join(paths.repoRoot, ISOLATION_CONFIG);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
  const list = cfg?.protectedBranches;
  if (!Array.isArray(list) || !list.every((b) => typeof b === 'string' && b.trim())) {
    throw new Error(`${file}: "protectedBranches" must be an array of branch names`);
  }
  return list.map((b) => b.trim().replace(/^refs\/heads\//, ''));
}

/** The refusal text when `branch` is protected, or null when a sandbox may run on it. */
export function protectedBranchError(branch, paths = resolvePaths()) {
  const b = String(branch ?? '').replace(/^refs\/heads\//, '');
  if (!b || !protectedBranches(paths).includes(b)) return null;
  return `branch ${b} is protected (${ISOLATION_CONFIG.split(path.sep).join('/')}); a sandbox needs its own branch — pick another one or a new name`;
}

/** Throws unless `name` is a valid sandbox name (the only input deletion paths are built from). */
export function assertSandboxName(name) {
  const err = validateName(name);
  if (err) throw new Error(`refusing sandbox name "${name}": ${err}`);
}

export function worktreePath(name, paths = resolvePaths()) {
  assertSandboxName(name);
  return path.join(paths.worktreesDir, name);
}

export function sandboxStateDir(name, paths = resolvePaths()) {
  assertSandboxName(name);
  return path.join(paths.stateDir, name);
}

/**
 * Throws unless `wt` is exactly the launcher's worktree path for `name`. A state file is plain JSON
 * a user can edit; its `worktree` field must never steer `git worktree remove --force` elsewhere.
 */
export function assertOwnWorktree(wt, name, paths = resolvePaths()) {
  const own = worktreePath(name, paths);
  if (!samePath(wt, own) || !isStrictlyInside(own, paths.worktreesDir)) {
    throw new Error(`refusing to touch ${wt}: sandbox ${name} lives at ${own}`);
  }
  return own;
}

export function stateFilePath(name, paths = resolvePaths()) {
  return path.join(sandboxStateDir(name, paths), 'state.json');
}

function splitPath(p) {
  const resolved = path.resolve(p);
  const { root } = path.parse(resolved);
  const rest = resolved.slice(root.length).split(path.sep).filter(Boolean);
  return { root, rest };
}

/** The deepest common ancestor of two absolute paths; throws when they are on different drives. */
export function commonAncestor(a, b, platform = process.platform) {
  const pa = splitPath(a);
  const pb = splitPath(b);
  const norm = platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  if (norm(pa.root) !== norm(pb.root)) {
    throw new Error(`the repo (${a}) and the worktrees dir (${b}) are on different drives; set ${ENV.WORKTREES_DIR} to a folder on the repo's drive`);
  }
  const common = [];
  for (let i = 0; i < Math.min(pa.rest.length, pb.rest.length); i++) {
    if (norm(pa.rest[i]) !== norm(pb.rest[i])) break;
    common.push(pa.rest[i]);
  }
  return path.join(pa.root, ...common);
}

function toPosixRel(from, to) {
  return path.relative(from, to).split(path.sep).join('/');
}

function joinPosix(...parts) {
  return parts.filter((p) => p !== '').join('/').replace(/\/+/g, '/');
}

/**
 * Container-side paths per DD-7. C is the deepest common ancestor of the repo root and the
 * worktrees dir; both the main `.git` and the worktree keep their position relative to C under
 * /work, so the relative gitdir links resolve inside the container.
 */
export function containerPaths(name, paths = resolvePaths()) {
  const hostWorktree = worktreePath(name, paths);
  const c = commonAncestor(paths.repoRoot, paths.worktreesDir);
  const worktree = joinPosix(CONTAINER_WORK_ROOT, toPosixRel(c, hostWorktree));
  const repo = joinPosix(CONTAINER_WORK_ROOT, toPosixRel(c, paths.repoRoot));
  return {
    commonRoot: c,
    hostGitDir: paths.gitDir,
    hostWorktree,
    repo,
    gitDir: joinPosix(repo, '.git'),
    worktree,
    claudeHome: CONTAINER_CLAUDE_HOME,
    pluginsDir: CONTAINER_PLUGINS_DIR,
    hostTmp: CONTAINER_HOST_TMP,
    nodeModules: {
      nmRoot: joinPosix(worktree, 'node_modules'),
      nmClient: joinPosix(worktree, 'client/node_modules'),
      nmServer: joinPosix(worktree, 'server/node_modules'),
      nmHook: joinPosix(worktree, 'hook/node_modules'),
      nmInstaller: joinPosix(worktree, 'artisyn-hooks-installer/node_modules'),
    },
    tmp: joinPosix(worktree, 'tmp'),
    caches: {
      npm: '/home/dev/.npm',
      bun: '/home/dev/.bun',
      playwright: '/home/dev/.cache/ms-playwright',
    },
  };
}
