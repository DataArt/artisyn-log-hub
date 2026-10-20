import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { ImportUploadSummary } from '../../models/export-import';
import {
  ApiError,
  confirmBootstrapImport,
  getBootstrapImportJobStatus,
  uploadBootstrapImportZip,
} from '../api';
import { routes } from '../hooks/useHashRoute';
import { useExportImportJobPoll } from '../pages/repository/export-import/useExportImportJobPoll';
import { formatBytes } from '../lib/format';
import { Button } from '../ui/button';
import { cn } from '../lib/cn';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

// ---------------------------------------------------------------------------
// ImportRepoSessionsDialog — "Import repo sessions" sidebar action. Unlike
// export-import/ImportPanel.tsx (which imports into an already-selected
// repo), this has no target repoId up front: it uploads straight to the
// bootstrap-import endpoints, which resolve/create a personal repo named
// after the export's own meta.sourceRepoUrl — so sessions can be imported
// onto an empty server with no repos yet.
// ---------------------------------------------------------------------------

interface ImportRepoSessionsDialogProps {
  open: boolean;
  onClose: () => void;
}

const JOB_STATUS_DOT_CLASSES: Record<string, string> = {
  running: 'bg-blue-600',
  done: 'bg-emerald-600',
  error: 'bg-red-600',
};

export function ImportRepoSessionsDialog({
  open,
  onClose,
}: ImportRepoSessionsDialogProps) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] =
    useState<ImportUploadSummary | null>(null);

  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [targetRepoId, setTargetRepoId] = useState<number | null>(null);
  const [targetTeamId, setTargetTeamId] = useState<number | null>(null);
  const navigatedRef = useRef(false);

  const jobStatusQuery = useExportImportJobPoll(
    jobId,
    getBootstrapImportJobStatus,
    ['bootstrap-import-job-status'],
  );

  function resetAll() {
    setFileName(null);
    setUploadSummary(null);
    setUploadError(null);
    setConfirmError(null);
    setJobId(null);
    setTargetRepoId(null);
    setTargetTeamId(null);
    navigatedRef.current = false;
  }

  function handleClose() {
    resetAll();
    onClose();
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    resetAll();
    setFileName(file.name);
    setIsUploading(true);
    try {
      const summary = await uploadBootstrapImportZip(file);
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
      const {
        jobId: newJobId,
        repoId,
        teamId,
      } = await confirmBootstrapImport(uploadSummary.uploadToken);
      setJobId(newJobId);
      setTargetRepoId(repoId);
      setTargetTeamId(teamId);
    } catch (err) {
      setConfirmError(
        err instanceof Error ? err.message : 'Failed to start import.',
      );
    } finally {
      setIsConfirming(false);
    }
  }

  useEffect(() => {
    if (
      jobId &&
      targetRepoId != null &&
      jobStatusQuery.data?.status === 'done' &&
      !navigatedRef.current
    ) {
      navigatedRef.current = true;
      void queryClient.invalidateQueries({ queryKey: ['my-repos'] });
      void queryClient.invalidateQueries({ queryKey: ['teams'] });
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions', targetRepoId],
      });
      void queryClient.invalidateQueries({
        queryKey: ['repo-sessions-branch', targetRepoId],
      });
      const destinationTeamId = targetTeamId;
      setFileName(null);
      setUploadSummary(null);
      setJobId(null);
      setTargetRepoId(null);
      setTargetTeamId(null);
      onClose();
      void navigate(
        destinationTeamId != null
          ? routes.teamRepo(destinationTeamId, targetRepoId)
          : routes.repo(targetRepoId),
      );
    }
  }, [
    jobId,
    targetRepoId,
    targetTeamId,
    jobStatusQuery.data?.status,
    queryClient,
    onClose,
    navigate,
  ]);

  const isJobRunning =
    jobId != null &&
    jobStatusQuery.data?.status !== 'done' &&
    jobStatusQuery.data?.status !== 'error';

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) handleClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import repo sessions</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Upload a zip previously exported from a repo&apos;s Import/Export
          settings. A personal repo named after the original repo is created
          automatically if one doesn&apos;t already exist.
        </p>

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
        </div>

        {uploadError && (
          <p className="text-sm text-destructive">{uploadError}</p>
        )}

        {uploadSummary && (
          <div className="rounded-md border border-border p-3 text-xs">
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
          </div>
        )}

        {confirmError && (
          <p className="text-sm text-destructive">{confirmError}</p>
        )}

        {jobId && (
          <div className="flex items-center gap-2 text-sm">
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
            {jobStatusQuery.data?.status === 'error' && (
              <span className="text-destructive">
                {jobStatusQuery.data.errorMessage ?? 'Import failed.'}
              </span>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          {uploadSummary && !jobId && (
            <Button
              disabled={isConfirming}
              onClick={() => void handleConfirmImport()}
            >
              {isConfirming && <Loader2 className="size-3.5 animate-spin" />}
              Import
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
