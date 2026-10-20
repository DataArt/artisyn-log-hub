import { useState } from 'react';
import type { UploadQueueEntry, UploadQueueStatus } from '../../../../models';
import { formatBytes } from '../../../lib/format';
import { cn } from '../../../lib/cn';
import { Button } from '../../../ui/button';
import { TableRow, TableCell } from '../../../ui/table';
import { UploadQueueEntryDetailModal } from './UploadQueueEntryDetailModal';

// Mirrors the hook/server's hardcoded chunk size (10MB) — used only to
// approximate "bytes received so far" for the chunk-progress sub-line, since
// the server derives bytesReceived on the fly during saveChunk() but does not
// persist it as a column (see upload-queue.service.ts).
const CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

const STATUS_DOT_CLASSES: Record<UploadQueueStatus, string> = {
  pending: 'bg-gray-400',
  processing: 'bg-blue-600',
  partially_uploaded: 'bg-amber-600',
  failed: 'bg-red-600',
  rejected_foreign_session: 'bg-muted-foreground',
};

const STATUS_TEXT_CLASSES: Record<UploadQueueStatus, string> = {
  pending: 'text-foreground',
  processing: 'text-blue-700 dark:text-blue-400',
  partially_uploaded: 'text-amber-700 dark:text-amber-400 font-semibold',
  failed: 'text-red-600 dark:text-red-400 font-semibold',
  rejected_foreign_session: 'text-muted-foreground',
};

const STATUS_LABEL: Record<UploadQueueStatus, string> = {
  pending: 'pending',
  processing: 'processing…',
  partially_uploaded: 'partially uploaded',
  failed: 'failed',
  rejected_foreign_session: 'Rejected: foreign session',
};

function formatReceivedAt(value: string): string {
  const date = new Date(value);
  if (isNaN(date.getTime())) return value;
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function StatusCell({ status }: { status: UploadQueueStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={cn(
          'inline-block size-2 rounded-full',
          STATUS_DOT_CLASSES[status],
        )}
      />
      <span className={STATUS_TEXT_CLASSES[status]}>
        {STATUS_LABEL[status]}
      </span>
    </span>
  );
}

export function UploadQueueEntryRow({ row }: { row: UploadQueueEntry }) {
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <TableRow
      className={
        row.status === 'failed'
          ? 'bg-red-50 dark:bg-red-950/20 border-l-2 border-red-600'
          : row.status === 'partially_uploaded'
            ? 'bg-amber-50 dark:bg-amber-950/20 border-l-2 border-amber-600'
            : ''
      }
    >
      <TableCell className="whitespace-normal">
        {row.fileName}
        {row.status === 'failed' && row.errorMessage && (
          <div className="mt-0.5 text-[11px] text-red-600 dark:text-red-400">
            {row.errorMessage}
          </div>
        )}
        {row.status === 'partially_uploaded' &&
          row.chunksReceived != null &&
          row.totalChunks != null && (
            <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
              Chunk {row.chunksReceived} of {row.totalChunks} received (
              {formatBytes(
                Math.min(row.chunksReceived * CHUNK_SIZE_BYTES, row.sizeBytes),
              )}{' '}
              / {formatBytes(row.sizeBytes)})
            </div>
          )}
      </TableCell>
      <TableCell>{row.logType}</TableCell>
      <TableCell className="whitespace-nowrap">
        {formatReceivedAt(row.receivedAt)}
      </TableCell>
      <TableCell>{formatBytes(row.sizeBytes)}</TableCell>
      <TableCell>
        <StatusCell status={row.status} />
      </TableCell>
      <TableCell className="text-right">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setDetailsOpen(true)}
        >
          Details
        </Button>
        {detailsOpen && (
          <UploadQueueEntryDetailModal
            entry={row}
            onClose={() => setDetailsOpen(false)}
          />
        )}
      </TableCell>
    </TableRow>
  );
}
