/**
 * The turn navigator of the session OTEL tab (2026-10-30 otel-tabs-traces, DD-12, FR-30 / FR-31):
 * "‹ Turn n of N ›", the Start / Cost / Slowest order switch, Expand / Collapse, the turn header
 * (start, duration, cost, hidden, LLM calls, depth, spans, waiting, output tokens) and the turn
 * "Time" bar.
 *
 * `n` is the turn's chronological number; ‹ / › step through the turns in the chosen order, so
 * "Cost" walks from the most expensive turn down. The order only sorts the loaded turns.
 */
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDuration } from '../../../../lib/format';
import { OtelSegmented } from '../../otel/OtelChartControls';
import { formatCount, formatMicrosUsd } from '../../otel/otel-format';
import {
  splitOtelTurnTime,
  type OtelTurn,
  type OtelTurnOrder,
} from './otel-trace-assembly';
import { TraceTimeBar } from './TraceTimeBar';

export interface TraceNavigatorProps {
  /** The turns in the chosen order. */
  turns: readonly OtelTurn[];
  /** Index of the shown turn in `turns`. */
  position: number;
  onPositionChange: (position: number) => void;
  order: OtelTurnOrder;
  onOrderChange: (order: OtelTurnOrder) => void;
  /** The chronological number (1-based) of a turn. */
  turnNumber: (turn: OtelTurn) => number;
  onExpandAll: () => void;
  onCollapseAll: () => void;
}

const ORDER_OPTIONS = [
  { value: 'start', label: 'Start' },
  { value: 'cost', label: 'Cost' },
  { value: 'slowest', label: 'Slowest' },
] as const;

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-muted-foreground">{label} </span>
      <span className="font-mono font-semibold">{children}</span>
    </span>
  );
}

const STEP_BUTTON =
  'rounded border border-border p-0.5 hover:bg-accent disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent';

export function TraceNavigator({
  turns,
  position,
  onPositionChange,
  order,
  onOrderChange,
  turnNumber,
  onExpandAll,
  onCollapseAll,
}: TraceNavigatorProps) {
  const turn = turns[position];
  if (turn === undefined) return null;
  const h = turn.header;
  const split = splitOtelTurnTime(turn);

  return (
    <div className="space-y-2" data-testid="otel-trace-navigator">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={STEP_BUTTON}
            onClick={() => onPositionChange(position - 1)}
            disabled={position <= 0}
            aria-label="Previous turn"
            data-testid="otel-turn-prev"
          >
            <ChevronLeft className="size-4" />
          </button>
          <span className="text-sm font-semibold" data-testid="otel-turn-label">
            Turn {turnNumber(turn)} of {turns.length} · {clock(h.startMs)}
            {turn.inProgress && ' · running'}
          </span>
          <button
            type="button"
            className={STEP_BUTTON}
            onClick={() => onPositionChange(position + 1)}
            disabled={position >= turns.length - 1}
            aria-label="Next turn"
            data-testid="otel-turn-next"
          >
            <ChevronRight className="size-4" />
          </button>
          {turn.inProgress && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">
              in progress
            </span>
          )}
        </div>
        <OtelSegmented
          label="Order"
          value={order}
          options={ORDER_OPTIONS}
          onChange={onOrderChange}
          testId="otel-turn-order"
        />
        <span className="text-xs">
          <button
            type="button"
            className="text-blue-700 hover:underline"
            onClick={onExpandAll}
            data-testid="otel-expand-all"
          >
            Expand
          </button>
          <span className="text-muted-foreground"> · </span>
          <button
            type="button"
            className="text-blue-700 hover:underline"
            onClick={onCollapseAll}
            data-testid="otel-collapse-all"
          >
            Collapse
          </button>
        </span>
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
        data-testid="otel-turn-header"
      >
        <Stat label="Start">{clock(h.startMs)}</Stat>
        <Stat label="Duration">{formatDuration(h.durationMs)}</Stat>
        <Stat label="Cost">{formatMicrosUsd(h.costUsdMicros)}</Stat>
        {h.standaloneCostUsdMicros > 0 && (
          <Stat label="+ standalone">
            {formatMicrosUsd(h.standaloneCostUsdMicros)}
          </Stat>
        )}
        <Stat label="hidden">{formatMicrosUsd(h.hiddenCostUsdMicros)}</Stat>
        <Stat label="LLM calls">{formatCount(h.llmCalls)}</Stat>
        <Stat label="Depth">{formatCount(h.depth)}</Stat>
        <Stat label="Spans">{formatCount(h.spans)}</Stat>
        <Stat label="Waiting for you">{formatDuration(h.waitingMs)}</Stat>
        <Stat label="Output tokens">{formatCount(h.outputTokens)}</Stat>
      </div>
      <TraceTimeBar split={split} />
    </div>
  );
}
