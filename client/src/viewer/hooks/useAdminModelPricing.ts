import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  clearAdminModelOverride,
  fetchAdminModelPricing,
  fetchAnthropicPricingNow,
  importOpenRouterPricing,
  setAdminModelOverride,
  setAdminModelPrice,
} from '../api';

/** Query key of the admin model-pricing table (`GET /api/v1/admin/model-pricing`). */
export const ADMIN_MODEL_PRICING_QUERY_KEY = [
  'admin',
  'model-pricing',
] as const;

/** Query key of the public pricing map that every cost view reads (`useModelPricing`). */
const MODEL_PRICING_QUERY_KEY = ['model-pricing'] as const;

/** The admin model-pricing table: every known model plus both fetch statuses. */
export function useAdminModelPricing() {
  return useQuery({
    queryKey: ADMIN_MODEL_PRICING_QUERY_KEY,
    queryFn: fetchAdminModelPricing,
  });
}

/**
 * The four admin pricing writes. Each one invalidates both the admin table and the public
 * pricing map, so cost figures elsewhere in the app pick up the new rates.
 */
export function useModelPricingMutations() {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: ADMIN_MODEL_PRICING_QUERY_KEY,
    });
    void queryClient.invalidateQueries({ queryKey: MODEL_PRICING_QUERY_KEY });
  };

  const setPrice = useMutation({
    mutationFn: setAdminModelPrice,
    onSuccess: invalidate,
  });
  const setOverride = useMutation({
    mutationFn: setAdminModelOverride,
    onSuccess: invalidate,
  });
  const clearOverride = useMutation({
    mutationFn: clearAdminModelOverride,
    onSuccess: invalidate,
  });
  const importOpenRouter = useMutation({
    mutationFn: importOpenRouterPricing,
    onSuccess: invalidate,
  });
  const fetchAnthropic = useMutation({
    mutationFn: fetchAnthropicPricingNow,
    onSuccess: invalidate,
  });

  return {
    setPrice,
    setOverride,
    clearOverride,
    importOpenRouter,
    fetchAnthropic,
  };
}
