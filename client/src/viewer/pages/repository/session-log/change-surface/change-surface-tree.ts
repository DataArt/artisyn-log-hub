/**
 * The pure tree module behind the Change surface tab's file tree.
 *
 * Pipeline: rows → nested nodes → filter → sort → display-only
 * single-child collapse → flat visible list. Nothing here touches the DOM or React, so the
 * whole pipeline is unit-testable and the component stays a renderer.
 *
 * **The single-child collapse merges labels only.** A collapsed chain keeps the counts it
 * already had (they are identical all along a single-child chain by construction) and keeps
 * the deepest folder's full path as its identity, so the `sum(leaf +) === root +` identity holds
 * whether the collapse is on or off. Folder identity for the spread metric is always the
 * literal full path, computed server-side — this module never feeds a metric.
 */
import type { ChangeSurfaceFileRow } from '../../../../../models/repositories';

/** How the tree's siblings are ordered. */
export type ChangeSurfaceSortKey = 'lines' | 'files' | 'path';

export interface ChangeSurfaceTreeNode {
  /**
   * Stable identity — the full repo-relative folder path (`'.'` for the root) for a folder,
   * the full repo-relative file path for a leaf. Never affected by the display-only collapse,
   * so expand/collapse state survives toggling `collapseSingleChild`.
   */
  path: string;
  kind: 'folder' | 'file';
  /**
   * What the row prints. Usually the last path segment; for a collapsed single-child chain,
   * the whole chain joined with `/`.
   */
  label: string;
  /** The segments a collapse folded into this row, for the "collapsed chain" hint. */
  collapsedFrom: string[];
  /** Distinct files at or below this node. */
  files: number;
  linesAdded: number;
  linesRemoved: number;
  children: ChangeSurfaceTreeNode[];
  /** Leaves only — the payload row this node was built from. */
  row: ChangeSurfaceFileRow | null;
}

/** The out-of-tree group: paths that could not be normalised into the repo. */
export interface ChangeSurfaceOutsideGroup {
  rows: ChangeSurfaceFileRow[];
  files: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface ChangeSurfaceTreeResult {
  /** `null` when no in-repo row survived the filter. */
  root: ChangeSurfaceTreeNode | null;
  outside: ChangeSurfaceOutsideGroup;
  /** Distinct folders among the rows actually in the tree. */
  folders: number;
  /** Distinct top-level modules among the rows actually in the tree. */
  modules: number;
  /** Files actually in the tree (the root's own count, or `0`). */
  files: number;
  /**
   * The largest `linesAdded + linesRemoved` of any node (the outside group included), i.e.
   * the shared track the churn bars are scaled against.
   */
  maxChurn: number;
}

export interface BuildChangeSurfaceTreeOptions {
  /** Case-insensitive substring match against the row's display path. */
  filter?: string;
  sort?: ChangeSurfaceSortKey;
  collapseSingleChild?: boolean;
}

/** The label the repo-root folder prints as (a root file counts as the root folder, not "no folder"). */
export const REPO_ROOT_LABEL = '. (repo root)';

/** The root node's identity — matches the server's `'.'` folder key. */
export const REPO_ROOT_PATH = '.';

function churn(node: { linesAdded: number; linesRemoved: number }): number {
  return node.linesAdded + node.linesRemoved;
}

function makeNode(
  path: string,
  label: string,
  kind: 'folder' | 'file',
): ChangeSurfaceTreeNode {
  return {
    path,
    kind,
    label,
    collapsedFrom: [],
    files: 0,
    linesAdded: 0,
    linesRemoved: 0,
    children: [],
    row: null,
  };
}

/** A row belongs in the tree only when it normalised into the repo. */
function isInRepo(row: ChangeSurfaceFileRow): boolean {
  return !row.outsideRepo && row.relPath !== null;
}

/** What a row is matched and displayed by — the repo-relative path, or the raw one. */
export function rowDisplayPath(row: ChangeSurfaceFileRow): string {
  return row.relPath ?? row.rawPath;
}

function matchesFilter(row: ChangeSurfaceFileRow, needle: string): boolean {
  if (needle === '') return true;
  return rowDisplayPath(row).toLowerCase().includes(needle);
}

function sortChildren(
  node: ChangeSurfaceTreeNode,
  key: ChangeSurfaceSortKey,
): void {
  node.children.sort((a, b) => {
    // Folders always precede files at the same level — a code-review diff tree reads that way,
    // and it keeps a root file like `package.json` from splitting the folder list.
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    if (key === 'path') return a.path.localeCompare(b.path);
    if (key === 'files' && a.files !== b.files) return b.files - a.files;
    const diff = churn(b) - churn(a);
    if (diff !== 0) return diff;
    if (a.files !== b.files) return b.files - a.files;
    return a.path.localeCompare(b.path);
  });
  for (const child of node.children) sortChildren(child, key);
}

/**
 * Display-only collapse. A folder with exactly one child, and that child a folder, adopts the
 * child: label and path become the child's, the folded segment is recorded, and the counts —
 * which are equal along a single-child chain — are left untouched.
 *
 * The root is deliberately never collapsed away: it carries the sum-identity total.
 */
function collapseSingleChildChains(
  node: ChangeSurfaceTreeNode,
  isRoot: boolean,
): ChangeSurfaceTreeNode {
  const collapsed = node.children.map((c) =>
    collapseSingleChildChains(c, false),
  );
  node.children = collapsed;
  if (isRoot) return node;

  let current = node;
  const parts: string[] = [current.label];
  while (
    current.children.length === 1 &&
    current.children[0].kind === 'folder'
  ) {
    current = current.children[0];
    parts.push(current.label);
  }
  if (parts.length === 1) return current;
  const joined = parts.join('/');
  // The merged row keeps the deepest node's identity, children and — crucially — its counts,
  // which equal every folded ancestor's by construction. The collapse writes no count.
  return { ...current, label: joined, collapsedFrom: joined.split('/') };
}

function countFolders(node: ChangeSurfaceTreeNode, acc: Set<string>): void {
  if (node.kind === 'file') return;
  // A folder counts only when it directly holds at least one file — the server's folder
  // distribution is keyed on the file's own directory, and intermediate directories are not
  // "touched folders".
  if (node.children.some((c) => c.kind === 'file')) acc.add(node.path);
  for (const child of node.children) countFolders(child, acc);
}

function maxNodeChurn(node: ChangeSurfaceTreeNode): number {
  let max = churn(node);
  for (const child of node.children) {
    max = Math.max(max, maxNodeChurn(child));
  }
  return max;
}

/**
 * Build the tree. Aggregation happens on the way in (every ancestor accumulates the leaf's
 * files and lines), so a folder row is the exact sum of its subtree and the root is the exact
 * sum of the leaves shown — the sum identity, over the rows actually displayed.
 */
export function buildChangeSurfaceTree(
  rows: readonly ChangeSurfaceFileRow[],
  options: BuildChangeSurfaceTreeOptions = {},
): ChangeSurfaceTreeResult {
  const needle = (options.filter ?? '').trim().toLowerCase();
  const sortKey = options.sort ?? 'lines';

  const outsideRows: ChangeSurfaceFileRow[] = [];
  const outside: ChangeSurfaceOutsideGroup = {
    rows: outsideRows,
    files: 0,
    linesAdded: 0,
    linesRemoved: 0,
  };

  const root = makeNode(REPO_ROOT_PATH, REPO_ROOT_LABEL, 'folder');
  const modules = new Set<string>();
  let inRepoRows = 0;

  for (const row of rows) {
    if (!matchesFilter(row, needle)) continue;
    if (!isInRepo(row)) {
      outsideRows.push(row);
      outside.files += 1;
      outside.linesAdded += row.linesAdded;
      outside.linesRemoved += row.linesRemoved;
      continue;
    }
    inRepoRows += 1;
    const relPath = row.relPath as string;
    const segments = relPath.split('/').filter((s) => s !== '');
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1];
    const folderSegments = segments.slice(0, -1);
    modules.add(folderSegments.length > 0 ? folderSegments[0] : REPO_ROOT_PATH);

    let cursor = root;
    cursor.files += 1;
    cursor.linesAdded += row.linesAdded;
    cursor.linesRemoved += row.linesRemoved;
    let prefix = '';
    for (const segment of folderSegments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      let next = cursor.children.find(
        (c) => c.kind === 'folder' && c.path === prefix,
      );
      if (!next) {
        next = makeNode(prefix, segment, 'folder');
        cursor.children.push(next);
      }
      next.files += 1;
      next.linesAdded += row.linesAdded;
      next.linesRemoved += row.linesRemoved;
      cursor = next;
    }
    const leaf = makeNode(relPath, fileName, 'file');
    leaf.files = 1;
    leaf.linesAdded = row.linesAdded;
    leaf.linesRemoved = row.linesRemoved;
    leaf.row = row;
    cursor.children.push(leaf);
  }

