/**
 * The trace waterfall of the session OTEL tab (2026-10-30 otel-tabs-traces, `session-otel-tab.svg`
 * and `session-otel-live-update.svg`): one turn as an indented span tree with duration bars on a
 * shared time axis (zoomed by the minimap window), Σ rollups, `agent <id>` labels, hidden rows in
 * red, the provisional "turn in progress" row and dotted unconfirmed (realtime-only) rows.
 *
 * Rows are keyed by `spanId`; the collapsed set and the selection are owned by the caller, outside
 * the data, so a live merge keeps both. Live highlight (from the poll's `newKeys`), CSS classes
 * only and never a scroll: amber "NEW" rows, a flash on every ancestor's Σ value, and a
 * "↓ N new spans below" pill while new rows sit below the visible area (a click scrolls to them).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import type { OtelCallRow } from '../../../../../models/repositories';
import type { OtelTraceNode, OtelTurn } from './otel-trace-assembly';
import type { OtelTraceWindow } from './TraceMinimap';
import { TraceWaterfallRow, WATERFALL_GRID } from './TraceWaterfallRow';

export interface TraceWaterfallProps {
  turn: OtelTurn;
  turnNumber: number;
  callsByRequest: ReadonlyMap<string, OtelCallRow>;
  window: OtelTraceWindow;
  /** Keys of collapsed rows (everything else is expanded). */
  collapsed: ReadonlySet<string>;
  onToggle: (key: string) => void;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Span ids highlighted by the latest poll. */
  newSpanKeys: ReadonlySet<string>;
}

const TICKS = 5;

interface VisibleRow {
  node: OtelTraceNode;
}

/** Rows in display order, skipping the children of collapsed rows. */
function visibleRows(
  turn: OtelTurn,
  collapsed: ReadonlySet<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  const visit = (n: OtelTraceNode) => {
    out.push({ node: n });
    if (collapsed.has(n.key)) return;
    for (const c of n.children) visit(c);
  };
  for (const r of turn.rows) visit(r);
  return out;
}

/** Keys of every ancestor of a highlighted row (their Σ values flash). */
function ancestorsOf(turn: OtelTurn, keys: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  if (keys.size === 0) return out;
  const visit = (n: OtelTraceNode, path: string[]) => {
    if (keys.has(n.key)) for (const p of path) out.add(p);
    path.push(n.key);
    for (const c of n.children) visit(c, path);
    path.pop();
  };
  for (const r of turn.rows) visit(r, []);
  return out;
}

function tickLabel(ms: number): string {
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)} s` : `${Math.round(s)} s`;
}

export function TraceWaterfall({
  turn,
  turnNumber,
  callsByRequest,
  window: win,
  collapsed,
  onToggle,
  selectedKey,
  onSelect,
  newSpanKeys,
}: TraceWaterfallProps) {
  const { startMs, endMs, durationMs } = turn.header;
  const total = Math.max(durationMs, 1);
  const windowStartMs = startMs + win.from * total;
  const windowEndMs = startMs + win.to * total;

  const rows = useMemo(() => visibleRows(turn, collapsed), [turn, collapsed]);
  const flash = useMemo(
    () => ancestorsOf(turn, newSpanKeys),
    [turn, newSpanKeys],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const [below, setBelow] = useState(0);

  const countBelow = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight;
    let n = 0;
    el.querySelectorAll<HTMLElement>('[data-new="true"]').forEach((row) => {
      if (row.offsetTop >= bottom - 4) n += 1;
    });
    setBelow(n);
  }, []);

  // `rows` / `newSpanKeys` are the triggers: the DOM they render is what gets counted.
  useEffect(() => {
    countBelow();
  }, [countBelow, rows, newSpanKeys]);

  const scrollToNew = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight;
    const target = [
      ...el.querySelectorAll<HTMLElement>('[data-new="true"]'),
    ].find((row) => row.offsetTop >= bottom - 4);
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const at =
      windowStartMs + ((windowEndMs - windowStartMs) * i) / (TICKS - 1);
    return tickLabel(at - startMs);
  });

  return (
    <div className="rounded-md border" data-testid="otel-trace-waterfall">
      <div
        className={`${WATERFALL_GRID} border-b bg-muted/40 px-1 py-1 text-[11px] text-muted-foreground`}
      >
        <span>Service &amp; operation</span>
        <div className="flex justify-between">
          {ticks.map((t, i) => (
            <span key={i}>{t}</span>
          ))}
        </div>
        <span className="text-right">Duration</span>
      </div>
      <div className="relative">
        <div
          ref={scrollRef}
          className="relative max-h-[560px] overflow-auto"
          onScroll={countBelow}
        >
          {rows.map(({ node }) => (
            <TraceWaterfallRow
              key={node.key}
              node={node}
              call={
                node.span?.requestId
                  ? callsByRequest.get(node.span.requestId)
                  : undefined
              }
              turnNumber={turnNumber}
              windowStartMs={windowStartMs}
              windowEndMs={windowEndMs}
              openEndMs={endMs}
              collapsed={collapsed.has(node.key)}
              selected={selectedKey === node.key}
              isNew={newSpanKeys.has(node.key)}
              flashSum={flash.has(node.key)}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
        {below > 0 && (
          <button
            type="button"
            className="absolute bottom-2 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white shadow"
            onClick={scrollToNew}
            data-testid="otel-new-spans-pill"
          >
            <ArrowDown className="size-3" />
            {below} new span{below === 1 ? '' : 's'} below
          </button>
        )}
      </div>
      <p className="border-t px-2 py-1 text-[11px] text-muted-foreground">
        Σ = rolled-up cost of the subtree. LLM cost joined from api_request by
        request_id. Red = hidden call (no transcript records it). A dotted left
        edge = received in realtime, not yet confirmed.
      </p>
    </div>
  );
}
