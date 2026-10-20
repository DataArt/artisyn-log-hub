'use strict';
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
    }).trim();
  } catch {
    return null;
  }
}

// Resolve the git repo root for the given directory. Falls back to cwd if not in a repo.
function getGitRoot(cwd) {
  const root = git(['rev-parse', '--show-toplevel'], cwd);
  return root ? path.normalize(root) : cwd;
}

function getGitContext(cwd) {
  if (!cwd) return null;

  const rawRoot = git(['rev-parse', '--show-toplevel'], cwd);
  if (!rawRoot) return null;
  const root = path.normalize(rawRoot);

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

module.exports = { getGitRoot, getGitContext };
