import { Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { tabTestId, type TabRow } from '../../tab-ids';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip';
import type { OverflowPlacement } from '../../ui/overflow-row';

/** Per-id decorations of session tab triggers, from data the pane has already loaded (FR-B3). */
export interface SessionTabDecorations {
  /** Bash commands in the session tree, shown muted after the Bash label; absent → no count. */
  bashCount?: number;
  /** Transcript-derived MCP failures exist → a red dot on Tools/MCP (DD-9). */
  toolsFailure?: boolean;
}

/** The trigger content of a row: its label plus the per-id decoration. */
function tabLabel(
  row: TabRow,
  deco: SessionTabDecorations,
  placement: OverflowPlacement,
): ReactNode {
  if (row.id === 'bash') {
    return (
      <>
        {row.label}
        {deco.bashCount !== undefined && (
          <span
            className="ml-1.5 font-mono text-xs text-muted-foreground"
            data-testid={
              placement === 'measure' ? undefined : 'session-bash-count'
            }
          >
            {deco.bashCount}
          </span>
        )}
      </>
    );
  }
  if (row.id === 'raw-logs') {
    return (
      <>
        <Lock className="size-[1em] text-amber-500 stroke-[2.5]" />
        {row.label}
      </>
    );
  }
  if (row.id === 'tools' && deco.toolsFailure === true) {
    return (
      // The dot sits after the label (inline), so it never covers the text.
      <span className="inline-flex items-center gap-1.5">
        {row.label}
        {placement === 'measure' ? (
          <span aria-hidden="true" className="size-2" />
        ) : (
          <span
            data-testid="session-tools-failure-dot"
            role="img"
            aria-label="Failed MCP tool calls in this session"
            className="size-2 shrink-0 rounded-full bg-red-600"
          />
        )}
      </span>
    );
  }
  return row.label;
}

/** The tooltip body of a row: the registry description; Raw Logs adds its privacy note in amber. */
function TabTooltipContent({ row }: { row: TabRow }) {
  if (row.id === 'raw-logs') {
    return (
      <TooltipContent
        side="bottom"
        variant="light"
        className="max-w-[280px] bg-amber-50 border-amber-300 text-amber-900"
      >
        <p className="text-xs">{row.description}</p>
        <p className="font-semibold text-xs mt-1">Only visible to you</p>
        <p className="text-xs mt-0.5">
          Raw logs contain unfiltered session data. Other users viewing this
          session cannot see this tab.
        </p>
      </TooltipContent>
    );
  }
  return (
    <TooltipContent side="bottom" variant="light" className="max-w-[280px]">
      {row.description}
    </TooltipContent>
  );
}

interface SessionTabTriggerProps {
  row: TabRow;
  active: boolean;
  placement: OverflowPlacement;
  decorations: SessionTabDecorations;
  onSelect: () => void;
}

/**
 * One session tab trigger, the same wherever it is placed (DD-4): in a bar row and inside an open
 * "More" menu it carries `data-testid="tab-session-<id>"`, its decorations and its description
 * tooltip; in the hidden measuring copy it has no test ids, handlers or tooltip.
 */
export function SessionTabTrigger({
  row,
  active,
  placement,
  decorations,
  onSelect,
}: SessionTabTriggerProps) {
  const inMenu = placement === 'menu';
  const className = cn(
    'flex items-center gap-1 text-sm whitespace-nowrap transition-colors',
    inMenu
      ? 'w-full rounded-sm px-2 py-1.5 text-left hover:bg-muted'
      : 'px-3 py-2',
    active
      ? inMenu
        ? 'font-medium text-foreground'
        : 'border-b-2 border-primary font-medium text-foreground'
      : 'text-muted-foreground hover:text-foreground',
  );
  const content = tabLabel(row, decorations, placement);
  if (placement === 'measure') {
    return (
      <span className={className} aria-hidden="true">
        {content}
      </span>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          role={inMenu ? undefined : 'tab'}
          aria-selected={inMenu ? undefined : active}
          data-testid={tabTestId('session', row.id)}
          onClick={onSelect}
          className={className}
        >
          {content}
        </button>
      </TooltipTrigger>
      <TabTooltipContent row={row} />
    </Tooltip>
  );
}