  if (inRepoRows === 0) {
    return {
      root: null,
      outside,
      folders: 0,
      modules: 0,
      files: 0,
      maxChurn: churn(outside),
    };
  }

  sortChildren(root, sortKey);
  const folderPaths = new Set<string>();
  countFolders(root, folderPaths);

  const shaped =
    options.collapseSingleChild === true
      ? collapseSingleChildChains(root, true)
      : root;

  return {
    root: shaped,
    outside,
    folders: folderPaths.size,
    modules: modules.size,
    files: shaped.files,
    maxChurn: Math.max(maxNodeChurn(shaped), churn(outside)),
  };
}

/** One row of the flat, windowable list the tree component renders. */
export interface FlatChangeSurfaceRow {
  node: ChangeSurfaceTreeNode;
  /** Render indent level; the root is `0`. */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/**
 * Flatten to the rows that are currently visible. Nodes are expanded by default; `collapsed`
 * holds the paths the user has explicitly closed (which is also how "Collapse all" works —
 * it fills the set with every folder path).
 */
export function flattenVisibleRows(
  root: ChangeSurfaceTreeNode | null,
  collapsed: ReadonlySet<string>,
): FlatChangeSurfaceRow[] {
  const out: FlatChangeSurfaceRow[] = [];
  if (root === null) return out;
  const walk = (node: ChangeSurfaceTreeNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && !collapsed.has(node.path);
    out.push({ node, depth, hasChildren, expanded });
    if (!expanded) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(root, 0);
  return out;
}

/** Every folder path in the tree — what "Collapse all" seeds its set from. */
export function collectFolderPaths(
  root: ChangeSurfaceTreeNode | null,
): string[] {
  const out: string[] = [];
  if (root === null) return out;
  const walk = (node: ChangeSurfaceTreeNode) => {
    if (node.kind !== 'folder') return;
    out.push(node.path);
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}
