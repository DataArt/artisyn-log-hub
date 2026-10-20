import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import type { ClaudeMdFile } from './types';
import { BYTES_PER_TOKEN, formatBytes, formatCompact } from './log-parser';
import { getRuleShortName, formatDate } from './context-panel-helpers';

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
  const hasContent = !!file.content;

  const overviewContent = (
    <div className="rounded border border-border bg-muted/40 p-3 space-y-2">
      <div className="flex gap-3 text-xs">
        <span className="w-24 shrink-0 text-muted-foreground">Path</span>
        <span className="font-mono text-foreground break-all">{file.path}</span>
      </div>
      <div className="flex gap-3 text-xs">
        <span className="w-24 shrink-0 text-muted-foreground">Size</span>
        <span className="font-mono text-foreground">
          {formatBytes(file.bytes)} · ~{formatCompact(estTokens)} tok
        </span>
      </div>
      {file.lastModified != null && (
        <div className="flex gap-3 text-xs">
          <span className="w-24 shrink-0 text-muted-foreground">Modified</span>
          <span className="font-mono text-foreground">
            {formatDate(file.lastModified)}
          </span>
        </div>
      )}
    </div>
  );

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">{name}</DialogTitle>
        </DialogHeader>
        {hasContent ? (
          <Tabs defaultValue="overview">
            <TabsList className="w-full">
              <TabsTrigger value="overview" className="flex-1">
                Overview
              </TabsTrigger>
              <TabsTrigger value="body" className="flex-1">
                Body
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="mt-4">
              {overviewContent}
            </TabsContent>
            <TabsContent value="body" className="mt-4">
              <pre className="rounded border border-border bg-muted/40 p-3 text-xs font-mono text-foreground overflow-auto max-h-[60vh] whitespace-pre-wrap break-words leading-relaxed">
                {file.content}
              </pre>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-3">
            {overviewContent}
            <p className="text-[10px] text-muted-foreground">
              Rule file content is not captured in session telemetry.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
