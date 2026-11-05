/**
 * Chart carousel of the Live view pane (2026-11-04 otel-live-view, DD-13): ‹ › arrows, "n / N",
 * the page title, the existing `OtelCostChart` for the bucket pages (5-minute grain, last 2 h)
 * and the latency line chart. The page is remembered by id, so a page that appears or drops out
 * on a later poll does not move the user to another chart.
 */
import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { OtelLiveNode, OtelLiveView } from '../../models/otel-live';
import { OtelCostChart } from '../pages/repository/otel/OtelCostChart';
import { OtelSegmented } from '../pages/repository/otel/OtelChartControls';
import type { OtelMetric } from '../pages/repository/otel/otel-url-state';
import {
  buildLiveChartPages,
  type LiveBucketChartPage,
  type LiveLatencyChartPage,
} from './live-chart-data';
import { LiveLatencyChart } from './LiveLatencyChart';
import { LiveSharePage } from './LiveSharePage';
import { buildLiveShare } from './live-share-data';

interface LiveSharePageRef {
  kind: 'share';
  id: 'share';
  title: string;
}

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

export function LiveChartCarousel({
  view,
  nodes,
  selected,
}: {
  view: OtelLiveView;
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
}) {
  const pages = useMemo(() => {
    const list: (
      | ReturnType<typeof buildLiveChartPages>[number]
      | LiveSharePageRef
    )[] = buildLiveChartPages(view);
    if (buildLiveShare(nodes, selected, 'cost') !== null) {
      list.push({
        kind: 'share',
        id: 'share',
        title: 'Share by team / repository / user',
      });
    }
    return list;
  }, [view, nodes, selected]);
  const [pageId, setPageId] = useState<string>('cost');
  const found = pages.findIndex((p) => p.id === pageId);
  const index = found >= 0 ? found : 0;
  const page = pages[index];
  const go = (delta: number) => {
    const next = (index + delta + pages.length) % pages.length;
    setPageId(pages[next].id);
  };

  return (
    <section
      className="rounded-md border border-border p-3"
      data-testid="live-chart-carousel"
      data-page={page.id}
    >
      <div className="mb-2 flex items-center gap-2">
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
