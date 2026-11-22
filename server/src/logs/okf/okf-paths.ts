/**
 * OKF usage — path helpers shared by the snapshot, the metadata, the team filter and the counting
 * module (`okf-usage-counting.ts`). Pure, no DB, no I/O.
 *
 * A path key is a repo-relative path with `/` separators; a folder key ends in `/` and the repo
 * root is `/`. A bundle root is stored without a trailing slash (`docs/kb`; the repo root is `.`
 * or `''`).
 */
import type { OkfOp } from './okf-usage.types';

/** One aggregated access row (a `session_okf_access` row, or a sum of them). */
export interface OkfUsageRow {
  pathKey: string;
  op: OkfOp;
  afterOwnEdit?: boolean;
  bytes: number;
  calls: number;
}

/** `true` for a folder path key (ends in `/`; the repo root is `/`). */
export function isFolderKey(pathKey: string): boolean {
  return pathKey.endsWith('/');
}

/** A bundle root as a folder-key prefix: `docs/kb` → `docs/kb/`, repo root → `''`. */
export function rootPrefix(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '' || r === '.' ? '' : `${r}/`;
}

/** The folder key of a bundle root (`docs/kb/`, repo root `/`). */
export function rootFolderKey(root: string): string {
  const p = rootPrefix(root);
  return p === '' ? '/' : p;
}

/** True when the path key (file or folder) is inside the folder prefix (`''` = everything). */
export function isUnderPrefix(pathKey: string, prefix: string): boolean {
  if (prefix === '') return true;
  return pathKey.startsWith(prefix);
}

function normaliseRoot(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '.' ? '' : r;
}

/** True when a path key (file, or folder ending in `/`) lies inside the bundle root. */
function isUnderRoot(pathKey: string, root: string): boolean {
  const r = normaliseRoot(root);
  if (r === '') return true;
  const p = pathKey === '/' ? '' : pathKey.replace(/\/+$/, '');
  return p === r || p.startsWith(`${r}/`);
}

/**
 * FR-2 (DD-S4): true when the path key, taken relative to the bundle root, has a segment starting
 * with `.` (`kb/.hidden/a.md`, `kb/.obsidian/`). The root's own segments do not count, so a bundle
 * rooted at `.claude/kb` still owns `.claude/kb/a.md`. A path outside the root is checked whole.
 */
export function isDotPathUnderRoot(pathKey: string, root: string): boolean {
  const r = normaliseRoot(root);
  const p = pathKey === '/' ? '' : pathKey.replace(/\/+$/, '');
  const rel =
    r === ''
      ? p
      : p.startsWith(`${r}/`)
        ? p.slice(r.length + 1)
        : p === r
          ? ''
          : p;
  return rel.split('/').some((seg) => seg.startsWith('.'));
}

/** FR-2 (DD-S5): `index.md` / `log.md` (any depth, any case) are reserved names, never articles. */
export function isReservedOkfName(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return base === 'index.md' || base === 'log.md';
}

/**
 * The deepest bundle whose root contains the path key, or `null`. Also `null` when the path,
 * relative to that deepest root, has a dot segment (FR-2, DD-S4): dot-path files are not part of
 * a bundle, so reading them is not KB access.
 */
export function bundleOfPath<B extends { root: string }>(
  pathKey: string,
  bundles: readonly B[] | null,
): B | null {
  if (bundles === null) return null;
  let best: B | null = null;
  let bestLen = -1;
  for (const b of bundles) {
    const len = normaliseRoot(b.root).length;
    if (len > bestLen && isUnderRoot(pathKey, b.root)) {
      best = b;
      bestLen = len;
    }
  }
  if (best !== null && isDotPathUnderRoot(pathKey, best.root)) return null;
  return best;
}

/**
 * The bundle's articles (FR-2, DD-S5): its snapshot-listed files without its `index.md`, without
 * any reserved name (`index.md` / `log.md` at any depth, {@link isReservedOkfName}) and —
 * defensively, `normaliseSnapshot` already drops them — without dot-path files. The index and the
 * logs are navigation / history, read by design, so the format checks and the hot-files list
 * leave them out. Reading them still counts as KB access.
 */
export function bundleArticles<F extends { path: string }>(bundle: {
  root?: string;
  index: string;
  files: readonly F[];
}): F[] {
  const root = bundle.root;
  return bundle.files.filter(
    (f) =>
      f.path !== bundle.index &&
      !isReservedOkfName(f.path) &&
      (root === undefined || !isDotPathUnderRoot(f.path, root)),
  );
}
