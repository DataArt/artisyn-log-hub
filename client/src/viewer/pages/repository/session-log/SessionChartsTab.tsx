import { useMemo, useState } from 'react';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { SessionLogsData } from '../../../api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Skeleton } from '../../../ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group';
import { agentTree, assistantTimeline, toolHeatmap } from './charts/chart-data';
import { AgentTree } from './charts/agent-tree/AgentTree';
import { ChartsDashboardTab } from './charts/ChartsDashboardTab';
import { ContextGrowthChart } from './charts/context-usage/ContextGrowthChart';
import { ContextUsageTab } from './charts/context-usage/ContextUsageTab';
import { GanttTimeline } from './charts/GanttTimeline';
import { ToolHeatmap } from './charts/ToolHeatmap';
import type { GanttMode } from './charts/useGanttLayout';
import type { ChartTab } from './charts/chart-tab';
import { buildSubagentSessions } from './charts/subagent-sessions';
import { CallTreeView } from './CallTreeView';
import type { ParsedSession } from './types';

interface Props {
  /** The chart session tab to render (`CHART_TABS`). */
  chart: ChartTab;
  /** Opens another session tab — the Dashboard's cards open the full chart tabs. */
  onOpenChart: (chart: ChartTab) => void;
  parsedLogs: ParsedSession | null;
  subagentLogsMap?: Map<string, Record<string, unknown>[]>;
  agentParentMap?: Map<string, string | null>;
  isLoading: boolean;
  error: unknown;
  pricing: ModelPricingMap | null;
  logsData: SessionLogsData | undefined;
  topN: number | null;
  onTopNChange: (n: number | null) => void;
}

function EmptyChart({ children }: { children: string }) {
  return (
    <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

/**
 * One session chart. The seven charts are plain session tabs (Dashboard, Context Growth, Context
 * Usage, Agent Tree, Timeline, Tool Heatmap, Call Tree) — the tab bar has a single level — and
 * this component renders the one named by `chart`, sharing the derived chart data between them.
 */
export function SessionChartsTab({
  chart,
  onOpenChart,
  parsedLogs,
  subagentLogsMap,
  agentParentMap,
  isLoading,
  error,
  pricing,
  logsData,
  topN,
  onTopNChange,
}: Props) {
  const [ganttMode, setGanttMode] = useState<GanttMode>('time');
  const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

  const timeline = useMemo(
    () =>
      parsedLogs
        ? assistantTimeline(
            parsedLogs,
            pricing,
            subagentLogsMap,
            agentParentMap,
          )
        : null,
    [parsedLogs, pricing, subagentLogsMap, agentParentMap],
  );
  const heatmap = useMemo(
    () =>
      parsedLogs
        ? toolHeatmap(parsedLogs, subagentLogsMap, agentParentMap)
        : null,
    [parsedLogs, subagentLogsMap, agentParentMap],
  );
  const tree = useMemo(
    () =>
      parsedLogs
        ? agentTree(parsedLogs, pricing, subagentLogsMap, agentParentMap)
        : null,
    [parsedLogs, pricing, subagentLogsMap, agentParentMap],
  );

  // Labelled sub-agent sessions for the Context Usage chart
  // ("<workflow name>:Agent N" for a workflow member, "Agent N" otherwise).
  const subagentSessions = useMemo(
    () =>
      parsedLogs ? buildSubagentSessions(parsedLogs, subagentLogsMap) : [],
    [parsedLogs, subagentLogsMap],
  );

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-destructive">
        Failed to load session logs
      </div>
    );
  }

  // Call Tree reads the raw logs and shows its own loading state.
  if (chart === 'call-tree') {
    return (
      <div className="p-4 pt-3" data-testid="session-chart-call-tree">
        <CallTreeView
          logsData={logsData}
          isLoading={isLoading}
          error={error instanceof Error ? error : null}
          pricing={pricing ?? undefined}
          topN={topN}
          onTopNChange={onTopNChange}
        />
      </div>
    );
  }

  if (isLoading && !parsedLogs) {
    return (
      <div className="p-4 pt-3">
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (!parsedLogs) {
    return <EmptyChart>No session data to chart</EmptyChart>;
  }

  return (
    <div className="p-4 pt-3" data-testid={`session-chart-${chart}`}>
      {chart === 'dashboard' && (
        <ChartsDashboardTab
          parsedLogs={parsedLogs}
          logsData={logsData}
          timeline={timeline}
          tree={tree}
          heatmap={heatmap}
          pricing={pricing}
          topN={topN}
          onTopNChange={onTopNChange}
          onNavigate={onOpenChart}
        />
      )}

      {chart === 'context-growth' && (
        <ContextGrowthChart
          session={parsedLogs}
          pricing={pricing ?? undefined}
        />
      )}

      {chart === 'context-usage' && (
        <ContextUsageTab
          session={parsedLogs}
          subagentSessions={subagentSessions}
          pricing={pricing ?? undefined}
        />
      )}

      {chart === 'agent-tree' &&
        (!tree ? (
          <EmptyChart>No agent tree data available</EmptyChart>
        ) : (
          <AgentTree
            data={tree}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
          />
        ))}

      {chart === 'timeline' &&
        (!timeline ? (
          <EmptyChart>No timeline data available</EmptyChart>
        ) : (
          <Card className="gap-0 py-0">
            <CardHeader className="flex flex-row items-center justify-between gap-2 px-3 pb-0 pt-3">
              <CardTitle className="text-xs font-medium text-muted-foreground">
                Timeline (Gantt)
              </CardTitle>
              <ToggleGroup
                type="single"
                size="sm"
                value={ganttMode}
                onValueChange={(v) => v && setGanttMode(v as GanttMode)}
              >
                <ToggleGroupItem value="turns" className="px-2 text-[11px]">
                  Steps
                </ToggleGroupItem>
                <ToggleGroupItem value="time" className="px-2 text-[11px]">
                  Time
                </ToggleGroupItem>
              </ToggleGroup>
            </CardHeader>
            <CardContent className="px-3 pb-3 pt-2">
              <GanttTimeline
                data={timeline}
                mode={ganttMode}
                selectedTurnId={selectedTurnId}
                onSelectTurn={setSelectedTurnId}
              />
            </CardContent>
          </Card>
        ))}

      {chart === 'tool-heatmap' &&
        (!heatmap ? (
          <EmptyChart>No tool heatmap data available</EmptyChart>
        ) : (
          <ToolHeatmap data={heatmap} />
        ))}
    </div>
  );
}
