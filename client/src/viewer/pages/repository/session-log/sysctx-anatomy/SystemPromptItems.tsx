/**
 * Building blocks of the System prompt modal: one expandable item row, a Markdown body and a
 * JSON block. A row mounts its body only while expanded, so a large tool set is never rendered
 * at once (DD 13). Markdown is rendered without `rehype-raw`, so raw HTML in a prompt part or a
 * tool description stays text (DD 14).
 */
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';

export type PromptItemSection =
  | 'shared'
  | 'session'
  | 'ungrouped'
  | 'tool'
  | 'flag';

const remarkPlugins = [remarkGfm];

export interface PromptItemRowProps {
  title: ReactNode;
  /** Right-hand side: sizes, or a scalar flag's value. */
  meta?: ReactNode;
  section: PromptItemSection;
  /** False for a scalar flag: no chevron, no `data-expanded`, no body. */
  expandable: boolean;
  expanded: boolean;
  onToggle?: () => void;
  children?: ReactNode;
}

export function PromptItemRow({
  title,
  meta,
  section,
  expandable,
  expanded,
  onToggle,
  children,
}: PromptItemRowProps) {
  const open = expandable && expanded;
  const head = (
    <>
      {expandable && (
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90',
          )}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {meta !== undefined && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {meta}
        </span>
      )}
    </>
  );
  return (
    <div
      data-testid="sysprompt-item"
      data-section={section}
      data-expanded={expandable ? String(open) : undefined}
      className={cn(
        'rounded-md border',
        open ? 'border-indigo-300' : 'border-border',
      )}
    >
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted/60',
            open && 'rounded-b-none bg-indigo-50 hover:bg-indigo-50',
          )}
        >
          {head}
        </button>
      ) : (
        <div className="flex w-full items-center gap-2 px-3 py-1.5 text-sm">
          {head}
        </div>
      )}
      {open && (
        <div className="border-t p-3" data-testid="sysprompt-item-body">
          {children}
        </div>
      )}
    </div>
  );
}

export function MarkdownBody({ text }: { text: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words">
      <ReactMarkdown remarkPlugins={remarkPlugins}>{text}</ReactMarkdown>
    </div>
  );
}

export function JsonBlock({ json }: { json: string }) {
  return (
    <div className="relative">
      <span className="absolute right-2 top-2 rounded border bg-background px-1 text-[10px] font-mono text-muted-foreground">
        json
      </span>
      <pre className="overflow-auto rounded bg-muted p-3 font-mono text-xs">
        {json}
      </pre>
    </div>
  );
}

/** Sub-label inside a tool body (`DESCRIPTION`, `INPUT SCHEMA`). */
export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
