import { useState } from 'react';
import type * as React from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../../lib/cn';

/** Shared rate formatter used across the Session Info tab sections. */
export const rateFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function CollapsibleSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mb-4">
      <button
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1 hover:text-foreground transition-colors"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 transition-transform',
            open && 'rotate-90',
          )}
        />
        {title}
      </button>
      {open && children}
    </div>
  );
}

export function InfoRow({
  label,
  children,
  title,
  secondary,
}: {
  label: string;
  children: React.ReactNode;
  /** Optional native tooltip — the Session Info tab uses plain `title=` tooltips. */
  title?: string;
  /**
   * Optional muted line rendered *under* the value, for a scope split such as
   * `0 own · 19 457 in 22 sub-agents`. Omitted entirely when `null`/`undefined`, so a row
   * without a split renders exactly the same markup it always did.
   */
  secondary?: React.ReactNode;
}) {
  return (
    <div className="flex" title={title}>
      <span className="text-xs text-muted-foreground w-40 shrink-0">
        {label}
      </span>
      {secondary == null ? (
        <span className="text-sm font-mono">{children}</span>
      ) : (
        <span className="flex min-w-0 flex-col">
          <span className="text-sm font-mono">{children}</span>
          <span className="text-xs text-muted-foreground">{secondary}</span>
        </span>
      )}
    </div>
  );
}
