import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDraggableWidth } from '../../../hooks/useDraggableWidth';
import { ReportsTree } from './ReportsTree';
import { ReportParameterStrip } from './ReportParameterStrip';
import { DEFAULT_REPORT_ID, findReport, type ReportId } from './report-catalog';
import {
  applyReportParamsToSearchParams,
  reportParamsFromSearchParams,
  type ReportParamsState,
} from './report-url';
import { SessionTimelineReport } from './SessionTimelineReport';
import { WorkTimeDistributionReport } from './WorkTimeDistributionReport';
import { BranchSummaryReport } from './BranchSummaryReport';
import { CostByBranchReport } from './CostByBranchReport';
import { CostByUserReport } from './CostByUserReport';
import { CacheReadRatioReport } from './CacheReadRatioReport';
import { ProductivityReport } from './ProductivityReport';
import { ExecutiveSummaryReport } from './executive-summary/ExecutiveSummaryReport';
import { ToolAnalyticsReport } from './ToolAnalyticsReport';
import { TokenUsageReport } from './TokenUsageReport';
import { ProductivityCountersReport } from './ProductivityCountersReport';
import { ActiveSessionsReport } from './ActiveSessionsReport';
import { HarnessUsageReport } from './HarnessUsageReport';
import { ClaudeVersionUsageReport } from './ClaudeVersionUsageReport';
import { ChangeSurfaceReport } from './ChangeSurfaceReport';
import { AttributionBreakdownReport } from './AttributionBreakdownReport';
import { AttributionUsageReport } from './AttributionUsageReport';

interface Props {
  repoId: number;
  teamId?: number;
}

export function ReportsPanel({ repoId, teamId }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { width, onMouseDown } = useDraggableWidth({
    storageKey: 'artisyn:reportsTreeWidth',
    defaultWidth: 220,
    minWidth: 160,
    getMaxWidth: () => window.innerWidth * 0.5,
  });

  const reportIdFromUrl = searchParams.get('report') as ReportId | null;
  const selectedReportId =
    reportIdFromUrl && findReport(reportIdFromUrl) ? reportIdFromUrl : null;
  const report = selectedReportId ? findReport(selectedReportId) : undefined;
  const committed = reportParamsFromSearchParams(
    searchParams,
    report?.defaultGroupBy,
  );

  // Reports tab opened with no report param: auto-select the first report.
  useEffect(() => {
    if (!searchParams.get('report')) {
      const next = new URLSearchParams(searchParams);
      next.set('mtab', 'reports');
      next.set('report', DEFAULT_REPORT_ID);
      setSearchParams(next, { replace: true });
    }
    // Intentionally mount-only: this seeds a missing `report` param exactly
    // once. searchParams/setSearchParams are stable-enough refs from
    // react-router and re-running on every param change isn't desired here.
  }, []);

  const [draft, setDraft] = useState<ReportParamsState>(committed);
  const [generation, setGeneration] = useState(0);

  // Reset draft params whenever the selected report changes, so switching
  // reports starts from the last-generated (committed) values, not stale edits.
  useEffect(() => {
    setDraft(committed);
    // Intentionally keyed on selectedReportId only — `committed` itself
    // changes on every keystroke-adjacent param edit, and we only want to
    // reset the draft when the *report* changes, not on every param tweak.
  }, [selectedReportId]);

  function handleSelectReport(id: ReportId) {
    const next = new URLSearchParams(searchParams);
    next.set('mtab', 'reports');
    next.set('report', id);
    setSearchParams(next, { replace: true });
  }

  function handleRun() {
    if (!selectedReportId) return;
    const next = new URLSearchParams(searchParams);
    applyReportParamsToSearchParams(
      { ...draft, report: selectedReportId },
      next,
    );
    setSearchParams(next, { replace: true });
    setGeneration((g) => g + 1);
  }

  return (
    <div className="flex h-full min-h-0">
      <div
        style={{ width }}
        className="flex-shrink-0 overflow-y-auto border-r border-border"
      >
        <ReportsTree
          selectedReportId={selectedReportId}
          onSelectReport={handleSelectReport}
        />
      </div>
      <div
        onMouseDown={onMouseDown}
        className="w-1 flex-shrink-0 cursor-col-resize hover:bg-accent"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {report ? (
          <>
            <ReportParameterStrip
              report={report}
              repoId={repoId}
              teamId={teamId}
              draft={draft}
              onDraftChange={(patch) =>
                setDraft((prev) => ({ ...prev, ...patch }))
              }
              onRun={handleRun}
            />
            <div className="flex-1 min-h-0 overflow-y-auto p-4">
              {renderReport(report.id, repoId, teamId, committed, generation)}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-muted-foreground">
              Select a report from the list on the left
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function renderReport(
  reportId: ReportId,
  repoId: number,
  teamId: number | undefined,
  params: ReportParamsState,
  generation: number,
) {
  switch (reportId) {
    case 'session-timeline':
      return (
        <SessionTimelineReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'work-time':
      return (
        <WorkTimeDistributionReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'branch-summary':
      return (
        <BranchSummaryReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'cost-by-branch':
      return (
        <CostByBranchReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'cost-by-user':
      return (
        <CostByUserReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'cache-read-ratio':
      return (
        <CacheReadRatioReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'productivity':
      return (
        <ProductivityReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'executive-summary':
      return (
        <ExecutiveSummaryReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    // usage reports
    case 'tool-analytics':
      return (
        <ToolAnalyticsReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'token-usage':
      return (
        <TokenUsageReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'productivity-counters':
      return (
        <ProductivityCountersReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'active-sessions':
      return (
        <ActiveSessionsReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'claude-version-usage':
      return (
        <ClaudeVersionUsageReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'harness-usage':
      return (
        <HarnessUsageReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    // change surface
    case 'change-surface':
      return (
        <ChangeSurfaceReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    // AI Session Attribution
    case 'attribution-breakdown':
      return (
        <AttributionBreakdownReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    case 'attribution-usage':
      return (
        <AttributionUsageReport
          repoId={repoId}
          teamId={teamId}
          params={params}
          generation={generation}
        />
      );
    default:
      return null;
  }
}
