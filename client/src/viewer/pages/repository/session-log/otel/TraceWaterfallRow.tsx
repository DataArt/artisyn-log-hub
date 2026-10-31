/**
 * One row of the session OTEL waterfall (2026-10-30 otel-tabs-traces): the indented operation
 * cell (toggle, operation, detail, `agent <id>`, own cost, Σ rollup, hidden / NEW tags), the
 * duration bar inside the visible time window and the duration text.
 *
 * Live state arrives as flags only (`isNew`, `flashSum`, `selected`) and is rendered with CSS
 * classes, so a poll never re-mounts a row (Visual/UX notes).
 */
import { memo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OtelCallRow } from '../../../../../models/repositories';
import { formatDuration } from '../../../../lib/format';
import { formatMicrosUsd } from '../../otel/otel-format';
import type { OtelTraceNode } from './otel-trace-assembly';
import { OTEL_SPAN_LLM_REQUEST } from './otel-trace-assembly';
import {
  otelSpanDetail,
  otelSpanOperation,
  shortAgentId,
} from './otel-span-format';
import { otelSpanBarClass } from './trace-bar-style';

/** The waterfall's grid: operation | bar | duration. */
export const WATERFALL_GRID =
  'grid grid-cols-[minmax(240px,40%)_minmax(0,1fr)_72px] items-center gap-x-2';

export interface TraceWaterfallRowProps {
  node: OtelTraceNode;
  call: OtelCallRow | undefined;
  /** Chronological number of the turn, for the provisional row's label. */
  turnNumber: number;
  /** Visible time range in ms epoch. */
  windowStartMs: number;
  windowEndMs: number;
  /** End used for spans that have none yet (the turn's latest span end). */
  openEndMs: number;
  collapsed: boolean;
  selected: boolean;
  isNew: boolean;
  /** A descendant just arrived or changed: flash the Σ value. */
  flashSum: boolean;
  onToggle: (key: string) => void;
  onSelect: (key: string) => void;
}

function TraceWaterfallRowImpl({
  node,
  call,
  turnNumber,
  windowStartMs,
  windowEndMs,
  openEndMs,
  collapsed,
  selected,
  isNew,
  flashSum,
  onToggle,
  onSelect,
}: TraceWaterfallRowProps) {
  const span = node.span;
  const hasChildren = node.children.length > 0;
  const hidden = span?.hidden === true;
  const unconfirmed = span !== null && !span.confirmed;
  const end = node.endMs ?? openEndMs;
  const range = Math.max(windowEndMs - windowStartMs, 1);
  const left = ((node.startMs - windowStartMs) / range) * 100;
  const width = Math.max(((end - node.startMs) / range) * 100, 0.4);
  const isLlm = span?.name === OTEL_SPAN_LLM_REQUEST;
  const detail = span !== null ? otelSpanDetail(span, call) : '';

  return (
    <div
      className={cn(
        WATERFALL_GRID,
        'relative cursor-pointer border-b border-border/50 py-1 pl-1 text-xs transition-colors duration-700',
        selected ? 'bg-blue-50' : isNew ? 'bg-amber-50' : 'hover:bg-accent/50',
        isNew && 'outline outline-1 -outline-offset-1 outline-amber-300',
      )}
      onClick={() => onSelect(node.key)}
      title={unconfirmed ? 'realtime, not yet confirmed' : undefined}
      data-testid="otel-waterfall-row"
      data-key={node.key}
      data-new={isNew ? 'true' : undefined}
      data-hidden={hidden ? 'true' : undefined}
      data-unconfirmed={unconfirmed ? 'true' : undefined}
    >
      {unconfirmed && (
        <span className="pointer-events-none absolute inset-y-0 left-0 border-l-2 border-dotted border-slate-500" />
      )}
      <div
        className="flex min-w-0 items-center gap-1.5"
        style={{ paddingLeft: node.depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="shrink-0 rounded hover:bg-accent"
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.key);
            }}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <ChevronRight className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="inline-block w-3.5 shrink-0" />
        )}
        {span === null ? (
          <span className="truncate">
            <span className="font-semibold">turn {turnNumber} in progress</span>{' '}
            <span className="italic text-muted-foreground">
              root span not received yet
            </span>
          </span>
        ) : (
          <span
            className={cn('truncate', hidden && 'text-red-600')}
            title={span.name}
          >
            <span className="font-mono">{otelSpanOperation(span.name)}</span>
            {detail && (
              <span className="ml-1.5 text-muted-foreground">{detail}</span>
            )}
          </span>
        )}
        {span?.agentId && (
          <span className="shrink-0 rounded bg-violet-50 px-1 text-[10px] text-violet-700">
            agent {shortAgentId(span.agentId)}
          </span>
        )}
        {hidden && (
          <span className="shrink-0 rounded bg-red-50 px-1 text-[10px] font-semibold text-red-700">
            hidden
          </span>
        )}
        {isLlm && node.costUsdMicros !== null && (
          <span
            className={cn(
              'shrink-0 font-mono',
              hidden ? 'text-red-600' : 'text-foreground',
            )}
          >
            {formatMicrosUsd(node.costUsdMicros)}
          </span>
        )}
        {hasChildren && node.rollupCostUsdMicros > 0 && (
          <span
            className={cn(
              'shrink-0 rounded px-1 font-mono text-muted-foreground transition-colors duration-700',
              flashSum && 'bg-amber-100 text-amber-900',
            )}
            title="Rolled-up cost of the subtree"
            data-testid="otel-waterfall-sum"
          >
            Σ {formatMicrosUsd(node.rollupCostUsdMicros)}
          </span>
        )}
        {isNew && (
          <span className="shrink-0 rounded bg-amber-400 px-1 text-[10px] font-bold text-white">
            NEW
          </span>
        )}
      </div>
      <div className="relative h-3 overflow-hidden">
        <div
          className={cn(
            'absolute inset-y-0.5 rounded-sm',
            otelSpanBarClass(node),
            node.endMs === null && 'opacity-60',
          )}
          style={{ left: `${left}%`, width: `${width}%` }}
        />
      </div>
      <div className="text-right font-mono text-muted-foreground">
        {node.endMs === null ? 'running' : formatDuration(end - node.startMs)}
      </div>
    </div>
  );
}

export const TraceWaterfallRow = memo(TraceWaterfallRowImpl);
