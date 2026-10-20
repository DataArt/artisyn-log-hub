import type { PricingFetchStatus } from '../../../../../models/pricing';

/** `YYYY-MM-DD HH:mm UTC` — the status line always shows UTC so admins in any zone agree. */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
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
  if (!status.lastAttemptAt)
    return 'Anthropic pricing checked daily · last check never';
  return `Anthropic pricing checked daily · last check ${formatUtc(status.lastAttemptAt)} · ${anthropicOutcome(status)}`;
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
