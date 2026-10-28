/**
 * The repository view's "OKF" main tab: how the repo's OKF knowledge bases were read over a
 * period. Filter strip, verdict card with the anomaly lines, five KPI tiles, then the KB tree
 * beside the share histogram, hot files and not-read list.
 *
 * Personal vs team view follows the route (`teamId`), not a toggle (DD-32). Every filter lives
 * in an `okf*` URL param (DD-44) and is applied at once; the query is keyed by the filter state.
 * Nothing is recomputed here — the server sends the verdict, tiles, bins, lists and tree.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Skeleton } from '@/ui/skeleton';
import { ApiError, fetchRepoOkfUsage } from '../../../api';
import { toIsoDateBounds } from '../reports/report-url';
import { OkfTree, type OkfTreeHandle } from '../session-log/okf/OkfTree';
import { OkfVerdictCard } from '../session-log/okf/OkfVerdictCard';
import { OkfFilterStrip } from './OkfFilterStrip';
import { OkfHotFiles } from './OkfHotFiles';
import { OkfKpiTiles } from './OkfKpiTiles';
import { OkfNotReadList } from './OkfNotReadList';
import { OkfShareHistogram } from './OkfShareHistogram';
import {
  okfFiltersFromParams,
  writeOkfFilters,
  type RepoOkfFilters,
} from './okf-url-state';

export interface RepoOkfTabProps {
  repoId: number;
  teamId?: number;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="okf-loading">
      <Skeleton className="h-28 w-full" />
      <div className="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function errorMessage(error: Error): string {
  if (error instanceof ApiError && error.statusCode === 403) return 'No access';
  return 'Error — KB usage could not be loaded.';
}

export function RepoOkfTab({ repoId, teamId }: RepoOkfTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(
    () => okfFiltersFromParams(searchParams),
    [searchParams],
  );
  const treeRef = useRef<OkfTreeHandle | null>(null);
  // The response lists only the selected bundle when one is chosen, so the bundle select keeps
  // the last full list it saw.
  const [knownBundles, setKnownBundles] = useState<string[]>([]);

  const onChange = (patch: Partial<RepoOkfFilters>) => {
    setSearchParams((prev) => writeOkfFilters(prev, { ...filters, ...patch }), {
      replace: true,
    });
  };

  const { startDate, endDate } = toIsoDateBounds(
    filters.startDate,
    filters.endDate,
  );
  const query = useQuery({
    queryKey: [
      'repo-okf-usage',
      repoId,
      teamId ?? null,
      startDate,
      endDate,
      filters.branches,
      filters.users,
      filters.attr,
      filters.bundle,
    ],
    queryFn: () =>
      fetchRepoOkfUsage(repoId, {
        teamId,
        startDate,
        endDate,
        branches: filters.branches,
        users: filters.users,
        attr: filters.attr,
        bundle: filters.bundle ?? undefined,
      }),
  });
  const data = query.data;

  const responseRoots = useMemo(
    () => (data?.bundles ?? []).map((b) => b.root),
    [data],
  );
  if (
    filters.bundle === null &&
    data &&
    responseRoots.join('\n') !== knownBundles.join('\n')
  ) {
    setKnownBundles(responseRoots);
  }
  const bundleRoots = filters.bundle === null ? responseRoots : knownBundles;

  const ignoredBundles = useMemo(
    () =>
      new Set(
        (data?.bundles ?? []).filter((b) => b.ignored).map((b) => b.root),
      ),
    [data],
  );

  const scrollToNode = (bundle: string | null, path?: string) => {
    treeRef.current?.scrollToNode(bundle, path);
  };

  let body;
  if (query.isLoading) {
    body = <LoadingSkeleton />;
  } else if (query.error) {
    body = (
      <div
        data-testid="okf-error"
        className="m-4 rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground"
      >
        {errorMessage(query.error)}
      </div>
    );
  } else if (!data) {
    body = null;
  } else if (data.tiles.kbSessions === 0 && data.bundles.length === 0) {
    body = (
      <div
        data-testid="okf-empty"
        className="p-8 text-center text-sm text-muted-foreground"
      >
        <div className="font-medium text-foreground">
          KB not used in this period
        </div>
        <div className="mt-1">
          No session in the filter read an OKF knowledge base, and no KB
          snapshot was uploaded.
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-3 p-4">
        <OkfVerdictCard
          verdict={data.verdict}
          variant="repo"
          kbSessions={data.tiles.kbSessions}
          totalSessions={data.tiles.totalSessions}
          onNodeClick={scrollToNode}
        />
        <OkfKpiTiles
          tiles={data.tiles}
          snapshot={data.snapshot}
          bundleCount={data.bundles.length}
        />
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1">
            <OkfTree
              ref={treeRef}
              tree={data.tree}
              metric={filters.heat}
              variant="repo"
              ignoredBundles={ignoredBundles}
              nullGroupLabel={
                data.snapshot
                  ? 'No longer in KB'
                  : 'Accessed KB paths (no snapshot)'
              }
            />
          </div>
          <div className="flex flex-col gap-3 xl:w-[340px]">
            <OkfShareHistogram bins={data.shareBins} />
            <OkfHotFiles files={data.hotFiles} onNodeClick={scrollToNode} />
            <OkfNotReadList files={data.notRead} onNodeClick={scrollToNode} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="repo-okf-tab">
      <OkfFilterStrip
        repoId={repoId}
        teamId={teamId}
        filters={filters}
        onChange={onChange}
        bundleRoots={bundleRoots}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
