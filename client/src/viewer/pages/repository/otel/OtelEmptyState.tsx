/**
 * Empty states of the OTEL tabs (2026-10-30 otel-tabs-traces, `otel-empty-states.svg`, DD-15).
 * Neutral tone, never an error: an old-hook session is not "broken".
 *
 * - `A` — no OTEL data at all (OTEL off, a pre-OTEL hook, an imported session);
 * - `B` — OTEL logs but no traces (session tab, replaces the waterfall);
 * - `C` — no OTEL data in the selected period / filters (repository and team tabs), offering a
 *   wider period.
 * - `reason` — (2026-10-30 otel-shared-receiver, `repo-otel-tab-coverage.svg`) the repository /
 *   team scope has sessions but none of them carries OTEL (N = 0 of M): the dominant reason's
 *   title and body (`OTEL_REASON_MESSAGES`, DD-31), "Show 1 month" and the help link. Replaces
 *   the chart and the tiles.
 */
import { Hourglass, CircleSlash } from 'lucide-react';
import { otelHookIsLive } from './otel-format';
import { OtelHelpLink } from './OtelHelpLink';
import type { OtelCoverage } from '../../../../models/repositories';
import { formatCount } from './otel-format';
import { OTEL_HELP_ANCHORS, OTEL_REASON_MESSAGES } from './otel.constants';

export type OtelEmptyStateProps =
  | { variant: 'A'; scope: 'session' | 'repository' | 'team' }
  | { variant: 'B'; hookVersion: string | null }
  | { variant: 'C'; scope: 'repository' | 'team'; onShowMonth?: () => void }
  | {
      variant: 'reason';
      scope: 'repository' | 'team';
      coverage: OtelCoverage;
      onShowMonth?: () => void;
    };

const SCOPE_NOUN = {
  session: 'session',
  repository: 'repository',
  team: 'team',
} as const;

export function OtelEmptyState(props: OtelEmptyStateProps) {
  if (props.variant === 'reason') {
    return (
      <OtelReasonEmptyState
        coverage={props.coverage}
        onShowMonth={props.onShowMonth}
      />
    );
  }
  if (props.variant === 'B') {
    const live = otelHookIsLive(props.hookVersion);
    return (
      <div
        className="flex flex-col items-center gap-2 rounded-md border border-dashed px-6 py-8 text-center"
        data-testid="otel-empty-B"
      >
        <Hourglass className="size-6 text-muted-foreground" />
        <p className="text-sm font-semibold">No traces for this session</p>
        <p className="max-w-[460px] text-xs text-muted-foreground">
          {live
            ? 'Traces are off for this session. Charts and hidden calls above come from OTEL logs.'
            : 'No traces — upgrade the hook. This session was recorded by a hook without trace support; charts and hidden calls above come from OTEL logs.'}
        </p>
        <OtelHelpLink
          variant="button"
          anchor={live ? OTEL_HELP_ANCHORS.enable : OTEL_HELP_ANCHORS.upgrade}
        >
          {live ? 'How to enable traces' : 'Upgrade the hook'}
        </OtelHelpLink>
      </div>
    );
  }

  const isA = props.variant === 'A';
  const noun = SCOPE_NOUN[props.scope];
  return (
    <div
      className="mx-auto flex max-w-[560px] flex-col items-center gap-2 rounded-md border border-dashed px-6 py-10 text-center"
      data-testid={`otel-empty-${props.variant}`}
    >
      <CircleSlash className="size-6 text-muted-foreground" />
      <p className="text-sm font-semibold">
        {isA ? `No OTEL data for this ${noun}` : 'No OTEL data in this period'}
      </p>
      <p className="text-xs text-muted-foreground">
        {isA
          ? props.scope === 'session'
            ? 'This session was recorded without OpenTelemetry, so there are no cost charts or traces here. Cost, logs and every other tab work as before.'
            : `No session of this ${noun} carries OTEL records yet. Cost and every other tab work as before.`
          : 'No session in the selected period and filters carries OTEL records. Widen the period to see older ones.'}
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {props.variant === 'C' && props.onShowMonth && (
          <button
            type="button"
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100"
            onClick={props.onShowMonth}
            data-testid="otel-show-month"
          >
            Show 1 month
          </button>
        )}
        <OtelHelpLink variant="button" anchor={OTEL_HELP_ANCHORS.enable}>
          How to enable OTEL
        </OtelHelpLink>
        {isA && (
          <OtelHelpLink variant="button" anchor={OTEL_HELP_ANCHORS.upgrade}>
            Upgrade the hook
          </OtelHelpLink>
        )}
      </div>
    </div>
  );
}

/** The `reason` variant: 0 of M sessions carry OTEL; the most frequent reason explains why. */
function OtelReasonEmptyState({
  coverage,
  onShowMonth,
}: {
  coverage: OtelCoverage;
  onShowMonth?: () => void;
}) {
  // The server sorts reasons by count, most frequent first (DD-29).
  const dominant = coverage.reasons[0]?.reason ?? 'no-status';
  const message = OTEL_REASON_MESSAGES[dominant];
  return (
    <div
      className="mx-auto flex max-w-[560px] flex-col items-center gap-2 rounded-md border border-dashed px-6 py-10 text-center"
      data-testid="otel-empty-reason"
      data-reason={dominant}
    >
      <CircleSlash className="size-6 text-muted-foreground" />
      <p className="text-sm font-semibold">
        No OTEL data in this period (0 of {formatCount(coverage.totalSessions)}{' '}
        session{coverage.totalSessions === 1 ? '' : 's'})
      </p>
      <p className="text-xs text-muted-foreground">
        Most sessions report: {message.title}. {message.body}
      </p>
      <div className="mt-1 flex flex-wrap justify-center gap-2">
        {onShowMonth && (
          <button
            type="button"
            className="rounded-md border border-blue-300 bg-blue-50 px-3 py-1.5 text-sm text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
            onClick={onShowMonth}
            data-testid="otel-show-month"
          >
            Show 1 month
          </button>
        )}
        <OtelHelpLink variant="button" anchor={message.helpAnchor}>
          Why no OTEL? (help)
        </OtelHelpLink>
      </div>
    </div>
  );
}
