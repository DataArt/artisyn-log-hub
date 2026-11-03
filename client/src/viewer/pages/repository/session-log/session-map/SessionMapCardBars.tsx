/**
 * The three bars of a Session Map card — cost, tool-call mix, context — each with an instant
 * cursor-following hint (`HoverPopover`) that names the numbers behind it and shows the colour key.
 * Hovering a bar row highlights it, so it is clear which bar the hint is about.
 */
import type * as React from 'react';
import { HoverPopover } from '../../../../components/ViewportPopover';
import { zoneColor } from '../../analytics/HorizontalBarChart';
import { formatTokens } from '../../../../lib/format';
import type { MapNode } from './session-map-model';
import { CONTEXT_BAR_COLOR, FAMILIES } from './session-map.constants';
import { formatMapUsd, formatShare } from './session-map-format';

const ZONES = [
  { color: '#22c55e', label: 'under 25%' },
  { color: '#3b82f6', label: '25–75%' },
  { color: '#f97316', label: 'over 75%' },
] as const;

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
      style={{ backgroundColor: color }}
    />
  );
}

function Hint({
  title,
  children,
}: {
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="font-semibold text-foreground">{title}</div>
      {children}
    </div>
  );
}

/**
 * A labelled bar row that highlights on hover and shows `hint` under the cursor; `value` is the
 * optional right-hand figure.
 */
function HintRow({
  label,
  hint,
  value,
  children,
}: {
  label: string;
  hint: React.ReactNode;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <HoverPopover maxWidth={320} className="px-3 py-2.5 text-xs" content={hint}>
      <div className="-mx-1 flex cursor-help items-center gap-2 rounded px-1 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-slate-100">
        <span className="w-14 shrink-0">{label}</span>
        <div className="flex-1">{children}</div>
        {value !== undefined && (
          <span className="w-20 shrink-0 text-right">{value}</span>
        )}
      </div>
    </HoverPopover>
  );
}

function Track({ fraction, color }: { fraction: number; color: string }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-slate-200/70">
      <div
        className="h-full rounded"
        style={{ width: `${pct}%`, backgroundColor: color }}
      />
    </div>
  );
}

export function CostBar({
  cost,
  share,
  scale,
  scaleLabel,
}: {
  cost: number;
  /** Share of the whole session cost. */
  share: number;
  scale: number;
  /** What a full bar stands for, e.g. "the most expensive agent". */
  scaleLabel: string;
}) {
  const fraction = scale > 0 ? cost / scale : 0;
  const color = zoneColor(cost, scale);
  return (
    <HintRow
      label="cost"
      hint={
        <Hint title={`Cost — ${formatMapUsd(cost)}`}>
          <div>{formatShare(share)} of the whole session cost.</div>
          <div>
            Bar: {formatShare(fraction)} of {scaleLabel} (
            <span className="font-mono">{formatMapUsd(scale)}</span>).
          </div>
          <div className="mt-0.5 flex flex-col gap-1">
            {ZONES.map((z) => (
              <div
                key={z.color}
                className={`flex items-center gap-2 ${z.color === color ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
              >
                <Swatch color={z.color} />
                {z.label}
              </div>
            ))}
          </div>
        </Hint>
      }
    >
      <Track fraction={fraction} color={color} />
    </HintRow>
  );
}

export function MixBar({
  familyCounts,
}: {
  familyCounts: MapNode['familyCounts'];
}) {
  const total = FAMILIES.reduce((s, f) => s + familyCounts[f.id], 0);
  const used = FAMILIES.filter((f) => familyCounts[f.id] > 0);
  return (
    <HintRow
      label="tools"
      hint={
        total === 0 ? (
          <Hint title="Tool calls">No tool calls yet</Hint>
        ) : (
          <Hint title={`Tool calls by type — ${total}`}>
            {used.map((f) => (
              <div key={f.id} className="flex items-center gap-2">
                <Swatch color={f.color} />
                <span className="flex-1">{f.label}</span>
                <span className="font-mono">{familyCounts[f.id]}</span>
                <span className="w-9 text-right text-muted-foreground">
                  {formatShare(familyCounts[f.id] / total)}
                </span>
              </div>
            ))}
          </Hint>
        )
      }
    >
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-slate-200/70">
        {used.map((f) => (
          <div
            key={f.id}
            style={{
              width: `${(familyCounts[f.id] / total) * 100}%`,
              backgroundColor: f.color,
            }}
          />
        ))}
      </div>
    </HintRow>
  );
}

export function ContextBar({
  peakContext,
  contextLength,
}: {
  peakContext: number | null;
  contextLength: number | null;
}) {
  const known = peakContext !== null && !!contextLength;
  const fraction = known ? peakContext / contextLength : 0;
  return (
    <HintRow
      label="context"
      value={
        known
          ? `${formatTokens(peakContext)} / ${formatTokens(contextLength)}`
          : 'n/a'
      }
      hint={
        <Hint title="Context window">
          {known ? (
            <>
              <div className="flex items-center gap-2">
                <Swatch color={CONTEXT_BAR_COLOR} />
                <span>
                  peak{' '}
                  <span className="font-mono">{formatTokens(peakContext)}</span>{' '}
                  of{' '}
                  <span className="font-mono">
                    {formatTokens(contextLength)}
                  </span>{' '}
                  tokens ({formatShare(fraction)})
                </span>
              </div>
              <div className="text-muted-foreground">
                Largest single request (input + cache) vs. the model’s context
                window.
              </div>
            </>
          ) : (
            <div className="text-muted-foreground">
              No token usage yet, or the model’s window is unknown.
            </div>
          )}
        </Hint>
      }
    >
      <Track fraction={fraction} color={CONTEXT_BAR_COLOR} />
    </HintRow>
  );
}
