import { useIsFetching } from '@tanstack/react-query';

const REFRESH_QUERY_KEYS = new Set([
  'repo-sessions',
  'repo-branches',
  'repo-sessions-branch',
]);

/**
 * Detects an in-flight *refresh* (refetch of already-loaded data) for the
 * session list, as distinct from the initial load: `query.state.data` must
 * already be defined for the query to count. Backs the refresh banner
 * (`SessionListPanel.tsx`) and the spinning refresh button
 * (`RepositoryView.tsx`).
 */
export function useSessionListRefreshing(
  repoId: number,
  teamId: number | undefined,
): boolean {
  const count = useIsFetching({
    predicate: (query) => {
      const [keyName, keyRepoId, keyTeamId] = query.queryKey;
      return (
        typeof keyName === 'string' &&
        REFRESH_QUERY_KEYS.has(keyName) &&
        keyRepoId === repoId &&
        keyTeamId === teamId &&
        query.state.data !== undefined
      );
    },
  });
  return count > 0;
}

/**
 * Pure helper: true only when `nextError` is truthy, `prevError` was falsy
 * (a fresh failure, not a persisting one), and `hasData` is true (i.e. this
 * is a refresh failure on top of good data, not a first-load failure).
 */
export function didRefreshJustFail(
  prevError: unknown,
  nextError: unknown,
  hasData: boolean,
): boolean {
  return Boolean(!prevError && nextError && hasData);
}
