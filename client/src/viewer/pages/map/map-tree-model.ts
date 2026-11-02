/**
 * Pure helpers of the All views tree view: flattening the visible rows, the default expand set,
 * the leaf count of a container and the filter highlight ranges. No React here.
 */

import type { NavNode } from './nav-tree';

export interface MapTreeRow {
  node: NavNode;
  depth: number;
  parentId: string | null;
}

/** The rows shown for `nodes` with `expanded` containers open, in tree order. */
export function flattenVisible(
  nodes: readonly NavNode[],
  expanded: ReadonlySet<string>,
): MapTreeRow[] {
  const rows: MapTreeRow[] = [];
  const walk = (
    list: readonly NavNode[],
    depth: number,
    parentId: string | null,
  ) => {
    for (const node of list) {
      rows.push({ node, depth, parentId });
      if (node.kind === 'container' && expanded.has(node.id)) {
        walk(node.children ?? [], depth + 1, node.id);
      }
    }
  };
  walk(nodes, 0, null);
  return rows;
}

/** Number of leaves under a container (shown next to a collapsed one). */
export function leafCount(node: NavNode): number {
  if (node.kind === 'leaf') return 1;
  let n = 0;
  for (const c of node.children ?? []) n += leafCount(c);
  return n;
}

/** Container ids open on a first visit: the top level plus the rail context's path. */
export function contextPath(ctx: {
  teamId?: number;
  repoId?: number;
  sessionId?: string;
}): string[] {
  const ids: string[] = [];
  if (ctx.teamId !== undefined) ids.push('teams', `team:${ctx.teamId}`);
  if (ctx.repoId !== undefined) {
    ids.push('repos', `repo:${ctx.repoId}`);
    if (ctx.sessionId !== undefined) {
      ids.push(`repo:${ctx.repoId}/sessions`, `repo:${ctx.repoId}/session`);
    }
  }
  return ids;
}

/** Parses a stored `map-expanded` value (a string array). */
export function parseExpanded(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((v): v is string => typeof v === 'string');
}

const SUBSTRING_MIN_CHARS = 3;

/**
 * `[start, end)` ranges of `text` the filter words matched, merged and sorted: a word marks a
 * prefix of a word in the text, or (from 3 chars) any substring of it — the matcher's rules.
 */
export function highlightRanges(
  text: string,
  query: string,
): [number, number][] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 0);
  if (words.length === 0) return [];
  const lower = text.toLowerCase();
  const ranges: [number, number][] = [];
  for (const word of words) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(word, from);
      if (at < 0) break;
      const atWordStart = at === 0 || !/[\p{L}\p{N}]/u.test(lower[at - 1]);
      if (atWordStart || word.length >= SUBSTRING_MIN_CHARS) {
        ranges.push([at, at + word.length]);
      }
      from = at + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** The node with `id` anywhere in `nodes`, or `undefined`. */
export function findNode(
  nodes: readonly NavNode[],
  id: string,
): NavNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children ?? [], id);
    if (hit) return hit;
  }
  return undefined;
}

/** The repository id in a node id under `repo:<id>/…` (DD-10), or `undefined`. */
export function repoIdOfNode(id: string): number | undefined {
  const m = /^repo:(\d+)(?:\/|$)/.exec(id);
  return m ? Number(m[1]) : undefined;
}
