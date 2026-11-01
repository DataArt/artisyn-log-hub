/**
 * The slim amber banner above the session OTEL chart when the root's `otel-status` state is
 * `partial` (2026-10-30 otel-shared-receiver, Visual/UX notes): "Only <present> arrived —
 * <missing> missing (reason …). Help →". A signal counts as present when the receiver had at
 * least one of its records at Stop.
 */
import { TriangleAlert } from 'lucide-react';
import type { OtelStatusDto } from '../../../../models/repositories';
import { OtelHelpLink } from './OtelHelpLink';
import { OTEL_REASON_MESSAGES } from './otel.constants';

export interface OtelPartialBannerProps {
  status: OtelStatusDto;
}

const SIGNALS = ['logs', 'metrics', 'spans'] as const;

/** `a`, `a and b`, `a, b and c`. */
function joinSignals(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function otelPartialBannerText(status: OtelStatusDto): string {
  const present = SIGNALS.filter((s) => status.received[s] > 0);
  const missing = SIGNALS.filter((s) => status.received[s] <= 0);
  const head =
    present.length > 0
      ? `Only ${joinSignals(present)} arrived`
      : 'Only part of the OTEL data arrived';
  const tail = missing.length > 0 ? ` — ${joinSignals(missing)} missing` : '';
  const reason = status.reason !== null ? ` (reason ${status.reason})` : '';
  return `${head}${tail}${reason}.`;
}

export function OtelPartialBanner({ status }: OtelPartialBannerProps) {
  const message = OTEL_REASON_MESSAGES[status.reason ?? 'unknown'];
  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
      data-testid="otel-partial-banner"
      data-reason={status.reason ?? 'unknown'}
    >
      <TriangleAlert className="size-3.5 shrink-0" />
      <span>{otelPartialBannerText(status)}</span>
      <OtelHelpLink anchor={message.helpAnchor} className="text-xs">
        Help →
      </OtelHelpLink>
    </div>
  );
}
