import { useQuery } from '@tanstack/react-query';
import { fetchModelPricing } from '../api';
import type { ModelPricingMap } from '../../models/pricing';

/**
 * Model rates, optionally as of a date (`YYYY-MM-DD`, D2.6) so a session is priced at the
 * rates in effect when it ran. The key keeps the `['model-pricing']` prefix, so the admin
 * prefix invalidation still refreshes every dated variant.
 */
export function useModelPricing(asOf?: string): ModelPricingMap | undefined {
  const { data } = useQuery({
    queryKey: ['model-pricing', asOf ?? null],
    queryFn: () => fetchModelPricing(asOf),
    staleTime: 5 * 60 * 1000,
  });
  return data;
}
