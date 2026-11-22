/**
 * The repository view's "OKF" main tab: how the repo's OKF knowledge bases were read over a
 * period. Filter strip on top; below it the shared view (`OkfUsageView`: summary line, Versions,
 * Wrong format, Hot files, Explorer). The tab only fetches and passes `data`.
 *
 * Personal vs team view follows the route (`teamId`), not a toggle (DD-32). Every filter lives
 * in an `okf*` URL param (DD-44) and is applied at once; the query is keyed by the filter state.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchRepoOkfUsage } from '../../../api';
import { toIsoDateBounds } from '../reports/report-url';
import { LoadingSkeleton } from '../session-log/okf/SessionOkfStates';
import { OkfFilterStrip } from './OkfFilterStrip';
import {
  okfFiltersFromParams,
  writeOkfFilters,
  type RepoOkfFilters,
} from './okf-url-state';
import { OkfLoadError } from './view/OkfLoadError';
import { OkfUsageView } from './view/OkfUsageView';

export interface RepoOkfTabProps {
  repoId: number;
  teamId?: number;
}

const NO_BUNDLE_ROOTS: readonly string[] = [];

export function RepoOkfTab({ repoId, teamId }: RepoOkfTabProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(
    () => okfFiltersFromParams(searchParams),
    [searchParams],
  );

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

  let body;
  if (query.isLoading) {
    body = <LoadingSkeleton />;
  } else if (query.error) {
    body = (
      <div className="p-4">
        <OkfLoadError error={query.error} />
      </div>
    );
  } else if (data) {
    body = (
      <div className="p-4">
        <OkfUsageView data={data} />
      </div>
    );
  } else {
    body = null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="repo-okf-tab">
      <OkfFilterStrip
        repoId={repoId}
        teamId={teamId}
        filters={filters}
        onChange={onChange}
        bundleRoots={data?.bundleRoots ?? NO_BUNDLE_ROOTS}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </div>
  );
}
