/**
 * Session-tree sub-rows (2026-11-03 OKF value signals): under an article row, one expandable row
 * per agent with the new code pointers it was shown there (✓ = followed), and one row per agent
 * that searched the article's code area without opening it ("routing miss · N searches") with
 * its action line. Misses on articles that are not in the tree are listed after the rows.
 */
import { useSearchParams } from 'react-router-dom';
import { okfActionText } from '@/lib/okf/okf-action-text';
import { OkfMissCheck } from './OkfMissCheck';
import {
  okfMissFinding,
  type OkfAgentMiss,
  type OkfAgentPointers,
} from './okf-session-details';

/** One agent's new pointers in one article. */
export function OkfAgentPointerRow({
  entry,
  depth,
}: {
  entry: OkfAgentPointers;
  depth: number;
}) {
  const followed = entry.pointers.filter((p) => p.followed).length;
  return (
    <div
      data-testid="okf-agent-pointers"
      className="space-y-0.5 border-l-2 border-sky-500/40 bg-muted/30 py-1 pr-2 text-[11px]"
      style={{ marginLeft: 8 + depth * 14 + 18, paddingLeft: 8 }}
    >
      <div className="text-muted-foreground">
        <span className="font-mono font-medium text-foreground">
          {entry.label}
        </span>{' '}
        · {entry.pointers.length} new code{' '}
        {entry.pointers.length === 1 ? 'path' : 'paths'} shown · {followed}{' '}
        followed
        {entry.promptNamedPaths > 0 ? (
          <span data-testid="okf-prompt-named">
            {' '}
            · {entry.promptNamedPaths}{' '}
            {entry.promptNamedPaths === 1 ? 'path' : 'paths'} already named in
            its prompt
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
        {entry.pointers.map((p) => (
          <span
            key={p.pointer}
            data-testid="okf-agent-pointer"
            data-followed={p.followed}
            className={p.followed ? '' : 'text-muted-foreground'}
          >
            {p.followed ? '✓' : '·'} {p.pointer}
          </span>
        ))}
      </div>
    </div>
  );
}

/** "routing miss · N searches" row of one agent on one article, with its action line. */
export function OkfMissRow({
  miss,
  depth,
  showArticle = false,
}: {
  miss: OkfAgentMiss;
  depth: number;
  showArticle?: boolean;
}) {
  const action = okfActionText(okfMissFinding(miss));
  // Same session page, Bash tab: keep the current URL params (repo, team, session), swap the tab.
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.set('tab', 'bash');
  next.delete('bashCall');
  const bashTo = `?${next.toString()}`;
  return (
    <div
      data-testid="okf-routing-miss-row"
      className="space-y-0.5 border-l-2 border-amber-500/50 py-1 pr-2 text-[11px]"
      style={{ marginLeft: 8 + depth * 14 + 18, paddingLeft: 8 }}
    >
      <div>
        <span className="font-mono font-medium">{miss.label}</span>
        {showArticle ? (
          <span className="font-mono text-muted-foreground">
            {' '}
            · {miss.article}
          </span>
        ) : null}
        <span className="text-amber-600 dark:text-amber-400">
          {' '}
          · searched without reading · {miss.searches}{' '}
          {miss.searches === 1 ? 'search' : 'searches'}
        </span>
      </div>
      <OkfMissCheck patterns={miss.patterns} to={bashTo} />
      {action ? (
        <div
          data-testid="okf-routing-miss-action"
          className="text-muted-foreground"
        >
          → {action}
        </div>
      ) : null}
    </div>
  );
}

/** Routing misses on articles that are not rows of the tree (e.g. no snapshot). */
export function OkfOrphanMisses({
  misses,
}: {
  misses: readonly OkfAgentMiss[];
}) {
  if (misses.length === 0) return null;
  return (
    <div className="border-t border-border py-1">
      <div className="px-3 text-[10px] uppercase tracking-wide text-muted-foreground">
        Searched without reading — articles outside the tree
      </div>
      {misses.map((m) => (
        <OkfMissRow
          key={`${m.agentId}:${m.article}`}
          miss={m}
          depth={0}
          showArticle
        />
      ))}
    </div>
  );
}
