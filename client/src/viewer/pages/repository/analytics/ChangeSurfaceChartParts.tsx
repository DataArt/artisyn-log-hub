/**
 * Presentational pieces of the analytics "Change Surface" chart,
 * extracted from ChangeSurfaceBarChart.tsx (component-size split): the three
 * mutually-exclusive legends (band / zone / group), the hover tooltip, and the
 * centered loading/empty/error note. All stateless; the chart owns every piece
 * of state and passes it in.
 */
import type * as d3 from 'd3';
import type { ChangeSurfaceBucket } from '../../../../models/repositories';
import {
  CHANGE_BAND_COLORS,
  CHANGE_BAND_LEGEND,
  CHANGE_SURFACE_NA,
  formatLinesAdded,
  formatLinesRemoved,
} from '../../../lib/change-surface-ui';
import { ViewportPopover } from '../../../components/ViewportPopover';
import {
  formatChangeSurfaceValue,
  resolveChangeSurfaceMetric,
  resolveChangeSurfaceValue,
  type ChangeSurfaceMetricKey,
} from './change-surface-metrics';

export interface SeriesPoint {
  seriesKey: string;
  seriesLabel: string;
  bucket: ChangeSurfaceBucket;
}

export interface TooltipState {
  x: number;
  y: number;
  label: string;
  repoBucket: ChangeSurfaceBucket | null;
  points: SeriesPoint[];
}

export function BandLegend() {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 px-1 text-xs text-muted-foreground">
      {CHANGE_BAND_LEGEND.map(({ band, label, range }) => (
        <span key={band} className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm opacity-85"
            style={{ backgroundColor: CHANGE_BAND_COLORS[band] }}
          />
          {label} {range}
        </span>
      ))}
      <span className="italic">
        no changed files in the bucket renders as {CHANGE_SURFACE_NA}
      </span>
    </div>
  );
}

export function ZoneLegend() {
  return (
    <div className="mt-2 flex items-center gap-4 px-1 text-xs text-muted-foreground">
      {(
        [
          { color: '#22c55e', label: '<25%' },
          { color: '#3b82f6', label: '25–75%' },
          { color: '#f97316', label: '>75%' },
        ] as const
      ).map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm opacity-85"
            style={{ backgroundColor: color }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

export function GroupLegend({
  keys,
  labels,
  colorScale,
}: {
  keys: string[];
  labels: Map<string, string>;
  colorScale: d3.ScaleOrdinal<string, string>;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-center gap-4 px-1 text-xs text-muted-foreground">
      {keys.map((key) => (
        <span key={key} className="flex items-center gap-1">
          <span
            className="inline-block h-3 w-3 rounded-sm opacity-85"
            style={{ backgroundColor: colorScale(key) }}
          />
          {labels.get(key) ?? key}
        </span>
      ))}
    </div>
  );
}

export function BucketTooltip({
  x,
  y,
  label,
  repoBucket,
  points,
  metricKey,
}: TooltipState & { metricKey: ChangeSurfaceMetricKey }) {
  const metric = resolveChangeSurfaceMetric(metricKey);
  return (
    <ViewportPopover x={x} y={y} offset={12} className="w-[280px]">
      <div className="mb-2 text-xs font-semibold text-muted-foreground">
        {label}
      </div>
      {points.map(({ seriesKey, seriesLabel, bucket }) => (
        <div
          key={seriesKey}
          className="flex items-center justify-between text-xs"
        >
          <span className="truncate text-muted-foreground">{seriesLabel}</span>
          <span className="ml-2 font-mono font-bold">
            {formatChangeSurfaceValue(
              resolveChangeSurfaceValue(bucket, metricKey),
              metric,
            )}
          </span>
        </div>
      ))}
      {repoBucket && (
        <div className="mt-1.5 border-t border-border pt-1.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">sessions</span>
            <span className="font-mono">
              {repoBucket.sessions.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">files · folders</span>
            <span className="font-mono">
              {repoBucket.changedFiles.toLocaleString()} ·{' '}
              {repoBucket.foldersTouched.toLocaleString()}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">lines</span>
            <span className="font-mono">
              <span className="text-green-600">
                {formatLinesAdded(repoBucket.linesAdded)}
              </span>{' '}
              <span className="text-red-600">
                {formatLinesRemoved(repoBucket.linesRemoved)}
              </span>
            </span>
          </div>
        </div>
      )}
      {repoBucket != null && repoBucket.sessionIds.length > 0 && (
        <div className="mt-1.5 text-[10px] text-muted-foreground">
          click to list the sessions
        </div>
      )}
    </ViewportPopover>
  );
}

export function CenteredNote({ text }: { text: string }) {
  return (
    <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
      {text}
    </div>
  );
}
