/**
 * The plan mix under the Total OTEL cost tile of the repository and team tabs (2026-11-03
 * otel-cost-attribution, DD-9, DD-18, Visual/UX notes): "Mix of plans: max · 12 sessions · $96.40
 * — pro · 3 · $10.20 — not reported · 40 · $172.35", then `OTEL_PLAN_EXPLANATION`. Rows come in
 * the server's order (cost descending, not reported last). Renders nothing when no row carries a
 * plan — including an older server that sends no `planMix`.
 */
import type { OtelPlanMixRow } from '../../../../models/repositories';
import { formatCount, formatMicrosUsd } from './otel-format';
import { OTEL_PLAN_EXPLANATION } from './otel.constants';

/** The "Mix of plans: …" text; null when no row has a non-null plan. */
export function otelPlanMixText(
  planMix: readonly OtelPlanMixRow[] | undefined,
): string | null {
  if (!planMix || !planMix.some((r) => r.plan !== null)) return null;
  const parts = planMix.map((r, i) => {
    const sessions =
      i === 0
        ? `${formatCount(r.sessions)} session${r.sessions === 1 ? '' : 's'}`
        : formatCount(r.sessions);
    return `${r.plan ?? 'not reported'} · ${sessions} · ${formatMicrosUsd(r.costUsdMicros)}`;
  });
  return `Mix of plans: ${parts.join(' — ')}`;
}

export function OtelPlanMix({
  planMix,
}: {
  planMix: readonly OtelPlanMixRow[] | undefined;
}) {
  const text = otelPlanMixText(planMix);
  if (text === null) return null;
  return (
    <span className="mt-1 block" data-testid="otel-plan-mix">
      <span className="block">{text}</span>
      <span className="block text-[10px]">{OTEL_PLAN_EXPLANATION}</span>
    </span>
  );
}
