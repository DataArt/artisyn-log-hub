/**
 * One row of the All views tree: chevron, icon, highlighted label, synonym chip, tab-bar
 * decorations, the child count of a collapsed container and the "What it answers" text (a column
 * at `md+`, the row tooltip below it).
 */
import type { KeyboardEvent, ReactNode } from 'react';
import {
  BookOpen,
  ChartColumn,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FileText,
  FolderGit2,
  Layers,
  Lock,
  MessageSquare,
  PanelTop,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import { highlightRanges, leafCount, type MapTreeRow } from './map-tree-model';
import type { NavNode } from './nav-tree';

const ICONS: Record<NavNode['icon'], typeof Users> = {
  team: Users,
  repo: FolderGit2,
  session: MessageSquare,
  group: Layers,
  tab: PanelTop,
  report: FileText,
  view: ChartColumn,
  help: BookOpen,
  question: CircleHelp,
};

const NEEDS_LABEL: Record<NonNullable<NavNode['needs']>, string> = {
  team: 'choose a team ▸',
  repo: 'choose a repository ▸',
  session: 'choose a session ▸',
};

export function HighlightedText({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  const ranges = highlightRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let pos = 0;
  for (const [start, end] of ranges) {
    if (start > pos) parts.push(text.slice(pos, start));
    parts.push(
      <mark
        key={start}
        className="rounded-sm bg-amber-200/70 text-foreground dark:bg-amber-500/40"
      >
        {text.slice(start, end)}
      </mark>,
    );
    pos = end;
  }
  if (pos < text.length) parts.push(text.slice(pos));
  return <>{parts}</>;
}

export interface MapTreeRowProps {
  row: MapTreeRow;
  expanded: boolean;
  focused: boolean;
  query: string;
  /** A filter is active and this leaf does not match it. */
  dimmed: boolean;
  /** The synonym that matched when the label did not. */
  synonym?: string;
  /** The description is a column (`md+`) rather than a tooltip. */
  wide: boolean;
  setRef: (el: HTMLDivElement | null) => void;
  onFocus: () => void;
  onClick: () => void;
  /** Opens the picker for the context a greyed (`needs`) node is missing. */
  onChoose: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
}

export function MapTreeRowView({
  row,
  expanded,
  focused,
  query,
  dimmed,
  synonym,
  wide,
  setRef,
  onFocus,
  onClick,
  onChoose,
  onKeyDown,
}: MapTreeRowProps) {
  const { node, depth } = row;
  const isContainer = node.kind === 'container';
  const Icon = ICONS[node.icon];
  const greyed = node.needs !== undefined || node.greyReason !== undefined;

  const label = (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">
        <HighlightedText text={node.label} query={query} />
      </span>
      {synonym && (
        <span className="shrink-0 rounded-full border border-border px-1.5 text-[11px] text-muted-foreground">
          ≈ {synonym}
        </span>
      )}
      {node.count !== undefined && (
        <span className="shrink-0 rounded bg-muted px-1 text-[11px] tabular-nums text-muted-foreground">
          {node.count}
        </span>
      )}
      {node.lock && (
        <Lock
          className="size-3 shrink-0 text-amber-600"
          aria-label="Only visible to you"
        />
      )}
      {node.failureDot && (
        <span
          role="img"
          aria-label="Failed tool calls"
          className="size-2 shrink-0 rounded-full bg-red-600"
        />
      )}
      {isContainer && !expanded && (
        <span className="shrink-0 text-xs text-muted-foreground">
          ({leafCount(node)})
        </span>
      )}
      {node.greyReason !== undefined ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          · {node.greyReason}
        </span>
      ) : (
        node.needs && (
          // Picks nothing by itself: it opens the picker for the missing context (FR-E3).
          <button
            type="button"
            tabIndex={-1}
            data-testid={`map-choose-${node.id}`}
            onClick={(e) => {
              e.stopPropagation();
              onChoose();
            }}
            className="shrink-0 text-xs text-primary hover:underline"
          >
            {NEEDS_LABEL[node.needs]}
          </button>
        )
      )}
    </span>
  );

  const content = (
    <div
      ref={setRef}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isContainer ? expanded : undefined}
      aria-selected={focused}
      aria-disabled={greyed || undefined}
      tabIndex={focused ? 0 : -1}
      data-testid={`map-node-${node.id}`}
      onFocus={onFocus}
      onClick={onClick}
      onKeyDown={onKeyDown}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-sm py-1 pr-2 text-sm outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring',
        focused && 'bg-accent/40',
        greyed && 'text-muted-foreground',
        dimmed && 'opacity-45',
      )}
      style={{ paddingLeft: `${depth * 16 + 4}px` }}
    >
      <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
        {isContainer &&
          (expanded ? (
            <ChevronDown className="size-3.5" aria-hidden />
          ) : (
            <ChevronRight className="size-3.5" aria-hidden />
          ))}
      </span>
      <span className="min-w-0 flex-1 md:max-w-[45%] md:flex-none md:basis-[45%]">
        {label}
      </span>
      {wide && node.description && (
        <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground md:block">
          <HighlightedText text={node.description} query={query} />
        </span>
      )}
    </div>
  );

  if (wide || !node.description) return content;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{content}</TooltipTrigger>
      <TooltipContent variant="light" side="bottom" className="max-w-[280px]">
        {node.description}
      </TooltipContent>
    </Tooltip>
  );
}
