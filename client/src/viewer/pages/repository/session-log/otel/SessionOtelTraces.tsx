/**
 * The "Traces" section of the session OTEL tab (2026-10-30 otel-tabs-traces): navigator, minimap,
 * waterfall and span details for one turn at a time.
 *
 * All view state lives here, outside the polled data, so a live merge keeps it: the chosen turn
 * (by trace id; none chosen = follow the latest turn), the turn order, the collapsed rows, the
 * selected span and the minimap window (reset when the turn changes).
 */
import { useCallback, useMemo, useState } from 'react';
import type { OtelCallRow } from '../../../../../models/repositories';
import {
  flattenOtelTurn,
  orderOtelTurns,
  type OtelTurn,
  type OtelTurnOrder,
} from './otel-trace-assembly';
import { otelCallsByRequest } from './otel-span-format';
import { TraceNavigator } from './TraceNavigator';
import {
  FULL_OTEL_TRACE_WINDOW,
  TraceMinimap,
  type OtelTraceWindow,
} from './TraceMinimap';
import { TraceWaterfall } from './TraceWaterfall';
import { SpanDetailsPanel } from './SpanDetailsPanel';

export interface SessionOtelTracesProps {
  /** Turns in chronological order (`assembleOtelTraces`). */
  turns: readonly OtelTurn[];
  calls: readonly OtelCallRow[];
  attributesMasked: boolean;
  newSpanKeys: ReadonlySet<string>;
}

const NO_KEYS: ReadonlySet<string> = new Set();

export function SessionOtelTraces({
  turns,
  calls,
  attributesMasked,
  newSpanKeys,
}: SessionOtelTracesProps) {
  const [order, setOrder] = useState<OtelTurnOrder>('start');
  const [chosenTurn, setChosenTurn] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(NO_KEYS);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ turn: string; window: OtelTraceWindow }>({
    turn: '',
    window: FULL_OTEL_TRACE_WINDOW,
  });

  const ordered = useMemo(() => orderOtelTurns(turns, order), [turns, order]);
  const numbers = useMemo(
    () => new Map(turns.map((t, i) => [t.key, i + 1])),
    [turns],
  );
  const callsByRequest = useMemo(() => otelCallsByRequest(calls), [calls]);
  const turnNumber = useCallback(
    (t: OtelTurn) => numbers.get(t.key) ?? 0,
    [numbers],
  );

  const latest = turns[turns.length - 1];
  const current =
    (chosenTurn !== null
      ? turns.find((t) => t.key === chosenTurn)
      : undefined) ?? latest;
  const position = current
    ? Math.max(
        0,
        ordered.findIndex((t) => t.key === current.key),
      )
    : 0;
  const traceWindow =
    current && zoom.turn === current.key ? zoom.window : FULL_OTEL_TRACE_WINDOW;

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const select = useCallback((key: string) => {
    setSelectedKey((prev) => (prev === key ? null : key));
  }, []);

  if (current === undefined) return null;

  const selectedNode =
    selectedKey !== null
      ? flattenOtelTurn(current).find((n) => n.key === selectedKey)
      : undefined;

  const collapseAll = () => {
    const keys = new Set<string>();
    for (const t of turns) {
      for (const n of flattenOtelTurn(t)) {
        if (n.children.length > 0 && n.depth > 0) keys.add(n.key);
      }
    }
    setCollapsed(keys);
  };

  return (
    <section className="space-y-3" data-testid="otel-traces">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <h3 className="text-sm font-semibold">Traces</h3>
        <span className="text-xs text-muted-foreground">
          one trace per user turn (claude_code.interaction)
        </span>
      </div>
      <TraceNavigator
        turns={ordered}
        position={position}
        onPositionChange={(p) => {
          const t = ordered[p];
          if (t) setChosenTurn(t.key);
        }}
        order={order}
        onOrderChange={setOrder}
        turnNumber={turnNumber}
        onExpandAll={() => setCollapsed(NO_KEYS)}
        onCollapseAll={collapseAll}
      />
      <TraceMinimap
        turn={current}
        window={traceWindow}
        onWindowChange={(w) => setZoom({ turn: current.key, window: w })}
      />
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          <TraceWaterfall
            turn={current}
            turnNumber={turnNumber(current)}
            callsByRequest={callsByRequest}
            window={traceWindow}
            collapsed={collapsed}
            onToggle={toggle}
            selectedKey={selectedKey}
            onSelect={select}
            newSpanKeys={newSpanKeys}
          />
        </div>
        {selectedNode && (
          <div className="xl:w-[340px] xl:shrink-0">
            <SpanDetailsPanel
              node={selectedNode}
              call={
                selectedNode.span?.requestId
                  ? callsByRequest.get(selectedNode.span.requestId)
                  : undefined
              }
              attributesMasked={attributesMasked}
              onClose={() => setSelectedKey(null)}
            />
          </div>
        )}
      </div>
    </section>
  );
}
