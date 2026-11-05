/**
 * Building blocks of the Live details panel (2026-11-04 otel-live-view, DD-10): label / value
 * rows, titled sections, ranked lists, the top-tools list and the latest events / calls lists.
 * Masked values (DD-11) read "masked"; aggregates are never masked.
 */
import type { ReactNode } from 'react';
import type {
  OtelLiveCallRow,
  OtelLiveEvent,
  OtelLiveTopTool,
  OtelLiveTotals,
} from '../../models/otel-live';
import {
  formatCount,
  formatMicrosUsd,
  formatTokenCount,
} from '../pages/repository/otel/otel-format';
import { formatLiveClock, formatLiveSpanMs } from './live-format';

/** `$0.84 · 430.0 K`: cost and all four token sums. */
export function costAndTokens(t: OtelLiveTotals): string {
  const tokens =
    (Number(t.inputTokens) || 0) +
    (Number(t.outputTokens) || 0) +
    (Number(t.cacheReadTokens) || 0) +
    (Number(t.cacheWriteTokens) || 0);
  return `${formatMicrosUsd(t.costUsdMicros)} · ${formatTokenCount(tokens)}`;
}

export function DetailRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

export function DetailSection({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      className="space-y-1 border-t border-border pt-2"
      data-testid={testId}
    >
      <h4 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        {title}
        {hint && <span className="ml-1 normal-case">· {hint}</span>}
      </h4>
      {children}
    </section>
  );
}

export interface RankedItem {
  key: string;
  label: string;
  value: string;
  onClick?: () => void;
}

export function RankedList({ items }: { items: readonly RankedItem[] }) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">None.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {items.map((it) => {
        const label = (
          <span className="min-w-0 truncate" title={it.label}>
            {it.label}
          </span>
        );
        return (
          <li
            key={it.key}
            className="flex items-baseline justify-between gap-3"
            data-testid="live-details-item"
          >
            {it.onClick ? (
              <button
                type="button"
                className="min-w-0 truncate text-left hover:underline"
                onClick={it.onClick}
              >
                {label}
              </button>
            ) : (
              label
            )}
            <span className="shrink-0 font-mono text-xs">{it.value}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Top tools from spans; `null` with `masked` → "masked" (DD-11). */
export function TopTools({
  tools,
  masked,
}: {
  tools: readonly OtelLiveTopTool[] | null;
  masked: boolean;
}) {
  return (
    <DetailSection
      title="Top tools (spans)"
      hint="last 2 h"
      testId="live-details-tools"
    >
      {tools === null ? (
        <p className="text-xs text-muted-foreground">
          {masked ? 'masked' : 'No tool spans.'}
        </p>
      ) : (
        <RankedList
          items={tools.map((t) => ({
            key: t.name,
            label: t.name,
            value:
              t.failed > 0
                ? `${formatCount(t.calls)} · ${t.failed} failed`
                : formatCount(t.calls),
          }))}
        />
      )}
    </DetailSection>
  );
}

export function LatestEvents({
  events,
  masked,
  now,
}: {
  events: readonly OtelLiveEvent[] | null;
  masked: boolean;
  now: number;
}) {
  const list = events ?? [];
  return (
    <DetailSection title="Latest OTEL events" testId="live-details-events">
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No events.</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-xs">
          {list.map((e, i) => (
            <li
              key={`${e.time}-${e.kind}-${i}`}
              className="flex gap-2"
              data-testid="live-details-event"
            >
              <span className="shrink-0">{formatLiveClock(e.time, now)}</span>
              <span className="shrink-0 text-muted-foreground">
                {e.kind === 'tool' ? 'tool span' : e.kind}
              </span>
              <span className="min-w-0 flex-1 truncate" title={e.label ?? ''}>
                {e.label ?? (masked && e.kind === 'tool' ? 'masked' : '')}
              </span>
              {e.costUsdMicros !== null && (
                <span className="shrink-0">
                  {formatMicrosUsd(e.costUsdMicros)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

export function LatestCalls({
  calls,
  now,
}: {
  calls: readonly OtelLiveCallRow[] | null;
  now: number;
}) {
  const list = calls ?? [];
  return (
    <DetailSection title="Latest calls" testId="live-details-calls">
      {list.length === 0 ? (
        <p className="text-xs text-muted-foreground">No calls.</p>
      ) : (
        <ul className="space-y-0.5 font-mono text-xs">
          {list.map((c) => (
            <li key={c.callKey} className="flex gap-2">
              <span className="shrink-0">
                {formatLiveClock(c.eventTime, now)}
              </span>
              <span className="shrink-0">
                {formatMicrosUsd(c.costUsdMicros)}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {formatLiveSpanMs(c.durationMs)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}
