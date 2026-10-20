import type { DetailRow } from '../../../../components/DetailTooltip';

/**
 * Which `model_pricing` rate a call-tree leaf's tokens are billed at.
 *
 * The split TTL pricing split the single `'cache-write'` category in two: the 5m and 1h TTLs have their own
 * rates (`priceCacheW5m` / `priceCacheW1h`, the latter ~1.6× the former), so a leaf holding
 * an aggregate cache-write figure could not be priced correctly. Leaves are emitted per TTL
 * instead — see `useCallTreeNodes.ts`. The `CallTreeNodeType` stays a single `'cache-write'`,
 * since both TTLs share the same row colour.
 */
export type PricingType =
  | 'input'
  | 'output'
  | 'cache-write-5m'
  | 'cache-write-1h'
  | 'cache-read';

export type CallTreeNodeType =
  | 'system-context'
  | 'claude-md'
  | 'prompt'
  | 'session-total'
  | 'user-prompt'
  | 'skills-group'
  | 'skill'
  | 'rules-group'
  | 'rule'
  | 'code-group'
  | 'docs-group'
  | 'file'
  | 'vision-group'
  | 'image'
  | 'sub-agent'
  | 'output'
  | 'cache-write'
  | 'cache-read';

export interface CallTreeNode {
  type: CallTreeNodeType;
  label: string;
  /** undefined = N/A (prompt turn whose tokenBreakdown is null); null = show "—" */
  tokens: number | undefined | null;
  /** Leaf-only: which pricing rate applies; undefined for group/non-leaf nodes */
  pricingType?: PricingType;
  /** Model override for sub-agent cost computation */
  model?: string;
  /** Actual cost from real token breakdown (prompt/session-total only); undefined = use estimates */
  actualCost?: number | null;
  /** Must be false for all level-2 nodes regardless of whether children is set */
  expandable: boolean;
  children?: CallTreeNode[];
  tooltipRows: DetailRow[];
}

export const TYPE_COLOR_BG: Record<CallTreeNodeType, string> = {
  'system-context': 'bg-slate-400/50',
  'claude-md': 'bg-slate-400/50',
  'session-total': 'bg-slate-400/50',
  prompt: 'bg-sky-400',
  'user-prompt': 'bg-sky-400',
  'skills-group': 'bg-indigo-400',
  skill: 'bg-indigo-400',
  'rules-group': 'bg-teal-400',
  rule: 'bg-teal-400',
  'code-group': 'bg-blue-400',
  'docs-group': 'bg-blue-400',
  file: 'bg-blue-400',
  'vision-group': 'bg-purple-400',
  image: 'bg-purple-400',
  'sub-agent': 'bg-orange-400',
  output: 'bg-yellow-400',
  'cache-write': 'bg-red-400',
  'cache-read': 'bg-red-400',
};

export const DEPTH_PADDING = ['pl-2', 'pl-7', 'pl-12'] as const;

// These node types start collapsed; clicking toggles them open/closed.
export const DEFAULT_COLLAPSED_TYPES = new Set<CallTreeNodeType>([
  'skills-group',
  'rules-group',
  'code-group',
  'docs-group',
  'vision-group',
]);

// Group types that the top-N filter applies to (leaf items inside them).
export const FILTERABLE_GROUP_TYPES = new Set<CallTreeNodeType>([
  'skills-group',
  'rules-group',
  'code-group',
  'docs-group',
  'vision-group',
]);

export function getNodeId(
  node: CallTreeNode,
  parentId: string,
  idx: number,
): string {
  if (node.type === 'system-context') return 'system-context';
  if (node.type === 'session-total') return 'session-total';
  return `${parentId}-${node.type}-${idx}`;
}
