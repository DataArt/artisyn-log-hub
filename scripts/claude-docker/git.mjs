// Git helpers for the sandbox launcher: version check, branch queries, worktree add/remove,
// pending work and the merged check (DD-5), branch deletion and the host identity (DD-8).
// Every call is a synchronous spawnSync against the main repo (`git -C <repoRoot>`).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { MIN_GIT_VERSION, resolvePaths } from './config.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;

/** Runs git; returns { status, stdout, stderr }. Throws on spawn errors, and on a non-zero exit unless allowFail. */
function git(args, { cwd, allowFail = false } = {}) {
  const dir = cwd ?? resolvePaths().repoRoot;
  const res = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (res.error) throw new Error(`git ${args.join(' ')} failed to run: ${res.error.message}`);
  const out = { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
  if (out.status !== 0 && !allowFail) {
    const msg = (out.stderr || out.stdout).trim();
    const err = new Error(`git ${args.join(' ')} exited with ${out.status}${msg ? `:\n${msg}` : ''}`);
    err.status = out.status;
    err.stderr = out.stderr;
    throw err;
  }
  return out;
}

function lines(text) {
  return text.split(/\r?\n/).filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Version and branch queries
// ---------------------------------------------------------------------------------------------

/** Parses `git version 2.56.0.windows.2` into [2, 56, 0]; null when unrecognised. */
export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text || '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

function versionAtLeast(v, min) {
  for (let i = 0; i < min.length; i++) {
    if (v[i] !== min[i]) return v[i] > min[i];
  }
  return true;
}

/** Exits the process with a message unless git >= 2.48 (needed for `worktree add --relative-paths`). */
export function assertGitVersion() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  const want = MIN_GIT_VERSION.join('.');
  if (res.error || res.status !== 0) {
    process.stderr.write(`git was not found on PATH; claude-docker needs git ${want} or newer.\n`);
    process.exit(1);
  }
  const v = parseGitVersion(res.stdout);
  if (!v || !versionAtLeast(v, MIN_GIT_VERSION)) {
    process.stderr.write(
      `claude-docker needs git ${want} or newer (for worktree --relative-paths); found: ${res.stdout.trim() || 'unknown'}.\n`,
    );
    process.exit(1);
  }
  return v;
}

/** True when refs/heads/<branch> exists. */
export function branchExists(branch) {
  if (!branch) return false;
  return git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).status === 0;
}

/** True when `ref` names a local branch (with or without the refs/heads/ prefix). */
export function isLocalBranch(ref) {
  if (!ref) return false;
  return branchExists(ref.replace(/^refs\/heads\//, ''));
}

/** The current branch of the main checkout, or null on a detached HEAD. */
export function currentBranch(cwd) {
  const out = git(['branch', '--show-current'], { cwd }).stdout.trim();
  return out || null;
}

/** The commit sha `ref` resolves to, or null when it does not resolve. */
export function revParse(ref, cwd) {
  const res = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, allowFail: true });
  return res.status === 0 ? res.stdout.trim() : null;
}

// ---------------------------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------------------------

/**
 * Creates the worktree (DD-16 step 4):
 *   git -c core.autocrlf=input worktree add --relative-paths [-b <branch>] <wt> [<from>|<branch>]
 * With create, a new branch is made from `from` (default: the main checkout's HEAD); otherwise the
 * existing branch is checked out. On failure, the error message is git's stderr verbatim (e.g. the
 * "already checked out" / "already used by worktree" refusal), with err.gitRefusal = true.
 * Returns { createdFrom }: the branch tip right after creation.
 */
export function addWorktree({ wt, branch, from, create }) {
  const args = ['-c', 'core.autocrlf=input', 'worktree', 'add', '--relative-paths'];
  if (create) {
    args.push('-b', branch, wt);
    if (from) args.push(from);
  } else {
    args.push(wt, branch);
  }
  const res = git(args, { allowFail: true });
  if (res.status !== 0) {
    const err = new Error(res.stderr.trim() || `git worktree add exited with ${res.status}`);
    err.gitRefusal = true;
    err.status = res.status;
    throw err;
  }
  return { createdFrom: revParse(`refs/heads/${branch}`) };
}

function isGoneError(stderr) {
  return /is not a working tree|not a valid path|does not exist|no such file/i.test(stderr || '');
}

