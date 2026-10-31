'use strict';
/**
 * Claude Code Hook helper — annotates harness-snapshot entries with their git status (not a hook
 * entry point itself).
 *
 * `annotateGitStatus` sets an optional `gitStatus` on `skills[]`, `agents[]` and
 * `systemContext.files[]` of a freshly built harness snapshot, in place, before its id is computed
 * (the id depends on it — see `computeSnapshotId` in `harness-snapshot.js`):
 *
 * - `outside-repo` — a user, plugin or org-synced skill, or an agent/context file whose path leaves
 *   the project root (`../…`). These are never asked about.
 * - `tracked` — listed by `git ls-files`.
 * - `ignored` — matched by `git check-ignore`.
 * - `untracked` — an in-root file that is neither.
 *
 * At most 2 git processes per call: `git ls-files -z` over the in-root candidates (or
 * `git rev-parse --git-dir` as a repo probe when there are none), then `git check-ignore --stdin
 * -z` over the candidates that are not tracked. Fail-open: when git is missing, fails, times out or
 * the project is not a repository, no entry gets a `gitStatus` at all, and this never throws.
 */
const { git, gitWithInput } = require('./git-context');

/** Upper bound on the joined `ls-files` pathspec arguments; over it, nothing is annotated. */
const MAX_PATHSPEC_CHARS = 24000;

/**
 * @param {string} p - a snapshot entry path
 * @returns {boolean} true when the path leaves the project root (`../…`) or is absolute
 */
function leavesRoot(p) {
  return p === '..' || p.startsWith('../') || p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
}

/**
 * @param {string} out - NUL-separated git output
 * @returns {string[]}
 */
function splitNul(out) {
  return out.split('\0').filter((s) => s.length > 0);
}

/**
 * @param {{
 *   projectRoot: string,
 *   skills?: Array<{ source?: string, path?: string, gitStatus?: string }>|null,
 *   agents?: Array<{ path?: string, gitStatus?: string }>|null,
 *   systemContext?: { files?: Array<{ path?: string, gitStatus?: string }> }|null,
 * }} options
 * @returns {void}
 */
function annotateGitStatus({ projectRoot, skills, agents, systemContext } = {}) {
  try {
    if (typeof projectRoot !== 'string' || !projectRoot) return;

    /** @type {Array<{ gitStatus?: string }>} */
    const outside = [];
    /** @type {Map<string, Array<{ gitStatus?: string }>>} */
    const candidates = new Map();
    const addCandidate = (entry) => {
      const p = entry.path;
      if (typeof p !== 'string' || !p || leavesRoot(p)) {
        outside.push(entry);
        return;
      }
      if (!candidates.has(p)) candidates.set(p, []);
      candidates.get(p).push(entry);
    };

    for (const s of Array.isArray(skills) ? skills : []) {
      if (!s || typeof s !== 'object') continue;
      if (s.source === 'project') addCandidate(s);
      else outside.push(s);
    }
    for (const a of Array.isArray(agents) ? agents : []) {
      if (a && typeof a === 'object') addCandidate(a);
    }
    const files = systemContext && Array.isArray(systemContext.files) ? systemContext.files : [];
    for (const f of files) {
      if (f && typeof f === 'object') addCandidate(f);
    }

    if (outside.length === 0 && candidates.size === 0) return;

    const paths = [...candidates.keys()];
    /** @type {Set<string>} */
    const tracked = new Set();

    if (paths.length === 0) {
      // Repo probe: without one, a non-repo project would still get `outside-repo` everywhere.
      if (git(['rev-parse', '--git-dir'], projectRoot) === null) return;
    } else {
      const pathspecs = paths.map((p) => ':(literal)' + p);
      if (pathspecs.join(' ').length > MAX_PATHSPEC_CHARS) return;
      const out = git(['ls-files', '-z', '--', ...pathspecs], projectRoot);
      if (out === null) return;
      const wanted = new Set(paths);
      for (const p of splitNul(out)) {
        if (wanted.has(p)) tracked.add(p);
      }
    }

    for (const entry of outside) entry.gitStatus = 'outside-repo';
    for (const p of tracked) {
      for (const entry of candidates.get(p)) entry.gitStatus = 'tracked';
    }

    const rest = paths.filter((p) => !tracked.has(p));
    if (rest.length === 0) return;
    const res = gitWithInput(['check-ignore', '--stdin', '-z'], projectRoot, rest.join('\0') + '\0');
    if (res.status !== 0 && res.status !== 1) return;
    const ignored = new Set(splitNul(res.stdout));
    for (const p of rest) {
      const status = ignored.has(p) ? 'ignored' : 'untracked';
      for (const entry of candidates.get(p)) entry.gitStatus = status;
    }
  } catch {
    // fail-open: a git status is a nice-to-have, never a reason to lose the snapshot
  }
}

module.exports = { annotateGitStatus, MAX_PATHSPEC_CHARS };
