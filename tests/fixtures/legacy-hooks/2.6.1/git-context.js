'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Git context helpers
// ---------------------------------------------------------------------------
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
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

// Resolves the main repo root for the given directory via `--git-common-dir`, which
// points at the shared `.git` directory even when `cwd` is inside a linked worktree
// (whereas `--show-toplevel` would resolve to the worktree's own checkout directory).
// Returns null if `cwd` is not inside a git repo at all.
function resolveRootFromCommonDir(cwd) {
  const rawCommonDir = git(['rev-parse', '--git-common-dir'], cwd);
  if (!rawCommonDir) return null;
  const absoluteCommonDir = path.resolve(cwd, rawCommonDir);
  return path.normalize(path.dirname(absoluteCommonDir));
}

// Resolves the main repo root for the given directory — for linked worktrees this is
// the primary checkout's root, not the worktree's own directory, since both share the
// same `.git` common dir (see resolveRootFromCommonDir). Falls back to cwd if not in a repo.
function getGitRoot(cwd) {
  return resolveRootFromCommonDir(cwd) || cwd;
}

function getGitContext(cwd) {
  if (!cwd) return null;

  const root = resolveRootFromCommonDir(cwd);
  if (!root) return null;

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

  return { remote: remote || null, root, branch, user };
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

module.exports = { getGitRoot, getGitContext, getWorkDirPath, ensureWorkDir };
