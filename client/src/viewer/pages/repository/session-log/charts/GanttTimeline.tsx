import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { modelColor } from '@/lib/chart-colors';
import { cn } from '@/lib/cn';
import { formatCost, formatDuration } from '@/lib/format';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/ui/hover-card';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type { TimelineBlock, TimelineData } from './chart-data';
import {
  type GanttMode,
  pct,
  px,
  useGanttLayout,
  VIEWBOX_WIDTH,
} from './useGanttLayout';

interface GanttTimelineProps {
  data: TimelineData;
  mode?: GanttMode;
  /** Currently selected turn id (highlighted outline). */
  selectedTurnId?: string | null;
  onSelectTurn?: (turnId: string) => void;
}

const LANE_HEIGHT = 32;
const LABEL_WIDTH = 120;
const MARKER_LABEL_Y_OFFSET = 12;
const TIME_AXIS_HEIGHT = 18;

// Candidate tick spacings, in ms — picked so labels read as round durations
// (1s/5s/30s/1m/5m/...) rather than an arbitrary fraction of the session.
const NICE_TIME_STEPS_MS = [
  1_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000,
  86_400_000,
];

function pickTimeAxisStepMs(totalDurationMs: number, targetTicks = 5): number {
  if (totalDurationMs <= 0) return NICE_TIME_STEPS_MS[0];
  const rawStep = totalDurationMs / targetTicks;
  for (const step of NICE_TIME_STEPS_MS) {
    if (step >= rawStep) return step;
  }
  return NICE_TIME_STEPS_MS[NICE_TIME_STEPS_MS.length - 1];
}

function buildTimeAxisTicks(totalDurationMs: number): number[] {
  if (totalDurationMs <= 0) return [0];
  const step = pickTimeAxisStepMs(totalDurationMs);
  const ticks: number[] = [];
  for (let t = 0; t <= totalDurationMs; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] !== totalDurationMs) ticks.push(totalDurationMs);
  return ticks;
}

function BarTooltipContent({ block }: { block: TimelineBlock }) {
  const borderColor = `hsl(${modelColor(block.model)})`;
  return (
    <div className="flex gap-0">
      <div
        className="w-0.5 shrink-0 rounded-full"
        style={{ backgroundColor: borderColor }}
      />
      <div className="space-y-1 pl-2.5 text-xs">
        <div className="font-medium">{block.agentLabel}</div>
        <div className="space-y-0.5 text-muted-foreground">
          <div>Duration: {formatDuration(block.rawDurationMs)}</div>
          {block.cost != null && block.cost > 0 && (
            <div>Cost: {formatCost(block.cost)}</div>
          )}
          {block.toolCallCount > 0 && (
            <div>Tool calls: {block.toolCallCount}</div>
          )}
          {block.model && <div>Model: {block.model}</div>}
        </div>
      </div>
    </div>
  );
}

