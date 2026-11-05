/**
 * The account a session's OTEL data reports (2026-11-03 otel-cost-attribution, DD-10, DD-18,
 * wireframe `session-otel-plan-notional.svg`):
 *
 * - `SessionOtelAccount` — under the session OTEL status line: muted "Account:" with one chip per
 *   reported value (plan, seat, provider, base URL; null values are left out), then a blue info
 *   strip with `OTEL_PLAN_NOTE` and a "What is this?" help link when a plan is reported. Renders
 *   nothing when the route sent no account (`plan` null or absent — an older server).
 * - `SessionOtelPlanChip` — the `plan: <value>` chip of the session "OTEL cost" tile, with the
 *   same note as its tooltip.
 */
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/ui/tooltip';
import type { OtelSessionPlan } from '../../../../../models/repositories';
import { OtelHelpLink } from '../../otel/OtelHelpLink';
import { OTEL_HELP_ANCHORS, OTEL_PLAN_NOTE } from '../../otel/otel.constants';

const CHIP_CLASSES =
  'rounded bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-700 ring-1 ring-slate-100 dark:bg-slate-900/40 dark:text-slate-300 dark:ring-slate-800';

export interface SessionOtelAccountProps {
  plan: OtelSessionPlan | null | undefined;
}

export function SessionOtelAccount({ plan }: SessionOtelAccountProps) {
  if (!plan) return null;
  const chips: [string, string, string | null][] = [
    ['plan', 'plan', plan.plan],
    ['seat', 'seat', plan.seatType],
    ['provider', 'provider', plan.provider],
    ['baseUrl', 'base URL', plan.customBaseUrl],
  ];
  const shown = chips.filter(
    (c): c is [string, string, string] => c[2] !== null && c[2] !== '',
  );
  if (shown.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="session-otel-account">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Account:</span>
        {shown.map(([key, label, value]) => (
          <span
            key={key}
            className={CHIP_CLASSES}
            data-testid={`session-otel-account-${key}`}
          >
            {label}: {value}
          </span>
        ))}
      </div>
      {plan.plan && (
        <div
          className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:bg-blue-950/40 dark:text-blue-200"
          data-testid="session-otel-plan-note"
        >
          <span>{OTEL_PLAN_NOTE(plan.plan)}</span>
          <OtelHelpLink anchor={OTEL_HELP_ANCHORS.plan}>
            What is this?
          </OtelHelpLink>
        </div>
      )}
    </div>
  );
}

/** The `plan: <value>` chip of the session "OTEL cost" tile; null when no plan is reported. */
export function SessionOtelPlanChip({
  plan,
}: {
  plan: OtelSessionPlan | null | undefined;
}) {
  if (!plan?.plan) return null;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          className={CHIP_CLASSES}
          data-testid="otel-kpi-plan-chip"
        >
          plan: {plan.plan}
        </TooltipTrigger>
        <TooltipContent className="max-w-[360px]">
          {OTEL_PLAN_NOTE(plan.plan)}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
