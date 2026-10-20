import { useQuery } from '@tanstack/react-query';
import { fetchAiToolVersions } from '../api';
import type { AiToolVersionHistoryEntry } from '../../models/ai-tool-versions';

const CLAUDE_CODE_TOOL = 'claude-code';

/**
 * Claude Code release-version history (ascending `effectiveFrom`), used to pick the
 * stable/latest versions that were current when a session started. `undefined` while
 * loading or on error — callers treat that as "no reference versions".
 */
export function useAiToolVersions(): AiToolVersionHistoryEntry[] | undefined {
  const { data } = useQuery({
    queryKey: ['ai-tool-versions', CLAUDE_CODE_TOOL],
    queryFn: () => fetchAiToolVersions(CLAUDE_CODE_TOOL),
    staleTime: 5 * 60 * 1000,
  });
  return data?.history;
}
