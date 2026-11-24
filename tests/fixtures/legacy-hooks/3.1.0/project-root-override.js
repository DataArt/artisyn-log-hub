'use strict';
/**
 * Shared utility — an explicit project root that replaces git's main-checkout root.
 *
 * By default the hook treats a linked git worktree as part of its main checkout: the project root
 * is the parent of `git rev-parse --git-common-dir`, so config, the work dir and the uploaded
 * `git.root` all point at the primary checkout. That is wrong when the worktree is the only part of
 * the repo a session can see — e.g. a dev sandbox container that mounts one worktree plus the
 * shared `.git`. Setting `ARTISYN_PROJECT_ROOT` to that worktree makes the hook treat it as the
 * project root instead. Hook processes inherit Claude Code's environment, so the variable is
 * visible here.
 *
 * The override applies only when `cwd` is the root itself or inside it: a container-wide variable
 * must not redirect child processes that run in unrelated repos (test fixtures, scratch repos).
 * Every root resolution goes through `git-context.js`'s `resolveRootFromCommonDir`, which consults
 * this helper first — do not read the variable anywhere else.
 */
const path = require('path');

/**
 * `$ARTISYN_PROJECT_ROOT` (resolved and normalized) when set, non-blank and containing `cwd`,
 * else `null`.
 * @param {string} cwd
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|null}
 */
function projectRootOverride(cwd, env = process.env) {
  const v = typeof env.ARTISYN_PROJECT_ROOT === 'string' ? env.ARTISYN_PROJECT_ROOT.trim() : '';
  if (!v || !cwd) return null;
  const root = path.normalize(path.resolve(v));
  const rel = path.relative(root, path.resolve(cwd));
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return root;
}

module.exports = { projectRootOverride };
