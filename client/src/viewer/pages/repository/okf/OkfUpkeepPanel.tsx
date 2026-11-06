/**
 * "Upkeep" panel of the repo OKF tab (FR-5, DD-15): KB articles read by an agent that also
 * edited them. Those reads are maintenance, not lookups, so they are excluded from the read
 * totals, shares, hot files and the verdict, and listed here instead (article · sessions ·
 * bytes). A click scrolls the tree to the article.
 */
import { formatBytes } from '@/lib/format';
import type { OkfRepoUpkeepItem } from '../../../../models/repositories';
import { pathInBundle } from './okf-url-state';

export function OkfUpkeepPanel({
  items,
  onNodeClick,
}: {
  items: readonly OkfRepoUpkeepItem[];
  onNodeClick: (bundle: string | null, path?: string) => void;
}) {
  return (
    <div
      data-testid="okf-upkeep-panel"
      className="rounded-md border border-border bg-card p-3"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Upkeep · reads by agents that edited the article
      </div>
      <div className="mb-1 text-[11px] text-muted-foreground">
        Excluded from read totals, shares, hot files and the verdict.
      </div>
      {items.length === 0 ? (
        <div className="py-2 text-xs text-muted-foreground">
          No upkeep reads
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2 px-1 text-[10px] text-muted-foreground">
            <span className="min-w-0 flex-1">Article</span>
            <span className="w-8 shrink-0 text-right">Sess.</span>
            <span className="w-16 shrink-0 text-right">Read</span>
          </div>
          {items.map((u) => (
            <button
              key={`${u.bundle ?? ''}:${u.path}`}
              type="button"
              data-testid="okf-upkeep-row"
              onClick={() => onNodeClick(u.bundle, u.path)}
              title={`${u.path} · ${u.sessions} sessions`}
              className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
            >
              <span className="min-w-0 flex-1 truncate font-mono">
                {pathInBundle(u.bundle, u.path)}
              </span>
              <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {u.sessions}
              </span>
              <span className="w-16 shrink-0 text-right font-mono tabular-nums">
                {formatBytes(u.readBytes)}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
