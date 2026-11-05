/**
 * The overview of the repo OKF tab (everything but the filter strip and the article
 * drill-down): FR-11 analysis banner; section A (verdict card with the Checks block and the
 * structure findings, KPI tiles); section B (value-signal tiles and findings);
 * then the KB tree beside the share histogram, hot files, Upkeep panel and not-read list.
 * Nothing is recomputed here — the server sends the verdict, tiles, bins, lists and tree.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, type CSSProperties } from 'react';
import { getRepoSettings } from '../../../api';
import { useDraggableWidth } from '../../../hooks/useDraggableWidth';
import type { RepoOkfUsageResponse } from '../../../../models/repositories';
import { OkfTree, type OkfTreeHandle } from '../session-log/okf/OkfTree';
import { OkfVerdictCard } from '../session-log/okf/OkfVerdictCard';
import {
  OKF_SECTION_A_TITLE,
  OkfSection,
  OkfSignalsSection,
} from '../session-log/okf/OkfSection';
import type { OkfHeatMetric } from '../session-log/okf/okf-tree';
import { isStructureFinding } from '@/lib/okf/okf-check-text';
import { OkfAnalysisCoverageBanner } from './OkfAnalysisCoverageBanner';
import { OkfHotFiles } from './OkfHotFiles';
import { OkfKpiTiles, OkfSignalTiles } from './OkfKpiTiles';
import { OkfSignalFindings } from './OkfSignalFindings';
import { OkfNotReadList } from './OkfNotReadList';
import { OkfShareHistogram } from './OkfShareHistogram';
import { OkfUpkeepPanel } from './OkfUpkeepPanel';

/**
 * Narrowest the KB tree may get when the side column is dragged wider, in px: what its fixed
 * columns need, so it does not scroll sideways.
 */
const TREE_MIN_WIDTH = 720;

export interface RepoOkfOverviewProps {
  repoId: number;
  teamId?: number;
  data: RepoOkfUsageResponse;
  metric: OkfHeatMetric;
  /** Opens the article drill-down (`okfArticle`). */
  onOpenArticle: (path: string) => void;
  /** Opens Settings → Analysis (OKF thresholds). */
  onOpenSettings: () => void;
}

/**
 * `shareMinBundleFiles` in effect for this view, for the histogram caption. The repo response
 * only says which fields are custom, so the value comes from the settings route (same query
 * key as the filter strip, no extra round trip): the view's own `okf` section, else the
 * defaults. Null while the settings are not loaded (the caption is hidden).
 */
function useShareMinBundleFiles(
  repoId: number,
  teamId: number | undefined,
  custom: readonly string[],
): number | null {
  const settings = useQuery({
    queryKey: ['repoSettings', repoId, teamId ?? null],
    queryFn: () => getRepoSettings(repoId, teamId),
  }).data;
  if (!settings) return null;
  const fallback = settings.okfDefaults.shareMinBundleFiles ?? null;
  if (!custom.includes('shareMinBundleFiles')) return fallback;
  const section =
    teamId != null
      ? settings.teamConfig?.okf
      : (settings.userConfig?.okf ?? settings.teamConfig?.okf);
  return section?.shareMinBundleFiles ?? fallback;
}

