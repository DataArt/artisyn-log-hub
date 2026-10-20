import type * as React from 'react';
import { HoverPopover } from './ViewportPopover';

export interface DetailRow {
  label: string;
  value: string;
}

interface Props {
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  rows: DetailRow[];
  /**
   * Optional monospaced formula line rendered under the rows, separated by a rule —
   * for metrics whose derivation is worth spelling out (e.g. the cache read ratio).
   */
  formula?: string;
  /** Optional muted footnote rendered last, e.g. a scope caveat. */
  footnote?: string;
}

export function DetailTooltip({ children, rows, formula, footnote }: Props) {
  if (rows.length === 0 && !formula && !footnote) return <>{children}</>;

  return (
    <HoverPopover
      maxWidth={400}
      className="animate-in fade-in-0 zoom-in-95 px-3 py-2.5 text-xs"
      content={
        <div className="flex flex-col gap-1.5">
          {rows.map(({ label, value }, i) => (
            <div key={i} className="flex gap-3">
              <span className="w-[88px] shrink-0 text-muted-foreground">
                {label}
              </span>
              <span className="break-all font-mono text-foreground">
                {value}
              </span>
            </div>
          ))}
          {formula && (
            <div className="mt-0.5 border-t border-border pt-1.5 font-mono text-[11px] text-foreground">
              {formula}
            </div>
          )}
          {footnote && (
            <div className="text-[11px] leading-snug text-muted-foreground">
              {footnote}
            </div>
          )}
        </div>
      }
    >
      {children}
    </HoverPopover>
  );
}
