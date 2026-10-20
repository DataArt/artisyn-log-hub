import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';

interface Props {
  children: ReactElement;
}

/**
 * Drop-in replacement for Recharts' `ResponsiveContainer` (same `children` contract,
 * always sized to 100%/100% of its parent).
 *
 * `ResponsiveContainer` measures its parent synchronously on mount, before the browser
 * has laid out a freshly-inserted subtree (e.g. right after switching into a report
 * tab) — that first read comes back 0x0 and Recharts logs a "width(-1) and height(-1)"
 * warning even though it self-corrects a frame later once its ResizeObserver fires for
 * real. Gating the mount on an actual measured size avoids ever calling into Recharts
 * while the container is 0x0, at the cost of a single imperceptible frame of delay.
 */
export function ChartResponsiveContainer({ children }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [hasSize, setHasSize] = useState(false);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setHasSize(true);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={wrapperRef} className="h-full w-full">
      {hasSize && (
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      )}
    </div>
  );
}
