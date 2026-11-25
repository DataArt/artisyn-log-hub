/**
 * Tile grid of the Live view pane (2026-11-21 cloudwatch-cai-parity): every page of
 * `buildLiveChartPages` as a compact tile with no controls — the title, a small chart (the
 * page's first metric and variant) and a ⤢ icon on hover. The whole tile is a button that
 * enlarges the page (`onOpen`). A container query sets 1 / 2 / 3 / 4 columns as the pane grows,
 * 4 at the default pane width of a 1440 px viewport.
 */
import { Maximize2 } from 'lucide-react';
import type { OtelLiveNode } from '../../models/otel-live';
import { OtelCostChart } from '../pages/repository/otel/OtelCostChart';
import type {
  LiveBucketChartPage,
  LiveChartPage,
  LiveLatencyChartPage,
} from './live-chart-data';
import { LiveLatencyChart } from './LiveLatencyChart';
import { LiveSharePage } from './LiveSharePage';

const TILE_CHART_HEIGHT = 120;
const NO_KEYS: ReadonlySet<string> = new Set();
const noop = () => {};

function BucketTile({ page }: { page: LiveBucketChartPage }) {
  if (page.notReported) {
    return (
      <p
        className="flex items-center justify-center px-2 text-center text-xs text-muted-foreground"
        style={{ height: TILE_CHART_HEIGHT }}
        data-testid="live-chart-not-reported"
      >
        Not reported: no traces in the last 2 h
      </p>
    );
  }
  const variant = page.variants[0];
  return (
    <OtelCostChart
      buckets={variant.buckets}
      interval="5m"
      metric={page.metrics[0]}
      stackBy={variant.stackBy}
      view="absolute"
      cumulative={false}
      newBucketKeys={NO_KEYS}
      hiddenKeys={NO_KEYS}
      onToggleKey={noop}
      height={TILE_CHART_HEIGHT}
      compact
    />
  );
}

function LatencyTile({ page }: { page: LiveLatencyChartPage }) {
  // The LLM spans by default, as the enlarged page; the tool spans when only they are present.
  const points = page.llm.some((p) => p.count > 0) ? page.llm : page.tool;
  return (
    <LiveLatencyChart points={points} height={TILE_CHART_HEIGHT} compact />
  );
}

function tileSubtitle(page: LiveChartPage): string {
  if (page.kind === 'share') return 'totals since start';
  if (page.kind === 'latency') return 'LLM spans · 5-min';
  const variant = page.variants[0];
  return variant.stackBy === 'total'
    ? 'last 2 h · 5-min'
    : `by ${variant.label.toLowerCase()} · 5-min`;
}

export function LiveChartTiles({
  pages,
  nodes,
  selected,
  onOpen,
}: {
  pages: readonly LiveChartPage[];
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="@container" data-testid="live-chart-grid">
      <div className="grid grid-cols-1 gap-3 @[26rem]:grid-cols-2 @[42rem]:grid-cols-3 @[56rem]:grid-cols-4">
        {pages.map((page) => (
          <button
            key={page.id}
            type="button"
            className="group relative min-w-0 rounded-md border border-border p-2 text-left hover:border-blue-300 hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Enlarge ${page.title}`}
            onClick={() => onOpen(page.id)}
            data-testid="live-chart-tile"
            data-page={page.id}
          >
            <span className="flex min-w-0 items-baseline gap-1.5 pr-5">
              <span className="truncate text-xs font-medium">{page.title}</span>
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {tileSubtitle(page)}
            </span>
            <Maximize2
              className="absolute right-2 top-2 size-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              aria-hidden
            />
            <span className="mt-1 block">
              {page.kind === 'buckets' ? (
                <BucketTile page={page} />
              ) : page.kind === 'share' ? (
                <LiveSharePage nodes={nodes} selected={selected} compact />
              ) : (
                <LatencyTile page={page} />
              )}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
