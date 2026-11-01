/**
 * The minimap of the session OTEL waterfall (2026-10-30 otel-tabs-traces, `session-otel-tab.svg`
 * marker 2): the whole turn, every span as a thin bar, with a viewport window that sets the
 * waterfall's visible time range.
 *
 * Drag on empty minimap space to select a new window; drag the window to move it; double-click
 * (or "Reset zoom") shows the whole turn again. The window is a pair of 0..1 fractions of the
 * turn's duration, owned by the caller.
 */
import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { cn } from '@/lib/cn';
import type { OtelTraceNode, OtelTurn } from './otel-trace-assembly';
import { flattenOtelTurn } from './otel-trace-assembly';
import { otelSpanBarClass } from './trace-bar-style';

/** The visible part of a turn: fractions of its duration, `0 <= from < to <= 1`. */
export interface OtelTraceWindow {
  from: number;
  to: number;
}

export const FULL_OTEL_TRACE_WINDOW: OtelTraceWindow = { from: 0, to: 1 };

/** The narrowest window, so a click without a drag never zooms into nothing. */
const MIN_WINDOW = 0.02;
const HEIGHT = 44;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export function isFullOtelTraceWindow(w: OtelTraceWindow): boolean {
  return w.from <= 0 && w.to >= 1;
}

export interface TraceMinimapProps {
  turn: OtelTurn;
  window: OtelTraceWindow;
  onWindowChange: (window: OtelTraceWindow) => void;
}

type Drag =
  | { mode: 'select'; anchor: number }
  | { mode: 'move'; anchor: number; start: OtelTraceWindow };

export function TraceMinimap({
  turn,
  window: win,
  onWindowChange,
}: TraceMinimapProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { startMs, durationMs } = turn.header;
  const total = Math.max(durationMs, 1);
  const nodes: OtelTraceNode[] = flattenOtelTurn(turn).filter(
    (n) => n.span !== null,
  );
  const rowH = nodes.length > 0 ? Math.max(1, HEIGHT / nodes.length) : 1;

  const fractionAt = (clientX: number): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return 0;
    return clamp01((clientX - rect.left) / rect.width);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const f = fractionAt(e.clientX);
    e.currentTarget.setPointerCapture(e.pointerId);
    const inside = !isFullOtelTraceWindow(win) && f >= win.from && f <= win.to;
    setDrag(
      inside
        ? { mode: 'move', anchor: f, start: win }
        : { mode: 'select', anchor: f },
    );
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const f = fractionAt(e.clientX);
    if (drag.mode === 'move') {
      const width = drag.start.to - drag.start.from;
      const from = Math.min(
        1 - width,
        Math.max(0, drag.start.from + f - drag.anchor),
      );
      onWindowChange({ from, to: from + width });
      return;
    }
    const from = Math.min(drag.anchor, f);
    const to = Math.max(drag.anchor, f);
    if (to - from >= MIN_WINDOW) onWindowChange({ from, to });
  };

  const onPointerUp = () => setDrag(null);

  return (
    <div className="space-y-0.5" data-testid="otel-trace-minimap">
      <div className="flex items-center justify-between gap-4 text-[11px] text-muted-foreground">
        <span>drag on the minimap to zoom the waterfall</span>
        {!isFullOtelTraceWindow(win) && (
          <button
            type="button"
            className="text-blue-700 hover:underline"
            onClick={() => onWindowChange(FULL_OTEL_TRACE_WINDOW)}
            data-testid="otel-minimap-reset"
          >
            Reset zoom
          </button>
        )}
      </div>
      <div
        ref={ref}
        className="relative cursor-crosshair select-none overflow-hidden rounded border border-border bg-muted/40"
        style={{ height: HEIGHT }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => onWindowChange(FULL_OTEL_TRACE_WINDOW)}
      >
        {nodes.map((n, i) => {
          const end = n.endMs ?? turn.header.endMs;
          const left = ((n.startMs - startMs) / total) * 100;
          const width = Math.max(((end - n.startMs) / total) * 100, 0.3);
          return (
            <div
              key={n.key}
              className={cn('absolute', otelSpanBarClass(n))}
              style={{
                left: `${left}%`,
                width: `${width}%`,
                top: i * rowH,
                height: Math.max(1, rowH - 0.5),
              }}
            />
          );
        })}
        {!isFullOtelTraceWindow(win) && (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-background/60"
              style={{ width: `${win.from * 100}%` }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-background/60"
              style={{ width: `${(1 - win.to) * 100}%` }}
            />
            <div
              className="absolute inset-y-0 cursor-grab border-x-2 border-blue-500"
              style={{
                left: `${win.from * 100}%`,
                width: `${(win.to - win.from) * 100}%`,
              }}
              data-testid="otel-minimap-window"
            />
          </>
        )}
      </div>
    </div>
  );
}
