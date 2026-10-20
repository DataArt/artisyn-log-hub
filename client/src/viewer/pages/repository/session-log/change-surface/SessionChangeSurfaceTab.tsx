/**
 * The session view's "Change surface" tab.
 *
 * Issues both session-scoped queries: the aggregate — the same payload
 * the Summary tile and the three CS detectors read — and the per-path rows, which are fetched
 * only because this tab was opened. Nothing on this tab is recomputed client-side; the tree is
 * the one derived structure, and it derives shape, not metrics.
 *
 * Three empty states, deliberately distinct:
 * - `computed: false` — never recomputed, or no repo root was ever learned → "No change-surface
 *   data". Never a `0`, which would read as "this session changed nothing".
 * - zero changed files with `computed: true` — a real no-change session → "No file changes
 *   recorded for this session".
 * - loading — skeleton rows, never a zeroed tree.
 */
import { useQuery } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';
import { Skeleton } from '@/ui/skeleton';
import {
  fetchSessionChangeSurface,
  fetchSessionChangeSurfaceFiles,
} from '../../../../api';
import { getSessionLogsErrorMessage } from '../session-logs-error';
import { ChangeSurfaceBreakdowns } from './ChangeSurfaceBreakdowns';
import { ChangeSurfaceFileTree } from './ChangeSurfaceFileTree';
import { ChangeSurfaceFolderTable } from './ChangeSurfaceFolderTable';
import { ChangeSurfaceHeadline } from './ChangeSurfaceHeadline';
import { ChangeSurfaceSpreadCards } from './ChangeSurfaceSpreadCards';

export interface SessionChangeSurfaceTabProps {
  repoId: number;
  sessionId: string;
  teamId?: number;
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-4" data-testid="change-surface-loading">
      <Skeleton className="h-24 w-full" />
      <div className="flex gap-3">
        <Skeleton className="h-20 flex-1" />
        <Skeleton className="h-20 flex-1" />
        <Skeleton className="h-20 flex-1" />
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      className="p-8 text-center text-sm text-muted-foreground"
      data-testid="change-surface-empty"
    >
      <div className="font-medium text-foreground">{title}</div>
      <div className="mt-1">{body}</div>
    </div>
  );
}

export function SessionChangeSurfaceTab({
  repoId,
  sessionId,
  teamId,
}: SessionChangeSurfaceTabProps) {
  const [filter, setFilter] = useState('');
  const treeRef = useRef<HTMLDivElement | null>(null);

  const aggregateQuery = useQuery({
    queryKey: ['session-change-surface', repoId, sessionId, teamId],
    queryFn: () => fetchSessionChangeSurface(repoId, sessionId, teamId),
  });

  const filesQuery = useQuery({
    queryKey: ['session-change-surface-files', repoId, sessionId, teamId],
    queryFn: () => fetchSessionChangeSurfaceFiles(repoId, sessionId, teamId),
    // The aggregate decides whether there is anything to show at all; the rows are pointless
    // (and the endpoint is a wasted round-trip) for a never-recomputed session.
    enabled: aggregateQuery.data?.computed === true,
  });

  const onFolderSelect = useCallback((folder: string) => {
    // `.` is the repo root — every path is "under" it, so the useful action is to clear the
    // filter rather than to search for a literal dot.
    setFilter(folder === '.' ? '' : folder);
    treeRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  if (aggregateQuery.isLoading) return <LoadingSkeleton />;

  if (aggregateQuery.error) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        {getSessionLogsErrorMessage(aggregateQuery.error)}
      </div>
    );
  }

  const data = aggregateQuery.data;
  if (!data) {
    return (
      <EmptyState title="Error" body="Change surface could not be loaded." />
    );
  }

  if (!data.computed) {
    return (
      <EmptyState
        title="No change-surface data"
        body={
          data.repoRootKnown
            ? 'This session has not been analysed yet. It is computed when the session is uploaded or the repository is recomputed.'
            : 'No repository root is known for this session, so no changed path could be placed inside the repository.'
        }
      />
    );
  }

  if (data.changedFiles === 0 && data.outsideRepoFiles === 0) {
    return (
      <EmptyState
        title="No file changes recorded for this session"
        body="No Edit or Write call in this session tree touched a file."
      />
    );
  }

  return (
    <div className="space-y-3 p-4" data-testid="change-surface-tab">
      <ChangeSurfaceHeadline data={data} />
      <ChangeSurfaceSpreadCards data={data} />
      <ChangeSurfaceBreakdowns data={data} />
      <ChangeSurfaceFolderTable
        folders={data.folderDistribution}
        onFolderSelect={onFolderSelect}
      />
      <div ref={treeRef}>
        {filesQuery.isLoading ? (
          <div className="space-y-1.5 rounded-md border border-border bg-card p-3">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : filesQuery.error ? (
          <div className="rounded-md border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            {getSessionLogsErrorMessage(filesQuery.error)}
          </div>
        ) : (
          <ChangeSurfaceFileTree
            rows={filesQuery.data?.files ?? []}
            total={filesQuery.data?.total ?? 0}
            truncated={filesQuery.data?.truncated ?? false}
            filter={filter}
            onFilterChange={setFilter}
          />
        )}
      </div>
    </div>
  );
}
