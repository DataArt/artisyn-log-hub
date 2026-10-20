import type * as React from 'react';
import type { DetailRow } from './DetailTooltip';
import { HoverPopover } from './ViewportPopover';

interface Props {
  children: React.ReactElement<React.HTMLAttributes<HTMLElement>>;
  rows?: DetailRow[];
  body?: string;
  maxWidth?: number;
}

const BODY_PREVIEW_MAX = 400;

export function DefinitionTooltip({
  children,
  rows = [],
  body,
  maxWidth = 480,
}: Props) {
  const hasContent = rows.length > 0 || (body && body.trim().length > 0);
  if (!hasContent) return <>{children}</>;

  const truncatedBody =
    body && body.length > BODY_PREVIEW_MAX
      ? body.slice(0, BODY_PREVIEW_MAX) + '…'
      : body;

  return (
    <HoverPopover
      maxWidth={maxWidth}
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
          {truncatedBody && (
            <>
              {rows.length > 0 && (
                <div className="my-0.5 border-t border-border/50" />
              )}
              <pre className="max-h-48 overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
                {truncatedBody}
              </pre>
            </>
          )}
        </div>
      }
    >
      {children}
    </HoverPopover>
  );
}
