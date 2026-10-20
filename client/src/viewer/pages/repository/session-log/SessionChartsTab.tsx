import { useMemo, useState } from 'react';
import type { ModelPricingMap } from '../../../../models/pricing';
import type { SessionLogsData } from '../../../api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../ui/card';
import { Skeleton } from '../../../ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '../../../ui/toggle-group';
import { agentTree, assistantTimeline, toolHeatmap } from './charts/chart-data';
import { AgentTree } from './charts/agent-tree/AgentTree';
import { ChartsDashboardTab } from './charts/ChartsDashboardTab';
import { ContextGrowthChart } from './charts/context-usage/ContextGrowthChart';
import { ContextUsageTab } from './charts/context-usage/ContextUsageTab';
import { GanttTimeline } from './charts/GanttTimeline';
import { ToolHeatmap } from './charts/ToolHeatmap';
import type { GanttMode } from './charts/useGanttLayout';
import {
  CHART_TAB_STORAGE_KEY,
  CHART_TABS,
  readChartTab,
} from './charts/chart-tab';
import { tabTestId } from '../../../tab-ids';
import type { ChartTab } from './charts/chart-tab';
import { buildSubagentSessions } from './charts/subagent-sessions';
import { CallTreeView } from './CallTreeView';
import type { ParsedSession } from './types';

const CHART_TAB_LABELS: Record<ChartTab, string> = {
  dashboard: 'Dashboard',
  'context-growth': 'Context Growth',
  'context-usage': 'Context Usage',
  'agent-tree': 'Agent Tree',
  timeline: 'Timeline',
  'tool-heatmap': 'Tool Heatmap',
  'call-tree': 'Call Tree',
};

/** The sub-tab trigger row, shared by the loading skeleton and the loaded view. */
function ChartTabTriggers() {
  return (
    <>
      {CHART_TABS.map((t) => (
        <TabsTrigger
          key={t}
          value={t}
          className="flex-none"
          data-testid={tabTestId('chart', t)}
        >
          {CHART_TAB_LABELS[t]}
        </TabsTrigger>
      ))}
    </>
  );
}

interface Props {
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

export function SessionChartsTab({
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
  const [activeTab, setActiveTab] = useState<ChartTab>(readChartTab);

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

  // Labelled sub-agent sessions for the Context Usage sub-tab
  // ("<workflow name>:Agent N" for a workflow member, "Agent N" otherwise).
  const subagentSessions = useMemo(
    () =>
      parsedLogs ? buildSubagentSessions(parsedLogs, subagentLogsMap) : [],
    [parsedLogs, subagentLogsMap],
  );

  function handleTabChange(value: string) {
    const tab = value as ChartTab;
    setActiveTab(tab);
    try {
      localStorage.setItem(CHART_TAB_STORAGE_KEY, tab);
    } catch {
      // Storage unavailable — the tab still switches, it just is not remembered.
    }
  }

  if (error) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-destructive">
        Failed to load session logs
      </div>
    );
  }

  if (isLoading && !parsedLogs) {
    return (
      <Tabs
        value={activeTab}
        onValueChange={handleTabChange}
        className="flex flex-col h-full"
      >
        <TabsList variant="line" className="px-4 pt-3 pb-0 w-fit">
          <ChartTabTriggers />
        </TabsList>
        <div className="p-4 pt-3">
          <Skeleton className="h-64 w-full" />
        </div>
      </Tabs>
    );
  }

  if (!parsedLogs) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No session data to chart
      </div>
    );
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      className="flex flex-col h-full"
    >
      <TabsList variant="line" className="px-4 pt-3 pb-0 w-fit">
        <ChartTabTriggers />
      </TabsList>

      <TabsContent value="dashboard" className="p-4 pt-3">
        <ChartsDashboardTab
          parsedLogs={parsedLogs}
          logsData={logsData}
          timeline={timeline}
          tree={tree}
          heatmap={heatmap}
          pricing={pricing}
          topN={topN}
          onTopNChange={onTopNChange}
          onNavigate={handleTabChange}
        />
      </TabsContent>

      <TabsContent value="context-growth" className="p-4 pt-3">
        <ContextGrowthChart
          session={parsedLogs}
          pricing={pricing ?? undefined}
        />
      </TabsContent>

      <TabsContent value="context-usage" className="p-4 pt-3">
        <ContextUsageTab
          session={parsedLogs}
          subagentSessions={subagentSessions}
          pricing={pricing ?? undefined}
        />
      </TabsContent>

      <TabsContent value="agent-tree" className="p-4 pt-3">
        {!tree ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No agent tree data available
          </div>
        ) : (
          <AgentTree
            data={tree}
            selectedAgentId={selectedAgentId}
            onSelectAgent={setSelectedAgentId}
          />
        )}
      </TabsContent>

      <TabsContent value="timeline" className="p-4 pt-3">
        {!timeline ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No timeline data available
          </div>
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
        )}
      </TabsContent>

      <TabsContent value="tool-heatmap" className="p-4 pt-3">
        {!heatmap ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            No tool heatmap data available
          </div>
        ) : (
          <ToolHeatmap data={heatmap} />
        )}
      </TabsContent>

      <TabsContent value="call-tree" className="p-4 pt-3">
        <CallTreeView
          logsData={logsData}
          isLoading={isLoading}
          error={error instanceof Error ? error : null}
          pricing={pricing ?? undefined}
          topN={topN}
          onTopNChange={onTopNChange}
        />
      </TabsContent>
    </Tabs>
  );
}
