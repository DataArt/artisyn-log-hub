/**
 * The "slow updates" banner of the OTEL tabs (2026-10-30 otel-tabs-traces, DD-15 / FR-22),
 * linking to the matching section of the in-app help (`user-docs/otel-tab.md`).
 *
 * | Reason | Text |
 * |---|---|
 * | `old-hook` (and a slow repository / team) | Data updates slowly — update the hook |
 * | `realtime-off` | Data updates slowly — the hook's realtime channel is off or cannot reach the server |
 */
import { Clock } from 'lucide-react';
import type { OtelSlowReason } from '../../../../models/repositories';
import { OtelHelpLink } from './OtelHelpLink';
import { OTEL_HELP_ANCHORS } from './otel.constants';

export interface OtelSlowUpdatesBannerProps {
  reason: OtelSlowReason;
  hookVersion: string | null;
}

export function otelSlowBannerText(reason: OtelSlowReason): string {
  return reason === 'realtime-off'
    ? "Data updates slowly — the hook's realtime channel is off or cannot reach the server"
    : 'Data updates slowly — update the hook';
}

export function OtelSlowUpdatesBanner({
  reason,
  hookVersion,
}: OtelSlowUpdatesBannerProps) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      data-testid="otel-slow-banner"
      data-reason={reason}
    >
      <Clock className="size-3.5 shrink-0" />
      <span>{otelSlowBannerText(reason)}</span>
      {reason === 'old-hook' && hookVersion && (
        <span className="text-amber-700">(hook {hookVersion})</span>
      )}
      <OtelHelpLink
        anchor={
          reason === 'old-hook'
            ? OTEL_HELP_ANCHORS.upgrade
            : OTEL_HELP_ANCHORS.realtime
        }
        className="text-xs"
      >
        {reason === 'old-hook'
          ? 'How to upgrade'
          : 'About the realtime channel'}
      </OtelHelpLink>
    </div>
  );
}
