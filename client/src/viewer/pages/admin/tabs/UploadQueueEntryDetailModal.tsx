import { useState } from 'react';
import type { UploadQueueEntry } from '../../../../models';
import { downloadUploadQueueFile } from '../../../api';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatBytes } from '../../../lib/format';
import { Button } from '../../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { formatTimestamp } from './AdminErrorLogsTab';

interface Props {
  entry: UploadQueueEntry;
  onClose: () => void;
}

/**
 * Details for one upload-queue row: full metadata, the processing error and a
 * download of the staged file itself, so an admin can analyze why it failed.
 */
export function UploadQueueEntryDetailModal({ entry, onClose }: Props) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const { copied, copy } = useCopyToClipboard(entry.errorMessage ?? '');

  async function handleDownload() {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadUploadQueueFile(entry.id, entry.fileName);
    } catch (e) {
      setDownloadError(
        e instanceof Error && e.message ? e.message : 'Download failed',
      );
    } finally {
      setDownloading(false);
    }
  }

  const fields: [string, string][] = [
    ['File', entry.fileName],
    ['Status', entry.status],
    ['Type', entry.logType],
    ['Received at', formatTimestamp(entry.receivedAt)],
    ['Size', `${formatBytes(entry.sizeBytes)} (${entry.sizeBytes} bytes)`],
    ['Session', entry.sessionId],
    ['Repository', entry.repoUrl ?? '—'],
  ];
  if (entry.chunksReceived != null && entry.totalChunks != null) {
    fields.push([
      'Chunks',
      `${entry.chunksReceived} of ${entry.totalChunks} received`,
    ]);
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Upload Queue Entry</DialogTitle>
          <DialogDescription>
            Download the staged file to inspect the payload that failed to
            process.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
            {fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="flex flex-col gap-1">
            <span className="text-xs font-semibold">Error</span>
            <pre className="rounded border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {entry.errorMessage ?? 'No error recorded.'}
            </pre>
          </div>

          {downloadError && (
            <p className="text-xs text-destructive">{downloadError}</p>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              disabled={downloading}
              onClick={() => void handleDownload()}
            >
              {downloading ? 'Downloading…' : 'Download file'}
            </Button>
            {entry.errorMessage && (
              <Button variant="outline" onClick={copy}>
                {copied ? '✓ copied' : 'Copy error'}
              </Button>
            )}
          </div>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
