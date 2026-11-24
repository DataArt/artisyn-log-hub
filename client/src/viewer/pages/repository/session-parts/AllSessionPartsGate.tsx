import { useEffect, useState, type ReactNode } from 'react';
import { useSessionParts } from './SessionPartsContext';

/**
 * Renders `children` only once every log part of the session is loaded (impl-plan DD-33): the
 * views it wraps (Bash, the charts, Usage, Harness usage, the Session Map) aggregate across the
 * whole agent tree, so a partial tree would show wrong totals. Asks for all parts on mount and
 * shows "Loading session logs {n} of {m}" meanwhile.
 *
 * `keepOnceLoaded`: once every part was in, keep `children` on screen while the parts a live
 * session adds later load (the Session Map would otherwise unmount, losing its playback
 * position, on every new agent). Give the gate a per-session `key` so it starts over on a new
 * session.
 */
export function AllSessionPartsGate({
  children,
  keepOnceLoaded = false,
}: {
  children: ReactNode;
  keepOnceLoaded?: boolean;
}) {
  const { requestAll, allLoaded, loaded, total } = useSessionParts();
  const [everLoaded, setEverLoaded] = useState(false);
  if (keepOnceLoaded && allLoaded && !everLoaded) setEverLoaded(true);

  useEffect(() => {
    if (!allLoaded) void requestAll();
  }, [allLoaded, requestAll]);

  if (allLoaded || (keepOnceLoaded && everLoaded)) return <>{children}</>;

  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  return (
    <div
      className="flex h-full items-center justify-center p-4"
      data-testid="session-parts-loading"
    >
      <div className="flex w-full max-w-md flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Loading session logs {loaded} of {total}
        </p>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
    </div>
  );
}
