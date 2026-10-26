import type { PricingFetchStatus } from '../../../../../models/pricing';

/** `YYYY-MM-DD HH:mm UTC` — the status line always shows UTC so admins in any zone agree. */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** "next check in 5 h" / "in 20 min" / "within the hour" (the scheduler ticks hourly). */
function nextCheckText(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms < 60_000) return 'next check within the hour';
  if (ms < 3_600_000) return `next check in ${Math.round(ms / 60_000)} min`;
  return `next check in ${Math.round(ms / 3_600_000)} h`;
}

function count(status: PricingFetchStatus, key: string): number {
  return status.lastCounts?.[key] ?? 0;
}

function anthropicOutcome(status: PricingFetchStatus): string {
  if (status.lastResult === 'failed') {
    return `check failed: ${status.lastError ?? 'unknown error'}`;
  }
  if (status.lastResult === 'changed') {
    const n = count(status, 'changed');
    return `${n} ${n === 1 ? 'model' : 'models'} updated`;
  }
  return 'no changes';
}

function anthropicText(status: PricingFetchStatus): string {
  const next = nextCheckText(status.nextCheckAt);
  const head = next
    ? `Anthropic pricing checked daily · ${next}`
    : 'Anthropic pricing checked daily';
  if (!status.lastAttemptAt) return `${head} · last check never`;
  return `${head} · last check ${formatUtc(status.lastAttemptAt)} · ${anthropicOutcome(status)}`;
}

function openRouterText(status: PricingFetchStatus): string {
  if (!status.lastAttemptAt) return 'OpenRouter last import never';
  const when = formatUtc(status.lastAttemptAt);
  if (status.lastResult === 'failed') {
    return `OpenRouter last import ${when} (failed: ${status.lastError ?? 'unknown error'})`;
  }
  return `OpenRouter last import ${when} (${count(status, 'updated')} updated, ${count(status, 'skippedOverride')} skipped)`;
}

interface Props {
  anthropic: PricingFetchStatus;
  openrouter: PricingFetchStatus;
}

/** One-line status of the daily Anthropic fetch and the last OpenRouter import. */
export function ModelPricingStatusLine({ anthropic, openrouter }: Props) {
  return (
    <p
      className="text-xs text-muted-foreground"
      data-testid="model-pricing-status-line"
    >
      {anthropicText(anthropic)} · {openRouterText(openrouter)}
    </p>
  );
}
