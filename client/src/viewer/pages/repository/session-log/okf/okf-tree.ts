/**
 * Pure helpers behind the OKF tree (session and repo OKF tabs).
 *
 * The server sends the tree already aggregated (bundle → folder → file, every folder the sum of
 * its children); nothing here recomputes a metric. These helpers only shape it for display:
 * sort by the selected heat metric with "not read" rows last, narrow it to one agent's files,
 * flatten it to the visible rows, and find the ancestors of a node for "scroll to node".
 */
import type { OkfTreeNode } from '../../../../../models/repositories';

/** What the READ heat bar and value show. */
export type OkfHeatMetric = 'bytes' | 'calls';

/** Stable identity of a tree node: bundle + path (the synthetic group has bundle `null`). */
export function okfNodeKey(
  node: Pick<OkfTreeNode, 'bundle' | 'path' | 'kind'>,
): string {
  return `${node.kind === 'bundle' ? 'B' : 'N'}:${node.bundle ?? ''}:${node.path}`;
}

/** Nothing at all happened on this node — the neutral grey "not read" row. */
export function isNotRead(node: OkfTreeNode): boolean {
  return (
    node.readBytes === 0 &&
    node.readCalls === 0 &&
    node.listCalls === 0 &&
    node.writeCalls === 0
  );
}

/** The READ heat value of a node under the selected metric. */
export function heatValue(node: OkfTreeNode, metric: OkfHeatMetric): number {
  return metric === 'bytes' ? node.readBytes : node.readCalls;
}

/** Files at or below a node. */
export function countFiles(node: OkfTreeNode): number {
  if (node.kind === 'file') return 1;
  let n = 0;
  for (const c of node.children ?? []) n += countFiles(c);
  return n;
}

function compareNodes(
  a: OkfTreeNode,
  b: OkfTreeNode,
  metric: OkfHeatMetric,
): number {
  const aIdle = isNotRead(a);
  const bIdle = isNotRead(b);
  if (aIdle !== bIdle) return aIdle ? 1 : -1;
  const diff = heatValue(b, metric) - heatValue(a, metric);
  if (diff !== 0) return diff;
  const activity = b.listCalls + b.writeCalls - (a.listCalls + a.writeCalls);
  if (activity !== 0) return activity;
  return a.path.localeCompare(b.path);
}

/**
 * Sort every level by the heat metric, "not read" rows last. Top-level bundles keep the
 * server's order, except that the synthetic `bundle: null` group always goes last.
 */
export function sortOkfTree(
  nodes: readonly OkfTreeNode[],
  metric: OkfHeatMetric,
): OkfTreeNode[] {
  const sortLevel = (list: readonly OkfTreeNode[]): OkfTreeNode[] =>
    [...list]
      .sort((a, b) => compareNodes(a, b, metric))
      .map((n) => (n.children ? { ...n, children: sortLevel(n.children) } : n));
  const top = nodes.map((n) =>
    n.children ? { ...n, children: sortLevel(n.children) } : n,
  );
  return [
    ...top.filter((n) => n.bundle !== null),
    ...top.filter((n) => n.bundle === null),
  ];
}

/**
 * Narrow the tree to the file paths one agent read. Folders and bundles stay only when a kept
 * file is below them; the numbers on them stay the whole tree's (the response has no per-agent
 * split), the filter only answers "what did this agent read".
 */
export function filterOkfTreeByFiles(
  nodes: readonly OkfTreeNode[],
  files: ReadonlySet<string>,
): OkfTreeNode[] {
  const out: OkfTreeNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      if (files.has(node.path)) out.push(node);
      continue;
    }
    const children = filterOkfTreeByFiles(node.children ?? [], files);
    if (children.length > 0) out.push({ ...node, children });
  }
  return out;
}

/** One visible row of the flattened tree. */
export interface FlatOkfRow {
  node: OkfTreeNode;
  key: string;
  depth: number;
  /** What the row prints: the path relative to its parent, or the whole path. */
  label: string;
  hasChildren: boolean;
  expanded: boolean;
  /** The top-level node this row is under — its values scale the row's bars. */
  top: OkfTreeNode;
}

function relativeLabel(node: OkfTreeNode, parent: OkfTreeNode | null): string {
  if (parent && parent.path !== '' && node.path.startsWith(parent.path)) {
    return node.path.slice(parent.path.length);
  }
  return node.path;
}

/**
 * Default expansion: a node with activity is open, a folder nobody touched starts closed (it
 * still lists as one "not read" row with its file count). `overrides` holds the user's clicks.
 */
export function isExpanded(
  node: OkfTreeNode,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  const o = overrides.get(okfNodeKey(node));
  if (o !== undefined) return o;
  return node.kind === 'bundle' || !isNotRead(node);
}

export function flattenOkfTree(
  nodes: readonly OkfTreeNode[],
  overrides: ReadonlyMap<string, boolean>,
): FlatOkfRow[] {
  const out: FlatOkfRow[] = [];
  const walk = (
    node: OkfTreeNode,
    parent: OkfTreeNode | null,
    top: OkfTreeNode,
    depth: number,
  ) => {
    const hasChildren = (node.children?.length ?? 0) > 0;
    const expanded = hasChildren && isExpanded(node, overrides);
    out.push({
      node,
      key: okfNodeKey(node),
      depth,
      label: relativeLabel(node, parent),
      hasChildren,
      expanded,
      top,
    });
    if (!expanded) return;
    for (const child of node.children ?? []) walk(child, node, top, depth + 1);
  };
  for (const n of nodes) walk(n, null, n, 0);
  return out;
}

/**
 * Keys from the top-level node down to the target, the target last; `null` when it is not in
 * the tree. With no `path` the target is the bundle node itself; a path that only matches by
 * value (a different bundle) is used as a fallback.
 */
export function findOkfNodePath(
  nodes: readonly OkfTreeNode[],
  bundle: string | null,
  path?: string,
): string[] | null {
  const matches = (n: OkfTreeNode, strict: boolean): boolean => {
    if (path === undefined || path === '') {
      return n.kind === 'bundle' && n.bundle === bundle;
    }
    return n.path === path && (!strict || n.bundle === bundle);
  };
  const search = (strict: boolean): string[] | null => {
    const walk = (n: OkfTreeNode, trail: string[]): string[] | null => {
      const here = [...trail, okfNodeKey(n)];
      if (matches(n, strict)) return here;
      for (const c of n.children ?? []) {
        const found = walk(c, here);
        if (found) return found;
      }
      return null;
    };
    for (const n of nodes) {
      const found = walk(n, []);
      if (found) return found;
    }
    return null;
  };
  return search(true) ?? search(false);
}

/** Short agent label: `main` for the root session, else the first 4 chars of its id (DD-47). */
export function okfAgentLabel(agentId: string, rootSessionId: string): string {
  return agentId === rootSessionId ? 'main' : agentId.slice(0, 4);
}
