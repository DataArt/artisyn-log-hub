/**
 * The live indicator of an OTEL tab (2026-10-30 otel-tabs-traces, DD-15 / DD-20 / FR-28): a dot
 * with the poll state and a Pause / Resume button.
 *
 * | State | Text |
 * |---|---|
 * | `live` | Live · N s ago |
 * | `hidden` | Paused · tab hidden |
 * | `idle` | Paused · idle — resume |
 * | `paused` | Paused · by you |
 * | `ended` | Session ended (session) / Period ended (repository, team) |
 * | `slow`, reason `old-hook` | Slow updates · hook X |
 * | `slow`, reason `realtime-off` | Slow updates · realtime off |
 */
import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { OtelSlowReason } from '../../../../models/repositories';
import type { OtelLiveIndicatorState } from './useOtelLivePoll';

export interface OtelLiveIndicatorProps {
  state: OtelLiveIndicatorState;
  /** Wording of `ended`. */
  scope: 'session' | 'repository' | 'team';
  slowReason?: OtelSlowReason | null;
  hookVersion?: string | null;
  lastUpdatedAt: number | null;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
  /** The "resume" link of the idle state (any input resumes anyway). */
  onResume?: () => void;
}

function agoText(lastUpdatedAt: number | null, now: number): string {
  if (lastUpdatedAt === null) return '';
  const s = Math.max(0, Math.round((now - lastUpdatedAt) / 1000));
  return s < 60 ? ` · ${s} s ago` : ` · ${Math.round(s / 60)} min ago`;
}

export function otelIndicatorLabel(
  props: Pick<
    OtelLiveIndicatorProps,
    'state' | 'scope' | 'slowReason' | 'hookVersion'
  >,
): string {
  switch (props.state) {
    case 'loading':
      return 'Loading…';
    case 'live':
      return 'Live';
    case 'hidden':
      return 'Paused · tab hidden';
    case 'idle':
      return 'Paused · idle';
    case 'paused':
      return 'Paused · by you';
    case 'ended':
      return props.scope === 'session' ? 'Session ended' : 'Period ended';
    case 'slow':
      return props.slowReason === 'realtime-off'
        ? 'Slow updates · realtime off'
        : `Slow updates · hook ${props.hookVersion ?? 'unknown'}`;
  }
}

const DOT_CLASS: Record<OtelLiveIndicatorState, string> = {
  loading: 'bg-slate-300',
  live: 'bg-emerald-500 animate-pulse',
  slow: 'bg-amber-500',
  hidden: 'bg-slate-400',
  idle: 'bg-slate-400',
  paused: 'bg-slate-400',
  ended: 'bg-slate-300',
};

export function OtelLiveIndicator(props: OtelLiveIndicatorProps) {
  const { state, lastUpdatedAt, paused, onPausedChange, onResume } = props;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (state !== 'live' && state !== 'slow') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [state]);

  const showAgo = state === 'live' || state === 'slow';
  const canPause = state !== 'ended' && state !== 'loading';

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      data-testid="otel-live-indicator"
      data-state={state}
    >
      <span
        className={cn('inline-block size-2 rounded-full', DOT_CLASS[state])}
      />
      <span>
        {otelIndicatorLabel(props)}
        {showAgo && agoText(lastUpdatedAt, now)}
      </span>
      {state === 'idle' && onResume && (
        <button
          type="button"
          className="text-blue-600 hover:underline"
          onClick={onResume}
        >
          — resume
        </button>
      )}
      {canPause && (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 hover:bg-accent"
          onClick={() => onPausedChange(!paused)}
          data-testid="otel-pause-toggle"
        >
          {paused ? <Play className="size-3" /> : <Pause className="size-3" />}
          {paused ? 'Resume' : 'Pause'}
        </button>
      )}
    </div>
  );
}
