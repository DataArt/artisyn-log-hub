import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import type { ClaudeMdFile } from './types';
import { BYTES_PER_TOKEN, formatBytes, formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';
import {
  getRuleShortName,
  formatDate,
  instructionTypeMeta,
} from './context-panel-helpers';

/** Rule metadata only — the rule text is never shown (FR-5). */
export function RuleDetailModal({
  file,
  onClose,
  charsPerToken = BYTES_PER_TOKEN,
}: {
  file: ClaudeMdFile;
  onClose: () => void;
  charsPerToken?: number;
}) {
  const estTokens = Math.round(file.bytes / charsPerToken);
  const name = getRuleShortName(file.path);
  const typeMeta = instructionTypeMeta(file);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{name}</DialogTitle>
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
            <span className={cn('text-xs', typeMeta.cls)}>
              {typeMeta.label}
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
