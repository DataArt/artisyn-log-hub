/**
 * The Summary tab's stat-tile primitive.
 *
 * A new tile rather than an extraction of the Usage tab's private `StatTile`
 * (`usage/SessionUsageTab.tsx:40-66`): the visual contract (`rounded-md border px-4 py-3`,
 * `text-xs text-muted-foreground` label with an optional dotted-underline tooltip, `mt-1
 * font-mono text-lg font-bold` value) is kept identical, but this tile is strictly richer —
 * it also carries an optional secondary line, an optional progress bar (the peak-context tile),
 * and dedicated `incomplete` / `loading` render states.
 */
import type { ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { Skeleton } from '@/ui/skeleton';
import { cn } from '@/lib/cn';

export interface SummaryStatTileProgress {
  /** Fraction in `[0, 1]`, or `null` to render an empty track (Visual/UX notes: unknown window). */
  pct: number | null;
  /**
   * Optional Tailwind background class for the filled portion, so a
   * meter can carry a **fixed, data-defined** colour (the change-surface band) instead of the
   * peak-context tile's decorative amber. Defaults to that amber when omitted, which is what
   * every existing caller relies on.
   */
  colorClassName?: string;
}

interface Props {
  label: string;
  /** Optional tooltip hint, rendered as a dotted-underline trigger over the label. */
  hint?: string;
  value: ReactNode;
  secondary?: ReactNode;
  /** Thin progress bar under the value/secondary line — only the peak-context tile uses this. */
  progress?: SummaryStatTileProgress;
  /**
   * The "incomplete" render: dashed border, muted `n/a` value, and a small
   * "data incomplete" chip, in place of `value`/`secondary`/`progress`.
   */
  incomplete?: boolean;
  /** `Skeleton` bars in the value/secondary positions — never a zeroed value. */
  loading?: boolean;
  /**
   * Optional left-border accent (`border-l-<color>-500 dark:border-l-<color>-400`), the same
   * categorical colors the Executive Summary report's `KpiTiles.tsx` uses. Purely decorative —
   * identity is still carried by `label`, never by hue alone — so it is suppressed on the
   * `incomplete`/`loading` states rather than implying data-backed color where there is none.
   */
  accentClassName?: string;
}

export function SummaryStatTile({
  label,
  hint,
  value,
  secondary,
  progress,
  incomplete = false,
  loading = false,
  accentClassName,
}: Props) {
  return (
    <div
      className={cn(
        'min-w-[150px] flex-1 rounded-md border border-l-[3px] px-4 py-3',
        incomplete && 'border-dashed',
        !incomplete && !loading && accentClassName,
      )}
    >
      <div className="text-xs text-muted-foreground">
        {hint ? (
          <Tooltip>
            <TooltipTrigger className="text-left underline decoration-dotted">
              {label}
            </TooltipTrigger>
            <TooltipContent className="max-w-[360px]">{hint}</TooltipContent>
          </Tooltip>
        ) : (
          label
        )}
      </div>

      {loading ? (
        <div className="mt-1.5 flex flex-col gap-1.5">
          <Skeleton className="h-6 w-20" />
          <Skeleton className="h-3 w-28" />
        </div>
      ) : incomplete ? (
        <>
          <div className="mt-1 font-mono text-lg font-bold text-muted-foreground">
            n/a
          </div>
          <div className="mt-1.5 inline-flex items-center rounded-full border border-dashed border-muted-foreground/40 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            data incomplete
          </div>
        </>
      ) : (
        <>
          <div className="mt-1 font-mono text-lg font-bold">{value}</div>
          {secondary != null && (
            <div className="mt-1 text-xs text-muted-foreground">
              {secondary}
            </div>
          )}
          {progress && (
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full',
                  progress.colorClassName ?? 'bg-amber-500',
                )}
                style={{
                  width:
                    progress.pct != null
                      ? `${Math.min(100, Math.max(0, progress.pct * 100))}%`
                      : '0%',
                }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
