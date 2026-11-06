/**
 * The session view's "OKF" tab: how this session tree (main agent + sub-agents) read the repo's
 * OKF knowledge bases. Section A (verdict card with the Checks block, KB folder cards), section B
 * (value-signal tile, legend and the selected agent's trail — `okfAgent` in the URL, set by the
 * Agents panel or a tile link), then the KB tree with the Agents panel
 * beside it when the tab is at least 56rem wide (a container query: the session pane is much
 * narrower than the viewport), below it otherwise,, and the on-demand deeper-analysis hint last.
 *
 * Nothing is recomputed here: the verdict, the tree aggregation and the per-agent lists come
 * from the server; the client only renders the verdict text (`okf-verdict-text.ts`), sorts the
 * tree by the Bytes/Calls toggle and narrows it to one agent's reads.
 *
 * States: loading → skeletons; error → inline message; `verdict: null` (no bundle and no KB
 * access) → empty state; no snapshot (session uploaded by a hook without OKF support) → amber
 * banner linking to the hook install page, tree of accessed paths only.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { fetchSessionOkfUsage } from '../../../../api';
import {
  okfRepoTabParams,
  okfThresholdsSettingsParams,
} from '../../okf/okf-url-state';
import { useRepoTeamAccess } from '../../useRepoTeamAccess';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import {
  OkfAgentTrail,
  OkfTrailPrompt,
  useOkfAgentParam,
} from './OkfAgentTrail';
import { OkfAgentsPanel } from './OkfAgentsPanel';
import { OkfBundleCards } from './OkfBundleCards';
import {
  OKF_SECTION_A_TITLE,
  OkfSection,
  OkfSignalsSection,
  okfSessionSignalCount,
} from './OkfSection';
import { OkfTree, type OkfTreeHandle } from './OkfTree';
import { OkfValueSignalsLegend } from './OkfValueSignalsLegend';
import { OkfValueSignalsTile } from './OkfValueSignalsTile';
import { OkfVerdictCard } from './OkfVerdictCard';
import {
  DeeperAnalysisHint,
  EmptyState,
  LoadingSkeleton,
  NoSnapshotBanner,
} from './SessionOkfStates';
import {
  buildOkfSessionDetails,
  okfRangedCallsByPath,
} from './okf-session-details';
import type { OkfHeatMetric } from './okf-tree';
import { okfTrailLinkAgents } from './okf-trail';
import { buildOkfAgentLabels, okfAgentLabel } from '@/lib/okf/okf-agent-label';

export interface SessionOkfTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
}

export function SessionOkfTab({
  repoId,
  sessionId,
  teamId,
}: SessionOkfTabProps) {
  const [metric, setMetric] = useState<OkfHeatMetric>('bytes');
  const treeRef = useRef<OkfTreeHandle | null>(null);
  const treeBoxRef = useRef<HTMLDivElement | null>(null);
  const trailRef = useRef<HTMLDivElement | null>(null);
  const [, setSearchParams] = useSearchParams();
  // The selected agent lives in the URL (`okfAgent`): it narrows the tree and opens its trail.
  const [agentFilter, setAgentFilter] = useOkfAgentParam();
  // Section B's "show trail" links: select the agent and bring its trail into view.
  const openTrail = (id: string) => {
    setAgentFilter(id);
    requestAnimationFrame(() =>
      trailRef.current?.scrollIntoView({ block: 'nearest' }),
    );
  };
  // The verdict card's thresholds chip opens Settings → Analysis at the OKF thresholds card.
  const openSettings = () => {
    setSearchParams(okfThresholdsSettingsParams, { replace: true });
  };
  // The Checks block's link to the repository OKF tab (repo-level rules); only for callers
  // who see that tab.
  const { canSeeTeamWideTabs } = useRepoTeamAccess(teamId);
  const openRepoTab = () => {
    setSearchParams(okfRepoTabParams, { replace: true });
  };

  const query = useQuery({
    queryKey: ['session-okf-usage', repoId, sessionId, teamId],
    queryFn: () => fetchSessionOkfUsage(repoId, sessionId, teamId),
  });
  const data = query.data;

  const fileFilter = useMemo(() => {
    if (!agentFilter || !data) return null;
    const agent = data.agents.find((a) => a.id === agentFilter);
    return agent ? new Set(agent.files) : null;
  }, [agentFilter, data]);

  const agentLabels = useMemo(
    () => buildOkfAgentLabels(data?.agents ?? [], sessionId),
    [data, sessionId],
  );
  const details = useMemo(
    () =>
      data
        ? buildOkfSessionDetails(data.agents, sessionId, agentLabels)
        : undefined,
    [data, sessionId, agentLabels],
  );
  const rangedCalls = useMemo(
    () => okfRangedCallsByPath(data?.tree ?? []),
    [data],
  );

  const ignoredBundles = useMemo(
    () =>
      new Set(
        (data?.bundles ?? []).filter((b) => b.ignored).map((b) => b.root),
      ),
    [data],
  );

  const scrollToNode = (bundle: string | null, path?: string) => {
    // The target may be outside the selected agent's reads — show the whole tree.
    setAgentFilter(null);
    treeRef.current?.scrollToNode(bundle, path);
  };

  if (query.isLoading) return <LoadingSkeleton />;
  if (query.error) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {getSessionLogsErrorMessage(query.error)}
      </div>
    );
  }
  if (!data) {
    return <EmptyState title="Error" body="KB usage could not be loaded." />;
  }
  if (data.verdict === null) {
    return (
      <EmptyState
        title="No OKF knowledge base"
        body="This session's repository has no OKF bundle in its snapshot, and no agent read a KB article."
      />
    );
  }

  const subAgents = data.agents.filter((a) => a.id !== sessionId).length;
  const selectedLabel = agentFilter
    ? okfAgentLabel(agentFilter, sessionId, agentLabels)
    : '';

  return (
    <div className="@container/okf space-y-3 p-4" data-testid="session-okf-tab">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          OKF · whole session tree (main + {subAgents} sub-agents) ·{' '}
          {data.bundles.length}{' '}
          {data.bundles.length === 1 ? 'KB folder' : 'KB folders'}
        </h2>
        <span className="text-xs text-muted-foreground">Read heat</span>
        <ToggleGroup
          type="single"
          size="sm"
          variant="outline"
          value={metric}
          onValueChange={(v) => v && setMetric(v as OkfHeatMetric)}
          data-testid="okf-metric-toggle"
        >
          <ToggleGroupItem value="bytes" className="px-2 text-[11px]">
            Bytes
          </ToggleGroupItem>
          <ToggleGroupItem value="calls" className="px-2 text-[11px]">
            Calls
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {!data.hasSnapshot ? <NoSnapshotBanner /> : null}

      <OkfSection testId="okf-section-a" title={OKF_SECTION_A_TITLE}>
        <div className="max-w-4xl">
          <OkfVerdictCard
            verdict={data.verdict}
            variant="session"
            readTop={data.readTop}
            upkeep={data.upkeep}
            rangedCalls={rangedCalls}
            agents={data.agents}
            rootSessionId={sessionId}
            agentLabels={agentLabels}
            onNodeClick={scrollToNode}
            thresholds={data.thresholds}
            onOpenSettings={openSettings}
            onOpenRepoTab={canSeeTeamWideTabs ? openRepoTab : undefined}
          />
        </div>
        <OkfBundleCards
          bundles={data.bundles}
          onBundleClick={(root) => scrollToNode(root)}
        />
      </OkfSection>

      <OkfSignalsSection count={okfSessionSignalCount(data.signals)}>
        <OkfValueSignalsTile
          signals={data.signals}
          eventsTruncated={data.eventsTruncated}
          trailAgents={okfTrailLinkAgents(data.agents)}
          onShowTrail={openTrail}
        />
        <OkfValueSignalsLegend />
        <div ref={trailRef}>
          {agentFilter ? (
            <OkfAgentTrail
              repoId={repoId}
              sessionId={sessionId}
              teamId={teamId}
              agentId={agentFilter}
              label={selectedLabel}
              onClose={() => setAgentFilter(null)}
            />
          ) : (
            <OkfTrailPrompt />
          )}
        </div>
      </OkfSignalsSection>

      <div
        ref={treeBoxRef}
        className="flex flex-col gap-3 @4xl/okf:flex-row @4xl/okf:items-start"
      >
        <div className="min-w-0 flex-1">
          <OkfTree
            ref={treeRef}
            tree={data.tree}
            metric={metric}
            variant="session"
            ignoredBundles={ignoredBundles}
            nullGroupLabel={
              data.hasSnapshot
                ? 'Not in the KB snapshot'
                : 'Accessed KB paths (no snapshot)'
            }
            fileFilter={fileFilter}
            details={details}
            filterNote={`Showing only agent ${selectedLabel}'s reads (unread articles hidden) — folder totals are the whole tree's.`}
          />
        </div>
        <OkfAgentsPanel
          agents={data.agents}
          rootSessionId={sessionId}
          labels={agentLabels}
          selected={agentFilter}
          onSelect={(id) => {
            setAgentFilter(id);
            treeBoxRef.current?.scrollIntoView({ block: 'nearest' });
          }}
        />
      </div>

      <DeeperAnalysisHint sessionId={sessionId} />
    </div>
  );
}
