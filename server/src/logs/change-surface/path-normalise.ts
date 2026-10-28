/**
 * Change surface — path normalisation and row identity.
 *
 * A transcript records whatever spelling the tool call used: `D:\a\repo\src\X.ts` from
 * a Windows session, `/home/u/repo/src/x.ts` from a container, `~/.claude/settings.json`
 * for a file that is not in the repo at all. Every change-surface number is computed
 * over *logical* paths, so all of that has to collapse to one identity first.
 *
 * The root rules here are shared with `session_file_stats`' Read-path categories:
 * `normaliseReadPath()` in `claude-extractor.ts` strips a known root through
 * {@link stripRepoRootPreservingCase}, and keeps a path outside every root absolute.
 * Only when no root was ever learned does it fall back to `normaliseFilePath()` /
 * `KNOWN_TOP_LEVEL_DIRS`, which guesses a repo-relative path from a known-directory
 * list. Change surface itself never guesses — it strips a repo root it was actually
 * told about, and honestly reports everything else as out-of-repo.
 */

/**
 * Hard cap on the two `varchar(1024)` columns (`path_key`, `raw_path`).
 *
 * `(session_id, path_key)` carries a btree unique index, and Postgres refuses an index
 * row larger than 2704 bytes — so the key has to be bounded before it reaches the
 * index, not after.
 */
export const CHANGED_PATH_MAX_LENGTH = 1024;

/** Truncate a stored path value to {@link CHANGED_PATH_MAX_LENGTH} characters. */
export function truncateChangedPath(value: string): string {
  return value.length > CHANGED_PATH_MAX_LENGTH
    ? value.slice(0, CHANGED_PATH_MAX_LENGTH)
    : value;
}

/** What {@link normaliseChangedPath} yields for one raw path. */
export interface NormalisedChangedPath {
  /**
   * The row identity — `NOT NULL` by construction. Equals `relPathKey` when the path
   * normalised, and the slash-normalised, case-folded raw path otherwise, so two
   * spellings of one logical file can never become two rows (and never double-count
   * their lines, which would break the `sum(leaf +) === root +` identity).
   */
  pathKey: string;
  /** Repo-relative path in its **original case** — this is what gets displayed. */
  relPath: string | null;
  /** Case-folded `relPath` — identity and `GROUP BY`, never display. */
  relPathKey: string | null;
  /** Display folder; `'.'` for a file sitting directly at the repo root. */
  folder: string | null;
  /** Case-folded `folder`. */
  folderKey: string | null;
  /** Case-folded first segment; `'.'` for a repo-root file. */
  topModuleKey: string | null;
  /** Segment count of `folder` (`0` for `'.'`). */
  depth: number | null;
  /**
   * `true` only when a repo root **was** known and the path sits outside all of them.
   * With no known root nothing can be decided, so this stays `false` and the caller
   * leaves `cs_computed_at` `NULL` — "no data", never a fabricated `0`.
   */
  outsideRepo: boolean;
}

/** Backslashes to forward slashes; nothing else is rewritten. */
function toPosix(value: string): string {
  return value.replace(/\\/g, '/');
}

/** Slash-normalise a candidate root and drop its trailing slash. */
function normaliseRoot(root: string): string {
  const posix = toPosix(root).trim();
  // A bare `/` (or `C:/`) has nothing to strip beyond the separator itself.
  return posix.length > 1 && posix.endsWith('/')
    ? posix.slice(0, -1)
    : posix === '/'
      ? ''
      : posix;
}

/**
 * Strip the **longest** candidate root that matches on a `/` boundary.
 *
 * Longest-match is what makes linked worktrees work: `getGitRoot()` resolves via
 * `--git-common-dir` and therefore returns the *primary* checkout's root, so a session
 * run inside a worktree uploads both roots and the deeper one has to win. The `/`
 * boundary is what keeps root `…/repo` from swallowing `…/repoX/file.ts`.
 */
function stripLongestRoot(
  posixPath: string,
  roots: readonly string[],
): string | null {
  const lowerPath = posixPath.toLowerCase();
  let bestRootLength = -1;
  let best: string | null = null;
  for (const root of roots) {
    const prefix = `${root.toLowerCase()}/`;
    if (!lowerPath.startsWith(prefix)) continue;
    const rest = posixPath.slice(prefix.length);
    if (rest.length === 0) continue; // the root directory itself, not a file
    if (root.length > bestRootLength) {
      bestRootLength = root.length;
      best = rest;
    }
  }
  return best;
}

/** Drop `./` segments and empty segments left by `//` or a leading slash. */
function cleanSegments(relPath: string): string[] {
  return relPath.split('/').filter((seg) => seg.length > 0 && seg !== '.');
}

/**
 * The candidate roots that can actually be stripped: slash-normalised, trailing slash
 * dropped, and empty / bare-`/` / non-string entries removed. An empty result means the
 * repo root is unknown.
 */
export function usableRepoRoots(
  candidateRoots: readonly (string | null | undefined)[] | null | undefined,
): string[] {
  return (candidateRoots ?? [])
    .map((root) => (typeof root === 'string' ? normaliseRoot(root) : ''))
    .filter((root) => root.length > 0);
}

