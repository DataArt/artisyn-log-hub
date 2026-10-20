import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '../../../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs';
import type { SkillDefinition } from './types';
import { BYTES_PER_TOKEN, formatBytes, formatCompact } from './log-parser';
import { cn } from '../../../lib/cn';

interface Props {
  skill: SkillDefinition;
  onClose: () => void;
  charsPerToken?: number;
}

export function SkillDetailModal({
  skill,
  onClose,
  charsPerToken = BYTES_PER_TOKEN,
}: Props) {
  const estTokens =
    skill.bytes > 0 ? Math.round(skill.bytes / charsPerToken) : 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl" data-testid="skill-detail-modal">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {skill.name}
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="overview">
          <TabsList className="w-full">
            <TabsTrigger value="overview" className="flex-1">
              Overview
            </TabsTrigger>
            {skill.body && (
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
                    skill.source === 'project'
                      ? 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:border-sky-700'
                      : skill.source === 'plugin'
                        ? 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:border-violet-700'
                        : 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-700',
                  )}
                >
                  {skill.source === 'project'
                    ? 'PROJECT'
                    : skill.source === 'plugin'
                      ? 'PLUGIN'
                      : 'USER'}
                </span>
              </div>
              {skill.source === 'plugin' && skill.plugin && (
                <div
                  className="flex gap-3 text-xs"
                  data-testid="skill-detail-plugin"
                >
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Plugin
                  </span>
                  <span className="font-mono text-foreground">
                    {skill.plugin.id} · v{skill.plugin.version}
                    {skill.plugin.gitCommitSha
                      ? ` · ${skill.plugin.gitCommitSha.slice(0, 7)}`
                      : ''}
                  </span>
                </div>
              )}
              {skill.path && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Path
                  </span>
                  <span className="font-mono text-foreground break-all">
                    {skill.path}
                  </span>
                </div>
              )}
              {skill.bytes > 0 && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Size
                  </span>
                  <span className="font-mono text-foreground">
                    {formatBytes(skill.bytes)} · ~{formatCompact(estTokens)} tok
                  </span>
                </div>
              )}
              {skill.argumentHint && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Argument
                  </span>
                  <span className="font-mono text-foreground">
                    {skill.argumentHint}
                  </span>
                </div>
              )}
              {skill.description && (
                <div className="flex gap-3 text-xs">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    Description
                  </span>
                  <span className="text-foreground">{skill.description}</span>
                </div>
              )}
            </div>
          </TabsContent>

          {skill.body && (
            <TabsContent value="body" className="mt-4">
              <pre className="rounded border border-border bg-muted/40 p-3 text-xs font-mono text-foreground overflow-auto max-h-[60vh] whitespace-pre-wrap break-words leading-relaxed">
                {skill.body}
              </pre>
            </TabsContent>
          )}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
