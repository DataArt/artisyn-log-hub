'use strict';
/**
 * Claude Code Hook helper — "how big is this repo's tracked codebase right now?".
 * Not a hook entry point itself; `send-logs-hook.js` calls it behind its own throttle.
 *
 * The numbers this produces are the **denominators** behind the change-surface report's
 * "share of the codebase touched" indicators. Without them the server can only say how many files
 * a session changed, never whether that is 0.5 % or 40 % of the project — and it cannot compute
 * them itself, since the repo only ever exists on the developer's machine.
 *
 * Measured with ONE git call:
 *
 *     git diff --numstat <EMPTY_TREE_SHA> HEAD
 *
 * i.e. the diff of the whole committed tree against nothing, which is every tracked file rendered
 * as a pure addition. `trackedFiles` is the row count, `trackedLines` the sum of the additions
 * column, `trackedBinaryFiles` the number of rows git reported as `-` (binary, no line count).
 * On a repo of a few thousand files this takes well under a second.
 *
 * Why not `git ls-files`: it reports the *index* (which can differ from HEAD) and
 * carries no line counts, so pairing it with a HEAD-based line total would produce two numbers on
 * two different bases — a percentage that is quietly wrong. It would also need a read of every
 * file to count lines. The numstat form reads only the object store, is git-tracked-only by
 * construction (no `node_modules`, no build output, no gitignored file can appear), and
 * needs no working-tree access at all.
 */

const { git } = require('./git-context');

/**
 * Git's well-known empty-tree object id — present in every repository without being created,
 * because it is the hash of an empty tree object and git special-cases it. Diffing against it is
 * the standard way to say "compare HEAD to nothing".
 */
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * The numstat walk is the one deliberately expensive git call in the hook (0.62 s on a
 * 1,700-file repo, and large monorepos are several times that), so it gets its own budget
 * instead of the shared 2 s default in `git-context.js`. It runs at most once per
 * `CODE_INVENTORY_THROTTLE_MS` window, inside an upload run that is already doing network I/O.
 */
const CODE_INVENTORY_GIT_TIMEOUT_MS = 10000;

/**
 * Parse `git diff --numstat` output into the three counters.
 *
 * Each row is `<added>\t<removed>\t<path>`, with `-\t-\t<path>` for a binary file. Rows that do
 * not parse are counted as files but contribute no lines — the alternative (dropping them) would
 * understate `trackedFiles`, and this function's output is a denominator, so understating it
 * inflates every percentage computed from it.
 *
 * @param {string} numstat raw stdout
 * @returns {{trackedFiles: number, trackedLines: number, trackedBinaryFiles: number}}
 */
function parseNumstat(numstat) {
  let trackedFiles = 0;
  let trackedLines = 0;
  let trackedBinaryFiles = 0;

  for (const rawLine of numstat.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    trackedFiles += 1;

    const added = line.split('\t')[0];
    if (added === '-') {
      trackedBinaryFiles += 1;
      continue;
    }
    const parsed = Number.parseInt(added, 10);
    if (Number.isFinite(parsed)) trackedLines += parsed;
  }

  return { trackedFiles, trackedLines, trackedBinaryFiles };
}

/**
 * Measure the tracked codebase at `projectRoot`'s current HEAD.
 *
 * Returns `null` — never a partial or zeroed record — when the repo cannot be measured: no git,
 * not a repository, or (the common case) a repository with no commits at all, where both git calls
 * fail. A `null` here means the caller emits no `code-inventory` event, which the server reads as
 * "no denominator available" and renders as `n/a`, rather than as a codebase of zero files that
 * would make every percentage `Infinity` or `0 %`.
 *
 * A repo whose HEAD is an empty tree is a different case and legitimately reports zeros.
 *
 * @param {string} projectRoot repo root (`getGitRoot(cwd)`)
 * @returns {{trackedFiles: number, trackedLines: number, trackedBinaryFiles: number,
 *            commitSha: string, branch: string|null, capturedAt: string}|null}
 */
function buildCodeInventory(projectRoot) {
  if (!projectRoot) return null;

  const numstat = git(
    ['diff', '--numstat', EMPTY_TREE_SHA, 'HEAD'],
    projectRoot,
    CODE_INVENTORY_GIT_TIMEOUT_MS,
  );
  // `null` is failure; `''` is a real, empty answer (a HEAD with no files) and must not be
  // conflated with it — hence the explicit null check rather than a truthiness test.
  if (numstat === null) return null;

  const commitSha = git(['rev-parse', 'HEAD'], projectRoot);
  if (!commitSha) return null;

  // Empty on a detached HEAD, which is a normal state, not a failure — reported as `null`.
  const branch = git(['branch', '--show-current'], projectRoot);

  return {
    ...parseNumstat(numstat),
    commitSha,
    branch: branch ? branch : null,
    capturedAt: new Date().toISOString(),
  };
}

module.exports = {
  EMPTY_TREE_SHA,
  CODE_INVENTORY_GIT_TIMEOUT_MS,
  buildCodeInventory,
};
