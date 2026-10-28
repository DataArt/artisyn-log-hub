/**
 * A block of the Tools/MCP details pane that collapses beyond `COLLAPSE_HEIGHT_PX` behind a
 * "Show all" button. The height is measured after render and again whenever the content box
 * resizes, so switching output views re-checks it.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { COLLAPSE_HEIGHT_PX } from './tools-constants';

export function CollapsibleBlock({
  children,
  className,
  testId,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  const innerRef = useRef<HTMLDivElement | null>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > COLLAPSE_HEIGHT_PX);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const collapsed = overflows && !expanded;
  return (
    <div className="relative" data-testid={testId}>
      <div
        className={cn(
          'overflow-x-auto rounded border border-border',
          className,
        )}
        style={
          collapsed
            ? { maxHeight: COLLAPSE_HEIGHT_PX, overflowY: 'hidden' }
            : undefined
        }
      >
        <div ref={innerRef}>{children}</div>
      </div>
      {overflows ? (
        <div
          className={cn(
            'flex justify-center',
            collapsed &&
              'absolute inset-x-px bottom-px rounded-b bg-gradient-to-t from-white via-white/90 to-transparent pt-6',
          )}
        >
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="my-1 rounded border border-border bg-white px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="tools-block-toggle"
          >
            {collapsed ? 'Show all' : 'Show less'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
