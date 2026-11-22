import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../../../lib/cn';
import { formatDuration, formatTime } from '../../../../lib/format';
import {
  type BashView,
  type ShellKind,
  toRepoRelative,
} from '@loghub/bash-view';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';
import { StatusMark } from '../tool-call-view/StatusBadge';
import { commandOf } from '../tool-call-view/useBashView';
import { useToolView } from '../tool-call-view/ToolViewContext';
import type { BashCallRow } from './collect-bash-calls';

/** Calls per shell in the whole session (not just the visible rows). */
export type ShellCounts = Record<ShellKind, number>;

/** The filter state of a mixed session (DD-24); `null` on a single-shell session. */
export interface ShellFilter {
  /** Active filter; `null` = All. */
  shell: ShellKind | null;
  counts: ShellCounts;
  onChange: (shell: ShellKind | null) => void;
}

interface Props {
  /** The visible rows (already filtered by the caller). */
  rows: BashCallRow[];
  /** Shell views by call id; empty until a parser is loaded (previews stay raw). */
  views: Map<string, BashView>;
  /** Filter chips and per-row shell badges render only when set (a mixed session, DD-25). */
  shellFilter: ShellFilter | null;
  selectedId: string;
  onSelect: (id: string) => void;
}

/** Badge text per shell (DD-25). */
const SHELL_BADGE: Record<ShellKind, string> = {
  bash: 'bash',
  powershell: 'pwsh',
};

const ALL = 'all';

/** Toggle value → filter; `''` (the active chip clicked again) keeps the current filter. */
function filterOfValue(value: string): ShellKind | null | undefined {
  if (value === ALL) return null;
  if (value === 'bash') return 'bash';
  if (value === 'powershell') return 'powershell';
  return undefined;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

/**
 * `description`, else the view's first statement, else the first raw line (DD-18) — always
 * repo-relative. The same for both shells: the view is built with that row's own shell.
 */
function previewOf(
  row: BashCallRow,
  view: BashView | undefined,
  repoRoot: string,
): string {
  const description = row.input.description;
  if (typeof description === 'string' && description.trim() !== '')
    return toRepoRelative(description.trim(), repoRoot);
  if (view?.firstStatement) return view.firstStatement;
  return firstLine(
    view?.rawDisplay ?? toRepoRelative(commandOf(row.input), repoRoot),
  );
}

/** `All <n>` / `Bash <n>` / `PowerShell <n>` above the list of a mixed session (DD-25). */
function ShellFilterChips({ filter }: { filter: ShellFilter }) {
  const { shell, counts, onChange } = filter;
  const chips: { value: string; label: string; count: number }[] = [
    { value: ALL, label: 'All', count: counts.bash + counts.powershell },
    { value: 'bash', label: 'Bash', count: counts.bash },
    { value: 'powershell', label: 'PowerShell', count: counts.powershell },
  ];
  return (
    <div
      className="shrink-0 border-b border-border px-3 py-2"
      data-testid="shell-filter"
    >
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={shell ?? ALL}
        onValueChange={(v) => {
          const next = filterOfValue(v);
          if (next !== undefined) onChange(next);
        }}
        aria-label="Filter by shell"
      >
        {chips.map((chip) => (
          <ToggleGroupItem
            key={chip.value}
            value={chip.value}
            className="gap-1 px-2.5 text-xs"
            data-testid={`shell-filter-${chip.value}`}
          >
            {chip.label}
            <span className="tabular-nums text-muted-foreground">
              {chip.count}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/**
 * The Shell tab's left list (DD-18): a keyboard-navigable listbox (↑/↓ move the selection and keep
 * it scrolled into view), one row per call with `#n`, time, duration, status mark, a "changes N"
 * chip, a preview and a sub-agent badge. On a mixed session (DD-25) a filter row sits above it
 * and every row gets a `bash` / `pwsh` badge before its preview.
 */
export function BashCallList({
  rows,
  views,
  shellFilter,
  selectedId,
  onSelect,
}: Props) {
  const { repoRoot } = useToolView();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    rowRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = rows.findIndex((r) => r.id === selectedId);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
    if (row && row.id !== selectedId) onSelect(row.id);
  };

  return (
    <div className="flex max-h-[40%] w-full shrink-0 flex-col border-b border-border @2xl/bash:max-h-none @2xl/bash:w-[340px] @2xl/bash:border-b-0 @2xl/bash:border-r">
      {shellFilter && <ShellFilterChips filter={shellFilter} />}
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Shell commands"
        aria-activedescendant={`bash-call-${selectedId}`}
        onKeyDown={onKeyDown}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        data-testid="bash-call-list"
      >
        {rows.map((row) => {
          const view = views.get(row.id);
          const changes = view?.ok ? view.files.changes.length : 0;
          const selected = row.id === selectedId;
          const preview = previewOf(row, view, repoRoot);
          return (
            <div
              key={row.id}
              id={`bash-call-${row.id}`}
              ref={(el) => {
                if (el) rowRefs.current.set(row.id, el);
                else rowRefs.current.delete(row.id);
              }}
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(row.id)}
              className={cn(
                'flex cursor-pointer flex-col gap-1 border-b border-l-[3px] border-b-border px-3 py-2 text-xs',
                selected
                  ? 'border-l-[#3b82f6] bg-blue-50 dark:bg-blue-500/10'
                  : 'border-l-transparent hover:bg-muted/40',
              )}
              data-testid="bash-call-row"
              data-call-id={row.id}
              data-shell={row.shell}
            >
              <div className="flex items-center gap-2 text-muted-foreground">
                <span className="font-mono font-semibold text-foreground">
                  #{row.n}
                </span>
                <span className="font-mono">{formatTime(row.startedAt)}</span>
                {row.durationMs !== undefined && (
                  <span className="font-mono">
                    ⏱ {formatDuration(row.durationMs)}
                  </span>
                )}
                <StatusMark status={row.status} />
                {changes > 0 && (
                  <span className="rounded bg-orange-500/15 px-1.5 py-0.5 font-mono text-orange-700 dark:text-orange-300">
                    changes {changes}
                  </span>
                )}
                {row.agentLabel && (
                  <span
                    className="ml-auto max-w-[120px] truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-violet-700 dark:text-violet-300"
                    title={row.agentLabel}
                    data-testid="bash-call-agent-badge"
                  >
                    {row.agentLabel}
                  </span>
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                {shellFilter && (
                  <span
                    className="shrink-0 rounded border border-border bg-muted px-1 font-mono text-[10px] leading-4 text-muted-foreground"
                    data-testid="shell-badge"
                  >
                    {SHELL_BADGE[row.shell]}
                  </span>
                )}
                <div
                  className="min-w-0 truncate font-mono text-foreground"
                  title={preview}
                >
                  {preview}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
