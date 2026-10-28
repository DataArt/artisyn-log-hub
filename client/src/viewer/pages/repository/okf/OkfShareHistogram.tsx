/**
 * "File share per session" histogram of the repo OKF tab: four plain CSS bars (no chart
 * library), one per share bin, each labelled with its session count. Share is a bounded
 * ratio, so the bars use one flat colour, not the zone palette (ui-principles.md).
 */
import type {
  OkfShareBin,
  RepoOkfUsageResponse,
} from '../../../../models/repositories';

const BIN_ORDER: readonly OkfShareBin[] = ['0-10', '10-25', '25-50', '50+'];

const BIN_LABEL: Record<OkfShareBin, string> = {
  '0-10': '0–10 %',
  '10-25': '10–25 %',
  '25-50': '25–50 %',
  '50+': '>50 %',
};

const BAR_AREA_PX = 96;

export function OkfShareHistogram({
  bins,
}: {
  bins: RepoOkfUsageResponse['shareBins'];
}) {
  const counts = new Map(bins.map((b) => [b.bin, b.sessions]));
  const total = bins.reduce((s, b) => s + b.sessions, 0);
  const max = Math.max(0, ...bins.map((b) => b.sessions));

  return (
    <div
      data-testid="okf-share-histogram"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        File share per session · {total.toLocaleString()} sessions
      </div>
      {total === 0 ? (
        <div className="py-4 text-center text-xs text-muted-foreground">
          No snapshot-bound KB session
        </div>
      ) : (
        <div className="flex items-end gap-3">
          {BIN_ORDER.map((bin) => {
            const n = counts.get(bin) ?? 0;
            const h = max > 0 ? Math.round((n / max) * BAR_AREA_PX) : 0;
            return (
              <div
                key={bin}
                data-testid="okf-share-bin"
                className="flex flex-1 flex-col items-center gap-1"
              >
                <span className="font-mono text-[11px] tabular-nums">
                  {n.toLocaleString()}
                </span>
                <div
                  className="flex w-full items-end"
                  style={{ height: BAR_AREA_PX }}
                >
                  <div
                    className="w-full rounded-t bg-sky-500"
                    style={{ height: Math.max(n > 0 ? 2 : 0, h) }}
                  />
                </div>
                <span className="text-[10px] text-muted-foreground">
                  {BIN_LABEL[bin]}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
