/**
 * Charts of the Live view pane (2026-11-21 cloudwatch-cai-parity): builds the node's page list
 * once (`buildLiveChartPages`) and shows it as a tile grid (`LiveChartTiles`, the default) or as
 * the carousel (`LiveChartCarousel`), switched by a Tiles | Carousel toggle remembered in
 * `artisyn:liveChartMode`. A clicked tile enlarges into the carousel view with "‹ All charts";
 * Esc returns to the grid (through `escapeRef`, which `LiveModal` consults before closing).
 * The enlarged page is kept by id across polls and node changes; when the id is gone, the view
 * goes back to the grid.
 */
import { useEffect, useMemo, useState, type RefObject } from 'react';
import type { OtelLiveNode, OtelLiveView } from '../../models/otel-live';
import { OtelSegmented } from '../pages/repository/otel/OtelChartControls';
import { buildLiveChartPages } from './live-chart-data';
import {
  readLiveChartMode,
  rememberLiveChartMode,
  type LiveChartMode,
} from './live-chart-mode';
import { LiveChartCarousel } from './LiveChartCarousel';
import { LiveChartTiles } from './LiveChartTiles';

/** Returns true when it handled Esc (the modal then stays open). */
export type LiveEscapeHandler = () => boolean;

const MODE_OPTIONS: { value: LiveChartMode; label: string }[] = [
  { value: 'tiles', label: 'Tiles' },
  { value: 'carousel', label: 'Carousel' },
];

export function LiveCharts({
  view,
  nodes,
  selected,
  escapeRef,
}: {
  view: OtelLiveView;
  nodes: readonly OtelLiveNode[];
  selected: OtelLiveNode;
  escapeRef?: RefObject<LiveEscapeHandler | null>;
}) {
  const pages = useMemo(
    () => buildLiveChartPages(view, nodes, selected),
    [view, nodes, selected],
  );
  const [mode, setMode] = useState<LiveChartMode>(readLiveChartMode);
  const [carouselPageId, setCarouselPageId] = useState<string>('cost');
  const [enlargedId, setEnlargedId] = useState<string | null>(null);

  // A node change or a poll that drops the enlarged page returns to the grid (and stays there
  // if the page comes back later).
  if (enlargedId !== null && !pages.some((p) => p.id === enlargedId)) {
    setEnlargedId(null);
  }
  const enlarged =
    mode === 'tiles' &&
    enlargedId !== null &&
    pages.some((p) => p.id === enlargedId);

  useEffect(() => {
    if (escapeRef === undefined || !enlarged) return;
    escapeRef.current = () => {
      setEnlargedId(null);
      return true;
    };
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, enlarged]);

  const onMode = (next: LiveChartMode) => {
    if (next === mode) return;
    // The enlarged page carries over to the carousel; back in tiles the grid shows.
    if (next === 'carousel' && enlargedId !== null)
      setCarouselPageId(enlargedId);
    setEnlargedId(null);
    setMode(next);
    rememberLiveChartMode(next);
  };

  const toggle = (
    <OtelSegmented<LiveChartMode>
      label="View"
      value={mode}
      options={MODE_OPTIONS}
      onChange={onMode}
      testId="live-chart-mode"
    />
  );

  if (pages.length === 0) {
    return (
      <section data-testid="live-charts" data-mode={mode} className="space-y-2">
        <p
          className="text-sm text-muted-foreground"
          data-testid="live-chart-empty"
        >
          No chart data in the last 2 h.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="live-charts" data-mode={mode} className="space-y-2">
      {mode === 'carousel' ? (
        <LiveChartCarousel
          pages={pages}
          pageId={carouselPageId}
          onPage={setCarouselPageId}
          nodes={nodes}
          selected={selected}
          trailing={toggle}
        />
      ) : enlarged && enlargedId !== null ? (
        <LiveChartCarousel
          pages={pages}
          pageId={enlargedId}
          onPage={setEnlargedId}
          nodes={nodes}
          selected={selected}
          onBack={() => setEnlargedId(null)}
          trailing={toggle}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-sm font-medium">Charts</h3>
            <span
              className="text-xs text-muted-foreground"
              data-testid="live-chart-count"
            >
              · {pages.length} {pages.length === 1 ? 'chart' : 'charts'} · last
              2 h, 5-min buckets · click a tile to enlarge
            </span>
            <div className="ml-auto">{toggle}</div>
          </div>
          <LiveChartTiles
            pages={pages}
            nodes={nodes}
            selected={selected}
            onOpen={setEnlargedId}
          />
        </>
      )}
    </section>
  );
}
