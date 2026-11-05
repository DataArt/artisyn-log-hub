/**
 * Middle pane of the Live modal (2026-11-04 otel-live-view, FR-5): the breadcrumb of the
 * selected node (its `parentKey` chain), its heading with Last activity, the KPI tiles, the
 * chart carousel and then the breakdown table (`LiveBreakdownTable`). When the only node is home
 * and nothing is live, the pane shows the DD-18 empty state with a link to the offline help.
 */
import { Fragment } from 'react';
import { ChevronRight } from 'lucide-react';
import type { OtelLiveNode, OtelLiveResponse } from '../../models/otel-live';
import { OtelHelpLink } from '../pages/repository/otel/OtelHelpLink';
import { OTEL_HELP_ANCHORS } from '../pages/repository/otel/otel.constants';
import { formatLiveClock } from './live-format';
import { LiveBreakdownTable } from './LiveBreakdownTable';
import { LiveChartCarousel } from './LiveChartCarousel';
import { LiveFlowSankey } from './LiveFlowSankey';
import { LiveKpiTiles } from './LiveKpiTiles';
import { liveNodeLabel } from './LiveTree';

export interface LiveViewPaneProps {
  res: OtelLiveResponse;
  onSelect: (key: string) => void;
  /** Opens the details panel of a breakdown row. */
  onOpenPanel: (key: string) => void;
}

/** The node itself plus its ancestors, home first. */
function ancestry(
  node: OtelLiveNode,
  byKey: ReadonlyMap<string, OtelLiveNode>,
): OtelLiveNode[] {
  const chain: OtelLiveNode[] = [node];
  const seen = new Set([node.key]);
  let cur = node;
  while (cur.parentKey !== null) {
    const parent = byKey.get(cur.parentKey);
    if (!parent || seen.has(parent.key)) break;
    chain.unshift(parent);
    seen.add(parent.key);
    cur = parent;
  }
  return chain;
}

function LiveEmptyState() {
  return (
    <div
      className="mx-auto mt-16 max-w-md space-y-2 text-center"
      data-testid="live-empty"
    >
      <p className="text-base font-medium">Nothing is live right now</p>
      <p className="text-sm text-muted-foreground">
        Sessions appear here while Claude Code sends OpenTelemetry data.{' '}
        <OtelHelpLink anchor={OTEL_HELP_ANCHORS.enable}>
          How to enable OTEL
        </OtelHelpLink>
      </p>
    </div>
  );
}

export function LiveViewPane({
  res,
  onSelect,
  onOpenPanel,
}: LiveViewPaneProps) {
  const byKey = new Map<string, OtelLiveNode>();
  for (const n of res.view.breakdown) byKey.set(n.key, n);
  for (const n of res.nodes) byKey.set(n.key, n);
  const node = byKey.get(res.selected) ?? null;
  const home = res.nodes.find((n) => n.type === 'home') ?? null;

  if (
    res.nodes.length <= 1 &&
    (home === null || home.totals.liveSessions === 0) &&
    (node === null || node.type === 'home')
  ) {
    return <LiveEmptyState />;
  }
  if (node === null) return null;

  const now = Date.parse(res.generatedAt) || Date.now();
  const chain = ancestry(node, byKey);

  return (
    <div className="space-y-4" data-testid="live-view" data-key={node.key}>
      <nav
        className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
        aria-label="Breadcrumb"
        data-testid="live-breadcrumb"
      >
        {chain.map((n, i) => (
          <Fragment key={n.key}>
            {i > 0 && <ChevronRight className="size-3" aria-hidden />}
            {i === chain.length - 1 ? (
              <span
                className="max-w-[320px] truncate text-foreground"
                title={liveNodeLabel(n)}
              >
                {liveNodeLabel(n)}
              </span>
            ) : (
              <button
                type="button"
                className="max-w-[240px] truncate hover:text-foreground hover:underline"
                title={liveNodeLabel(n)}
                onClick={() => onSelect(n.key)}
              >
                {liveNodeLabel(n)}
              </button>
            )}
          </Fragment>
        ))}
      </nav>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2
          className="min-w-0 max-w-full truncate text-base font-semibold"
          title={liveNodeLabel(node)}
          data-testid="live-view-title"
        >
          {liveNodeLabel(node)}
        </h2>
        {!node.live && (
          <span
            className="rounded bg-muted px-1.5 text-xs text-muted-foreground"
            data-testid="live-view-ended"
          >
            ended
          </span>
        )}
        <span
          className="text-xs text-muted-foreground"
          data-testid="live-view-last-activity"
        >
          Last activity {formatLiveClock(node.totals.lastActivityAt, now)}
        </span>
        <span className="text-xs text-muted-foreground">
          · totals since start, charts last 2 h
        </span>
      </div>
      <LiveKpiTiles node={node} view={res.view} />
      <LiveChartCarousel view={res.view} nodes={res.nodes} selected={node} />
      <LiveFlowSankey view={res.view} nodes={res.nodes} selected={node} />
      <LiveBreakdownTable
        node={node}
        view={res.view}
        now={now}
        onOpenPanel={onOpenPanel}
      />
    </div>
  );
}
