/**
 * The agent trail in section B of the session OKF tab (package 3): the selected agent's KB and
 * code tool calls in order (`GET …/okf-usage/trail?agent=`), grouped into episodes that start at
 * a KB article read (`okf-trail.ts`), so a reader can check the B numbers by hand: which paths an
 * article showed, which the agent opened, and what it still had to search for — searches in the
 * area of an article it read are highlighted. Shown while `okfAgent` is in the URL.
 */
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError, fetchSessionOkfTrail } from '../../../../api';
import { OkfTrailRow } from './OkfTrailRow';
import {
  groupOkfTrail,
  itemsByOrd,
  trailCallCount,
  type OkfTrailEpisode,
} from './okf-trail';
import { okfCount } from '@/lib/okf/okf-check-text';
import { okfAgentFromParams, writeOkfAgent } from '../../okf/okf-url-state';
import type { OkfTrailItem } from '../../../../../models/repositories';

/** The trail's error line: no access, an agent outside this session tree, or any other failure. */
function trailErrorText(error: Error): string {
  if (error instanceof ApiError) {
    if (error.statusCode === 403) return 'No access';
    if (error.statusCode === 404)
      return 'No trail: the agent is not part of this session tree, or the server is too old to show trails.';
  }
  return 'The agent trail could not be loaded. Please try again.';
}

/** The session OKF tab's selected agent (`okfAgent` URL param) and its setter (replace). */
export function useOkfAgentParam(): [
  string | null,
  (id: string | null) => void,
] {
  const [searchParams, setSearchParams] = useSearchParams();
  const set = (id: string | null) => {
    setSearchParams((prev) => writeOkfAgent(prev, id), { replace: true });
  };
  return [okfAgentFromParams(searchParams), set];
}

/** Section B's line while no agent is selected. */
export function OkfTrailPrompt() {
  return (
    <p
      data-testid="okf-trail-prompt"
      className="text-[11px] text-muted-foreground"
    >
      Pick an agent in the Agents panel to see its trail — every KB and code
      call in order.
    </p>
  );
}

function AfterReading({ episode }: { episode: OkfTrailEpisode }) {
  if (episode.articles.length === 0 || episode.body.length === 0) return null;
  return (
    <li
      data-testid="okf-trail-after"
      className="py-0.5 text-center text-[11px] text-muted-foreground"
    >
      ── after reading: {okfCount(episode.areaSearches, 'search', 'searches')}{' '}
      in its area, {okfCount(episode.filesOpened, 'file', 'files')} opened ──
    </li>
  );
}

function Episode({
  episode,
  byOrd,
}: {
  episode: OkfTrailEpisode;
  byOrd: ReadonlyMap<number, OkfTrailItem>;
}) {
  const items = [...episode.head, ...episode.body];
  const rows = (list: OkfTrailItem[], offset: number) =>
    list.map((item, i) => (
      <OkfTrailRow
        key={`${item.ord}:${offset + i}`}
        item={item}
        byOrd={byOrd}
        showOrd={offset + i === 0 || items[offset + i - 1].ord !== item.ord}
      />
    ));
  return (
    <ol
      data-testid="okf-trail-episode"
      data-article={episode.articles[episode.articles.length - 1] ?? ''}
      className="space-y-0.5 border-t border-border pt-1 first:border-t-0 first:pt-0"
    >
      {episode.articles.length === 0 ? (
        <li className="text-[11px] text-muted-foreground">
          Before any KB article was read
        </li>
      ) : null}
      {rows(episode.head, 0)}
      <AfterReading episode={episode} />
      {rows(episode.body, episode.head.length)}
    </ol>
  );
}

export function OkfAgentTrail({
  repoId,
  sessionId,
  teamId,
  agentId,
  label,
  onClose,
}: {
  repoId: number;
  /** The opened (root) session. */
  sessionId: string;
  teamId?: number;
  agentId: string;
  /** The agent's label on this tab (`main` / `1.N · …`). */
  label: string;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: ['session-okf-trail', repoId, sessionId, agentId, teamId],
    queryFn: () => fetchSessionOkfTrail(repoId, sessionId, agentId, teamId),
  });
  const items = useMemo(() => query.data?.items ?? [], [query.data]);
  const episodes = useMemo(() => groupOkfTrail(items), [items]);
  const byOrd = useMemo(() => itemsByOrd(items), [items]);

  return (
    <div
      data-testid="okf-agent-trail"
      data-agent={agentId}
      className="max-w-4xl space-y-2 rounded-md border border-border bg-card px-3 py-2"
    >
      <div className="flex items-baseline gap-2">
        <h4
          data-testid="okf-trail-title"
          className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          Agent trail · {label}
          {query.data
            ? ` · ${okfCount(trailCallCount(items), 'call', 'calls')}`
            : ''}
        </h4>
        <button
          type="button"
          data-testid="okf-trail-close"
          onClick={onClose}
          className="ml-auto text-muted-foreground hover:text-foreground"
          aria-label="Close the agent trail"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {query.isLoading ? (
        <div
          data-testid="okf-trail-loading"
          className="h-16 animate-pulse rounded bg-muted"
        />
      ) : query.error ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid="okf-trail-error"
        >
          {trailErrorText(query.error)}
        </div>
      ) : items.length === 0 ? (
        <div
          className="text-xs text-muted-foreground"
          data-testid="okf-trail-empty"
        >
          This agent made no KB or code call that Log Hub can place in the
          repository.
        </div>
      ) : (
        <>
          {query.data?.truncated ? (
            <div
              data-testid="okf-trail-truncated"
              className="text-[11px] text-amber-700 dark:text-amber-400"
            >
              Showing the first {items.length.toLocaleString()} accesses only —
              the agent made more.
            </div>
          ) : null}
          <div className="space-y-1">
            {episodes.map((e, i) => (
              <Episode key={i} episode={e} byOrd={byOrd} />
            ))}
          </div>
        </>
      )}
      <p
        data-testid="okf-trail-hint"
        className="text-[11px] text-muted-foreground"
      >
        Judge: a search for something the article names is a gap in the article;
        a search for something else is not. Highlighted rows are in the code
        area of an article this agent read before.
      </p>
    </div>
  );
}
