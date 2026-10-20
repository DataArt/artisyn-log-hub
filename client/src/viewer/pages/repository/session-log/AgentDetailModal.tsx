import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import type { AgentDefinition } from './types';
import { BYTES_PER_TOKEN, formatBytes, formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';

interface Props {
  agent: AgentDefinition;
  onClose: () => void;
  charsPerToken?: number;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function AgentDetailModal({
  agent,
  onClose,
  charsPerToken = BYTES_PER_TOKEN,
}: Props) {
  const estTokens =
    agent.bytes > 0 ? Math.round(agent.bytes / charsPerToken) : 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {agent.name}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="overview">
          <TabsList className="w-full">
            <TabsTrigger value="overview" className="flex-1">
              Overview
            </TabsTrigger>
            {agent.body && (
              <TabsTrigger value="body" className="flex-1">
                Body
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <div className="rounded border border-border bg-muted/40 p-3 space-y-2">
              <div className="flex gap-3 text-xs">
                <span className="w-24 shrink-0 text-muted-foreground">
                  Source
                </span>
                <span
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-medium border',
                    agent.source === 'project'
                      ? 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-700'
                      : agent.source === 'plugin'
                        ? 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-700'
                        : 'bg-muted text-muted-foreground border-border',
                  )}
                >
                  {agent.source === 'project'
                    ? 'PROJECT'
                    : agent.source === 'plugin'
                      ? 'PLUGIN'
                      : 'BUILT-IN'}
                </span>
              </div>
              {agent.path && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Path
                  </span>
                  <span className="font-mono text-foreground break-all">
                    {agent.path}
                  </span>
                </div>
              )}
              {agent.bytes > 0 && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Size
                  </span>
                  <span className="font-mono text-foreground">
                    {formatBytes(agent.bytes)} · ~{formatCompact(estTokens)} tok
                  </span>
                </div>
              )}
              {agent.lastModified != null && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Modified
                  </span>
                  <span className="font-mono text-foreground">
                    {formatDate(agent.lastModified)}
                  </span>
                </div>
              )}
              {agent.description && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Description
                  </span>
                  <span className="text-foreground">{agent.description}</span>
                </div>
              )}
            </div>
          </TabsContent>

          {agent.body && (
            <TabsContent value="body" className="mt-4">
              <pre className="rounded border border-border bg-muted/40 p-3 text-xs font-mono text-foreground overflow-auto max-h-[60vh] whitespace-pre-wrap break-words leading-relaxed">
                {agent.body}
              </pre>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
