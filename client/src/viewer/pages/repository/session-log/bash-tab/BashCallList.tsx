import { useEffect, useRef, type KeyboardEvent } from 'react';
import { cn } from '../../../../lib/cn';
import { formatDuration, formatTime } from '../../../../lib/format';
import { type BashView, toRepoRelative } from '@loghub/bash-view';
import { StatusMark } from '../tool-call-view/StatusBadge';
import { commandOf } from '../tool-call-view/useBashView';
import { useToolView } from '../tool-call-view/ToolViewContext';
import type { BashCallRow } from './collect-bash-calls';

interface Props {
  rows: BashCallRow[];
  /** Bash views by call id; empty until the parser is loaded (previews stay raw). */
  views: Map<string, BashView>;
  selectedId: string;
  onSelect: (id: string) => void;
}

function firstLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return (line ?? '').trim();
}

/**
 * `description`, else the view's first statement, else the first raw line (DD-18) — always
 * repo-relative.
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

/**
 * The Bash tab's left list (DD-18): a keyboard-navigable listbox (↑/↓ move the selection and keep
 * it scrolled into view), one row per call with `#n`, time, duration, status mark, a "changes N"
 * chip, a preview and a sub-agent badge.
 */
export function BashCallList({ rows, views, selectedId, onSelect }: Props) {
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
    <div
      role="listbox"
      tabIndex={0}
      aria-label="Bash commands"
      aria-activedescendant={`bash-call-${selectedId}`}
      onKeyDown={onKeyDown}
      className="flex max-h-[40%] w-full shrink-0 flex-col overflow-y-auto border-b border-border outline-none focus-visible:ring-2 focus-visible:ring-primary/40 @2xl/bash:max-h-none @2xl/bash:w-[340px] @2xl/bash:border-b-0 @2xl/bash:border-r"
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
            <div className="truncate font-mono text-foreground" title={preview}>
              {preview}
            </div>
          </div>
        );
      })}
    </div>
  );
}
