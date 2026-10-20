import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { ImportUploadSummary } from '../../../../models/export-import';
import {
  ApiError,
  confirmImport,
  getImportJobStatus,
  uploadImportZip,
} from '../../../api';
import { Button } from '../../../ui/button';
import { cn } from '../../../lib/cn';
import { formatBytes } from '../../../lib/format';
import { useExportImportJobPoll } from './useExportImportJobPoll';

// ---------------------------------------------------------------------------
// ImportPanel — Import mode of the Import/Export subtab
// ---------------------------------------------------------------------------
// File picker -> uploadImportZip preview summary -> explicit "Import" confirm
// action -> confirmImport background job, progress polled via
// useExportImportJobPoll. On completion, invalidates the repo session-list
// and repo-detail queries so imported sessions (and the header's session
// count) show up without a manual refresh.
// ---------------------------------------------------------------------------

interface ImportPanelProps {
  repoId: number;
  teamId?: number;
  readOnly: boolean;
}

const JOB_STATUS_DOT_CLASSES: Record<string, string> = {
  running: 'bg-blue-600',
  done: 'bg-emerald-600',
  error: 'bg-red-600',
};

export function ImportPanel({ repoId, teamId, readOnly }: ImportPanelProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] =
    useState<ImportUploadSummary | null>(null);

  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const invalidatedJobIdRef = useRef<string | null>(null);

  const jobStatusQuery = useExportImportJobPoll(
    jobId,
    (id) => getImportJobStatus(repoId, id, teamId),
    ['import-job-status', repoId],
  );

  useEffect(() => {
    if (
      jobId &&
      jobStatusQuery.data?.status === 'done' &&
      invalidatedJobIdRef.current !== jobId
    ) {
      invalidatedJobIdRef.current = jobId;
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions', repoId, teamId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions-branch', repoId, teamId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['repo-detail', repoId],
      });
    }
  }, [jobId, jobStatusQuery.data?.status, queryClient, repoId, teamId]);

  function resetUpload() {
    setFileName(null);
    setUploadSummary(null);
    setUploadError(null);
    setConfirmError(null);
    setJobId(null);
    invalidatedJobIdRef.current = null;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    resetUpload();
    setFileName(file.name);
    setIsUploading(true);
    try {
      const summary = await uploadImportZip(repoId, file, teamId);
      setUploadSummary(summary);
    } catch (err) {
      if (err instanceof ApiError && err.statusCode === 422) {
        setUploadError(err.message || 'This zip file could not be imported.');
      } else {
        setUploadError(err instanceof Error ? err.message : 'Upload failed.');
      }
    } finally {
      setIsUploading(false);
    }
  }

  async function handleConfirmImport() {
    if (!uploadSummary) return;
    setConfirmError(null);
    setIsConfirming(true);
    try {
      const { jobId: newJobId } = await confirmImport(
        repoId,
        uploadSummary.uploadToken,
        teamId,
      );
      setJobId(newJobId);
    } catch (err) {
      setConfirmError(
        err instanceof Error ? err.message : 'Failed to start import.',
      );
    } finally {
      setIsConfirming(false);
    }
  }

  const isJobRunning =
    jobId != null &&
    jobStatusQuery.data?.status !== 'done' &&
    jobStatusQuery.data?.status !== 'error';

  return (
    <div>
      <p className="mb-3 text-xs text-muted-foreground">
        Import sessions from a previously exported zip archive into this
        repository.
      </p>

      {readOnly ? (
        <p className="text-xs text-muted-foreground">
          Only the repository owner can import sessions.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => void handleFileChange(e)}
              disabled={isUploading || isJobRunning}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={isUploading || isJobRunning}
              onClick={() => fileInputRef.current?.click()}
            >
              {isUploading && <Loader2 className="size-3.5 animate-spin" />}
              Choose zip file…
            </Button>
            {fileName && (
              <span className="text-xs text-muted-foreground">{fileName}</span>
            )}

            {uploadSummary && !jobId && (
              <Button
                size="sm"
                disabled={isConfirming}
                onClick={() => void handleConfirmImport()}
              >
                {isConfirming && <Loader2 className="size-3.5 animate-spin" />}
                Import
              </Button>
            )}
          </div>

          {uploadError && (
            <p className="mt-2 text-sm text-destructive">{uploadError}</p>
          )}

          {uploadSummary && (
            <div className="mt-3 max-w-md rounded-md border border-border p-3 text-xs">
              <p className="font-medium">
                {uploadSummary.sessionCount} session
                {uploadSummary.sessionCount === 1 ? '' : 's'} · ~
                {formatBytes(uploadSummary.approxUncompressedBytes)}
              </p>
              <p className="mt-1 text-muted-foreground">
                From {uploadSummary.meta.sourceRepoUrl} (
                {uploadSummary.meta.sourceRepoContext.type === 'team'
                  ? (uploadSummary.meta.sourceRepoContext.teamName ?? 'team')
                  : 'personal'}
                ), exported{' '}
                {new Date(uploadSummary.meta.createdAt).toLocaleString()}
              </p>
              {uploadSummary.meta.description && (
                <p className="mt-1 text-muted-foreground">
                  {uploadSummary.meta.description}
                </p>
              )}
            </div>
          )}

          {confirmError && (
            <p className="mt-2 text-sm text-destructive">{confirmError}</p>
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
                <span className="text-muted-foreground">Starting import…</span>
              )}
              {jobStatusQuery.data?.status === 'running' && (
                <span>
                  {jobStatusQuery.data.processed} of {jobStatusQuery.data.total}{' '}
                  sessions imported
                </span>
              )}
              {jobStatusQuery.data?.status === 'done' && (
                <span className="text-emerald-700 dark:text-emerald-400">
                  {jobStatusQuery.data.total} session
                  {jobStatusQuery.data.total === 1 ? '' : 's'} imported.
                </span>
              )}
              {jobStatusQuery.data?.status === 'error' && (
                <span className="text-destructive">
                  {jobStatusQuery.data.errorMessage ?? 'Import failed.'}
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
