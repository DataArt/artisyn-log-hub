/**
 * Header bar of the Live modal (2026-11-04 otel-live-view, Visual/UX notes):
 * "Live · ⓘ OTEL only · Updated N s ago · X live sessions · Y agents", the "Paused at" badge,
 * Pause / Resume and ✕.
 */
import { useEffect, useState } from 'react';
import { Info, Pause, Play, X } from 'lucide-react';
import { Button } from '../ui/button';
import { DialogTitle } from '../ui/dialog';
import { formatLiveClock } from './live-format';

export interface LiveModalHeaderProps {
  lastUpdatedAt: number | null;
  liveSessions: number | null;
  liveAgents: number | null;
  paused: boolean;
  pausedAt: number | null;
  onPause: (paused: boolean) => void;
  onClose: () => void;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Re-renders every second so "Updated N s ago" keeps counting between polls. */
function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

export function LiveModalHeader({
  lastUpdatedAt,
  liveSessions,
  liveAgents,
  paused,
  pausedAt,
  onPause,
  onClose,
}: LiveModalHeaderProps) {
  const now = useNowTick();
  const agoS =
    lastUpdatedAt === null
      ? null
      : Math.max(0, Math.round((now - lastUpdatedAt) / 1_000));

  return (
    <div
      className="flex items-center gap-3 border-b border-border px-4 py-2 text-sm"
      data-testid="live-modal-header"
    >
      <DialogTitle className="text-base">Live</DialogTitle>
      <span
        className="inline-flex items-center gap-1 text-xs text-muted-foreground"
        title="Figures come from Claude Code OpenTelemetry data only"
      >
        <Info className="size-3.5" />
        OTEL only
      </span>
      <span className="text-muted-foreground" data-testid="live-updated">
        {agoS === null ? 'Loading…' : `Updated ${agoS} s ago`}
      </span>
      {liveSessions !== null && (
        <span data-testid="live-header-sessions">
          {plural(liveSessions, 'live session', 'live sessions')}
        </span>
      )}
      {liveAgents !== null && (
        <span data-testid="live-header-agents">
          {plural(liveAgents, 'agent', 'agents')}
        </span>
      )}
      {paused && pausedAt !== null && (
        <span
          className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900"
          data-testid="live-paused-badge"
        >
          Paused at {formatLiveClock(pausedAt, now)}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="outline"
          size="sm"
          data-testid={paused ? 'live-resume' : 'live-pause'}
          onClick={() => onPause(!paused)}
        >
          {paused ? (
            <Play className="size-3.5" />
          ) : (
            <Pause className="size-3.5" />
          )}
          {paused ? 'Resume' : 'Pause'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close"
          data-testid="live-close"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
