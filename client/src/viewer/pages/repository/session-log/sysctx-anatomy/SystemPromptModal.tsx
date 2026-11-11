/**
 * The on-demand "System prompt" modal of the System context anatomy tab. It is mounted only
 * while open, parses the transcript's `prompt_snapshot` attachments in its own memo
 * (`buildSystemPromptView`, docs/knowledgebase/algorithms/system-prompt-view.md) and shows the
 * masked prompt parts, tool definitions and flags in three tabs. Copy and Download export the
 * same view as Markdown. Tab and expand state stay local: they belong to this transient modal,
 * not to the page URL (DD 11).
 */
import { useMemo, useState } from 'react';
import { Check, Copy, Download } from 'lucide-react';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/ui/tabs';
import { downloadTextFile } from '@/lib/download-text-file';
import { useCopyToClipboard } from '../../../../hooks/useCopyToClipboard';
import { fmtInt } from './AnatomyCells';
import {
  FlagsSection,
  PromptSection,
  ToolsSection,
} from './SystemPromptSections';
import {
  buildSystemPromptView,
  exportFileName,
  systemPromptViewToMarkdown,
  type SystemPromptView,
} from './system-prompt-view';

export interface SystemPromptModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  main: Record<string, unknown>[];
  /** Absolute repository root, used only to mask paths; empty when unknown. */
  repoRoot: string;
  /** Bytes per token (the anatomy's `cpt`). */
  cpt: number;
  /** The anatomy's exact first-request total, `null` when unknown. */
  firstRequestTotal: number | null;
}

/**
 * The header line: how the modal's two figures sit inside the first request. They equal the
 * anatomy's rows (System prompt + Memory index, Tool definitions); the rest is everything else the
 * anatomy table lists (instruction files, skills listing, …) plus Harness internals.
 */
function totalsLine(view: SystemPromptView, total: number | null): string {
  const prompt = `System prompt ≈ ${fmtInt(view.prompt.tokens)} (${fmtInt(view.totals.parts)} parts)`;
  const tools = `Tool definitions ≈ ${fmtInt(view.tools.tokens)} (${fmtInt(view.totals.tools)} tools)`;
  const rest = total === null ? null : total - view.totals.tokens;
  if (total === null || rest === null || rest < 0) {
    return `${prompt} + ${tools} = ≈ ${fmtInt(view.totals.tokens)} tokens`;
  }
  return `First request ${fmtInt(total)} tokens (exact) = ${prompt} + ${tools} + ≈ ${fmtInt(rest)} everything else (opening messages — see the anatomy table)`;
}

type PromptTab = 'prompt' | 'tools' | 'flags';

function isPromptTab(v: string): v is PromptTab {
  return v === 'prompt' || v === 'tools' || v === 'flags';
}

const PANEL_CLASS = 'mt-2 min-h-0 flex-1 overflow-auto pr-1';

export function SystemPromptModal({
  open,
  onOpenChange,
  main,
  repoRoot,
  cpt,
  firstRequestTotal,
}: SystemPromptModalProps) {
  const view = useMemo(
    () => buildSystemPromptView({ main, repoRoot, cpt }),
    [main, repoRoot, cpt],
  );
  const markdown = useMemo(() => systemPromptViewToMarkdown(view), [view]);
  const { copied, copy } = useCopyToClipboard(markdown);

  const [tab, setTab] = useState<PromptTab>('prompt');
  const [promptExpanded, setPromptExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  const [toolsExpanded, setToolsExpanded] = useState<Set<string>>(
    () => new Set(),
  );
  const [flagsExpanded, setFlagsExpanded] = useState<Set<string>>(
    () => new Set(),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[85vh] w-[90vw] max-w-[1100px] flex-col overflow-hidden"
        data-testid="sysprompt-modal"
      >
        <DialogHeader className="shrink-0 space-y-1">
          <DialogTitle className="text-base">System prompt</DialogTitle>
          <DialogDescription className="text-xs">
            Captured by Claude Code (prompt_snapshot). Internal, undocumented
            format — may change in any release.
          </DialogDescription>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <span
              className="text-sm tabular-nums"
              data-testid="sysprompt-totals"
            >
              {totalsLine(view, firstRequestTotal)}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={copy}
              data-testid="sysprompt-copy"
            >
              {copied ? <Check /> : <Copy />}
              {copied ? 'Copied' : 'Copy as Markdown'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => downloadTextFile(exportFileName(main), markdown)}
              data-testid="sysprompt-download"
            >
              <Download />
              Download .md
            </Button>
          </div>
        </DialogHeader>
        {view.error !== null ? (
          <div
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            data-testid="sysprompt-error"
          >
            {view.error}
          </div>
        ) : (
          <Tabs
            value={tab}
            onValueChange={(v) => {
              if (isPromptTab(v)) setTab(v);
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsList className="shrink-0 self-start">
              <TabsTrigger value="prompt" data-testid="sysprompt-tab-prompt">
                System prompt
              </TabsTrigger>
              <TabsTrigger value="tools" data-testid="sysprompt-tab-tools">
                Tool definitions
              </TabsTrigger>
              <TabsTrigger value="flags" data-testid="sysprompt-tab-flags">
                Flags
              </TabsTrigger>
            </TabsList>
            <TabsContent
              value="prompt"
              className={PANEL_CLASS}
              data-testid="sysprompt-panel-prompt"
            >
              <PromptSection
                prompt={view.prompt}
                expanded={promptExpanded}
                setExpanded={setPromptExpanded}
              />
            </TabsContent>
            <TabsContent
              value="tools"
              className={PANEL_CLASS}
              data-testid="sysprompt-panel-tools"
            >
              <ToolsSection
                tools={view.tools}
                expanded={toolsExpanded}
                setExpanded={setToolsExpanded}
              />
            </TabsContent>
            <TabsContent
              value="flags"
              className={PANEL_CLASS}
              data-testid="sysprompt-panel-flags"
            >
              <FlagsSection
                flags={view.flags}
                expanded={flagsExpanded}
                setExpanded={setFlagsExpanded}
              />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
