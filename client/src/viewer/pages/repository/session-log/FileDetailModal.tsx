import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import type { ClaudeMdFile } from './types';
import { BYTES_PER_TOKEN, formatBytes, formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';
import { formatDate } from './context-panel-helpers';

export function FileDetailModal({
  file,
  onClose,
  charsPerToken = BYTES_PER_TOKEN,
}: {
  file: ClaudeMdFile;
  onClose: () => void;
  charsPerToken?: number;
}) {
  const estTokens = Math.round(file.bytes / charsPerToken);
  const roleMeta =
    file.role === 'local-md'
      ? {
          label: 'local',
          cls: 'text-orange-600 dark:text-orange-400',
        }
      : {
          label: 'project',
          cls: 'text-emerald-600 dark:text-emerald-400',
        };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {file.path.replace(/\\/g, '/').split('/').pop()}
          </DialogTitle>
        </DialogHeader>
        <div className="rounded border border-border bg-muted/40 p-3 space-y-2">
          <div className="flex gap-3 text-xs">
            <span className="w-24 shrink-0 text-muted-foreground">Path</span>
            <span className="font-mono text-foreground break-all">
              {file.path}
            </span>
          </div>
          <div className="flex gap-3 text-xs">
            <span className="w-24 shrink-0 text-muted-foreground">Type</span>
            <span className={cn('text-xs', roleMeta.cls)}>
              {roleMeta.label}
            </span>
          </div>
          <div className="flex gap-3 text-xs">
            <span className="w-24 shrink-0 text-muted-foreground">Size</span>
            <span className="font-mono text-foreground">
              {formatBytes(file.bytes)} · ~{formatCompact(estTokens)} tok
            </span>
          </div>
          {file.lastModified != null && (
            <div className="flex gap-3 text-xs">
              <span className="w-24 shrink-0 text-muted-foreground">
                Modified
              </span>
              <span className="font-mono text-foreground">
                {formatDate(file.lastModified)}
              </span>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