export function GanttTimeline({
  data,
  mode = 'turns',
  selectedTurnId,
  onSelectTurn,
}: GanttTimelineProps) {
  const [hoveredMarker, setHoveredMarker] = useState<number | null>(null);
  const [hoveredBlock, setHoveredBlock] = useState<TimelineBlock | null>(null);
  const hoveredLaneIndex = hoveredBlock?.laneIndex ?? null;
  const anchorRef = useRef<HTMLDivElement>(null);
  const chartAreaRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = chartAreaRef.current;
    if (!el) return;
    let rafId: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const width = entry.contentRect.width;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setContainerWidth(width));
    });
    observer.observe(el);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const { blocks, userMarkers, lanes } = data;
  const layout = useGanttLayout(mode, data, containerWidth);
  const { blockX, blockWidth, markerX } = layout;

  const pos = useMemo(() => (layout.unit === 'px' ? px : pct), [layout.unit]);

  // A time axis only makes sense in 'time' mode — 'turns' bars are ordinal steps, not durations.
  const hasTimeAxis = mode === 'time';
  const topOffset =
    MARKER_LABEL_Y_OFFSET + (hasTimeAxis ? TIME_AXIS_HEIGHT : 0);
  const timeAxisTicks = useMemo(
    () => (hasTimeAxis ? buildTimeAxisTicks(data.totalDurationMs) : []),
    [hasTimeAxis, data.totalDurationMs],
  );

  const chartHeight = lanes.length * LANE_HEIGHT + topOffset;

  const lanesByIndex = useMemo(() => {
    const map = new Map<number, (typeof lanes)[0]>();
    for (const lane of lanes) map.set(lane.index, lane);
    return map;
  }, [lanes]);

  const handleClick = useCallback(
    (block: TimelineBlock) => onSelectTurn?.(block.turnId),
    [onSelectTurn],
  );

  if (blocks.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
        No timeline data
      </div>
    );
  }

  return (
    <div className="relative flex w-full">
      <TooltipProvider>
        <div
          data-testid="gantt-labels-column"
          className="shrink-0"
          style={{ width: LABEL_WIDTH, paddingTop: topOffset }}
        >
          {lanes.map((lane) => (
            <Tooltip key={`label-${lane.index}`}>
              <TooltipTrigger asChild>
                <div
                  className="truncate pr-2 text-[10px] text-muted-foreground"
                  style={{
                    height: LANE_HEIGHT,
                    lineHeight: `${LANE_HEIGHT}px`,
                  }}
                >
                  {lane.label}
                </div>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                {lane.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TooltipProvider>

      <div
        ref={chartAreaRef}
        className={cn(
          'min-w-0 flex-1',
          layout.isScrollable ? 'overflow-x-auto' : 'overflow-hidden',
        )}
        style={{ height: chartHeight }}
        data-testid={layout.isScrollable ? 'gantt-scroll-container' : undefined}
      >
        <div
          role="img"
          className="relative h-full"
          data-testid="gantt-chart-area"
          aria-label="Gantt timeline of session turns"
          style={
            layout.isScrollable
              ? { width: layout.contentWidth }
              : { width: '100%' }
          }
        >
          {hasTimeAxis && (
            <div
              data-testid="gantt-time-axis"
              className="absolute left-0 top-0 w-full border-b border-border/40"
              style={{ height: TIME_AXIS_HEIGHT }}
            >
              {timeAxisTicks.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 flex flex-col items-center"
                  style={{
                    left: pos((t / data.totalDurationMs) * VIEWBOX_WIDTH),
                    transform: 'translateX(-50%)',
                  }}
                >
                  <span className="whitespace-nowrap text-[9px] text-muted-foreground">
                    {formatDuration(t)}
                  </span>
                  <div className="h-1 w-px bg-border" />
                </div>
              ))}
            </div>
          )}

          {lanes.map((lane) => (
            <div
              key={`lane-${lane.index}`}
              data-testid="gantt-lane"
              className="absolute w-full border-b border-border/50"
              style={{
                top: lane.index * LANE_HEIGHT + topOffset,
                height: LANE_HEIGHT,
                backgroundColor:
                  hoveredLaneIndex === lane.index
                    ? 'hsl(var(--foreground) / 0.07)'
                    : lane.index % 2 === 0
                      ? 'hsl(var(--foreground) / 0.03)'
                      : undefined,
              }}
            />
          ))}

          {userMarkers.map((marker, i) => (
            <div
              key={`marker-${marker.offset}-${i}`}
              data-testid="gantt-marker"
              className="absolute border-l-2 border-dashed border-muted-foreground/40"
              style={{
                left: pos(markerX(marker)),
                top: topOffset,
                height: chartHeight - topOffset,
              }}
              onMouseEnter={() => setHoveredMarker(i)}
              onMouseLeave={() => setHoveredMarker(null)}
            />
          ))}

          {hoveredMarker != null && userMarkers[hoveredMarker] && (
            <div
              className="pointer-events-none absolute -translate-x-1/2 text-[9px] text-muted-foreground"
              style={{
                left: pos(markerX(userMarkers[hoveredMarker])),
                top: hasTimeAxis ? TIME_AXIS_HEIGHT : 0,
              }}
            >
              {userMarkers[hoveredMarker].content.slice(0, 30)}
            </div>
          )}

          {blocks.map((block) => {
            const lane = lanesByIndex.get(block.laneIndex);
            const isBackground = lane?.isBackground ?? false;
            const isSelected = block.turnId === selectedTurnId;
            const x = blockX(block);
            const w = blockWidth(block);
            const top = block.laneIndex * LANE_HEIGHT + 4 + topOffset;
            const barHeight = LANE_HEIGHT - 8;

            return (
              <div
                key={block.turnId}
                data-testid="gantt-bar"
                data-turn-id={block.turnId}
                data-selected={isSelected ? 'true' : undefined}
                className={cn(
                  'absolute cursor-pointer overflow-hidden rounded-sm transition-[filter]',
                  isBackground && 'opacity-60',
                  'hover:brightness-110',
                )}
                style={{
                  left: pos(x),
                  width: pos(w),
                  top,
                  height: barHeight,
                  backgroundColor: `hsl(${modelColor(block.model)})`,
                  backgroundImage:
                    'linear-gradient(to bottom, rgba(255,255,255,0.15), transparent)',
                  outline: isSelected
                    ? '2px solid hsl(var(--primary))'
                    : undefined,
                  outlineOffset: isSelected ? '1px' : undefined,
                }}
                onMouseEnter={() => setHoveredBlock(block)}
                onMouseLeave={() => setHoveredBlock(null)}
                onClick={() => handleClick(block)}
              >
                {block.segments?.map((seg) =>
                  seg.kind === 'waiting' ? (
                    // "Waiting on sub-agents" — hatched translucent overlay.
                    <div
                      key={`wait-${seg.startFrac}-${seg.widthFrac}`}
                      data-testid="gantt-waiting"
                      className="pointer-events-none absolute inset-y-0"
                      style={{
                        left: `${seg.startFrac * 100}%`,
                        width: `${seg.widthFrac * 100}%`,
                        backgroundImage:
                          'repeating-linear-gradient(45deg, rgba(0,0,0,0.28) 0 3px, transparent 3px 6px)',
                      }}
                      title={seg.label}
                    />
                  ) : (
                    // Inner-step divider: subtle separators between steps.
                    <div
                      key={`step-${seg.label}-${seg.startFrac}`}
                      data-testid="gantt-step"
                      className="pointer-events-none absolute inset-y-0 border-r border-black/25"
                      style={{
                        left: `${seg.startFrac * 100}%`,
                        width: `${Math.max(seg.widthFrac * 100, 0.5)}%`,
                        backgroundImage:
                          'linear-gradient(to bottom, rgba(255,255,255,0.12), transparent)',
                      }}
                      title={seg.label}
                    />
                  ),
                )}
              </div>
            );
          })}

          <HoverCard open={!!hoveredBlock} openDelay={0} closeDelay={100}>
            <HoverCardTrigger asChild>
              <div
                ref={anchorRef}
                className="pointer-events-none absolute"
                style={
                  hoveredBlock
                    ? {
                        left: pos(blockX(hoveredBlock)),
                        width: pos(blockWidth(hoveredBlock)),
                        top:
                          hoveredBlock.laneIndex * LANE_HEIGHT + 4 + topOffset,
                        height: LANE_HEIGHT - 8,
                      }
                    : { left: 0, width: 0, top: 0, height: 0 }
                }
              />
            </HoverCardTrigger>
            <HoverCardContent
              side="top"
              sideOffset={8}
              className="w-auto px-3 py-2"
            >
              {hoveredBlock && <BarTooltipContent block={hoveredBlock} />}
            </HoverCardContent>
          </HoverCard>
        </div>
      </div>
    </div>
  );
}