/**
 * `git worktree remove [--force] <wt>`; tolerant of the worktree already being gone.
 * Returns { removed: boolean }. Throws on a real refusal (e.g. a dirty tree without force).
 */
export function removeWorktree(wt, force = false) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wt);
  const res = git(args, { allowFail: true });
  if (res.status === 0) return { removed: true };
  if (!fs.existsSync(wt) || isGoneError(res.stderr)) return { removed: false };
  const err = new Error(res.stderr.trim() || `git worktree remove exited with ${res.status}`);
  err.status = res.status;
  throw err;
}

/** `git worktree move <from> <to>`, keeping the links relative (as `worktree add --relative-paths`). */
export function moveWorktree(from, to) {
  git(['-c', 'worktree.useRelativePaths=true', 'worktree', 'move', from, to]);
}

/** `git worktree prune`; drops admin entries of worktrees whose dirs are gone. */
export function worktreePrune() {
  git(['worktree', 'prune'], { allowFail: true });
}

// ---------------------------------------------------------------------------------------------
// Pending work and merged check (DD-5)
// ---------------------------------------------------------------------------------------------

/** `git merge-base --is-ancestor <branch> <base>` against the base's current tip. */
export function isMerged(branch, base) {
  if (!branch || !base || !branchExists(branch) || !branchExists(base)) return false;
  const res = git(['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`], { allowFail: true });
  return res.status === 0;
}

function localBranches() {
  return lines(git(['for-each-ref', '--format=%(refname)', 'refs/heads']).stdout);
}

/** Commits of <branch> not reachable from <base>, or (no base) from any other local branch. */
function unmergedCommits(branch, base) {
  const ref = `refs/heads/${branch}`;
  if (base && branchExists(base)) {
    return Number(git(['rev-list', '--count', `refs/heads/${base}..${ref}`]).stdout.trim()) || 0;
  }
  const others = localBranches().filter((r) => r !== ref);
  const args = ['rev-list', '--count', ref];
  if (others.length > 0) args.push('--not', ...others);
  return Number(git(args).stdout.trim()) || 0;
}

/**
 * Pending work of a sandbox (DD-5):
 *   files     — line count of `git -C <wt> status --porcelain` (0 when the worktree is gone);
 *   commits   — unmerged commits (see unmergedCommits);
 *   merged    — branch is an ancestor of its base (false without a base);
 *   noCommits — the branch tip still equals createdFrom.
 */
export function pendingWork(state) {
  const { branch, base, worktree, createdFrom } = state;
  let files = 0;
  if (worktree && fs.existsSync(worktree)) {
    files = lines(git(['status', '--porcelain'], { cwd: worktree }).stdout).length;
  }
  if (!branch || !branchExists(branch)) {
    return { files, commits: 0, merged: false, noCommits: false };
  }
  const tip = revParse(`refs/heads/${branch}`);
  return {
    files,
    commits: unmergedCommits(branch, base),
    merged: base ? isMerged(branch, base) : false,
    noCommits: Boolean(createdFrom) && tip === createdFrom,
  };
}

// ---------------------------------------------------------------------------------------------
// Branch deletion and identity
// ---------------------------------------------------------------------------------------------

/**
 * `git branch -d <branch>`. Never throws on a git refusal: returns { deleted: true } on success,
 * { deleted: false, gone: true } when the branch does not exist, or { deleted: false, message }
 * with git's refusal (e.g. "not fully merged") verbatim.
 */
export function deleteBranch(branch) {
  if (!branchExists(branch)) return { deleted: false, gone: true, message: `branch ${branch} does not exist` };
  const res = git(['branch', '-d', branch], { allowFail: true });
  if (res.status === 0) return { deleted: true };
  return { deleted: false, message: (res.stderr || res.stdout).trim() };
}

/** The host `git config user.name` / `user.email` ('' when unset). */
export function hostGitIdentity() {
  const get = (key) => git(['config', '--get', key], { allowFail: true }).stdout.trim();
  return { name: get('user.name'), email: get('user.email') };
}

/** The identity keys that are empty on the host (DD-8: create/start refuse while any is missing). */
export function missingIdentityKeys(identity = hostGitIdentity()) {
  const missing = [];
  if (!identity.name) missing.push('user.name');
  if (!identity.email) missing.push('user.email');
  return missing;
}
