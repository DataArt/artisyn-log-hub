// Small presentational pieces shared by the anatomy bar, partition table and drill-downs:
// number formatting, numeric cells, the git badge and the drill-down table shell.
import type * as React from 'react';
import { cn } from '@/lib/cn';
import {
  GIT_LABELS,
  HARNESS_INTERNALS_HINT,
  SOURCE_LABELS,
  type AnatomyGit,
  type AnatomySource,
} from './sysctx-anatomy-constants';

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Share as a percentage with one decimal, e.g. `67.9 %`. */
export function fmtShare(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

export function fmtBytesOrDash(bytes: number | null | undefined): string {
  return bytes === null || bytes === undefined ? '—' : fmtInt(bytes);
}

export function sourceLabel(source: AnatomySource | null): string {
  return source ? SOURCE_LABELS[source] : '—';
}

const GIT_BADGE_CLASSES: Record<AnatomyGit, string> = {
  tracked: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  untracked: 'bg-amber-100 text-amber-800 border-amber-200',
  ignored: 'bg-slate-200 text-slate-700 border-slate-300',
  'outside-repo': 'bg-sky-100 text-sky-800 border-sky-200',
  unknown: 'bg-transparent text-slate-500 border-slate-300',
};

/** Git status badge; `data-git` holds the raw value. `null` (no file) renders a dash. */
export function GitBadge({ git }: { git: AnatomyGit | null | undefined }) {
  if (!git) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      data-git={git}
      className={cn(
        'inline-flex items-center rounded border px-1.5 py-px text-[11px] leading-4 whitespace-nowrap',
        GIT_BADGE_CLASSES[git],
      )}
    >
      {GIT_LABELS[git]}
    </span>
  );
}

/** Right-aligned tabular number cell. */
export function NumCell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'px-2 py-1 text-right whitespace-nowrap tabular-nums',
        className,
      )}
    >
      {children}
    </td>
  );
}

export function TextCell({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td className={cn('px-2 py-1 align-top', className)} title={title}>
      {children}
    </td>
  );
}

/**
 * A compact drill-down table. `columns` are header labels; a label starting with `#` is a
 * right-aligned numeric column (the `#` is not shown).
 */
export function DrillTable({
  columns,
  children,
  testId,
}: {
  columns: string[];
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <table className="w-full text-xs" data-testid={testId}>
      <thead>
        <tr className="border-b border-border text-[11px] tracking-wide text-muted-foreground uppercase">
          {columns.map((c) => {
            const numeric = c.startsWith('#');
            return (
              <th
                key={c}
                className={cn(
                  'px-2 py-1 font-medium whitespace-nowrap',
                  numeric ? 'text-right' : 'text-left',
                )}
              >
                {numeric ? c.slice(1) : c}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

/** "Show all N …" / "Show fewer" toggle under a truncated drill-down. */
export function ShowAllToggle({
  total,
  noun,
  expanded,
  onToggle,
}: {
  total: number;
  noun: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="mt-1 px-2 text-xs text-primary hover:underline"
      onClick={onToggle}
    >
      {expanded ? 'Show fewer' : `Show all ${total} ${noun}`}
    </button>
  );
}

/** Body of the Harness internals hint (DD 13), shown by the table info icon and the bar tooltip. */
export function InternalsHintContent({
  internals,
  share,
  total,
  attributed,
}: {
  internals: number;
  share: number;
  total: number;
  attributed: number;
}) {
  const hint = HARNESS_INTERNALS_HINT(
    internals,
    share * 100,
    total,
    attributed,
  );
  return (
    <div
      className="max-w-[420px] space-y-1.5 text-left text-xs"
      data-testid="anatomy-internals-hint-text"
    >
      <div className="font-medium text-foreground">{hint.title}</div>
      <p className="text-muted-foreground">{hint.body}</p>
      <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
        {hint.bullets.map((b) => (
          <li key={b.term}>
            <span className="font-medium text-foreground">{b.term}</span> —{' '}
            {b.text}
          </li>
        ))}
      </ul>
      <p className="text-muted-foreground">{hint.closing}</p>
    </div>
  );
}
