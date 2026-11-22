/**
 * The OKF explorer tree, built on the client from the response's `files[]` and `folders[]`. Pure:
 * it only sums server values.
 *
 * Roots are the bundle roots in ascending order (a KB folder nested in another is its own root;
 * the outer one does not include it), then "Not in this snapshot" — a flat list of files that
 * were read but are not in the snapshot. Inside a folder: the search row, sub-folders ascending,
 * files ascending. A folder's "X of Y files opened" and tokens are sums over its in-snapshot
 * files (tokens also add the folder-level searches on it and below); its unit count is the
 * server's `folders[].units`.
 */
import type {
  OkfUsageFile,
  OkfUsageFolder,
  OkfUsageFolderSearch,
} from '../../../../../models/repositories';
import { OKF_ROOT_BUNDLE_LABEL } from './okf-view-text';

export type OkfExplorerFilter = 'all' | 'opened' | 'never';

export type OkfExplorerRowKind =
  | 'bundle'
  | 'folder'
  | 'file'
  | 'search'
  | 'missing-root';

export interface OkfExplorerFolderNode {
  /** Bundle root as the server sends it (no trailing slash). */
  bundle: string;
  /** Folder key ending in `/` (the repo root is `/`). */
  path: string;
  /** Text of the row: the bundle root, or the path below the parent folder. */
  label: string;
  isBundleRoot: boolean;
  units: number;
  search: OkfUsageFolderSearch | null;
  folders: OkfExplorerFolderNode[];
  files: OkfUsageFile[];
  /** Sums over the in-snapshot files of the subtree. */
  filesTotal: number;
  filesOpened: number;
  /** Tokens of those files plus the folder-level searches on it and below. */
  tokens: number;
  /** True when the folder or one below has folder-level searches. */
  hasSearch: boolean;
}

export interface OkfExplorerTree {
  roots: OkfExplorerFolderNode[];
  /** Files with reads that are not in the snapshot, ascending by path. */
  missing: OkfUsageFile[];
  missingTokens: number;
  /** Header numbers: sums over the bundle roots. */
  filesOpened: number;
  filesTotal: number;
}

/** One visible row of the explorer. */
export interface OkfExplorerRow {
  kind: OkfExplorerRowKind;
  /** Unique key, also the key of the open / closed state of an expandable row. */
  key: string;
  /**
   * `data-path`: the file path, the folder key (ends in `/`), the bundle root for a bundle and
   * for the "Not in this snapshot" root an empty string.
   */
  path: string;
  label: string;
  depth: number;
  opened: boolean;
  expandable: boolean;
  expanded: boolean;
  /** Bundle root of a `bundle` row (for the "not in git" chip). */
  bundle?: string;
  /** Folder rows: in-snapshot files below. */
  filesTotal?: number;
  filesOpened?: number;
  /** "Not in this snapshot" root: the number of files in it. */
  fileCount?: number;
  /** null = no number (a never-opened file). */
  units: number | null;
  tokens: number | null;
}

/** Key of the "Not in this snapshot" root row. */
export const OKF_MISSING_ROOT_KEY = 'missing-root';

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Folder-key prefix of a bundle root: `docs/kb` → `docs/kb/`, the repo root → `''`. */
function rootPrefix(root: string): string {
  const r = root.replace(/\/+$/, '');
  return r === '' || r === '.' ? '' : `${r}/`;
}

/** Folder key of a bundle root (`docs/kb/`, the repo root `/`). */
function rootFolderKey(root: string): string {
  const p = rootPrefix(root);
  return p === '' ? '/' : p;
}

/** Parent folder key of a file path or folder key; `''` at the top. */
function parentFolder(pathKey: string): string {
  const trimmed = pathKey.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx < 0 ? '' : trimmed.slice(0, idx + 1);
}

function nodeKey(bundle: string, path: string): string {
  return `${bundle}\n${path}`;
}

/** Builds the tree: links folders inside their bundle, attaches files and sums the numbers. */
export function buildOkfExplorerTree(
  files: readonly OkfUsageFile[],
  folders: readonly OkfUsageFolder[],
): OkfExplorerTree {
  const nodes = new Map<string, OkfExplorerFolderNode>();
  const ensure = (bundle: string, path: string): OkfExplorerFolderNode => {
    const key = nodeKey(bundle, path);
    let node = nodes.get(key);
    if (node === undefined) {
      node = {
        bundle,
        path,
        label: path,
        isBundleRoot: path === rootFolderKey(bundle),
        units: 0,
        search: null,
        folders: [],
        files: [],
        filesTotal: 0,
        filesOpened: 0,
        tokens: 0,
        hasSearch: false,
      };
      nodes.set(key, node);
    }
    return node;
  };

  for (const f of folders) {
    const node = ensure(f.bundle, f.path);
    node.units = f.units;
    node.search = f.search;
  }

  /** The nearest listed folder at or above `start` inside the bundle; the bundle root at last. */
  const nearest = (bundle: string, start: string): OkfExplorerFolderNode => {
    const rootKey = rootFolderKey(bundle);
    const prefix = rootPrefix(bundle);
    let cur = start;
    while (cur !== '' && cur.length > prefix.length && cur.startsWith(prefix)) {
      const found = nodes.get(nodeKey(bundle, cur));
      if (found !== undefined) return found;
      cur = parentFolder(cur);
    }
    return ensure(bundle, rootKey);
  };

  const missing: OkfUsageFile[] = [];
  for (const file of files) {
    if (!file.inSnapshot) {
      missing.push(file);
      continue;
    }
    nearest(file.bundle, parentFolder(file.path)).files.push(file);
  }

  const roots: OkfExplorerFolderNode[] = [];
  for (const node of [...nodes.values()]) {
    if (node.isBundleRoot) continue;
    const parent = nearest(node.bundle, parentFolder(node.path));
    parent.folders.push(node);
    const parentPrefix = parent.isBundleRoot
      ? rootPrefix(parent.bundle)
      : parent.path;
    node.label = node.path.slice(parentPrefix.length).replace(/\/+$/, '');
  }
  for (const node of nodes.values()) {
    if (!node.isBundleRoot) continue;
    const root = node.bundle.replace(/\/+$/, '');
    node.label = root === '' || root === '.' ? OKF_ROOT_BUNDLE_LABEL : root;
    roots.push(node);
  }

  const sum = (node: OkfExplorerFolderNode): void => {
    node.folders.sort((a, b) => byCodeUnit(a.path, b.path));
    node.files.sort((a, b) => byCodeUnit(a.path, b.path));
    node.filesTotal = node.files.length;
    node.filesOpened = 0;
    node.tokens = node.search?.tokens ?? 0;
    node.hasSearch = node.search !== null;
    for (const file of node.files) {
      if (file.units > 0) node.filesOpened += 1;
      node.tokens += file.tokens;
    }
    for (const child of node.folders) {
      sum(child);
      node.filesTotal += child.filesTotal;
      node.filesOpened += child.filesOpened;
      node.tokens += child.tokens;
      node.hasSearch = node.hasSearch || child.hasSearch;
    }
  };
  roots.sort((a, b) => byCodeUnit(a.path, b.path));
  let filesOpened = 0;
  let filesTotal = 0;
  for (const root of roots) {
    sum(root);
    filesOpened += root.filesOpened;
    filesTotal += root.filesTotal;
  }

  missing.sort((a, b) => byCodeUnit(a.path, b.path));
  return {
    roots,
    missing,
    missingTokens: missing.reduce((s, f) => s + f.tokens, 0),
    filesOpened,
    filesTotal,
  };
}

