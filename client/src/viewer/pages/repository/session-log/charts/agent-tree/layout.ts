import * as d3 from 'd3';
import type { AgentNode } from '../chart-data';

export interface LayoutNode {
  node: AgentNode;
  x: number;
  y: number;
  width: number;
  height: number;
  children: LayoutNode[];
}

export const NODE_WIDTH = 120;
export const NODE_HEIGHT = 48;
export const GROUP_PAD = 8;
export const GAP_X = 40;
export const GAP_Y = 16;

export function subtreeRight(layout: LayoutNode): number {
  let right = layout.x + layout.width;
  for (const child of layout.children) {
    const childRight = subtreeRight(child);
    if (childRight > right) right = childRight;
  }
  return right;
}

export function subtreeBottom(layout: LayoutNode): number {
  let bottom = layout.y + layout.height;
  for (const child of layout.children) {
    const childBottom = subtreeBottom(child);
    if (childBottom > bottom) bottom = childBottom;
  }
  return bottom;
}

/**
 * Lays out the agent tree left-to-right using d3's Reingold-Tilford tree
 * algorithm (`d3.hierarchy` + `d3.tree`), swapping its default top-down axes
 * (depth → x here, breadth → y here). This is what makes `main` land
 * vertically centered among the full spread of its descendants — the
 * algorithm centers every parent between its children's midpoint,
 * recursively — and why sibling subtrees never overlap regardless of how
 * bushy or deep the tree gets (unlike a hand-rolled left-to-right placement,
 * which has to reimplement that centering/collision logic itself).
 */
export function computeLayout(root: AgentNode): LayoutNode {
  const hierarchyRoot = d3.hierarchy(root, (d) =>
    d.children.length > 0 ? d.children : undefined,
  );

  const layoutTree = d3
    .tree<AgentNode>()
    .nodeSize([NODE_HEIGHT + GAP_Y, NODE_WIDTH + GAP_X]);
  const positioned = layoutTree(hierarchyRoot);

  // d3 centers the tree around x=0, which can go negative — re-base so the
  // topmost node sits at screen-y 0.
  let minBreadth = Infinity;
  positioned.each((d) => {
    if (d.x < minBreadth) minBreadth = d.x;
  });

  function toLayoutNode(d: d3.HierarchyPointNode<AgentNode>): LayoutNode {
    return {
      node: d.data,
      x: d.y,
      y: d.x - minBreadth,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      children: (d.children ?? []).map(toLayoutNode),
    };
  }

  return toLayoutNode(positioned);
}
