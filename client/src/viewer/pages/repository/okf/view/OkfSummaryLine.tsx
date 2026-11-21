/**
 * The summary line of the OKF view: how many sessions (repo tab) or agents (session tab) read
 * the KB, how many tokens of context that was, what it cost and — when the spend is known — its
 * share of the spend; the reference snapshot sits at the end of the line.
 */
import {
  formatApproxCost,
  formatApproxTokens,
  formatKbShare,
  formatSpend,
} from '@/lib/okf/okf-format';
import { localDayKey } from '@/lib/format';
import type {
  OkfUsageSnapshot,
  OkfUsageSummary,
  OkfUsageUnit,
} from '../../../../../models/repositories';
import { OkfTip } from './OkfTip';
import {
  OKF_SUMMARY_LEAD,
  OKF_TIP_COST,
  OKF_TIP_SNAPSHOT,
  okfCostCoverageText,
} from './okf-view-text';

function Dot() {
  return <span className="text-muted-foreground">·</span>;
}

export function OkfSummaryLine({
  unit,
  summary,
  snapshot,
}: {
  unit: OkfUsageUnit;
  summary: OkfUsageSummary;
  snapshot: OkfUsageSnapshot;
}) {
  const { lead, noun } = OKF_SUMMARY_LEAD[unit];
  const share = formatKbShare(summary.cost, summary.spend);
  const day = localDayKey(snapshot.takenAt);
  const snapshotOrigin = [snapshot.branch, day].filter(Boolean).join(', ');

  return (
    <div
      data-testid="okf-summary"
      className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-foreground"
    >
      <span data-testid="okf-summary-ratio">
        {lead}{' '}
        <strong className="font-semibold tabular-nums">
          {summary.unitsRead} of {summary.unitsTotal}
        </strong>{' '}
        {noun}
      </span>
      <Dot />
      <span data-testid="okf-summary-tokens">
        <strong className="font-semibold tabular-nums">
          ≈ {formatApproxTokens(summary.tokens)} tokens
        </strong>{' '}
        of context
      </span>
      <Dot />
      <span className="inline-flex items-baseline gap-1">
        <strong
          data-testid="okf-summary-cost"
          className="font-semibold tabular-nums"
        >
          ≈ {formatApproxCost(summary.cost, true)}
        </strong>
        {share !== null && summary.spend !== null ? (
          <span
            data-testid="okf-summary-share"
            className="tabular-nums text-muted-foreground"
          >
            (≈ {share} of {formatSpend(summary.spend)} spend)
          </span>
        ) : null}
        <OkfTip testId="okf-tip-cost" label="About the KB cost">
          <p>{OKF_TIP_COST}</p>
          <p className="mt-1">
            {okfCostCoverageText(summary.readsWithoutCost)}
          </p>
        </OkfTip>
      </span>
      <span className="ml-auto inline-flex items-baseline gap-1 pl-4 text-xs text-muted-foreground">
        <span data-testid="okf-summary-snapshot">
          {snapshotOrigin ? `snapshot from ${snapshotOrigin}` : 'snapshot'}
        </span>
        <OkfTip testId="okf-tip-snapshot" label="About the snapshot">
          {OKF_TIP_SNAPSHOT}
        </OkfTip>
      </span>
    </div>
  );
}
