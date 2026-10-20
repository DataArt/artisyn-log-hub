/**
 * Identity for repositories that have no git remote.
 *
 * The hook reports a local filesystem path (`git.repo`, or the top-level `cwd` when `git` is
 * null) for a project without a remote. A bare path is not unique across users — two people can
 * both work in `C:\work\project` — so it is scoped by the uploader's email:
 *
 *   `C:\work\project`  → `muaddib@arrakis.test/C:/work/project`
 *   `/home/u/proj`     → `muaddib@arrakis.test/home/u/proj`
 *   `\\srv\share\p`    → `muaddib@arrakis.test//srv/share/p`
 *
 * The resulting identity is a fixed point of `normalizeRepoUrl` (it returns an identity
 * unchanged), so ingest and the startup backfill always agree on the stored `repo_url`.
 */

/** True when `raw` looks like an absolute local path (Windows drive, UNC, or POSIX). */
export function isRawLocalPath(raw: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(raw) || /^\\\\/.test(raw) || /^\//.test(raw);
}

/** Builds the `<email>/<path>` identity for a local path. */
export function toLocalRepoIdentity(email: string, rawPath: string): string {
  const lowerEmail = email.toLowerCase();
  let path = rawPath.replace(/\\/g, '/');
  path = path.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  const stripped = path.replace(/\/+$/, '');
  if (stripped === '') {
    // Bare POSIX root (or a run of slashes) — keep a single `/`.
    path = '/';
  } else if (/^[A-Za-z]:$/.test(stripped)) {
    // Bare drive root — keep `C:/`.
    path = `${stripped}/`;
  } else {
    path = stripped;
  }
  return path.startsWith('/') ? lowerEmail + path : `${lowerEmail}/${path}`;
}

/** True when `value` is an identity built by `toLocalRepoIdentity`. */
export function isLocalRepoIdentity(value: string): boolean {
  return /^[^\s/:@]+@[^\s/:]+\//.test(value);
}
