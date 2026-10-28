/**
 * Middle pane of the Tools/MCP tab: one page of calls, newest first, as a keyboard-navigable
 * listbox (↑/↓ move the selection and keep it scrolled into view; the selection is the `tcall`
 * URL param). Columns: time, tool · operation with the channel badge, in / out bytes, and the
 * status with its small grey hints. A pager footer moves between pages.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { formatBytes, formatLocalTimestamp } from '../../../lib/format';
import type { ToolCallListItem } from '../../../../models/tool-monitoring';
import {
  HINT_LABELS,
  HINT_TITLES,
  STATUS_BADGE,
  STATUS_BADGE_BASE as BADGE,
} from './call-labels';
import { ChannelBadge } from './ChannelBadge';
import type { ToolsCallRef } from './tools-url-state';

const GRID =
  'grid grid-cols-[minmax(0,9.5rem)_minmax(0,1fr)_3.5rem_3.5rem_minmax(0,7.5rem)] items-center gap-2';

export interface ToolCallsTableProps {
  items: ToolCallListItem[];
  total: number;
  page: number;
  pageSize: number;
  selected: ToolsCallRef | null;
  onSelect: (ref: ToolsCallRef) => void;
  onPageChange: (page: number) => void;
  /** A newer page is loading while the previous one is still shown. */
  fetching?: boolean;
}

function isSelected(item: ToolCallListItem, ref: ToolsCallRef | null) {
  return (
    ref !== null && item.usageId === ref.usageId && item.callId === ref.callId
  );
}

export function ToolCallsTable({
  items,
  total,
  page,
  pageSize,
  selected,
  onSelect,
  onPageChange,
  fetching,
}: ToolCallsTableProps) {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const selectedIndex = items.findIndex((it) => isSelected(it, selected));

  useEffect(() => {
    if (selectedIndex >= 0)
      rowRefs.current.get(selectedIndex)?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    if (items.length === 0) return;
    const next =
      selectedIndex < 0
        ? 0
        : e.key === 'ArrowDown'
          ? selectedIndex + 1
          : selectedIndex - 1;
    const item = items[Math.max(0, Math.min(items.length - 1, next))];
    if (item && !isSelected(item, selected))
      onSelect({ usageId: item.usageId, callId: item.callId });
  };

  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(total, (page - 1) * pageSize + items.length);
  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div
      className="flex h-full min-h-0 flex-col"
      data-testid="tools-calls-table"
    >
      <div
        className={cn(
          GRID,
          'shrink-0 border-b border-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground',
        )}
      >
        <span>Time</span>
        <span>Tool · operation</span>
        <span className="text-right">In</span>
        <span className="text-right">Out</span>
        <span>Status</span>
      </div>
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Tool calls"
        aria-activedescendant={
          selectedIndex >= 0 ? `tools-call-${selectedIndex}` : undefined
        }
        onKeyDown={onKeyDown}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          fetching && 'opacity-60',
        )}
        data-testid="tools-calls-list"
      >
        {items.length === 0 ? (
          <div
            className="p-6 text-center text-xs text-muted-foreground"
            data-testid="tools-calls-empty"
          >
            No calls match these filters.
          </div>
        ) : null}
        {items.map((item, i) => {
          const sel = i === selectedIndex;
          const status = STATUS_BADGE[item.status];
          return (
            <div
              key={`${item.usageId}:${item.callId}`}
              id={`tools-call-${i}`}
              ref={(el) => {
                if (el) rowRefs.current.set(i, el);
                else rowRefs.current.delete(i);
              }}
              role="option"
              aria-selected={sel}
              onClick={() =>
                onSelect({ usageId: item.usageId, callId: item.callId })
              }
              className={cn(
                GRID,
                'cursor-pointer border-b border-l-[3px] border-b-border px-3 py-1.5 text-xs',
                sel
                  ? 'border-l-[#3b82f6] bg-blue-50'
                  : 'border-l-transparent hover:bg-muted/40',
              )}
              data-testid="tools-call-row"
              data-call-ref={`${item.usageId}:${item.callId}`}
            >
              <span className="truncate font-mono text-muted-foreground">
                {formatLocalTimestamp(item.ts)}
              </span>
              <span
                className="flex min-w-0 items-center gap-1.5"
                title={item.inputPreview || undefined}
              >
                <ChannelBadge channel={item.channel} />
                <span className="truncate font-mono text-foreground">
                  {item.tool}
                  <span className="text-muted-foreground"> · </span>
                  {item.operation}
                </span>
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(item.inBytes)}
              </span>
              <span className="text-right font-mono tabular-nums text-muted-foreground">
                {formatBytes(item.outBytes)}
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-1">
                <span className={cn(BADGE, status.cls)}>{status.label}</span>
                {item.hints.map((h) => (
                  <span
                    key={h}
                    className="text-[10px] text-muted-foreground"
                    title={HINT_TITLES[h]}
                  >
                    {HINT_LABELS[h]}
                  </span>
                ))}
              </span>
            </div>
          );
        })}
      </div>
      <div
        className="flex shrink-0 items-center justify-end gap-1 border-t border-border px-3 py-1 text-xs text-muted-foreground"
        data-testid="tools-calls-pager"
      >
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="flex size-6 items-center justify-center rounded hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronLeft className="size-4" />
        </button>
        <span className="font-mono tabular-nums">
          {first}–{last} of {total}
        </span>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPageChange(page + 1)}
          className="flex size-6 items-center justify-center rounded hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
    </div>
  );
}
