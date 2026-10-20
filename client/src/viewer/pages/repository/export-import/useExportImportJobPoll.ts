import { useQuery } from '@tanstack/react-query';
import type { ExportImportJobStatus } from '../../../../models/export-import';

/** Same polling cadence as `AdminUploadQueueTab.tsx:204-208`. */
const POLL_INTERVAL_MS = 5_000;

/**
 * Polls a `GET .../:jobId/status` endpoint (export or import — both share the
 * same `{ status, processed, total, errorMessage? }` shape) on a fixed 5s
 * timer, stopping once the job leaves `'running'` (`'done'`/`'error'` are
 * terminal — no further polling needed). `queryKey` distinguishes the export
 * poll from the import poll (and from other jobIds) in the query cache.
 */
export function useExportImportJobPoll(
  jobId: string | null,
  fetchStatus: (jobId: string) => Promise<ExportImportJobStatus>,
  queryKey: readonly unknown[],
) {
  return useQuery({
    queryKey: [...queryKey, jobId],
    queryFn: () => fetchStatus(jobId as string),
    enabled: jobId != null,
    refetchInterval: (query) =>
      query.state.data && query.state.data.status !== 'running'
        ? false
        : POLL_INTERVAL_MS,
  });
}
