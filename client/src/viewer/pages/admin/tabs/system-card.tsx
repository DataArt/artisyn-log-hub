import type { ReactNode } from 'react';

/** Labelled tile used by the admin System tab's card grids. */
export function Card({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="rounded-md border border-border bg-background p-4"
      data-testid={testId}
    >
      <div className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
