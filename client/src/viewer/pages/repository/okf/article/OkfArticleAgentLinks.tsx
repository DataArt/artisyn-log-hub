/**
 * Links from the OKF article drill-down to an agent's trail on the session OKF tab (package 3):
 * the routing-miss "missing agents" rows and the searched-after agents list each open the
 * session with `tab=okf&okfAgent=<agent>`, where section B shows that agent's calls in order.
 */
import { Link } from 'react-router-dom';
import type { RepoOkfArticleResponse } from '../../../../../models/repositories';
import { okfAgentLabel, okfShortAgentId } from '@/lib/okf/okf-agent-label';
import { okfSessionTrailParams } from '../okf-url-state';

/** `<repo page>?session=…&tab=okf&okfAgent=…` — the session OKF tab with the agent's trail. */
export function okfTrailHref(
  base: string,
  sessionId: string,
  agentId: string,
): string {
  const q = okfSessionTrailParams(new URLSearchParams(), sessionId, agentId);
  return `${base}?${q.toString()}`;
}

export function OkfTrailLink({
  base,
  sessionId,
  agentId,
}: {
  base: string;
  sessionId: string;
  agentId: string;
}) {
  return (
    <Link
      to={okfTrailHref(base, sessionId, agentId)}
      data-testid="okf-article-trail-link"
      className="text-primary underline-offset-2 hover:underline"
    >
      Agent trail
    </Link>
  );
}

type SearchedAfterPair = NonNullable<
  NonNullable<RepoOkfArticleResponse['searchedAfter']>['pairs']
>[number];

/** The agents that kept searching the article's area after reading it (newer servers only). */
export function OkfSearchedAfterAgents({
  pairs,
  base,
}: {
  pairs: readonly SearchedAfterPair[];
  base: string;
}) {
  if (pairs.length === 0) return null;
  return (
    <table className="w-full text-xs" data-testid="okf-article-searched-agents">
      <thead>
        <tr className="text-[10px] text-muted-foreground">
          <th className="px-1 text-left font-normal">Session</th>
          <th className="px-1 text-left font-normal">Agent</th>
          <th className="px-1 text-right font-normal">Searches after</th>
          <th className="px-1 text-left font-normal">Check</th>
        </tr>
      </thead>
      <tbody>
        {pairs.map((p) => (
          <tr
            key={`${p.sessionId}:${p.agentId}`}
            data-testid="okf-article-searched-agent"
          >
            <td className="px-1 font-mono text-muted-foreground">
              {p.sessionId.slice(0, 8)}
            </td>
            <td className="max-w-md truncate px-1">
              {p.agentId === p.sessionId
                ? okfAgentLabel(p.agentId, p.sessionId)
                : (p.label ?? okfShortAgentId(p.agentId))}
            </td>
            <td className="px-1 text-right tabular-nums">{p.searches}</td>
            <td className="px-1">
              <OkfTrailLink
                base={base}
                sessionId={p.sessionId}
                agentId={p.agentId}
              />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
