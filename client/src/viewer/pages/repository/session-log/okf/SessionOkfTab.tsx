/**
 * The session view's "OKF" tab: how this session tree (main agent + sub-agents) read the repo's
 * OKF knowledge bases. It fetches the session's usage and renders the shared view
 * (`OkfUsageView`) — the same summary line and four views as the repository tab, counted in
 * agents instead of sessions.
 *
 * States: loading → skeleton; error → "No access" or one fixed line; no KB snapshot → the
 * view's one-line state.
 */
import { useQuery } from '@tanstack/react-query';
import { fetchSessionOkfUsage } from '../../../../api';
import { OkfLoadError } from '../../okf/view/OkfLoadError';
import { OkfUsageView } from '../../okf/view/OkfUsageView';
import { LoadingSkeleton } from './SessionOkfStates';

export interface SessionOkfTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
}

export function SessionOkfTab({
  repoId,
  sessionId,
  teamId,
}: SessionOkfTabProps) {
  const query = useQuery({
    queryKey: ['session-okf-usage', repoId, sessionId, teamId],
    queryFn: () => fetchSessionOkfUsage(repoId, sessionId, teamId),
  });

  if (query.isLoading) return <LoadingSkeleton />;

  return (
    <div className="p-4" data-testid="session-okf-tab">
      {query.error ? (
        <OkfLoadError error={query.error} />
      ) : query.data ? (
        <OkfUsageView data={query.data} />
      ) : null}
    </div>
  );
}
