import type { PricingType, CallTreeNode } from './types';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { TokenBreakdown } from '../types';
import { computeCost } from '../../../../lib/format';

export function computeLeafCost(
  tokens: number,
  pricingType: PricingType,
  model: string | undefined,
  pricing: ModelPricingMap | undefined,
): number | null {
  if (!pricing || !model || !(model in pricing)) return null;
  const entry = pricing[model];
  switch (pricingType) {
    case 'input':
      return (tokens / 1_000_000) * entry.priceIn;
    case 'output':
      return (tokens / 1_000_000) * entry.priceOut;
    // Cache-write leaves are emitted one per TTL, each priced at its own rate. An
    // aggregate leaf priced at a single rate under-charged every 1h write by ~60%.
    case 'cache-write-5m':
      return (tokens / 1_000_000) * entry.priceCacheW5m;
    case 'cache-write-1h':
      return (tokens / 1_000_000) * entry.priceCacheW1h;
    case 'cache-read':
      return (tokens / 1_000_000) * entry.priceCacheR;
  }
}

/**
 * Cost of a whole `TokenBreakdown` — the call tree's "actual cost" for a turn, an agent or
 * the session total. Delegates to the canonical {@link computeCost} rather than
 * re-deriving the arithmetic, so the call tree cannot disagree with the session header or
 * the Info tab about what the same tokens cost.
 */
export function computeActualCost(
  breakdown: TokenBreakdown | null,
  model: string | undefined,
  pricing: ModelPricingMap | undefined,
): number | null {
  if (!breakdown || !pricing || !model || !(model in pricing)) return null;
  return computeCost(breakdown, pricing[model]);
}

export function sumDescendantLeafCost(
  node: CallTreeNode,
  defaultModel: string | undefined,
  pricing: ModelPricingMap | undefined,
): number | null {
  if (node.pricingType && node.tokens != null) {
    return computeLeafCost(
      node.tokens,
      node.pricingType,
      node.model ?? defaultModel,
      pricing,
    );
  }
  if (node.children && node.children.length > 0) {
    let total = 0;
    let hasAny = false;
    for (const child of node.children) {
      const childCost = sumDescendantLeafCost(child, defaultModel, pricing);
      if (childCost !== null) {
        total += childCost;
        hasAny = true;
      }
    }
    return hasAny ? total : null;
  }
  return null;
}

export function formatCostShare(share: number): string {
  if (share < 0.1) return '<0.1%';
  return `${share.toFixed(1)}%`;
}
