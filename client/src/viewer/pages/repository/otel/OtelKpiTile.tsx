/**
 * Tile primitives of the OTEL KPI rows (2026-10-30 otel-tabs-traces, DD-28): a stat tile with a
 * grey "▲ / ▼ vs previous period" chip and an optional sparkline, the tokens-by-type tile and the
 * cache read ratio tile (fixed 0–100 % bar; `n/a` in the undefined-ratio colour, never 0 %).
 * Every tile carries a hint, so the row reads uniformly (ui-principles.md).
 */
import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import { cn } from '@/lib/cn';
import { CACHE_RATIO_SCOPE_COLORS } from '../../../lib/cache-ratio-ui';
import {
  formatOtelKpiChange,
  formatShare,
  formatTokenCount,
  type OtelKpiChange,
} from './otel-format';

export function OtelSparkline({ values }: { values: readonly number[] }) {
  if (values.length < 2) return null;
  const w = 96;
  const h = 22;
  const max = Math.max(...values, 0);
  const step = w / (values.length - 1);
  const points = values
    .map(
      (v, i) =>
        `${(i * step).toFixed(1)},${(h - 1 - (max > 0 ? (v / max) * (h - 2) : 0)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      className="mt-1 block"
      aria-hidden
      data-testid="otel-sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="#3b82f6"
        strokeWidth={1.25}
      />
    </svg>
  );
}

function TileLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger className="text-left text-xs text-muted-foreground underline decoration-dotted">
          {label}
        </TooltipTrigger>
        <TooltipContent className="max-w-[360px]">{hint}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface OtelKpiTileProps {
  label: string;
  hint: string;
  value: ReactNode;
  secondary?: ReactNode;
  change?: OtelKpiChange | null;
  sparkline?: readonly number[];
  /** Amber outline while the value just changed (live highlight). */
  highlighted?: boolean;
  testId?: string;
  className?: string;
}

export function OtelKpiTile({
  label,
  hint,
  value,
  secondary,
  change,
  sparkline,
  highlighted,
  testId,
  className,
}: OtelKpiTileProps) {
  return (
    <div
      className={cn(
        'min-w-[150px] flex-1 rounded-md border px-4 py-3 transition-shadow',
        highlighted && 'border-amber-400 ring-2 ring-amber-200',
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-2">
        <TileLabel label={label} hint={hint} />
        {change && (
          <span
            className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="Change vs the previous period of equal length"
          >
            {formatOtelKpiChange(change)}
          </span>
        )}
      </div>
      <div className="mt-1 font-mono text-lg font-bold">{value}</div>
      {secondary !== undefined && (
        <div className="text-xs text-muted-foreground">{secondary}</div>
      )}
      {sparkline && <OtelSparkline values={sparkline} />}
    </div>
  );
}

export interface OtelTokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function OtelTokensTile({ tokens }: { tokens: OtelTokenTotals }) {
  const parts: [string, number][] = [
    ['input', tokens.input],
    ['output', tokens.output],
    ['cache read', tokens.cacheRead],
    ['cache write', tokens.cacheWrite],
  ];
  return (
    <div
      className="min-w-[260px] flex-[2] rounded-md border px-4 py-3"
      data-testid="otel-kpi-tokens"
    >
      <TileLabel
        label="Tokens by type"
        hint="Sum of the input, output, cache read and cache write tokens of the OTEL API calls in the period and filters."
      />
      <div className="mt-1 grid grid-cols-4 gap-2">
        {parts.map(([name, v]) => (
          <div key={name}>
            <div className="text-[10px] text-muted-foreground">{name}</div>
            <div className="font-mono text-sm font-bold">
              {formatTokenCount(v)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OtelCacheRatioTile({ ratio }: { ratio: number | null }) {
  const pct = ratio === null ? null : Math.max(0, Math.min(1, ratio));
  return (
    <div
      className="min-w-[200px] flex-1 rounded-md border px-4 py-3"
      data-testid="otel-kpi-cache-ratio"
    >
      <TileLabel
        label="Cache read ratio"
        hint="cache read / (input + cache read + cache write). n/a when there are no input or cache tokens."
      />
      <div
        className="mt-1 font-mono text-lg font-bold"
        style={
          pct === null
            ? { color: CACHE_RATIO_SCOPE_COLORS.undefinedRatio }
            : undefined
        }
      >
        {pct === null ? 'n/a' : formatShare(pct)}
      </div>
      <div className="mt-1 h-1.5 rounded bg-muted">
        {pct === null ? (
          <div
            className="h-1.5 w-3 rounded border-t border-dashed"
            style={{ borderColor: CACHE_RATIO_SCOPE_COLORS.undefinedRatio }}
          />
        ) : (
          <div
            className="h-1.5 rounded"
            style={{
              width: `${pct * 100}%`,
              backgroundColor: CACHE_RATIO_SCOPE_COLORS.root,
            }}
          />
        )}
      </div>
      <div className="mt-0.5 flex justify-between text-[10px] text-muted-foreground">
        <span>0 %</span>
        <span>100 %</span>
      </div>
    </div>
  );
}
