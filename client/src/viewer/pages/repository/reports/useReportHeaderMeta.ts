import { useQuery } from '@tanstack/react-query';
import { fetchRepositoryDetail, fetchTeams } from '../../../api';

// Repo URL + team name for a report document's header — every report is now
// a printable document, so this is shared rather than re-fetched per report.
export function useReportHeaderMeta(repoId: number, teamId?: number) {
  const repoDetailQuery = useQuery({
    queryKey: ['repo-detail', repoId, teamId ?? null],
    queryFn: () => fetchRepositoryDetail(repoId, teamId),
  });
  const teamsQuery = useQuery({
    queryKey: ['teams'],
    queryFn: fetchTeams,
    enabled: teamId != null,
  });

  return {
    repoUrl: repoDetailQuery.data?.repoUrl ?? '',
    teamName: teamsQuery.data?.find((t) => t.id === teamId)?.name ?? null,
  };
}
