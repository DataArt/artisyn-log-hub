'use strict';
/**
 * Claude Code Hook helper — the per-OS-user OTEL state dir `~/.artisyn/otel/` (not a hook entry
 * point itself).
 *
 * Hook 2.30.0+ runs one OTEL receiver per OS user instead of one per project. Everything that
 * receiver and the hooks of every repo share lives in one directory:
 *
 *   port.json            installer   {version:1, port, allocatedAt}
 *   token                installer, or the hook if missing — 64 lowercase hex chars, no newline
 *   repos.json           installer   {version:1, repos:[{repoKey, gitRoot, otelDir, uploader, traces,
 *                                     installedAt, hookVersion}]}
 *   registry.json        receiver    {version:1, savedAt, sessions:{…}}
 *   forward.json         installer   {version:1, mode, fingerprint, signals, original, savedAt}
 *   receiver.log         receiver    shared diagnostics log
 *   claude-version.json  hook        {version, seenAt} (see otel-status.js)
 *   bin/                 installer   receiver copy and the user-level SessionStart hook
 *
 * The dir is resolved per call from `os.homedir()` — never cached — so a fake HOME/USERPROFILE (the
 * scenario suite) isolates it. Files are written tmp + rename, mode 0o600 on POSIX; on Windows the
 * profile dir is already user-only, so no ACL is applied.
 *
 * TS twin: `artisyn-hooks-installer/src/user-state.ts`. `repoKey`/`ownerHash` are also duplicated in
 * `otel-receiver.js` and `otel-ensure-receiver.js`, which must stay standalone (no `require` of any
 * hook module). Keep all copies identical.
 *
 * Node built-ins only. Every reader fails soft (returns `null` / an empty shape), never throws.
 */

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The OTLP resource attribute that carries a repo's `repoKey` (DD-5). Twins: `otel-receiver.js`,
// `artisyn-hooks-installer/src/otel-env.ts`.
const REPO_ATTR_KEY = 'artisyn.repo';

const STATE_FILE_NAMES = Object.freeze({
  port: 'port.json',
  token: 'token',
  repos: 'repos.json',
  registry: 'registry.json',
  forward: 'forward.json',
  receiverLog: 'receiver.log',
  claudeVersion: 'claude-version.json',
  binDir: 'bin',
});

const FORWARD_MODES = ['proxy', 'keep', 'replace', 'none'];

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * `<home>/.artisyn/otel`. `homeDir` defaults to `os.homedir()`, read per call.
 * @param {string} [homeDir]
 * @returns {string}
 */
function otelStateDir(homeDir) {
  return path.join(homeDir || os.homedir(), '.artisyn', 'otel');
}

/**
 * Absolute path of one state file.
 * @param {keyof typeof STATE_FILE_NAMES} name
 * @param {{ stateDir?: string, homeDir?: string }} [opts]
 * @returns {string}
 */
function stateFilePath(name, opts = {}) {
  return path.join(opts.stateDir || otelStateDir(opts.homeDir), STATE_FILE_NAMES[name]);
}

/**
 * Parse a JSON object file; `null` when missing, unreadable, not JSON or not a plain object.
 * @param {string} file
 * @returns {Record<string, *>|null}
 */
function readJsonObject(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Write `value` as JSON to `file` atomically: a sibling tmp file, then rename over the target.
 * Creates the parent dir (mode 0o700). Returns `false` (and removes the tmp file) on any failure.
 * @param {string} file
 * @param {*} value
 * @returns {boolean}
 */
function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    return false;
  }
}

/**
 * `port.json`, validated: `{version, port, allocatedAt}` with an integer port in 1..65535, else `null`.
 * @param {{ stateDir?: string, homeDir?: string }} [opts]
 * @returns {{ version: number, port: number, allocatedAt: string|null }|null}
 */
function readPortFile(opts = {}) {
  const parsed = readJsonObject(stateFilePath('port', opts));
  if (!parsed) return null;
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : 1,
    port,
    allocatedAt: typeof parsed.allocatedAt === 'string' ? parsed.allocatedAt : null,
  };
}

