/**
 * Whole-tree value-signals tile of the session OKF tab (2026-11-03 OKF value signals): code paths
 * followed, searched without reading, searched after reading (counted per agent and article) and dead pointers,
 * each with its one-line explanation as a visible caption, as the server sent them
 * in `signals`, plus the muted "events truncated" note when a node hit the per-node event cap.
 * Hidden on an older server (no `signals`). The two search counts link to the trail of the first
 * agent behind them (package 3), so the number can be checked by hand.
 */
import type { OkfSignalSummary } from '../../../../../models/repositories';

function Cell({
  label,
  value,
  hint,
  testId,
  onTrail,
}: {
  label: string;
  value: string;
  hint: string;
  testId: string;
  /** Opens the trail of an agent behind this number (package 3); absent = no link. */
  onTrail?: () => void;
}) {
  return (
    <div className="w-44" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
      <div
        className="text-[11px] leading-snug text-muted-foreground"
        data-testid="okf-signal-caption"
      >
        {hint}
      </div>
      {onTrail ? (
        <button
          type="button"
          data-testid="okf-signal-trail-link"
          onClick={onTrail}
          className="text-[11px] text-primary underline-offset-2 hover:underline"
        >
          Check by hand: show an agent's trail →
        </button>
      ) : null}
    </div>
  );
}

/** "Searched after reading" value: agent × article pairs, in words. */
function searchedAfterText(pairs: number): string {
  if (pairs === 0) return 'none';
  return pairs === 1
    ? '1 agent kept searching after reading'
    : `${pairs.toLocaleString()} agents kept searching after reading`;
}

export function OkfValueSignalsTile({
  signals,
  eventsTruncated,
  trailAgents,
  onShowTrail,
}: {
  signals?: OkfSignalSummary;
  eventsTruncated?: boolean;
  /** The first agent behind each count, whose trail the cell links to (package 3). */
  trailAgents?: { searchedAfter: string | null; routingMiss: string | null };
  onShowTrail?: (agentId: string) => void;
}) {
  if (!signals && !eventsTruncated) return null;
  const link = (id: string | null | undefined) =>
    id && onShowTrail ? () => onShowTrail(id) : undefined;
  return (
    <div
      data-testid="okf-value-signals-tile"
      className="inline-block max-w-4xl space-y-2 rounded-md border border-border bg-card px-3 py-2"
    >
      {signals ? (
        <>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Value signals (heuristic) · whole session tree
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Cell
              testId="okf-signal-pointers-used"
              label="Code paths followed"
              value={
                signals.readsWithNewPointers > 0
                  ? `${signals.readsFollowed} / ${signals.readsWithNewPointers} reads`
                  : '—'
              }
              hint="Reads that showed a new code path, and how many had one opened afterwards"
            />
            <Cell
              testId="okf-signal-routing-miss"
              label="Searched without reading"
              value={`${signals.routingMissArticles} ${signals.routingMissArticles === 1 ? 'article' : 'articles'}`}
              hint="Articles whose code area agents searched without opening the article"
              onTrail={link(trailAgents?.routingMiss)}
            />
            <Cell
              testId="okf-signal-searched-after"
              label="Searched after reading"
              value={searchedAfterText(signals.searchedAfterPairs)}
              hint="Counted per agent and article: it kept searching the article's code area after reading it"
              onTrail={link(trailAgents?.searchedAfter)}
            />
            <Cell
              testId="okf-signal-dead"
              label="Dead pointers"
              value={signals.deadPointers.toLocaleString()}
              hint="Code paths shown in reads that no agent ever opened"
            />
          </div>
        </>
      ) : null}
      {eventsTruncated ? (
        <div
          data-testid="okf-events-truncated"
          className="text-[11px] text-muted-foreground"
        >
          Events truncated — an agent made more code calls than are stored; the
          signals count only the stored ones.
        </div>
      ) : null}
    </div>
  );
}
