import { useQuery } from '@tanstack/react-query';
import { fetchSessionTagValues } from '../../api';

/**
 * FR-8 tag discovery for the repository view (2026-11-24 otel-session-tags): the repository
 * header chips and the session-list tag pickers read the same cache entry. Scope = the view's
 * team and the personal-repo "my sessions only" user filter; the repository view has no period
 * or branch filter, so neither is sent (all-time, every branch).
 *
 * Key prefix `['repo-tag-values', repoId, teamId]` — the repository refresh invalidates it.
 */
export function useSessionTagValues(
  repoId: number,
  teamId: number | undefined,
  userEmail: string | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: ['repo-tag-values', repoId, teamId, userEmail ?? null],
    queryFn: () => fetchSessionTagValues(repoId, { teamId, userEmail }),
    enabled,
    staleTime: 30_000,
  });
}
