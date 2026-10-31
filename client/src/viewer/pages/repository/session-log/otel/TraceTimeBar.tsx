/**
 * The turn "Time" bar of the session OTEL navigator (2026-10-30 otel-tabs-traces, DD-12 / FR-31):
 * one horizontal bar split into waiting → model → tools → other, each instant counted once
 * (`splitOtelTurnTime`).
 */
import { formatDuration } from '../../../../lib/format';
import type { OtelTurnTimeSplit } from './otel-trace-assembly';

const PARTS = [
  { id: 'model', label: 'model', className: 'bg-blue-500' },
  { id: 'tool', label: 'tools', className: 'bg-emerald-500' },
  { id: 'waiting', label: 'waiting', className: 'bg-amber-400' },
  { id: 'other', label: 'other', className: 'bg-slate-300' },
] as const;

function partMs(split: OtelTurnTimeSplit, id: (typeof PARTS)[number]['id']) {
  switch (id) {
    case 'model':
      return split.modelMs;
    case 'tool':
      return split.toolMs;
    case 'waiting':
      return split.waitingMs;
    case 'other':
      return split.otherMs;
  }
}

export function TraceTimeBar({ split }: { split: OtelTurnTimeSplit }) {
  const total = Math.max(split.durationMs, 1);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
      data-testid="otel-turn-time"
    >
      <span
        className="text-muted-foreground"
        title="Union of llm_request / tool.execution / blocked_on_user intervals; overlaps counted once (waiting > model > tool); the rest is other."
      >
        Time
      </span>
      <div className="flex h-2.5 w-[320px] max-w-full overflow-hidden rounded-sm bg-muted">
        {PARTS.map((p) => {
          const ms = partMs(split, p.id);
          if (ms <= 0) return null;
          return (
            <div
              key={p.id}
              className={p.className}
              style={{ width: `${(ms / total) * 100}%` }}
              title={`${p.label} ${formatDuration(ms)}`}
            />
          );
        })}
      </div>
      {PARTS.map((p) => (
        <span
          key={p.id}
          className="inline-flex items-center gap-1"
          data-testid={`otel-turn-time-${p.id}`}
        >
          <span className={`inline-block size-2 rounded-sm ${p.className}`} />
          {p.label} {formatDuration(partMs(split, p.id))}
        </span>
      ))}
    </div>
  );
}
