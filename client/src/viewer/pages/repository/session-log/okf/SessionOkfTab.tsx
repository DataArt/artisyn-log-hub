/**
 * The session view's "OKF" tab: how this session tree (main agent + sub-agents) read the repo's
 * OKF knowledge bases. Verdict card, bundle cards, then the KB tree beside the Agents panel.
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
import { useNavigate } from 'react-router-dom';
import { Skeleton } from '@/ui/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { fetchSessionOkfUsage } from '../../../../api';
import { routes } from '../../../../hooks/useHashRoute';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { OkfAgentsPanel } from './OkfAgentsPanel';
import { OkfBundleCards } from './OkfBundleCards';
import { OkfTree, type OkfTreeHandle } from './OkfTree';
import { OkfVerdictCard } from './OkfVerdictCard';
import { okfAgentLabel, type OkfHeatMetric } from './okf-tree';

export interface SessionOkfTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="okf-loading">
      <Skeleton className="h-28 w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-20 w-72" />
        <Skeleton className="h-20 w-72" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="p-8 text-center text-sm text-muted-foreground"
      data-testid="okf-empty"
    >
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

function NoSnapshotBanner() {
  const navigate = useNavigate();
  return (
    <div
      data-testid="okf-no-snapshot"
      className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-foreground"
    >
      <div>
        ⚠ No KB snapshot for this session — the tree shows only the paths that
        were accessed (no &quot;not read&quot; list).
      </div>
      <div className="mt-0.5 text-xs">
        Update the Log Hub hook in this repository to see the full bundle tree.{' '}
        <button
          type="button"
          onClick={() => {
            void navigate(routes.apiKeys);
          }}
          className="font-medium underline underline-offset-2"
        >
          How to update
        </button>
      </div>
    </div>
  );
}

/** Name of the on-demand KB-analysis skill shipped with the hooks plugin (task kb-completeness-deep). */
const KB_ANALYSIS_COMMAND = '/log-hub-hooks:kb-analysis';

function DeeperAnalysisHint({ sessionId }: { sessionId: string }) {
  return (
    <p
      data-testid="okf-deeper-analysis"
      className="text-xs text-muted-foreground"
    >
      Deeper analysis (what should have been read, failed searches, KB gaps and
      fixes) runs locally in Claude Code, on demand:{' '}
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
        {KB_ANALYSIS_COMMAND} {sessionId}
      </code>
    </p>
  );
}

export function SessionOkfTab({
  repoId,
  sessionId,
  teamId,
}: SessionOkfTabProps) {
  const [metric, setMetric] = useState<OkfHeatMetric>('bytes');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const treeRef = useRef<OkfTreeHandle | null>(null);
  const treeBoxRef = useRef<HTMLDivElement | null>(null);

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
    ? okfAgentLabel(agentFilter, sessionId)
    : '';

  return (
    <div className="space-y-3 p-4" data-testid="session-okf-tab">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          OKF · whole session tree (main + {subAgents} sub-agents) ·{' '}
          {data.bundles.length}{' '}
          {data.bundles.length === 1 ? 'bundle' : 'bundles'}
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
      <DeeperAnalysisHint sessionId={sessionId} />

      {!data.hasSnapshot ? <NoSnapshotBanner /> : null}

      <div className="max-w-4xl">
        <OkfVerdictCard
          verdict={data.verdict}
          variant="session"
          readTop={data.readTop}
          agents={data.agents}
          rootSessionId={sessionId}
          onNodeClick={scrollToNode}
        />
      </div>

      <OkfBundleCards
        bundles={data.bundles}
        onBundleClick={(root) => scrollToNode(root)}
      />

      <div
        ref={treeBoxRef}
        className="flex flex-col gap-3 lg:flex-row lg:items-start"
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
            filterNote={`Showing only agent ${selectedLabel}'s reads — folder and bundle totals are the whole tree's.`}
          />
        </div>
        <OkfAgentsPanel
          agents={data.agents}
          rootSessionId={sessionId}
          selected={agentFilter}
          onSelect={(id) => {
            setAgentFilter(id);
            treeBoxRef.current?.scrollIntoView({ block: 'nearest' });
          }}
        />
      </div>
    </div>
  );
}
