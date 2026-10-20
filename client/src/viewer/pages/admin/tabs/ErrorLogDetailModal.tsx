import type { ErrorLogEntry } from '../../../../models/admin';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../../../ui/dialog';
import { Button } from '../../../ui/button';
import { useCopyToClipboard } from '../../../hooks/useCopyToClipboard';
import { formatTimestamp, SourcePill } from './AdminErrorLogsTab';

interface Props {
  entry: ErrorLogEntry;
  onClose: () => void;
}

export function ErrorLogDetailModal({ entry, onClose }: Props) {
  const copyText =
    entry.details !== null
      ? `${entry.message}\n\n${entry.details}`
      : entry.message;
  const { copied, copy } = useCopyToClipboard(copyText);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle>Error Log Detail</DialogTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">
              {formatTimestamp(entry.timestamp)}
            </span>
            <SourcePill source={entry.source} />
          </div>
        </DialogHeader>

        <div className="mt-3 flex-1 min-h-0 overflow-y-auto">
          <pre className="rounded border border-border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all overflow-y-auto">
            {entry.details !== null
              ? `${entry.message}\n\n${entry.details}`
              : entry.message}
          </pre>
        </div>

        <DialogFooter className="sm:justify-between">
          <Button variant="outline" onClick={copy}>
            {copied ? '✓ copied' : 'Copy to clipboard'}
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
