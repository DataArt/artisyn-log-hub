/**
 * Chart carousel of the Live view pane (2026-11-04 otel-live-view, DD-13): ‹ › arrows, "n / N",
 * the page title, the existing `OtelCostChart` for the bucket pages (5-minute grain, last 2 h)
 * and the latency line chart. The page is remembered by id, so a page that appears or drops out
 * on a later poll does not move the user to another chart.
 *
 * 2026-11-21 cloudwatch-cai-parity: the page list comes from `LiveCharts` (built once for both
 * modes). The same view is carousel mode and the enlarged tile of tile mode; the latter adds
 * "‹ All charts" (`onBack`).
 */
import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { OtelLiveNode } from '../../models/otel-live';
import { OtelCostChart } from '../pages/repository/otel/OtelCostChart';
import { OtelSegmented } from '../pages/repository/otel/OtelChartControls';
import type { OtelMetric } from '../pages/repository/otel/otel-url-state';
import type {
  LiveBucketChartPage,
  LiveChartPage,
  LiveLatencyChartPage,
} from './live-chart-data';
import { LiveLatencyChart } from './LiveLatencyChart';
import { LiveSharePage } from './LiveSharePage';

const NO_NEW_KEYS: ReadonlySet<string> = new Set();

const METRIC_LABELS: Record<OtelMetric, string> = {
  cost: 'Cost',
  calls: 'Calls',
  tokens: 'Tokens',
};

function BucketPage({ page }: { page: LiveBucketChartPage }) {
  const [metric, setMetric] = useState<OtelMetric>(page.metrics[0]);
  const [variantValue, setVariantValue] = useState(page.variants[0].value);
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const variant =
    page.variants.find((v) => v.value === variantValue) ?? page.variants[0];
  const activeMetric = page.metrics.includes(metric) ? metric : page.metrics[0];

  const onToggleKey = (key: string) =>
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  if (page.notReported) {
    return (
      <p
        className="py-6 text-sm text-muted-foreground"
        data-testid="live-chart-not-reported"
      >
        Not reported: no traces in the last 2 h. Edits by tool comes from OTEL
        tool spans.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {(page.metrics.length > 1 || page.variants.length > 1) && (
        <div className="flex flex-wrap items-center gap-3">
          {page.metrics.length > 1 && (
            <OtelSegmented<OtelMetric>
              label="Metric"
              value={activeMetric}
              options={page.metrics.map((m) => ({
                value: m,
                label: METRIC_LABELS[m],
              }))}
              onChange={setMetric}
              testId="live-chart-metric"
            />
          )}
          {page.variants.length > 1 && (
            <OtelSegmented<string>
              label="By"
              value={variant.value}
              options={page.variants.map((v) => ({
                value: v.value,
                label: v.label,
              }))}
              onChange={(v) => {
                setVariantValue(v);
                setHiddenKeys(new Set());
              }}
              testId="live-chart-variant"
            />
          )}
        </div>
      )}
      <OtelCostChart
        buckets={variant.buckets}
        interval="5m"
        metric={activeMetric}
        stackBy={variant.stackBy}
        view="absolute"
        cumulative={false}
        newBucketKeys={NO_NEW_KEYS}
        hiddenKeys={hiddenKeys}
        onToggleKey={onToggleKey}
        height={240}
      />
    </div>
  );
}

function LatencyPage({ page }: { page: LiveLatencyChartPage }) {
  const [kind, setKind] = useState<'llm' | 'tool'>('llm');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <OtelSegmented<'llm' | 'tool'>
          label="Spans"
          value={kind}
          options={[
            { value: 'llm', label: 'LLM' },
            { value: 'tool', label: 'Tools' },
          ]}
          onChange={setKind}
          testId="live-chart-latency-kind"
        />
        {kind === 'tool' && (
          <span
            className="text-xs text-muted-foreground"
            data-testid="live-chart-failed-tools"
          >
            {page.failedTools} failed tool{' '}
            {page.failedTools === 1 ? 'call' : 'calls'}
          </span>
        )}
      </div>
      <LiveLatencyChart points={kind === 'llm' ? page.llm : page.tool} />
    </div>
  );
}

export interface LiveChartCarouselProps {
  /** The page list of the node, never empty. */
  pages: readonly LiveChartPage[];
  /** The page shown; an id not in `pages` shows the first page. */
  pageId: string;
  onPage: (id: string) => void;
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
  /** Tile mode: "‹ All charts" back to the grid. */
  onBack?: () => void;
  /** Right end of the title row (the Tiles | Carousel toggle). */
  trailing?: ReactNode;
}

export function LiveChartCarousel({
  pages,
  pageId,
  onPage,
  nodes,
  selected,
  onBack,
  trailing,
}: LiveChartCarouselProps) {
  const found = pages.findIndex((p) => p.id === pageId);
  const index = found >= 0 ? found : 0;
  const page = pages[index];
  const go = (delta: number) => {
    const next = (index + delta + pages.length) % pages.length;
    onPage(pages[next].id);
  };

  return (
    <section
      className="rounded-md border border-border p-3"
      data-testid="live-chart-carousel"
      data-page={page.id}
      data-enlarged={onBack !== undefined ? 'true' : undefined}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        {onBack !== undefined && (
          <button
            type="button"
            className="mr-1 rounded border border-border px-2 py-0.5 text-xs hover:bg-accent"
            onClick={onBack}
            data-testid="live-chart-back"
          >
            ‹ All charts
          </button>
        )}
        <button
          type="button"
          aria-label="Previous chart"
          className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
          disabled={pages.length < 2}
          onClick={() => go(-1)}
          data-testid="live-chart-prev"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span
          className="text-xs tabular-nums text-muted-foreground"
          data-testid="live-chart-position"
        >
          {index + 1} / {pages.length}
        </span>
        <button
          type="button"
          aria-label="Next chart"
          className="rounded p-0.5 hover:bg-accent disabled:opacity-40"
          disabled={pages.length < 2}
          onClick={() => go(1)}
          data-testid="live-chart-next"
        >
          <ChevronRight className="size-4" />
        </button>
        <h3 className="text-sm font-medium" data-testid="live-chart-title">
          {page.title}
        </h3>
        <span className="text-xs text-muted-foreground">
          {page.kind === 'share'
            ? '· totals since start'
            : '· last 2 h, 5-min buckets'}
        </span>
        {trailing !== undefined && <div className="ml-auto">{trailing}</div>}
      </div>
      {page.kind === 'buckets' ? (
        <BucketPage key={page.id} page={page} />
      ) : page.kind === 'share' ? (
        <LiveSharePage nodes={nodes} selected={selected} />
      ) : (
        <LatencyPage page={page} />
      )}
    </section>
  );
}
