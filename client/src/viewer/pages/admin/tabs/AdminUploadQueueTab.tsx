import { Fragment, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { UploadQueueEntry } from '../../../../models';
import {
  clearBrokenUploadQueueEntries,
  fetchAdminUploadQueue,
  reprocessFailedUploadQueueEntries,
} from '../../../api';
import { PageState } from '../../../components/PageState';
import { Button } from '../../../ui/button';
import { ConfirmDialog } from '../../../ui/confirm-dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '../../../ui/table';
import { UploadQueueEntryRow } from './UploadQueueEntryRow';
import { UploadQueueStatsPanel } from './UploadQueueStatsPanel';

interface SessionGroup {
  sessionId: string;
  repoUrl: string | null;
  rows: UploadQueueEntry[];
}

function useUpdatedAgoLabel(dataUpdatedAt: number): string {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!dataUpdatedAt) return '';
  const secondsAgo = Math.max(
    0,
    Math.round((Date.now() - dataUpdatedAt) / 1000),
  );
  return `Updated ${secondsAgo}s ago`;
}

function groupBySession(entries: UploadQueueEntry[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const entry of entries) {
    const existing = groups.get(entry.sessionId);
    if (existing) {
      existing.rows.push(entry);
    } else {
      groups.set(entry.sessionId, {
        sessionId: entry.sessionId,
        repoUrl: entry.repoUrl,
        rows: [entry],
      });
    }
  }
  return Array.from(groups.values());
}

function ClearBrokenFilesButton({ failedCount }: { failedCount: number }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (failedCount === 0) return null;

  async function handleConfirm() {
    setError(null);
    setLoading(true);
    try {
      await clearBrokenUploadQueueEntries();
      setOpen(false);
      await queryClient.invalidateQueries({
        queryKey: ['admin-upload-queue'],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to clear broken files');
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        disabled={loading}
        onClick={() => setOpen(true)}
      >
        {loading ? 'Clearing…' : `Clear broken files (${failedCount})`}
      </Button>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
      <ConfirmDialog
        open={open}
        header="Clear broken files"
        message={`Permanently delete ${failedCount} failed upload(s) and their staged files? This cannot be undone.`}
        confirmLabel={loading ? 'Clearing…' : 'Delete'}
        cancelLabel="Cancel"
        destructive
        requiresTyping="confirm"
        onConfirm={() => void handleConfirm()}
        onCancel={() => {
          if (!loading) setOpen(false);
        }}
      />
    </>
  );
}

function ReprocessFailedButton({ failedCount }: { failedCount: number }) {
  const queryClient = useQueryClient();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (failedCount === 0) return null;

  async function handleClick() {
    setError(null);
    setLoading(true);
    try {
      await reprocessFailedUploadQueueEntries();
      await queryClient.invalidateQueries({
        queryKey: ['admin-upload-queue'],
      });
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Failed to reprocess failed uploads',
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={loading}
        onClick={() => void handleClick()}
      >
        {loading ? 'Reprocessing…' : `Reprocess failed (${failedCount})`}
      </Button>
      {error && <p className="text-xs text-destructive mt-1">{error}</p>}
    </>
  );
}

/**
 * The tab's original content: the header counts line, the toolbar buttons and the grouped
 * entry table. Extracted verbatim from `AdminUploadQueueTab` so the stats panel can render
 * *outside* the list's loading/error branches — an operator needs the worker stats most
 * when the list itself is failing.
 */
function QueueListSection({
  entries,
  updatedAgoLabel,
}: {
  entries: UploadQueueEntry[];
  updatedAgoLabel: string;
}) {
  const groups = groupBySession(entries);
  const pendingCount = entries.filter((e) => e.status === 'pending').length;
  const processingCount = entries.filter(
    (e) => e.status === 'processing',
  ).length;
  const partiallyUploadedCount = entries.filter(
    (e) => e.status === 'partially_uploaded',
  ).length;
  const failedCount = entries.filter((e) => e.status === 'failed').length;
  const rejectedForeignCount = entries.filter(
    (e) => e.status === 'rejected_foreign_session',
  ).length;

  return (
    <>
      {/* Constrained to the table's width so the toolbar buttons stay next to the content
          instead of being pushed a screen-width away on a wide monitor, and so the header's
          right edge lines up with the table's. */}
      <div className="flex max-w-[1000px] items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-block size-2.5 rounded-full bg-emerald-600" />
          <span className="text-xs text-muted-foreground">
            Auto-refreshing every 5s · {groups.length} session
            {groups.length !== 1 ? 's' : ''} · {entries.length} entr
            {entries.length !== 1 ? 'ies' : 'y'} · {pendingCount} pending ·{' '}
            {processingCount} processing ·{' '}
            {partiallyUploadedCount > 0 && (
              <>
                <span className="font-bold text-amber-700 dark:text-amber-400">
                  {partiallyUploadedCount} partially uploaded
                </span>{' '}
                ·{' '}
              </>
            )}
            {failedCount} failed
            {rejectedForeignCount > 0 && (
              <> · {rejectedForeignCount} rejected: foreign session</>
            )}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-muted-foreground/70">
            {updatedAgoLabel}
          </span>
          <ReprocessFailedButton failedCount={failedCount} />
          <ClearBrokenFilesButton failedCount={failedCount} />
        </div>
      </div>

      {entries.length === 0 ? (
        <PageState message="Upload queue is empty." />
      ) : (
        <div className="max-w-[1000px] rounded-md border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Received At</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>Status</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.map((group) => (
                <Fragment key={group.sessionId}>
                  <TableRow className="bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-50 dark:hover:bg-indigo-950/30">
                    <TableCell
                      colSpan={6}
                      className="whitespace-normal text-xs font-semibold text-indigo-900 dark:text-indigo-300"
                    >
                      Session {group.sessionId.slice(0, 8)}…{' '}
                      <span className="font-normal text-indigo-700 dark:text-indigo-400">
                        · {group.repoUrl ?? '—'} · {group.rows.length} entr
                        {group.rows.length !== 1 ? 'ies' : 'y'}
                      </span>
                    </TableCell>
                  </TableRow>
                  {group.rows.map((row) => (
                    <UploadQueueEntryRow key={row.id} row={row} />
                  ))}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export function AdminUploadQueueTab() {
  const { data, isLoading, isError, dataUpdatedAt } = useQuery({
    queryKey: ['admin-upload-queue'],
    queryFn: fetchAdminUploadQueue,
    refetchInterval: 5_000,
  });

  const updatedAgoLabel = useUpdatedAgoLabel(dataUpdatedAt);

  // The container and the stats panel render unconditionally: the panel has its own query,
  // so the two blocks fail (and load) independently in both directions.
  return (
    <div className="flex flex-col gap-3 p-4">
      <UploadQueueStatsPanel />

      {isLoading && <PageState message="Loading…" />}
      {!isLoading && (isError || !data) && (
        <PageState message="Failed to load upload queue." variant="error" />
      )}
      {!isLoading && !isError && data && (
        <QueueListSection entries={data} updatedAgoLabel={updatedAgoLabel} />
      )}
    </div>
  );
}
