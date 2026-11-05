/**
 * Whole-tree value-signals tile of the session OKF tab (2026-11-03 OKF value signals): pointers
 * used, routing misses, searched-after-reading pairs and dead pointers, as the server sent them
 * in `signals`, plus the muted "events truncated" note when a node hit the per-node event cap.
 * Hidden on an older server (no `signals`).
 */
import type { OkfSignalSummary } from '../../../../../models/repositories';

function Cell({
  label,
  value,
  hint,
  testId,
}: {
  label: string;
  value: string;
  hint: string;
  testId: string;
}) {
  return (
    <div className="min-w-[120px]" data-testid={testId} title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums">{value}</div>
    </div>
  );
}

export function OkfValueSignalsTile({
  signals,
  eventsTruncated,
}: {
  signals?: OkfSignalSummary;
  eventsTruncated?: boolean;
}) {
  if (!signals && !eventsTruncated) return null;
  return (
    <div
      data-testid="okf-value-signals-tile"
      className="inline-block max-w-4xl space-y-2 rounded-md border border-border bg-card px-3 py-2"
    >
      {signals ? (
        <>
          <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Value signals · whole session tree
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Cell
              testId="okf-signal-pointers-used"
              label="Pointers used"
              value={
                signals.readsWithNewPointers > 0
                  ? `${signals.readsFollowed} / ${signals.readsWithNewPointers} reads`
                  : '—'
              }
              hint="Reads that showed a new code pointer, and how many of them had one followed"
            />
            <Cell
              testId="okf-signal-routing-miss"
              label="Routing misses"
              value={`${signals.routingMissArticles} ${signals.routingMissArticles === 1 ? 'article' : 'articles'}`}
              hint="Articles whose code area agents searched without opening the article"
            />
            <Cell
              testId="okf-signal-searched-after"
              label="Searched after reading"
              value={`${signals.searchedAfterPairs} ${signals.searchedAfterPairs === 1 ? 'pair' : 'pairs'}`}
              hint="Agent · article pairs where the agent kept searching the article's area after reading it"
            />
            <Cell
              testId="okf-signal-dead"
              label="Dead pointers"
              value={signals.deadPointers.toLocaleString()}
              hint="Pointers shown in reads that no agent ever followed"
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