export function RepoOkfOverview({
  repoId,
  teamId,
  data,
  metric,
  onOpenArticle,
  onOpenSettings,
}: RepoOkfOverviewProps) {
  const treeRef = useRef<OkfTreeHandle | null>(null);
  // Side column (histogram, hot files, upkeep, not-read) beside the tree when the tab is at least
  // 72rem wide (container query: tree + default side column), below it otherwise; its handle
  // widens the tree when dragged right. The tree keeps at least TREE_MIN_WIDTH.
  const splitRef = useRef<HTMLDivElement | null>(null);
  const { width: sideWidth, onMouseDown: onSplitMouseDown } = useDraggableWidth(
    {
      storageKey: 'artisyn:okfRepoSideWidth',
      defaultWidth: 340,
      minWidth: 240,
      rightPanel: true,
      getMaxWidth: () =>
        (splitRef.current?.clientWidth ?? window.innerWidth) - TREE_MIN_WIDTH,
    },
  );
  const ignoredBundles = useMemo(
    () => new Set(data.bundles.filter((b) => b.ignored).map((b) => b.root)),
    [data],
  );
  const minBundleFiles = useShareMinBundleFiles(
    repoId,
    teamId,
    data.thresholds?.custom ?? [],
  );

  const scrollToNode = (bundle: string | null, path?: string) => {
    treeRef.current?.scrollToNode(bundle, path);
  };
  const { tiles } = data;
  // The server merges value-signal findings into the repo verdict (one level); the tab lists the
  // structure findings under A and the value signals under B.
  const signalFindings = data.verdict.findings.filter(
    (f) => !isStructureFinding(f),
  );
  const structureVerdict = {
    ...data.verdict,
    findings: data.verdict.findings.filter(isStructureFinding),
  };

  return (
    <div className="@container/okfrepo space-y-3 p-4">
      <OkfAnalysisCoverageBanner
        repoId={repoId}
        teamId={teamId}
        sessionsWithoutAnalysis={tiles.sessionsWithoutAnalysis ?? 0}
        sessionsInPeriod={tiles.sessionsInPeriod ?? tiles.totalSessions}
        canRecompute={data.canRecompute === true}
      />
      <OkfSection testId="okf-section-a" title={OKF_SECTION_A_TITLE}>
        <OkfVerdictCard
          verdict={structureVerdict}
          variant="repo"
          kbSessions={tiles.kbSessions}
          totalSessions={tiles.totalSessions}
          onNodeClick={scrollToNode}
          thresholds={data.thresholds}
          onOpenSettings={onOpenSettings}
          signalFindingsInLevel={
            signalFindings.filter((f) => f.severity !== 'info').length
          }
        />
        <OkfKpiTiles
          tiles={tiles}
          snapshot={data.snapshot}
          bundleCount={data.bundles.length}
        />
      </OkfSection>
      <OkfSignalsSection count={signalFindings.length}>
        <OkfSignalTiles tiles={tiles} />
        <OkfSignalFindings
          findings={signalFindings}
          onNodeClick={scrollToNode}
        />
      </OkfSignalsSection>
      <div
        ref={splitRef}
        className="flex flex-col gap-3 @6xl/okfrepo:flex-row @6xl/okfrepo:items-stretch @6xl/okfrepo:gap-0"
        style={{ '--okf-side-w': `${sideWidth}px` } as CSSProperties}
      >
        <div className="min-w-0 flex-1 @6xl/okfrepo:self-start">
          <OkfTree
            ref={treeRef}
            tree={data.tree}
            metric={metric}
            variant="repo"
            ignoredBundles={ignoredBundles}
            nullGroupLabel={
              data.snapshot
                ? 'No longer in KB'
                : 'Accessed KB paths (no snapshot)'
            }
            onOpenArticle={onOpenArticle}
          />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the KB tree"
          data-testid="okf-split-handle"
          onMouseDown={onSplitMouseDown}
          className="mx-1 hidden w-1 shrink-0 cursor-col-resize rounded hover:bg-accent @6xl/okfrepo:block"
        />
        <div className="flex flex-col gap-3 @6xl/okfrepo:w-(--okf-side-w) @6xl/okfrepo:shrink-0 @6xl/okfrepo:self-start">
          <OkfShareHistogram
            bins={data.shareBins}
            minBundleFiles={minBundleFiles}
          />
          <OkfHotFiles files={data.hotFiles} onNodeClick={scrollToNode} />
          {data.upkeep ? (
            <OkfUpkeepPanel items={data.upkeep} onNodeClick={scrollToNode} />
          ) : null}
          <OkfNotReadList files={data.notRead} onNodeClick={scrollToNode} />
        </div>
      </div>
    </div>
  );
}
