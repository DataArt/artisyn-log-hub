import { useEffect, useMemo, useRef, useState } from 'react';
import type * as React from 'react';
import type { ModelPricingMap } from '../../../../../models/pricing';
import type { SessionLogsData } from '../../../../api';
import { Card, CardContent } from '../../../../ui/card';
import { CallTreeView } from '../CallTreeView';
import { resolveCharsPerToken } from '../log-parser';
import type { ParsedSession } from '../types';
import type { ChartTab } from './chart-tab';
import { AgentTree } from './agent-tree/AgentTree';
import type { AgentNode, HeatmapData, TimelineData } from './chart-data';
import { ContextGrowthChart } from './context-usage/ContextGrowthChart';
import { buildSessionSlices } from './context-usage/context-data';
import { ContextPieChart } from './context-usage/ContextPieChart';
import { GanttTimeline } from './GanttTimeline';
import { ToolHeatmap } from './ToolHeatmap';

interface Props {
  parsedLogs: ParsedSession | null;
  logsData: SessionLogsData | undefined;
  timeline: TimelineData | null;
  tree: AgentNode | null;
  heatmap: HeatmapData | null;
  pricing: ModelPricingMap | null;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
  onNavigate: (tab: ChartTab) => void;
}

const AGENT_TREE_MAX_HEIGHT_PX = 260;

function EmptyPreview({ label }: { label: string }) {
  return (
    <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
      {label}
    </div>
  );
}

/**
 * Shrinks its content uniformly (CSS `transform: scale`) so it fits within `maxHeight` without
 * cropping — unlike the other dashboard cards, the Agent Tree diagram can be
 * arbitrarily wide or tall, so a hard clip would hide part of the picture instead of shrinking
 * all of it.
 */
function ScaleToFit({
  maxHeight,
  children,
}: {
  maxHeight: number;
  children: React.ReactNode;
}) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxHeight, setBoxHeight] = useState(maxHeight);

  useEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    const measure = () => {
      const contentWidth = inner.scrollWidth;
      const contentHeight = inner.scrollHeight;
      if (contentWidth === 0 || contentHeight === 0) return;
      const nextScale = Math.min(
        1,
        outer.clientWidth / contentWidth,
        maxHeight / contentHeight,
      );
      setScale(nextScale);
      setBoxHeight(Math.max(1, Math.min(maxHeight, contentHeight * nextScale)));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [maxHeight]);

  return (
    <div
      ref={outerRef}
      style={{ height: boxHeight }}
      className="overflow-hidden"
    >
      <div
        ref={innerRef}
        style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}
        // The Agent Tree canvas has its own drag-scroll wrapper,
        // which clips/scrolls oversized content by design for
        // the full interactive tab — here that would hide the very overflow this component
        // exists to shrink-to-fit instead, so it's neutralized for this preview only.
        className="[&_.overflow-x-auto]:!overflow-visible [&_.max-w-0]:!max-w-none"
      >
        {children}
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  tab,
  onNavigate,
  children,
}: {
  title: string;
  tab: ChartTab;
  onNavigate: (tab: ChartTab) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <Card className="gap-0 py-0">
        <CardContent className="p-3">
          <div className="pointer-events-none">{children}</div>
        </CardContent>
      </Card>
      <button
        onClick={() => onNavigate(tab)}
        className="self-start text-xs text-primary hover:underline"
      >
        See details →
      </button>
    </div>
  );
}

export function ChartsDashboardTab({
  parsedLogs,
  logsData,
  timeline,
  tree,
  heatmap,
  pricing,
  topN,
  onTopNChange,
  onNavigate,
}: Props) {
  const charsPerToken = resolveCharsPerToken(
    pricing ?? undefined,
    parsedLogs?.summary.model,
  );

  const sessionSlices = useMemo(
    () => (parsedLogs ? buildSessionSlices(parsedLogs, charsPerToken) : []),
    [parsedLogs, charsPerToken],
  );

  const hasAgentTree = !!tree && tree.children.length > 0;

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <DashboardCard
        title="Context Growth"
        tab="context-growth"
        onNavigate={onNavigate}
      >
        {parsedLogs ? (
          <ContextGrowthChart
            session={parsedLogs}
            pricing={pricing ?? undefined}
          />
        ) : (
          <EmptyPreview label="No context growth data" />
        )}
      </DashboardCard>

      <DashboardCard
        title="Context Usage"
        tab="context-usage"
        onNavigate={onNavigate}
      >
        {sessionSlices.length > 0 ? (
          <ContextPieChart slices={sessionSlices} />
        ) : (
          <EmptyPreview label="No context usage data" />
        )}
      </DashboardCard>

      {hasAgentTree && tree && (
        <DashboardCard
          title="Agent Tree"
          tab="agent-tree"
          onNavigate={onNavigate}
        >
          <ScaleToFit maxHeight={AGENT_TREE_MAX_HEIGHT_PX}>
            <AgentTree data={tree} />
          </ScaleToFit>
        </DashboardCard>
      )}

      <DashboardCard title="Timeline" tab="timeline" onNavigate={onNavigate}>
        {timeline ? (
          <GanttTimeline data={timeline} mode="time" />
        ) : (
          <EmptyPreview label="No timeline data" />
        )}
      </DashboardCard>

      <DashboardCard
        title="Tool Heatmap"
        tab="tool-heatmap"
        onNavigate={onNavigate}
      >
        {heatmap ? (
          <ToolHeatmap data={heatmap} />
        ) : (
          <EmptyPreview label="No tool heatmap data" />
        )}
      </DashboardCard>

      <DashboardCard title="Call Tree" tab="call-tree" onNavigate={onNavigate}>
        <CallTreeView
          logsData={logsData}
          isLoading={false}
          error={null}
          pricing={pricing ?? undefined}
          topN={topN}
          onTopNChange={onTopNChange}
          startCollapsed
          compact
        />
      </DashboardCard>
    </div>
  );
}