/**
 * Strip the longest matching candidate root from a raw path and return the repo-relative
 * remainder in its **original case**, or `null` when nothing matched.
 *
 * Same matching rules as {@link normaliseChangedPath} — backslashes become `/`, roots are
 * slash-normalised with empties dropped, matching is case-insensitive on a `/` boundary,
 * the longest root wins, and empty / `.` segments are dropped — but without the
 * case-folded identity columns. `null` covers: no usable root, a path outside every root,
 * and the root directory itself (no segments left).
 */
export function stripRepoRootPreservingCase(
  rawPath: string,
  candidateRoots: readonly (string | null | undefined)[],
): string | null {
  const roots = usableRepoRoots(candidateRoots);
  if (roots.length === 0) return null;

  const stripped = stripLongestRoot(toPosix(rawPath ?? ''), roots);
  if (stripped === null) return null;

  const segments = cleanSegments(stripped);
  return segments.length === 0 ? null : segments.join('/');
}

/** The un-normalisable outcome, shared by the two "nothing to strip" branches. */
function unnormalised(
  posixPath: string,
  outsideRepo: boolean,
): NormalisedChangedPath {
  return {
    pathKey: truncateChangedPath(posixPath.toLowerCase()),
    relPath: null,
    relPathKey: null,
    folder: null,
    folderKey: null,
    topModuleKey: null,
    depth: null,
    outsideRepo,
  };
}

/**
 * Normalise one raw changed path against the session's candidate repo roots.
 *
 * `candidateRoots` is an array because a session inside a linked worktree has two
 * legitimate roots (see {@link stripLongestRoot}); passing a single root is just the
 * one-element case. Passing none — the repo root was never learned, because the
 * artisyn log has not arrived or predates the hook that uploads it — returns the
 * unnormalised shape with `outsideRepo: false`, which is the caller's signal to leave
 * the session un-computed rather than to report zeroes.
 *
 * The raw path is matched at full length and only the *outputs* are truncated, so a
 * very long path still resolves against its root correctly.
 */
export function normaliseChangedPath(
  rawPath: string,
  candidateRoots?: readonly (string | null | undefined)[] | null,
): NormalisedChangedPath {
  const posixPath = toPosix(rawPath ?? '');

  const roots = usableRepoRoots(candidateRoots);

  // No root was ever learned: `outsideRepo` would be a guess, so we do not make one.
  if (roots.length === 0) return unnormalised(posixPath, false);

  const stripped = stripLongestRoot(posixPath, roots);
  if (stripped === null) return unnormalised(posixPath, true);

  const segments = cleanSegments(stripped);
  if (segments.length === 0) return unnormalised(posixPath, true);

  const relPath = segments.join('/');
  const folderSegments = segments.slice(0, -1);
  const folder = folderSegments.length === 0 ? '.' : folderSegments.join('/');
  const folderKey = folder.toLowerCase();
  const relPathKey = relPath.toLowerCase();

  return {
    pathKey: truncateChangedPath(relPathKey),
    relPath,
    relPathKey,
    folder,
    folderKey,
    topModuleKey: folderSegments.length === 0 ? '.' : folderKey.split('/')[0],
    depth: folderSegments.length,
    outsideRepo: false,
  };
}

/** `/d/x/…` (Git Bash / MSYS spelling of a Windows drive path) → `D:/x/…`; anything else as is. */
function msysToWindows(posixPath: string): string | null {
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(posixPath);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : null;
}

/** Resolve `.` / `..` segments of a slash-normalised absolute path (no filesystem access). */
function collapseDots(posixPath: string): string {
  const leadingSlash = posixPath.startsWith('/');
  const out: string[] = [];
  for (const seg of posixPath.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      // Never climb above a drive letter (`D:`) or the filesystem root.
      if (out.length > 0 && !/^[a-zA-Z]:$/.test(out[out.length - 1])) out.pop();
      continue;
    }
    out.push(seg);
  }
  return (leadingSlash ? '/' : '') + out.join('/');
}

/**
 * Repo-relative path of an **absolute** path, in its original case, or `null` (OKF usage, FR-2).
 *
 * Backslashes become `/`, `.` / `..` segments are resolved, then the longest matching candidate
 * root is stripped with the {@link stripRepoRootPreservingCase} rules (case-insensitive, `/`
 * boundary). A Git Bash spelling `/d/repo/…` is retried as `D:/repo/…` when it matches no root.
 *
 * Returns `''` for the repo root itself (so a caller can key the root folder), the relative path
 * without leading or trailing slash otherwise, and `null` when the session has no usable root or
 * the path is outside every root — nothing is stored then.
 */
export function resolveRepoPath(
  absPath: string,
  candidateRoots: readonly (string | null | undefined)[] | null | undefined,
): string | null {
  const roots = usableRepoRoots(candidateRoots);
  if (roots.length === 0 || typeof absPath !== 'string') return null;

  const tryOne = (posixPath: string): string | null => {
    const trimmed =
      posixPath.length > 1 && posixPath.endsWith('/')
        ? posixPath.slice(0, -1)
        : posixPath;
    const lower = trimmed.toLowerCase();
    if (roots.some((root) => root.toLowerCase() === lower)) return '';
    return stripRepoRootPreservingCase(trimmed, roots);
  };

  const collapsed = collapseDots(toPosix(absPath.trim()));
  const direct = tryOne(collapsed);
  if (direct !== null) return direct;
  const windows = msysToWindows(collapsed);
  return windows === null ? null : tryOne(windows);
}