/** Counts of the three filter chips. */
export function okfExplorerCounts(tree: OkfExplorerTree): {
  opened: number;
  never: number;
} {
  return {
    opened: tree.filesOpened,
    never: tree.filesTotal - tree.filesOpened,
  };
}

function folderVisible(
  node: OkfExplorerFolderNode,
  filter: OkfExplorerFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'opened') return node.filesOpened > 0 || node.hasSearch;
  return node.filesTotal - node.filesOpened > 0;
}

function fileVisible(file: OkfUsageFile, filter: OkfExplorerFilter): boolean {
  if (filter === 'all') return true;
  return filter === 'opened' ? file.units > 0 : file.units === 0;
}

/** Key of a folder row in the open / closed state. */
export function okfExplorerFolderKey(node: {
  bundle: string;
  path: string;
}): string {
  return `folder:${node.bundle}:${node.path}`;
}

/**
 * The visible rows for a filter and a set of open rows, top to bottom. Under "Never opened" a
 * folder's `filesOpened` / `filesTotal` still describe the whole folder (the row shows their
 * difference), search rows are left out and "Not in this snapshot" is hidden. A bundle root with
 * nothing to show under "Opened" / "Never opened" is left out.
 */
export function okfExplorerRows(
  tree: OkfExplorerTree,
  filter: OkfExplorerFilter,
  open: ReadonlySet<string>,
  missingUnits: number,
): OkfExplorerRow[] {
  const rows: OkfExplorerRow[] = [];

  const fileRow = (
    file: OkfUsageFile,
    depth: number,
    label: string,
  ): OkfExplorerRow => {
    const opened = file.units > 0;
    return {
      kind: 'file',
      key: `file:${file.path}`,
      path: file.path,
      label,
      depth,
      opened,
      expandable: false,
      expanded: false,
      units: opened ? file.units : null,
      tokens: opened ? file.tokens : null,
    };
  };

  const walk = (node: OkfExplorerFolderNode, depth: number): void => {
    if (!folderVisible(node, filter)) return;
    const key = okfExplorerFolderKey(node);
    const expanded = open.has(key);
    rows.push({
      kind: node.isBundleRoot ? 'bundle' : 'folder',
      key,
      path: node.isBundleRoot ? node.bundle : node.path,
      label: node.label,
      depth,
      opened: node.filesOpened > 0,
      expandable: true,
      expanded,
      bundle: node.isBundleRoot ? node.bundle : undefined,
      filesTotal: node.filesTotal,
      filesOpened: node.filesOpened,
      units: node.units,
      tokens: node.tokens,
    });
    if (!expanded) return;
    if (node.search !== null && filter !== 'never') {
      rows.push({
        kind: 'search',
        key: `search:${node.bundle}:${node.path}`,
        path: node.path,
        label: '',
        depth: depth + 1,
        opened: true,
        expandable: false,
        expanded: false,
        units: node.search.units,
        tokens: node.search.tokens,
      });
    }
    for (const child of node.folders) walk(child, depth + 1);
    for (const file of node.files) {
      if (!fileVisible(file, filter)) continue;
      const name = file.path.slice(file.path.lastIndexOf('/') + 1);
      rows.push(fileRow(file, depth + 1, name));
    }
  };

  for (const root of tree.roots) walk(root, 0);

  if (filter !== 'never' && tree.missing.length > 0) {
    const expanded = open.has(OKF_MISSING_ROOT_KEY);
    rows.push({
      kind: 'missing-root',
      key: OKF_MISSING_ROOT_KEY,
      path: '',
      label: '',
      depth: 0,
      opened: true,
      expandable: true,
      expanded,
      fileCount: tree.missing.length,
      units: missingUnits,
      tokens: tree.missingTokens,
    });
    if (expanded) {
      for (const file of tree.missing) rows.push(fileRow(file, 1, file.path));
    }
  }
  return rows;
}
