import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import type { ExportImportScope } from '../../../../models/export-import';
import type { RepositorySession } from '../../../../models/repositories';
import {
  downloadExportZip,
  fetchRepositorySessions,
  getExportJobStatus,
  getExportScopeSummary,
  startExport,
} from '../../../api';
import { Button } from '../../../ui/button';
import { cn } from '../../../lib/cn';
import { formatBytes } from '../../../lib/format';
import { DateRangePicker } from '../analytics/DateRangePicker';
import { ExportScopePicker } from './ExportScopePicker';
import { useExportImportJobPoll } from './useExportImportJobPoll';

// ---------------------------------------------------------------------------
// ExportPanel — Export mode of the Import/Export subtab
// ---------------------------------------------------------------------------
// Scope picker (all / date range / checkbox-selected sessions) with a live
// count + approximate size preview, "Start export" -> background job polling,
// and an automatic download once the job reports `status === 'done'`.
// ---------------------------------------------------------------------------

interface ExportPanelProps {
  repoId: number;
  teamId?: number;
  readOnly: boolean;
}

const JOB_STATUS_DOT_CLASSES: Record<string, string> = {
  running: 'bg-blue-600',
  done: 'bg-emerald-600',
  error: 'bg-red-600',
};

function localDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ExportPanel({ repoId, teamId, readOnly }: ExportPanelProps) {
  const [scope, setScope] = useState<ExportImportScope>('all');
  const [customFrom, setCustomFrom] = useState<string | undefined>();
  const [customTo, setCustomTo] = useState<string | undefined>();
  const [customPickerOpen, setCustomPickerOpen] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    new Set(),
  );

  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const downloadedJobIdRef = useRef<string | null>(null);

  const calendarRange: DateRange | undefined =
    customFrom && customTo
      ? { from: new Date(customFrom), to: new Date(customTo) }
      : undefined;

  function handleCustomApply(r: { from: Date; to: Date }) {
    setCustomFrom(localDateString(r.from));
    setCustomTo(localDateString(r.to));
  }

  const sessionsQuery = useQuery({
    queryKey: ['repo-sessions-for-export', repoId, teamId ?? null],
    queryFn: () => fetchRepositorySessions(repoId, teamId),
    enabled: scope === 'sessionIds' && !readOnly,
  });

  function toggleSession(sessionId: string) {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }

  function toggleSelectAll(all: RepositorySession[], checked: boolean) {
    setSelectedSessionIds(
      checked ? new Set(all.map((s) => s.sessionId)) : new Set(),
    );
  }

  const scopeFilters = useMemo(() => {
    if (scope === 'dateRange' && customFrom && customTo) {
      return {
        from: new Date(`${customFrom}T00:00:00`).toISOString(),
        to: new Date(`${customTo}T23:59:59`).toISOString(),
      };
    }
    if (scope === 'sessionIds') {
      return { sessionIds: Array.from(selectedSessionIds) };
    }
    return {};
  }, [scope, customFrom, customTo, selectedSessionIds]);

  const hasValidScope =
    scope === 'all' ||
    (scope === 'dateRange' && !!customFrom && !!customTo) ||
    (scope === 'sessionIds' && selectedSessionIds.size > 0);

  const summaryQuery = useQuery({
    queryKey: [
      'export-scope-summary',
      repoId,
      teamId ?? null,
      scope,
      scopeFilters,
    ],
    queryFn: () => getExportScopeSummary(repoId, teamId, scope, scopeFilters),
    enabled: hasValidScope && !readOnly,
  });

  const jobStatusQuery = useExportImportJobPoll(
    jobId,
    (id) => getExportJobStatus(repoId, id, teamId),
    ['export-job-status', repoId],
  );

  useEffect(() => {
    if (
      jobId &&
      jobStatusQuery.data?.status === 'done' &&
      downloadedJobIdRef.current !== jobId
    ) {
      downloadedJobIdRef.current = jobId;
      void downloadExportZip(repoId, jobId, teamId).catch((e) => {
        setStartError(e instanceof Error ? e.message : 'Download failed');
      });
    }
  }, [jobId, jobStatusQuery.data?.status, repoId, teamId]);

  async function handleStartExport() {
    setStartError(null);
    setIsStarting(true);
    downloadedJobIdRef.current = null;
    try {
      const { jobId: newJobId } = await startExport(repoId, {
        teamId,
        scope,
        ...scopeFilters,
      });
      setJobId(newJobId);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : 'Failed to start export');
    } finally {
      setIsStarting(false);
    }
  }

  const isJobRunning =
    jobId != null &&
    jobStatusQuery.data?.status !== 'done' &&
    jobStatusQuery.data?.status !== 'error';
  const summaryReady = summaryQuery.data != null;
  const startDisabled =
    readOnly ||
    !hasValidScope ||
    !summaryReady ||
    summaryQuery.data?.sessionCount === 0 ||
    isStarting ||
    isJobRunning;

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Export this repository&apos;s sessions (all, a date range, or a specific
        selection) as a downloadable zip archive.
      </p>

      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Only the repository owner can start an export.
        </p>
      ) : (
        <>
          <ExportScopePicker
            scope={scope}
            onScopeChange={setScope}
            customFrom={customFrom}
            customTo={customTo}
            onOpenCustomPicker={() => setCustomPickerOpen(true)}
            sessions={sessionsQuery.data}
            sessionsLoading={sessionsQuery.isLoading}
            sessionsError={sessionsQuery.isError}
            selectedSessionIds={selectedSessionIds}
            onToggleSession={toggleSession}
            onToggleSelectAll={toggleSelectAll}
          >
            <Button
              size="sm"
              disabled={startDisabled}
              onClick={() => void handleStartExport()}
            >
              {isStarting && <Loader2 className="size-3.5 animate-spin" />}
              Start export
            </Button>
          </ExportScopePicker>

          {hasValidScope && (
            <p className="mt-2 text-xs text-muted-foreground">
              {summaryQuery.isFetching && !summaryQuery.data
                ? 'Calculating preview…'
                : summaryQuery.isError
                  ? 'Failed to load preview.'
                  : summaryQuery.data
                    ? `${summaryQuery.data.sessionCount} session${
                        summaryQuery.data.sessionCount === 1 ? '' : 's'
                      } · ~${formatBytes(summaryQuery.data.approxUncompressedBytes)}`
                    : null}
            </p>
          )}

          {startError && (
            <p className="mt-2 text-sm text-destructive">{startError}</p>
          )}

          {jobId && (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <span
                className={cn(
                  'inline-block size-2 rounded-full',
                  jobStatusQuery.data
                    ? JOB_STATUS_DOT_CLASSES[jobStatusQuery.data.status]
                    : 'bg-gray-400',
                )}
              />
              {!jobStatusQuery.data && (
                <span className="text-muted-foreground">Starting export…</span>
              )}
              {jobStatusQuery.data?.status === 'running' && (
                <span>
                  {jobStatusQuery.data.processed} of {jobStatusQuery.data.total}{' '}
                  sessions packaged
                </span>
              )}
              {jobStatusQuery.data?.status === 'done' && (
                <span className="text-emerald-700 dark:text-emerald-400">
                  Export ready — download started.
                </span>
              )}
              {jobStatusQuery.data?.status === 'error' && (
                <span className="text-destructive">
                  {jobStatusQuery.data.errorMessage ?? 'Export failed.'}
                </span>
              )}
            </div>
          )}

          <DateRangePicker
            open={customPickerOpen}
            onOpenChange={setCustomPickerOpen}
            selected={calendarRange}
            onApply={handleCustomApply}
          />
        </>
      )}
    </div>
  );
}
