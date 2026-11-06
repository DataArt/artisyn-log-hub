/**
 * "Read · top 5 by bytes" of the session OKF verdict card, with the "N partial reads" chip on an
 * article read partly by line range (FR-4) and, under it, the muted "Upkeep" line: articles an
 * agent edited itself, whose re-reads are excluded from the totals and the verdict (FR-5).
 */
import { RefreshCw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { formatBytes } from '@/lib/format';
import type {
  OkfReadTopItem,
  OkfSessionUpkeepItem,
} from '../../../../../models/repositories';
import { okfPartialReadsText } from './okf-tree';

function OwnEditIcon() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="shrink-0" data-testid="okf-own-edit-icon">
          <RefreshCw
            className="size-3 text-muted-foreground"
            aria-label="read after own edit"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs">
        Read after the agent edited this file itself: it re-checked its own
        change rather than looking something up in the KB.
      </TooltipContent>
    </Tooltip>
  );
}

export function OkfReadTop({
  readTop,
  upkeep = [],
  rangedCalls,
  onNodeClick,
}: {
  readTop: readonly OkfReadTopItem[];
  upkeep?: readonly OkfSessionUpkeepItem[];
  /** Ranged read calls by file path (from the tree). */
  rangedCalls?: ReadonlyMap<string, number>;
  onNodeClick: (bundle: string | null, path?: string) => void;
}) {
  const top5 = readTop.slice(0, 5);
  if (top5.length === 0 && upkeep.length === 0) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        Read · top 5 by bytes
      </div>
      {top5.map((r) => {
        const ranged = rangedCalls?.get(r.path) ?? 0;
        return (
          <button
            key={`${r.bundle ?? ''}:${r.path}`}
            type="button"
            data-testid="okf-read-top"
            onClick={() => onNodeClick(r.bundle, r.path)}
            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent/60"
          >
            <span className="min-w-0 flex-1 truncate font-mono">{r.path}</span>
            {ranged > 0 ? (
              <span
                data-testid="okf-section-chip"
                className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground"
                title="Read calls with a line range (not the whole file)"
              >
                {okfPartialReadsText(ranged)}
              </span>
            ) : null}
            {r.ownEdit ? <OwnEditIcon /> : null}
            <span className="w-16 shrink-0 text-right font-mono tabular-nums">
              {formatBytes(r.readBytes)}
            </span>
          </button>
        );
      })}
      {upkeep.length > 0 ? (
        <div
          data-testid="okf-upkeep-line"
          className="mt-1 px-1 text-[11px] text-muted-foreground"
        >
          Upkeep (excluded from the totals and the verdict):{' '}
          {upkeep.map((u, i) => (
            <span key={`${u.bundle ?? ''}:${u.path}`}>
              {i > 0 ? ' · ' : ''}
              <button
                type="button"
                className="font-mono hover:underline"
                onClick={() => onNodeClick(u.bundle, u.path)}
              >
                {u.path}
              </button>{' '}
              {formatBytes(u.readBytes)} / {u.readCalls}{' '}
              {u.readCalls === 1 ? 'read' : 'reads'}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
