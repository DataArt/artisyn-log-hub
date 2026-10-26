import type { TimelineSession } from '../../../../models/repositories';
import { ViewportPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';
import { UNKNOWN_COST_TEXT } from '../../../lib/cost-hints';

interface Props {
  session: TimelineSession;
  x: number;
  y: number;
}

function formatDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  if (h > 0)
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function SessionTooltip({ session, x, y }: Props) {
  const start = new Date(session.startTime);
  const end = new Date(session.endTime);
  const durationMs = end.getTime() - start.getTime();

  const dateStr = start.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
  });
  const startStr = start.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  const endStr = end.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  const prompt = session.firstPrompt ?? PROMPT_HIDDEN_LABEL;
  const promptPreview = prompt.length > 50 ? prompt.slice(0, 50) + '…' : prompt;

  const rows: { label: string; value: string }[] = [];

  rows.push({
    label: 'Work time',
    value: formatDuration(session.workTimeMs),
  });
  if (session.totalCost != null) {
    rows.push({ label: 'Cost', value: formatCost(session.totalCost) });
  } else if (session.costUnavailableReason === 'unknown-model') {
    // The cost cannot be computed: say so and name the models, never show a number.
    const ids = session.unpricedModels ?? [];
    rows.push({
      label: 'Cost',
      value:
        ids.length > 0
          ? `${UNKNOWN_COST_TEXT} (no price in Log Hub for ${ids.join(', ')})`
          : `${UNKNOWN_COST_TEXT} (no price in Log Hub for this session's model)`,
    });
  }
  if (session.userEmail) {
    rows.push({ label: 'User', value: session.userEmail });
  }
  if (session.gitBranch) {
    rows.push({ label: 'Branch', value: session.gitBranch });
  }

  return (
    <ViewportPopover x={x} y={y} offset={12} maxWidth={320}>
      <div className="text-xs text-muted-foreground mb-1">
        {dateStr} {startStr}–{endStr} · {formatDuration(durationMs)}
      </div>
      {promptPreview && (
        <div className="font-medium mb-1 break-words">{promptPreview}</div>
      )}
      {rows.length > 0 && (
        <div className="flex flex-col gap-0.5 mt-1 border-t border-border pt-1">
          {rows.map(({ label, value }) => (
            <div key={label} className="flex justify-between gap-4 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono truncate max-w-[160px]">{value}</span>
            </div>
          ))}
        </div>
      )}
    </ViewportPopover>
  );
}
