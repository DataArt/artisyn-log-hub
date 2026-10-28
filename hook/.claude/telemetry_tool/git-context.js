'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { projectRootOverride } = require('./project-root-override');

// ---------------------------------------------------------------------------
// Git context helpers
// ---------------------------------------------------------------------------
// Default budget for the small, near-instant `git` calls this module makes (rev-parse, remote
// get-url, config). Deliberately short: these run on the hot path of every hook invocation, and a
// hung git is worse than a missing value.
const GIT_DEFAULT_TIMEOUT_MS = 2000;

/**
 * Run one `git` command and return its trimmed stdout, or `null` on any failure.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {number} [timeoutMs] budget for this call; defaults to `GIT_DEFAULT_TIMEOUT_MS`. Raise it
 *   only for a call that is expensive by design — `code-inventory.js`'s whole-history `--numstat`
 *   measures ~0.6 s on a 1,700-file repo and is given 10 s, whereas the default must stay short
 *   because every hook invocation pays it.
 * @returns {string|null}
 */
function git(args, cwd, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      // Not cosmetic on Windows, and not optional: this also runs inside detached background
      // processes — prompt-upload-hook.js reaches it through loadConfig()/getGitRoot() on every
      // prompt past the throttle — which spawn-hidden.js starts with DETACHED_PROCESS and therefore
      // no console. With no console to inherit, Windows allocates a brand-new *visible* one for this
      // git.exe: a console window flashing on the user's screen. `windowsHide` (CREATE_NO_WINDOW) is
      // what suppresses it. Pinned by __tests__/no-visible-window.test.js — do not drop it.
      windowsHide: true,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Run one `git` command that reads `input` on stdin, and return its exit status and raw stdout.
 * Unlike {@link git} it never collapses a non-zero exit into `null`: some commands report a
 * meaningful answer through the exit code (`git check-ignore` exits 1 for "nothing ignored").
 * Never throws.
 *
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} input - written to git's stdin
 * @param {number} [timeoutMs] budget for this call; defaults to `GIT_DEFAULT_TIMEOUT_MS`
 * @returns {{ status: number|null, stdout: string }} `status` is the exit code, or `null` when git
 *   could not be started, timed out or was killed by a signal; `stdout` is untrimmed (may be '')
 */
function gitWithInput(args, cwd, input, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      // See git() above: required so a detached hook process never flashes a console window.
      windowsHide: true,
    });
    return { status: 0, stdout: typeof stdout === 'string' ? stdout : '' };
  } catch (err) {
    const status = err && typeof err.status === 'number' ? err.status : null;
    const stdout = err && typeof err.stdout === 'string' ? err.stdout : '';
    return { status, stdout };
  }
}

// Resolves the project root for the given directory. An `ARTISYN_PROJECT_ROOT` override that
// contains `cwd` wins (see project-root-override.js) — then a linked worktree is its own project
// root, which is what a sandbox that sees only that worktree needs. Otherwise it is the main repo
// root via `--git-common-dir`, which points at the shared `.git` directory even when `cwd` is
// inside a linked worktree (whereas `--show-toplevel` would resolve to the worktree's own checkout
// directory). Returns null if there is no override and `cwd` is not inside a git repo at all.
// Every root lookup in the hook goes through here, so getGitRoot, getGitContext().root and
// getWorkDirPath always agree.
function resolveRootFromCommonDir(cwd) {
  const override = projectRootOverride(cwd);
  if (override) return override;
  const rawCommonDir = git(['rev-parse', '--git-common-dir'], cwd);
  if (!rawCommonDir) return null;
  const absoluteCommonDir = path.resolve(cwd, rawCommonDir);
  return path.normalize(path.dirname(absoluteCommonDir));
}

// Resolves the project root for the given directory — for linked worktrees this is
// the primary checkout's root, not the worktree's own directory, since both share the
// same `.git` common dir, unless `ARTISYN_PROJECT_ROOT` overrides it (see
// resolveRootFromCommonDir). Falls back to cwd if not in a repo.
function getGitRoot(cwd) {
  return resolveRootFromCommonDir(cwd) || cwd;
}

/**
 * Remove `user[:password]@` from a URL-scheme remote (`https://user:token@host/repo.git` →
 * `https://host/repo.git`) so a credential embedded in the remote never leaves the machine.
 * scp-like remotes (`git@host:org/repo.git`) carry no secret in that position and are returned
 * unchanged, as is anything that is not a string.
 * @param {string|null} url
 * @returns {string|null}
 */
function stripRemoteUserinfo(url) {
  if (typeof url !== 'string') return url;
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(url);
  if (!scheme) return url;
  const rest = url.slice(scheme[0].length);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const at = authority.lastIndexOf('@');
  if (at === -1) return url;
  return scheme[0] + rest.slice(at + 1);
}

function getGitContext(cwd) {
  if (!cwd) return null;

  const root = resolveRootFromCommonDir(cwd);
  if (!root) return null;

  // The *worktree's own* checkout directory, which differs from `root` only inside a linked
  // worktree without an `ARTISYN_PROJECT_ROOT` override (with the override pointing at the
  // worktree, `root` already is the worktree and the two are equal). Both are uploaded: a transcript's absolute `file_path`s
  // are written under whichever of the two the session actually ran in, so path normalisation
  // needs both candidates to pick the longest match.
  // `path.normalize` so it comes out in the same separator style as `root` (git reports
  // `D:/a/b` on Windows, `resolveRootFromCommonDir` reports `D:\a\b`); the server slash-normalises
  // both anyway, but two spellings of the same machine's roots in one payload read as a bug.
  const rawWorktreeRoot = git(['rev-parse', '--show-toplevel'], cwd);
  const worktreeRoot = rawWorktreeRoot ? path.normalize(rawWorktreeRoot) : null;

  const originUrl = git(['remote', 'get-url', 'origin'], cwd);
  const branch = git(['branch', '--show-current'], cwd);
  const user = git(['config', 'user.name'], cwd);
  const remoteList = git(['remote'], cwd);

  // Fall back to first available remote if 'origin' is not configured
  let remote = originUrl;
  if (!remote && remoteList) {
    const firstRemote = remoteList.split('\n')[0].trim();
    remote = firstRemote ? git(['remote', 'get-url', firstRemote], cwd) : null;
  }

  return { remote: stripRemoteUserinfo(remote) || null, root, worktreeRoot, branch, user };
}

// Path to the hook's runtime data directory (logs, recommendations, telemetry),
// nested under .artisyn/ alongside the plugin marketplace/config trees rather than
// sitting bare at the repo root.
function getWorkDirPath(cwd) {
  return path.join(getGitRoot(cwd || process.cwd()), '.artisyn', 'ai_work_dir');
}

// Ensures the work dir exists and is git-ignored (a local `.gitignore` inside the
// dir itself, rather than relying on the consuming repo's root .gitignore to know
// about it), then returns its path. Best-effort — a failure here must never break
// hook execution, since this runs on the hot path of every hook invocation.
function ensureWorkDir(cwd) {
  const dir = getWorkDirPath(cwd);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const gitignorePath = path.join(dir, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, '*\n!.gitignore\n');
    }
  } catch {
    // best-effort
  }
  return dir;
}

module.exports = {
  GIT_DEFAULT_TIMEOUT_MS,
  git,
  gitWithInput,
  getGitRoot,
  getGitContext,
  stripRemoteUserinfo,
  getWorkDirPath,
  ensureWorkDir,
};
