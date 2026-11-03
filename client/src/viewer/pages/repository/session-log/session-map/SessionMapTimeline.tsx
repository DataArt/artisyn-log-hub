/**
 * Session Map timeline (session-map DD-17, DD-18): SVG stacked bins per tool family, a red tick
 * per bin with failures, the cumulative cost path, time ticks and the position marker. Click or
 * drag scrubs (stops following); below it Play / Pause, the speeds, End, Live and the legend.
 * The bins come memoised on the model and are never rebuilt on a scrub.
 */
import { Pause, Play, Radio, SkipForward } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MapTimeline } from './session-map-model';
import {
  COST_LINE_COLOR,
  FAILED_COLOR,
  FAMILIES,
  PLAYBACK_SPEEDS,
  TIMELINE_H,
} from './session-map.constants';
import { formatClock } from './session-map-format';

/** Height of the controls row under the chart, px. */
const CONTROLS_H = 36;
const AXIS_H = 16;
const FAIL_H = 5;
const PAD_X = 8;

function useElementWidth<T extends HTMLElement>(): [
  React.RefObject<T | null>,
  number,
] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

export interface SessionMapTimelineProps {
  timeline: MapTimeline;
  t: number;
  live: boolean;
  following: boolean;
  playing: boolean;
  speed: number;
  onScrub: (t: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSpeedChange: (speed: number) => void;
  onEnd: () => void;
  onLive: () => void;
}

function BinsLayer({
  timeline,
  width,
  chartH,
}: {
  timeline: MapTimeline;
  width: number;
  chartH: number;
}) {
  return useMemo(() => {
    const inner = Math.max(1, width - 2 * PAD_X);
    const n = timeline.bins.length;
    const binW = n > 0 ? inner / n : inner;
    let maxCount = 0;
    for (const b of timeline.bins) {
      const c = FAMILIES.reduce((s, f) => s + b.familyCounts[f.id], 0);
      if (c > maxCount) maxCount = c;
    }
    const barTop = FAIL_H + 2;
    const barH = Math.max(1, chartH - barTop);
    const totalCost = timeline.bins[n - 1]?.cumulativeCost ?? 0;
    const rects: React.ReactNode[] = [];
    const fails: React.ReactNode[] = [];
    let path = '';
    timeline.bins.forEach((b, i) => {
      const x = PAD_X + i * binW;
      let y = chartH;
      for (const f of FAMILIES) {
        const c = b.familyCounts[f.id];
        if (c === 0 || maxCount === 0) continue;
        const h = (c / maxCount) * barH;
        y -= h;
        rects.push(
          <rect
            key={`${i}-${f.id}`}
            x={x + 0.5}
            y={y}
            width={Math.max(0.5, binW - 1)}
            height={h}
            fill={f.color}
            opacity={0.85}
          />,
        );
      }
      if (b.failures > 0) {
        fails.push(
          <rect
            key={`f${i}`}
            x={x + 0.5}
            y={0}
            width={Math.max(1, binW - 1)}
            height={FAIL_H}
            fill={FAILED_COLOR}
          />,
        );
      }
      if (totalCost > 0) {
        const cy = chartH - (b.cumulativeCost / totalCost) * barH;
        path += `${i === 0 ? `M${PAD_X},${chartH}L` : 'L'}${(x + binW).toFixed(1)},${cy.toFixed(1)}`;
      }
    });
    return (
      <g>
        {rects}
        {fails}
        {path !== '' && (
          <path
            d={path}
            fill="none"
            stroke={COST_LINE_COLOR}
            strokeWidth={1.5}
          />
        )}
      </g>
    );
  }, [timeline, width, chartH]);
}

export function SessionMapTimeline({
  timeline,
  t,
  live,
  following,
  playing,
  speed,
  onScrub,
  onPlay,
  onPause,
  onSpeedChange,
  onEnd,
  onLive,
}: SessionMapTimelineProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const dragging = useRef(false);
  const svgH = TIMELINE_H - CONTROLS_H;
  const chartH = svgH - AXIS_H;
  const span = Math.max(1, timeline.end - timeline.start);
  const inner = Math.max(1, width - 2 * PAD_X);
  const xOf = (ms: number): number =>
    PAD_X +
    ((Math.min(timeline.end, Math.max(timeline.start, ms)) - timeline.start) /
      span) *
      inner;

  const scrubAt = (clientX: number, el: Element): void => {
    const rect = el.getBoundingClientRect();
    const frac = Math.min(
      1,
      Math.max(0, (clientX - rect.left - PAD_X) / inner),
    );
    onScrub(Math.round(timeline.start + frac * span));
  };

  const markerX = xOf(t);

  return (
    <div
      data-testid="session-map-timeline"
      className="flex flex-col rounded-lg border bg-white px-2 pt-1 text-xs"
      style={{ minHeight: TIMELINE_H }}
    >
      <div ref={wrapRef} className="w-full">
        {width > 0 && (
          <svg
            width={width}
            height={svgH}
            className="cursor-ew-resize touch-none select-none"
            onPointerDown={(e) => {
              dragging.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              if (playing) onPause();
              scrubAt(e.clientX, e.currentTarget);
            }}
            onPointerMove={(e) => {
              if (dragging.current) scrubAt(e.clientX, e.currentTarget);
            }}
            onPointerUp={(e) => {
              dragging.current = false;
              e.currentTarget.releasePointerCapture(e.pointerId);
            }}
            onPointerCancel={() => {
              dragging.current = false;
            }}
          >
            <line
              x1={PAD_X}
              x2={width - PAD_X}
              y1={chartH}
              y2={chartH}
              stroke="#cbd5e1"
            />
            <BinsLayer timeline={timeline} width={width} chartH={chartH} />
            {timeline.ticks.map((tick) => {
              const x = xOf(tick);
              return (
                <g key={tick}>
                  <line
                    x1={x}
                    x2={x}
                    y1={chartH}
                    y2={chartH + 3}
                    stroke="#94a3b8"
                  />
                  <text
                    x={x}
                    y={chartH + AXIS_H - 3}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#64748b"
                  >
                    {formatClock(tick)}
                  </text>
                </g>
              );
            })}
            <g data-testid="session-map-marker" data-t={Math.round(t)}>
              <line
                x1={markerX}
                x2={markerX}
                y1={0}
                y2={chartH}
                stroke="#0f172a"
                strokeWidth={1.5}
              />
              <circle cx={markerX} cy={chartH} r={3.5} fill="#0f172a" />
            </g>
          </svg>
        )}
      </div>
      <div
        className="flex flex-wrap items-center gap-2"
        style={{ minHeight: CONTROLS_H }}
      >
        <button
          type="button"
          data-testid="session-map-play"
          onClick={playing ? onPause : onPlay}
          className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-slate-50"
        >
          {playing ? (
            <Pause className="h-3.5 w-3.5" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {playing ? 'Pause' : 'Play'}
        </button>
        <div className="flex overflow-hidden rounded border">
          {PLAYBACK_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => onSpeedChange(s)}
              className={`px-1.5 py-0.5 ${speed === s ? 'bg-blue-600 text-white' : 'hover:bg-slate-50'}`}
            >
              {s}×
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onEnd}
          className="flex items-center gap-1 rounded border px-2 py-0.5 hover:bg-slate-50"
        >
          <SkipForward className="h-3.5 w-3.5" />
          End
        </button>
        {live && (
          <button
            type="button"
            data-testid="session-map-live"
            onClick={onLive}
            disabled={following}
            className="flex items-center gap-1 rounded border border-green-300 px-2 py-0.5 text-green-700 hover:bg-green-50 disabled:opacity-50"
          >
            <Radio className="h-3.5 w-3.5" />
            Live
          </button>
        )}
        <span className="font-mono text-muted-foreground">
          {formatClock(t)}
        </span>
        <div className="ml-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
          {FAMILIES.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ backgroundColor: f.color }}
              />
              {f.label}
            </span>
          ))}
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: FAILED_COLOR }}
            />
            failed
          </span>
          <span className="flex items-center gap-1">
            <span
              className="inline-block h-0.5 w-3"
              style={{ backgroundColor: COST_LINE_COLOR }}
            />
            cumulative cost
          </span>
        </div>
      </div>
    </div>
  );
}
