/**
 * "Cost structure & hidden calls" (2026-10-30 otel-tabs-traces, Visual/UX notes): share bars per
 * `query_source` (top `OTEL_SHARE_TOP` + "other (N)"), a click on a row isolates that source in
 * the chart, and the hidden-call bars (cost · calls per hidden source).
 */
import { cn } from '@/lib/cn';
import type { OtelQuerySourceRow } from '../../../../models/repositories';
import {
  formatCount,
  formatMicrosUsd,
  formatShare,
  formatUsd,
  microsToUsd,
} from './otel-format';
import { OtelHelpLink } from './OtelHelpLink';
import { OTEL_HELP_ANCHORS, OTEL_SHARE_TOP } from './otel.constants';

export interface OtelShareBar {
  key: string;
  label: string;
  cost: number;
  share: number;
  /** The folded remainder; not clickable. */
  other: boolean;
}

/** Top `top` sources by cost plus one "other (N)" row (pure). */
export function otelShareBars(
  rows: readonly OtelQuerySourceRow[],
  top: number = OTEL_SHARE_TOP,
): OtelShareBar[] {
  const sorted = [...rows].sort(
    (a, b) =>
      (microsToUsd(b.costUsdMicros) ?? 0) - (microsToUsd(a.costUsdMicros) ?? 0),
  );
  const head = sorted.slice(0, top).map((r) => ({
    key: r.querySource,
    label: r.querySource || '(unknown)',
    cost: microsToUsd(r.costUsdMicros) ?? 0,
    share: r.share,
    other: false,
  }));
  const rest = sorted.slice(top);
  if (rest.length === 0) return head;
  return [
    ...head,
    {
      key: '__other',
      label: `other (${rest.length})`,
      cost: rest.reduce((a, r) => a + (microsToUsd(r.costUsdMicros) ?? 0), 0),
      share: rest.reduce((a, r) => a + r.share, 0),
      other: true,
    },
  ];
}

export interface OtelStructureSectionProps {
  querySources: readonly OtelQuerySourceRow[];
  /** The source isolated in the chart, if any. */
  isolated: string | null;
  onIsolate: (querySource: string | null) => void;
}

export function OtelStructureSection({
  querySources,
  isolated,
  onIsolate,
}: OtelStructureSectionProps) {
  const bars = otelShareBars(querySources);
  const hidden = querySources
    .filter((r) => r.hidden)
    .sort(
      (a, b) =>
        (microsToUsd(b.costUsdMicros) ?? 0) -
        (microsToUsd(a.costUsdMicros) ?? 0),
    );
  const maxHidden = Math.max(
    0,
    ...hidden.map((r) => microsToUsd(r.costUsdMicros) ?? 0),
  );

  return (
    <section className="rounded-md border p-4" data-testid="otel-structure">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Cost structure &amp; hidden calls
      </h3>
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <div className="text-sm font-semibold">Share by query_source</div>
          <p className="mb-2 text-xs text-muted-foreground">
            click a row to isolate it in the chart
          </p>
          <ul className="space-y-1.5">
            {bars.map((b) => {
              const active = isolated === b.key;
              return (
                <li key={b.key}>
                  <button
                    type="button"
                    disabled={b.other}
                    onClick={() => onIsolate(active ? null : b.key)}
                    className={cn(
                      'w-full rounded px-1 py-0.5 text-left text-xs',
                      !b.other && 'hover:bg-accent',
                      active && 'bg-blue-50 ring-1 ring-blue-300',
                    )}
                    data-testid="otel-share-row"
                  >
                    <div className="flex justify-between gap-2">
                      <span className="truncate font-mono">{b.label}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatUsd(b.cost)} · {formatShare(b.share)}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded bg-muted">
                      <div
                        className="h-1.5 rounded bg-blue-500"
                        style={{ width: `${Math.min(100, b.share * 100)}%` }}
                      />
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div>
          <div className="text-sm font-semibold">Hidden calls</div>
          <p className="mb-2 text-xs text-muted-foreground">
            API calls with no transcript records
          </p>
          {hidden.length === 0 ? (
            <p className="text-xs text-muted-foreground">No hidden calls.</p>
          ) : (
            <ul className="space-y-1.5" data-testid="otel-hidden-bars">
              {hidden.map((r) => {
                const cost = microsToUsd(r.costUsdMicros) ?? 0;
                return (
                  <li key={r.querySource} className="text-xs">
                    <div className="flex justify-between gap-2">
                      <span className="truncate font-mono">
                        {r.querySource || '(unknown)'}
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatMicrosUsd(r.costUsdMicros)} ·{' '}
                        {formatCount(r.calls)}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded bg-muted">
                      <div
                        className="h-1.5 rounded bg-red-400"
                        style={{
                          width: `${maxHidden > 0 ? (cost / maxHidden) * 100 : 0}%`,
                        }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Hidden = request_id in no transcript of the session tree (same rule
            as utility cost).{' '}
            <OtelHelpLink anchor={OTEL_HELP_ANCHORS.hidden}>More</OtelHelpLink>
          </p>
        </div>
      </div>
    </section>
  );
}