/**
 * Read `token`; with `create` (default) generate one when it is missing. The file is created with
 * the `wx` flag, so of two racing creators exactly one wins and the loser reads the winner's token.
 * An existing but malformed token is never overwritten (the installer owns it) — `null` then.
 * @param {{ stateDir?: string, homeDir?: string, create?: boolean }} [opts]
 * @returns {string|null}
 */
function readOrCreateToken(opts = {}) {
  const file = stateFilePath('token', opts);
  const read = () => {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      return TOKEN_RE.test(value) ? value : null;
    } catch (err) {
      return err && err.code === 'ENOENT' ? undefined : null;
    }
  };
  const existing = read();
  if (existing !== undefined || opts.create === false) return existing === undefined ? null : existing;
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return token;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const winner = read();
      return winner === undefined ? null : winner;
    }
    return null;
  }
}

/**
 * Keep one `repos.json` entry only when its identifying fields are usable.
 * @param {*} entry
 * @returns {boolean}
 */
function isRepoEntry(entry) {
  return !!entry && typeof entry === 'object'
    && typeof entry.repoKey === 'string' && entry.repoKey !== ''
    && typeof entry.gitRoot === 'string' && entry.gitRoot !== ''
    && typeof entry.otelDir === 'string' && entry.otelDir !== '';
}

/**
 * `repos.json`; a missing or malformed file reads as no repos. Malformed entries are dropped.
 * @param {{ stateDir?: string, homeDir?: string }} [opts]
 * @returns {{ version: number, repos: Array<Record<string, *>> }}
 */
function readRepos(opts = {}) {
  const parsed = readJsonObject(stateFilePath('repos', opts));
  const repos = parsed && Array.isArray(parsed.repos) ? parsed.repos.filter(isRepoEntry) : [];
  return { version: 1, repos };
}

/**
 * `forward.json` when it has a known `mode`, else `null`.
 * @param {{ stateDir?: string, homeDir?: string }} [opts]
 * @returns {Record<string, *>|null}
 */
function readForward(opts = {}) {
  const parsed = readJsonObject(stateFilePath('forward', opts));
  if (!parsed || !FORWARD_MODES.includes(parsed.mode)) return null;
  return parsed;
}

/**
 * The path form both hashes are taken over (DD-5): resolved, forward slashes, no trailing slash
 * (except a bare root), lowercased on win32.
 * @param {string} value
 * @param {string} [platform]
 * @returns {string}
 */
function normalizeForKey(value, platform = process.platform) {
  const impl = platform === 'win32' ? path.win32 : path.posix;
  let resolved = impl.resolve(String(value)).replace(/\\/g, '/');
  if (resolved.length > 1 && !/^[A-Za-z]:\/$/.test(resolved)) resolved = resolved.replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The repo identifier carried in OTLP resource attributes: first 16 hex chars of
 * sha256(normalized git root). No local path ever leaves the machine through it.
 * Twins: `otel-receiver.js`, `user-state.ts`.
 * @param {string} gitRoot
 * @param {string} [platform]
 * @returns {string}
 */
function repoKey(gitRoot, platform = process.platform) {
  return crypto.createHash('sha256').update(normalizeForKey(gitRoot, platform)).digest('hex').slice(0, 16);
}

/**
 * sha256 hex of the normalized home dir — the hello `ownerHash` (DD-9).
 * Twins: `otel-receiver.js`, `otel-ensure-receiver.js`, `user-state.ts`.
 * @param {string} home
 * @param {string} [platform]
 * @returns {string}
 */
function ownerHash(home, platform = process.platform) {
  return crypto.createHash('sha256').update(normalizeForKey(home, platform)).digest('hex');
}

module.exports = {
  REPO_ATTR_KEY,
  STATE_FILE_NAMES,
  FORWARD_MODES,
  otelStateDir,
  stateFilePath,
  readJsonObject,
  atomicWriteJson,
  readPortFile,
  readOrCreateToken,
  readRepos,
  readForward,
  normalizeForKey,
  repoKey,
  ownerHash,
};
