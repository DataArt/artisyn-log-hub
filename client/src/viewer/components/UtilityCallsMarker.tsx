/**
 * The muted "excl. utility calls (no OTEL)" marker next to a session cost (2026-10-30
 * otel-shared-receiver, DD-30, Visual/UX notes). Shown when the session's
 * `costBreakdown.costExcludesUtilityCalls` is true: the root has no OTEL API calls and its OTEL
 * state is not `ok`, so Claude Code's utility calls (visible only through OTEL) are not in the
 * cost. The ⓘ carries the tooltip and opens the in-app help on the "OTEL tab is empty"
 * troubleshooting section. Texts live in `lib/cost-hints.ts`.
 */
import { Info } from 'lucide-react';
import { OtelHelpLink } from '../pages/repository/otel/OtelHelpLink';
import { OTEL_HELP_ANCHORS } from '../pages/repository/otel/otel.constants';
import {
  UTILITY_CALLS_MARKER_HINT,
  UTILITY_CALLS_MARKER_TEXT,
} from '../lib/cost-hints';

export function UtilityCallsMarker() {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] font-normal normal-case tracking-normal text-muted-foreground"
      data-testid="utility-calls-marker"
    >
      {UTILITY_CALLS_MARKER_TEXT}
      <span title={UTILITY_CALLS_MARKER_HINT} className="inline-flex">
        <OtelHelpLink
          anchor={OTEL_HELP_ANCHORS.troubleshooting}
          className="inline-flex text-muted-foreground hover:text-foreground"
        >
          <Info className="size-3" aria-label={UTILITY_CALLS_MARKER_HINT} />
        </OtelHelpLink>
      </span>
    </span>
  );
}
