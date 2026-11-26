import { useQuery } from '@tanstack/react-query';
import { fetchSessionTagValues } from '../../api';

/**
 * FR-8 tag discovery over a date range (2026-11-24 otel-session-tags) for the Analytics and
 * Reports filter bars: the tag filter values and the TAGS section of the Group-by menus. The key
 * shares the `['repo-tag-values', repoId, teamId]` prefix of `useSessionTagValues`, so the
 * repository refresh invalidates it too. `range` absent = all time.
 */
export function useScopedTagValues(
  repoId: number,
  teamId: number | undefined,
  range: { startDate: string; endDate: string } | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: [
      'repo-tag-values',
      repoId,
      teamId,
      'range',
      range?.startDate ?? null,
      range?.endDate ?? null,
    ],
    queryFn: () => fetchSessionTagValues(repoId, { teamId, dateRange: range }),
    enabled,
    staleTime: 30_000,
  });
}
