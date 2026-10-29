/**
 * Filter strip of the Tools/MCP tab: date range, call status, a debounced search over the calls,
 * the removable scope chip set by the tree, and the "Monitored tools (N)" button (opens the
 * repository settings' "Monitored Tools" tab). Every change is
 * applied at once; the tab mirrors it to the `t*` URL params (DD-21). Status and search filter
 * the calls table only, the tree keeps its totals (DD-18).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Select } from 'radix-ui';
import { ChevronDown, Search, Settings2, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';
import { Input } from '@/ui/input';
import type { ToolCallStatus } from '../../../../models/tool-monitoring';
import { DateRangePicker } from '../analytics/DateRangePicker';
import { ChannelBadge } from './ChannelBadge';
import { SEARCH_DEBOUNCE_MS } from './tools-constants';
import type { ToolsScope, ToolsTabUrlState } from './tools-url-state';

const ALL_STATUSES = '__all__';

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  ok: 'OK',
  error: 'Error',
  killed: 'Killed',
  no_result: 'No result',
};

const STATUSES: readonly ToolCallStatus[] = [
  'ok',
  'error',
  'killed',
  'no_result',
];

const TRIGGER_CLASS =
  'flex h-9 items-center gap-1 rounded-md border border-input bg-background px-3 text-sm hover:bg-accent/50';

const ITEM_CLASS =
  'flex cursor-default select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground';

/** The filter fields the strip edits. */
export type ToolsTopBarPatch = Partial<
  Pick<ToolsTabUrlState, 'startDate' | 'endDate' | 'status' | 'q' | 'scope'>
>;

export interface ToolsTopBarProps {
  filters: ToolsTabUrlState;
  onChange: (patch: ToolsTopBarPatch) => void;
  /** Enabled monitored tools of the caller's level; null while the config loads. */
  monitoredCount: number | null;
  /** Opens the settings' Monitored Tools tab; the button is disabled without it. */
  onOpenMonitoredTools?: () => void;
  /**
   * The session detail's tab: one session's calls, so no date range and no Monitored tools
   * button (the config is edited on the repository tab).
   */
  sessionMode?: boolean;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function formatRangeLabel(from: string, to: string): string {
  const fmt = (d: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(
      new Date(d + 'T00:00:00'),
    );
  return `${fmt(from)} → ${fmt(to)}`;
}

function localDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const NO_SCOPE: ToolsScope = { channel: null, tool: null, operation: null };

/**
 * The search box keeps its own draft and sends it after {@link SEARCH_DEBOUNCE_MS} of quiet. A
 * value arriving from outside (back/forward, a link) replaces the draft.
 */
function SearchBox({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (q: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [seenValue, setSeenValue] = useState(value);
  const onCommitRef = useRef(onCommit);
  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  // The URL keeps the trimmed text, so a trailing space being typed is not "a new value".
  if (value !== seenValue) {
    setSeenValue(value);
    if (draft.trim() !== value) setDraft(value);
  }

  useEffect(() => {
    if (draft.trim() === value) return;
    const timer = window.setTimeout(
      () => onCommitRef.current(draft),
      SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [draft, value]);

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={draft}
        maxLength={200}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search input and output"
        aria-label="Search tool calls"
        className="w-64 pl-8"
        data-testid="tools-search"
      />
    </div>
  );
}

export function ToolsTopBar({
  filters,
  onChange,
  monitoredCount,
  onOpenMonitoredTools,
  sessionMode = false,
}: ToolsTopBarProps) {
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const { scope } = filters;

  const calendarRange: DateRange = {
    from: new Date(filters.startDate + 'T00:00:00'),
    to: new Date(filters.endDate + 'T00:00:00'),
  };

  const scopeLabel = scope.tool
    ? scope.operation
      ? `${scope.tool} · ${scope.operation}`
      : scope.tool
    : scope.channel === 'mcp'
      ? 'All MCP servers'
      : 'All CLI tools';

  return (
    <div
      data-testid="tools-top-bar"
      className="flex flex-shrink-0 flex-wrap items-end gap-3 border-b border-border px-4 py-3"
    >
      {sessionMode ? null : (
        <Field label="Date range">
          <button
            type="button"
            data-testid="tools-date-range"
            onClick={() => setDatePickerOpen(true)}
            className={TRIGGER_CLASS}
          >
            {formatRangeLabel(filters.startDate, filters.endDate)}
          </button>
        </Field>
      )}

      <Field label="Status">
        <Select.Root
          value={filters.status ?? ALL_STATUSES}
          onValueChange={(v) =>
            onChange({
              status: STATUSES.find((s) => s === v) ?? null,
            })
          }
        >
          <Select.Trigger
            data-testid="tools-status-select"
            className="flex h-9 w-36 items-center justify-between gap-1 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <span className="truncate">
              <Select.Value />
            </span>
            <Select.Icon>
              <ChevronDown className="size-4 opacity-50" />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content
              position="popper"
              className="z-50 rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
            >
              <Select.Viewport>
                <Select.Item value={ALL_STATUSES} className={ITEM_CLASS}>
                  <Select.ItemText>All statuses</Select.ItemText>
                </Select.Item>
                {STATUSES.map((s) => (
                  <Select.Item key={s} value={s} className={ITEM_CLASS}>
                    <Select.ItemText>{STATUS_LABELS[s]}</Select.ItemText>
                  </Select.Item>
                ))}
              </Select.Viewport>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
      </Field>

      <Field label="Search">
        <SearchBox value={filters.q} onCommit={(q) => onChange({ q })} />
      </Field>

      {scope.channel ? (
        <Field label="Scope">
          <span
            className="flex h-9 max-w-72 items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 pl-2 pr-1 text-sm"
            data-testid="tools-scope-chip"
          >
            <ChannelBadge channel={scope.channel} />
            <span className="truncate font-mono text-xs" title={scopeLabel}>
              {scopeLabel}
            </span>
            <button
              type="button"
              onClick={() => onChange({ scope: NO_SCOPE })}
              aria-label="Clear the scope"
              title="Show all tools"
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-blue-100 hover:text-foreground"
              data-testid="tools-scope-chip-clear"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </Field>
      ) : null}

      {sessionMode ? null : (
        <>
          <div className="ml-auto">
            <button
              type="button"
              onClick={onOpenMonitoredTools}
              disabled={!onOpenMonitoredTools}
              className={`${TRIGGER_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
              data-testid="tools-monitored-button"
            >
              <Settings2 className="size-4" />
              Monitored tools ({monitoredCount ?? '…'})
            </button>
          </div>

          <DateRangePicker
            open={datePickerOpen}
            onOpenChange={setDatePickerOpen}
            selected={calendarRange}
            onApply={(range) =>
              onChange({
                startDate: localDate(range.from),
                endDate: localDate(range.to),
              })
            }
          />
        </>
      )}
    </div>
  );
}
