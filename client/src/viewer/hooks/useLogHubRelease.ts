import { useQuery } from '@tanstack/react-query';
import { fetchLogHubRelease } from '../api';

const ONE_HOUR_MS = 3_600_000;

/**
 * Admin-only "new Log Hub release" state. Callers pass `user?.role === 'admin'`: the query is
 * disabled for everyone else, so team owners never call the admin-only endpoint (and never get a
 * 403). On an error or no data the consumers (left-nav dot, admin banner) render nothing.
 */
export function useLogHubRelease(isAdmin: boolean) {
  return useQuery({
    queryKey: ['admin', 'log-hub-release'],
    queryFn: fetchLogHubRelease,
    enabled: isAdmin,
    staleTime: ONE_HOUR_MS,
    refetchInterval: ONE_HOUR_MS,
    retry: false,
  });
}
