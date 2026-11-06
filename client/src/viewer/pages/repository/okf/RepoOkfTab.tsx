/**
 * The repository view's "OKF" main tab: how the repo's OKF knowledge bases were read over a
 * period. Filter strip on top; below it either the overview (`RepoOkfOverview`: banner, verdict
 * card, KPI tiles, tree and side lists) or — when `okfArticle` is set — the per-article
 * drill-down (`OkfArticleDrillDown`).
 *
 * Personal vs team view follows the route (`teamId`), not a toggle (DD-32). Every filter lives
 * in an `okf*` URL param (DD-44) and is applied at once; the query is keyed by the filter state.
 * `okfArticle` is not a filter, so a filter change keeps the drill-down open.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Skeleton } from '@/ui/skeleton';
import { ApiError, fetchRepoOkfUsage } from '../../../api';
import { toIsoDateBounds } from '../reports/report-url';
import { OkfArticleDrillDown } from './article/OkfArticleDrillDown';
import { OkfAnalysisCoverageBanner } from './OkfAnalysisCoverageBanner';
import { OkfFilterStrip } from './OkfFilterStrip';
import { RepoOkfOverview } from './RepoOkfOverview';
import {
  okfArticleFromParams,
  okfFiltersFromParams,
  okfThresholdsSettingsParams,
  writeOkfArticle,
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
  const article = okfArticleFromParams(searchParams);
  // The response lists only the selected bundle when one is chosen, so the bundle select keeps
  // the last full list it saw.
  const [knownBundles, setKnownBundles] = useState<string[]>([]);

  const onChange = (patch: Partial<RepoOkfFilters>) => {
    setSearchParams((prev) => writeOkfFilters(prev, { ...filters, ...patch }), {
      replace: true,
    });
  };
  const openArticle = (path: string | null) => {
    setSearchParams((prev) => writeOkfArticle(prev, path), { replace: true });
  };
  // Settings → Analysis, scrolled to the OKF thresholds card. Leaving the tab drops every
  // `okf*` param, as `setMainTab` does.
  const openSettings = () => {
    setSearchParams(okfThresholdsSettingsParams, { replace: true });
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

  let body;
  if (article !== null) {
    body = (
      <OkfArticleDrillDown
        repoId={repoId}
        teamId={teamId}
        path={article}
        filters={filters}
        onBack={() => openArticle(null)}
        onOpenArticle={openArticle}
      />
    );
  } else if (query.isLoading) {
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
    const without = data.tiles.sessionsWithoutAnalysis ?? 0;
    body = (
      <>
        <OkfAnalysisCoverageBanner
          className="mx-4 mt-4"
          repoId={repoId}
          teamId={teamId}
          sessionsWithoutAnalysis={without}
          sessionsInPeriod={
            data.tiles.sessionsInPeriod ?? data.tiles.totalSessions
          }
          canRecompute={data.canRecompute === true}
        />
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
      </>
    );
  } else {
    body = (
      <RepoOkfOverview
        repoId={repoId}
        teamId={teamId}
        data={data}
        metric={filters.heat}
        onOpenArticle={openArticle}
        onOpenSettings={openSettings}
      />
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
