/**
 * The coverage banner of the repository and team OTEL tabs (2026-10-30 otel-shared-receiver,
 * Visual/UX notes, `wireframes/repo-otel-tab-coverage.svg`): "OTEL for N of M sessions — totals
 * and averages below cover these N sessions only; the other M−N are not counted as zero.", then
 * the roots without OTEL as one chip per reason (coloured per DD-31, tooltip = the reason's title
 * and body) and the "Why no OTEL?" help link.
 *
 * Hidden when every root has OTEL (N = M) or there is no root in scope. With `onReasonFilter`
 * a chip is a button that filters the sessions list by its reason; without it (team tab) the
 * chips are plain labels.
 */
import { Info } from 'lucide-react';
import type {
  OtelCoverage,
  OtelReasonKey,
} from '../../../../models/repositories';
import { cn } from '@/lib/cn';
import { formatCount } from './otel-format';
import { OtelHelpLink } from './OtelHelpLink';
import {
  OTEL_HELP_ANCHORS,
  OTEL_REASON_CHIP_CLASSES,
  OTEL_REASON_MESSAGES,
  otelReasonShortLabel,
  otelReasonTooltip,
} from './otel.constants';

export interface OtelCoverageBannerProps {
  coverage: OtelCoverage;
  /** Chip click: filter the sessions list by this reason (repository tab only). */
  onReasonFilter?: (reason: OtelReasonKey) => void;
}

/** The banner text for N of M (Visual/UX notes). */
export function otelCoverageText(coverage: OtelCoverage): string {
  const n = coverage.otelSessions;
  const m = coverage.totalSessions;
  return `OTEL for ${formatCount(n)} of ${formatCount(m)} sessions — totals and averages below cover these ${formatCount(n)} sessions only; the other ${formatCount(m - n)} are not counted as zero.`;
}

export function OtelCoverageBanner({
  coverage,
  onReasonFilter,
}: OtelCoverageBannerProps) {
  if (
    coverage.totalSessions === 0 ||
    coverage.otelSessions >= coverage.totalSessions
  ) {
    return null;
  }
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
      data-testid="otel-coverage-banner"
    >
      <p className="flex items-start gap-1.5">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span data-testid="otel-coverage-text">
          {otelCoverageText(coverage)}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-1.5 pl-5">
        {coverage.reasons.length > 0 && <span>Without OTEL:</span>}
        {coverage.reasons.map(({ reason, count }) => {
          const tone = OTEL_REASON_MESSAGES[reason].tone;
          const className = cn(
            'rounded-full border px-2 py-0.5 text-xs',
            OTEL_REASON_CHIP_CLASSES[tone],
          );
          const label = `${otelReasonShortLabel(reason)} · ${formatCount(count)}`;
          return onReasonFilter ? (
            <button
              key={reason}
              type="button"
              className={cn(className, 'hover:brightness-95')}
              title={`${otelReasonTooltip(reason)} Click to list these sessions.`}
              onClick={() => onReasonFilter(reason)}
              data-testid="otel-coverage-chip"
              data-reason={reason}
            >
              {label}
            </button>
          ) : (
            <span
              key={reason}
              className={className}
              title={otelReasonTooltip(reason)}
              data-testid="otel-coverage-chip"
              data-reason={reason}
            >
              {label}
            </span>
          );
        })}
        <OtelHelpLink
          anchor={OTEL_HELP_ANCHORS.troubleshooting}
          className="text-xs"
        >
          Why no OTEL?
        </OtelHelpLink>
      </div>
    </div>
  );
}
