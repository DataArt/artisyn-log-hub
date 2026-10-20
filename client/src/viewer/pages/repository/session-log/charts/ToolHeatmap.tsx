import { useCallback, useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { Card, CardContent, CardHeader, CardTitle } from '@/ui/card';
import { CHART_TOOLTIP_CLASS } from './chart-tooltip-class';
import type { HeatmapData } from './chart-data';

interface ToolHeatmapProps {
  data: HeatmapData;
  onSelectTurn?: (turnIndex: number) => void;
}

interface TooltipInfo {
  toolName: string;
  turnLabel: string;
  count: number;
  x: number;
  y: number;
}

const BUCKET_THRESHOLD = 50;
const BUCKET_SIZE = 5;

function buildCellMap(data: HeatmapData, useBuckets: boolean) {
  const map = new Map<string, number>();
  for (const cell of data.cells) {
    // cell.turnIndex is the 0-based step/column index.
    const col = useBuckets
      ? Math.floor(cell.turnIndex / BUCKET_SIZE)
      : cell.turnIndex;
    const key = `${cell.toolName}::${col}`;
    map.set(key, (map.get(key) ?? 0) + cell.count);
  }
  let globalMax = 0;
  for (const v of map.values()) if (v > globalMax) globalMax = v;
  return { map, globalMax };
}

function HeatmapTooltip({ info }: { info: TooltipInfo }) {
  return (
    <div
      className={CHART_TOOLTIP_CLASS}
      style={{ left: info.x + 12, top: info.y - 10 }}
    >
      <div className="font-medium">{info.toolName}</div>
      <div className="text-muted-foreground">{info.turnLabel}</div>
      <div>
        Count: <span className="font-mono">{info.count}</span>
      </div>
    </div>
  );
}

export function ToolHeatmap({ data, onSelectTurn }: ToolHeatmapProps) {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  const useBuckets = data.turnCount >= BUCKET_THRESHOLD;
  const columnCount = useBuckets
    ? Math.ceil(data.turnCount / BUCKET_SIZE)
    : data.turnCount;

  const { map: cellMap, globalMax } = useMemo(
    () => buildCellMap(data, useBuckets),
    [data, useBuckets],
  );

  // Label for a step column = its agent/step name (from chart-data).
  const stepLabel = useCallback(
    (col: number) => data.columnLabels[col] ?? `Step ${col + 1}`,
    [data.columnLabels],
  );

  const columnLabels = useMemo(() => {
    const labels: { col: number; label: string }[] = [];
    for (let c = 0; c < columnCount; c++) {
      if (useBuckets) {
        const start = c * BUCKET_SIZE + 1;
        const end = Math.min(start + BUCKET_SIZE, data.turnCount);
        if (c % 2 === 0) labels.push({ col: c, label: `${start}-${end}` });
      } else {
        // One column per step — show every label (truncated to fit).
        const full = stepLabel(c);
        labels.push({
          col: c,
          label: full.length > 10 ? full.slice(0, 9) : full,
        });
      }
    }
    return labels;
  }, [columnCount, useBuckets, data.turnCount, stepLabel]);

  const handleMouseEnter = useCallback(
    (toolName: string, col: number, e: React.MouseEvent) => {
      const count = cellMap.get(`${toolName}::${col}`);
      if (count == null) return;
      const turnLabel = useBuckets
        ? `Steps ${col * BUCKET_SIZE + 1}-${Math.min(col * BUCKET_SIZE + BUCKET_SIZE, data.turnCount)}`
        : stepLabel(col);
      setTooltip({ toolName, turnLabel, count, x: e.clientX, y: e.clientY });
    },
    [cellMap, useBuckets, data.turnCount, stepLabel],
  );

  const handleClick = useCallback(
    (col: number) => {
      if (!onSelectTurn) return;
      onSelectTurn(useBuckets ? col * BUCKET_SIZE : col);
    },
    [onSelectTurn, useBuckets],
  );

  if (data.toolNames.length === 0) {
    return (
      <Card className="gap-0 py-0">
        <CardHeader className="px-3 pb-0 pt-3">
          <CardTitle className="text-xs font-medium text-muted-foreground">
            Tool Heatmap
          </CardTitle>
        </CardHeader>
        <CardContent className="px-3 pb-3 pt-2">
          <p className="text-xs text-muted-foreground">No tool usage data</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="gap-0 py-0">
      <CardHeader className="px-3 pb-0 pt-3">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          Tool Heatmap
        </CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto px-3 pb-3 pt-2">
        <div className="inline-flex gap-1">
          <div
            className="grid gap-px"
            style={{
              gridTemplateRows: `repeat(${data.toolNames.length}, 16px)`,
              minWidth: 80,
            }}
          >
            {data.toolNames.map((name) => (
              <div
                key={name}
                className="flex items-center text-right font-mono text-[10px] text-muted-foreground"
                title={name}
              >
                <span className="w-full truncate">{name}</span>
              </div>
            ))}
          </div>

          <div>
            <div
              className="grid gap-px"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, 16px)`,
                gridTemplateRows: `repeat(${data.toolNames.length}, 16px)`,
              }}
            >
              {data.toolNames.map((toolName) =>
                Array.from({ length: columnCount }, (_, col) => {
                  const count = cellMap.get(`${toolName}::${col}`);
                  const intensity = count ? count / globalMax : 0;
                  return (
                    <button
                      key={`${toolName}-${col}`}
                      type="button"
                      className={cn(
                        'size-4 rounded-sm transition-opacity',
                        onSelectTurn && 'cursor-pointer',
                        count == null && 'bg-muted/30',
                      )}
                      style={
                        count != null
                          ? {
                              backgroundColor: `hsl(var(--chart-1))`,
                              opacity: 0.15 + intensity * 0.85,
                            }
                          : undefined
                      }
                      onMouseEnter={(e) => handleMouseEnter(toolName, col, e)}
                      onMouseMove={(e) => {
                        if (tooltip)
                          setTooltip((t) =>
                            t ? { ...t, x: e.clientX, y: e.clientY } : null,
                          );
                      }}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={() => handleClick(col)}
                    />
                  );
                }),
              )}
            </div>

            <div
              className="relative mt-1 grid gap-px"
              style={{
                gridTemplateColumns: `repeat(${columnCount}, 16px)`,
                height: useBuckets ? undefined : 56,
              }}
            >
              {columnLabels.map(({ col, label }) => (
                <div
                  key={col}
                  className={cn(
                    'font-mono text-[9px] text-muted-foreground',
                    useBuckets
                      ? 'text-center'
                      : 'origin-top-left translate-x-3 rotate-45 whitespace-nowrap',
                  )}
                  style={{ gridColumn: col + 1 }}
                  title={data.columnLabels[col]}
                >
                  {label}
                </div>
              ))}
            </div>
          </div>
        </div>

        {tooltip && <HeatmapTooltip info={tooltip} />}
      </CardContent>
    </Card>
  );
}
