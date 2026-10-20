import { AlertTriangle } from 'lucide-react';
import type { RepositorySession } from '../../../models/repositories';
import type { ModelPricingMap } from '../../../models/pricing';
import type { SessionLogsData } from '../../api';
import type { ParsedSession } from './session-log/types';
import { buildAttributionChips } from './session-list/session-list-helpers';
import { formatDuration, formatInt } from './session-log/log-parser';
import { CostBreakdownTooltip } from '../../components/CostBreakdownTooltip';
import { NoPricingBadge } from '../../components/NoPricingBadge';
import { cn } from '../../lib/cn';
import { formatCost, formatLocalTimestamp } from '../../lib/format';
import { computeSessionInfoDerived } from './session-log/session-info-derive';

/**
 * One of the 5 mutually-exclusive states the session detail
 * attribution row can be in, checked in this fixed priority order (Visual/UX notes / Test
 * coverage plan): a repo with the feature off never shows the row at all; a `failed` last
 * run outranks every watermark comparison (still shown alongside whatever `values` a prior
 * successful evaluation left behind); `unevaluated` means no evaluation has ever landed
 * (`evaluatedWatermark === null`); `stale` means the last evaluation is behind the newest
 * known prompt watermark; `evaluated` is the steady state.
 */
export type SessionAttributionRowState =
  | 'off'
  | 'failed'
  | 'unevaluated'
  | 'stale'
  | 'evaluated';

export function deriveSessionAttributionState(
  sessionAttribution: SessionLogsData['sessionAttribution'] | null | undefined,
): SessionAttributionRowState {
  if (!sessionAttribution || !sessionAttribution.enabled) return 'off';
  if (sessionAttribution.lastRun?.outcome === 'failed') return 'failed';
  if (sessionAttribution.evaluatedWatermark === null) return 'unevaluated';
  if (
    sessionAttribution.currentWatermark !== null &&
    sessionAttribution.currentWatermark > sessionAttribution.evaluatedWatermark
  ) {
    return 'stale';
  }
  return 'evaluated';
}

/** "Evaluated at prompt N of M" when the latest known watermark is known, else the shorter
 * "Evaluated at prompt N" — `null` whenever there is nothing to report yet. */
export function formatWatermarkReceipt(
  evaluatedWatermark: number | null,
  currentWatermark: number | null,
): string | null {
  if (evaluatedWatermark === null) return null;
  return currentWatermark !== null
    ? `Evaluated at prompt ${evaluatedWatermark} of ${currentWatermark}`
    : `Evaluated at prompt ${evaluatedWatermark}`;
}

export interface AttributionDisplay {
  state: SessionAttributionRowState;
  chips: ReturnType<typeof buildAttributionChips>;
  label: string | null;
}

/**
 * One shared derivation of the attribution row's state/chips/label, so every surface that shows
 * it (this header, and the Session Summary tab's executive band) reads off the exact same
 * `sessionAttribution` payload the exact same way and can never disagree.
 */
export function buildAttributionDisplay(
  sessionAttribution: SessionLogsData['sessionAttribution'] | null | undefined,
): AttributionDisplay {
  const state = deriveSessionAttributionState(sessionAttribution);
  const chips = buildAttributionChips(
    sessionAttribution?.values,
    sessionAttribution?.attributes ?? [],
  );
  const watermarkReceipt = formatWatermarkReceipt(
    sessionAttribution?.evaluatedWatermark ?? null,
    sessionAttribution?.currentWatermark ?? null,
  );
  const label: string | null =
    state === 'unevaluated'
      ? 'Session attributes not yet evaluated'
      : state === 'failed'
        ? 'Last evaluation failed'
        : state === 'stale'
          ? (watermarkReceipt ?? 'Evaluated') + ' · stale'
          : watermarkReceipt;
  return { state, chips, label };
}

function HeaderStat({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
        {label}
      </p>
      <div className="text-xs font-mono font-medium">{children}</div>
    </div>
  );
}

export interface SessionDetailHeaderProps {
  session: RepositorySession;
  parsedLogs: ParsedSession | null;
  sessionCost: number | null;
  pricing: ModelPricingMap | null;
  /** `null`/`undefined` renders no attribution row, same as
   * `enabled: false` (a repo that predates the feature, or a fetch still in flight). */
  sessionAttribution?: SessionLogsData['sessionAttribution'] | null;
}

export function SessionDetailHeader({
  session,
  parsedLogs,
  sessionCost,
  pricing,
  sessionAttribution,
}: SessionDetailHeaderProps) {
  const { workflowEstimatedCost, workflowSubagentTokens, showWorkflowCostRow } =
    computeSessionInfoDerived(session, parsedLogs, pricing ?? undefined);
  // D2.3 — the server-priced sub-agent cost (0 when the session spawned none), never
  // telemetry minus main.
  const subAgentCost = session.costBreakdown.subagentCost;

  // The model this session ran on has no `model_pricing` row. Trust the server's
  // explicit reason first (it decides against the same normalised id the pricing join
  // uses); fall back to the loaded pricing map for a session the list row could not
  // classify. `pricing == null` means "still loading", which must not badge anything.
  const headerModel = parsedLogs?.summary.model ?? null;
  const unpriced =
    session.costUnavailableReason === 'unknown-model' ||
    (headerModel != null && pricing != null && pricing[headerModel] == null);

  // Attribution row derivation. `values`/`attributes` are already
  // orphan-stripped and resolved server-side, so the chip builder just
  // renders what it is given.
  const {
    state: attributionState,
    chips: attributionChips,
    label: attributionLabel,
  } = buildAttributionDisplay(sessionAttribution);

  return (
    <div className="shrink-0 border-b border-border bg-muted/20 px-4 py-3 flex flex-wrap items-start gap-x-5 gap-y-2">
      <HeaderStat label="Start">
        {formatLocalTimestamp(session.startTime)}
      </HeaderStat>
      <HeaderStat label="End">
        {formatLocalTimestamp(session.endTime)}
      </HeaderStat>
      {session.userEmail && (
        <HeaderStat label="User">
          <span className="font-normal">{session.userEmail}</span>
        </HeaderStat>
      )}

      {parsedLogs !== null && (
        <>
          <div className="h-6 w-px self-center bg-border" />
          {parsedLogs.summary.model && (
            <HeaderStat label="Model">
              <span
                className={
                  unpriced
                    ? 'inline-flex rounded border border-warning/50 bg-warning/15 px-1.5 py-0.5 font-mono text-warning-foreground dark:bg-warning/20 dark:text-warning'
                    : 'font-mono'
                }
                title={
                  unpriced
                    ? 'This model has no model_pricing row, so no cost can be computed for it.'
                    : undefined
                }
              >
                {parsedLogs.summary.model}
              </span>
            </HeaderStat>
          )}
          <HeaderStat label="Prompts">
            {parsedLogs.summary.promptCount}
          </HeaderStat>
          <HeaderStat label="Work time">
            {formatDuration(parsedLogs.summary.totalWorkTimeMs)}
          </HeaderStat>
          <HeaderStat
            label={
              subAgentCost > 0 ? (
                <>
                  Tokens in/out/cache{' '}
                  <span
                    className="text-muted-foreground/70 normal-case tracking-normal"
                    title="Sub-agent token usage is tracked separately and not included in these totals."
                  >
                    (main thread)
                  </span>
                </>
              ) : (
                'Tokens in/out/cache'
              )
            }
          >
            <span className="flex gap-2">
              <span>{formatInt(parsedLogs.summary.tokenBreakdown.input)}</span>
              <span className="text-muted-foreground">/</span>
              <span>{formatInt(parsedLogs.summary.tokenBreakdown.output)}</span>
              <span className="text-muted-foreground">/</span>
              <span className="text-muted-foreground/70" title="cache read">
                {formatInt(parsedLogs.summary.tokenBreakdown.cacheRead)}
              </span>
              <span className="text-muted-foreground">/</span>
              <span className="text-muted-foreground/70" title="cache write">
                {formatInt(parsedLogs.summary.tokenBreakdown.cacheWrite)}
              </span>
            </span>
          </HeaderStat>
          <HeaderStat label="Cost">
            <span className="inline-flex items-center gap-1">
              {sessionCost !== null &&
              parsedLogs !== null &&
              parsedLogs.summary.model &&
              pricing?.[parsedLogs.summary.model] ? (
                <CostBreakdownTooltip
                  breakdown={parsedLogs.summary.tokenBreakdown}
                  pricing={pricing[parsedLogs.summary.model]}
                  reportedCost={sessionCost}
                  subAgentCost={subAgentCost}
                  workflowEstimatedCost={workflowEstimatedCost}
                  workflowSubagentTokens={workflowSubagentTokens}
                  showWorkflowCostRow={showWorkflowCostRow}
                  hasCostDiscrepancy={session.hasCostDiscrepancy}
                >
                  <span className="cursor-help">{formatCost(sessionCost)}</span>
                </CostBreakdownTooltip>
              ) : unpriced ? (
                // An unpriced session that still has a metered OTEL
                // figure keeps showing it — hiding a real number would be a regression —
                // with the badge appended to say the token×price estimate is unavailable.
                <>
                  {sessionCost !== null && (
                    <span>{formatCost(sessionCost)}</span>
                  )}
                  <NoPricingBadge modelId={headerModel} />
                </>
              ) : (
                <span>
                  {sessionCost !== null ? formatCost(sessionCost) : '—'}
                </span>
              )}
              {subAgentCost > 0 && (
                <span
                  className="text-[10px] font-normal text-muted-foreground/70"
                  title="Includes sub-agent cost in addition to the main-thread total shown above."
                >
                  +sub-agents
                </span>
              )}
              {session.hasCostDiscrepancy && (
                <span
                  title="Telemetry-reported cost and the computed token×price estimate differ by 33% or more for this session."
                  className="cursor-help"
                >
                  <AlertTriangle className="size-3.5 shrink-0 text-amber-500" />
                </span>
              )}
            </span>
          </HeaderStat>
          {parsedLogs.summary.maxContextTokens !== null && (
            <HeaderStat label="Max context">
              {formatInt(parsedLogs.summary.maxContextTokens)}
            </HeaderStat>
          )}
          {parsedLogs.summary.skillsUsed.length > 0 && (
            <HeaderStat label="Skills">
              <span className="flex flex-wrap gap-1">
                {parsedLogs.summary.skillsUsed.map((skill) => (
                  <span
                    key={skill}
                    className="inline-flex items-center rounded-full border border-border bg-background px-2 py-0.5 font-normal"
                  >
                    {skill}
                  </span>
                ))}
              </span>
            </HeaderStat>
          )}
        </>
      )}
      {attributionState !== 'off' && (
        <div className="flex w-full flex-wrap items-center gap-1.5">
          {attributionChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-sky-500/10 text-sky-700 dark:text-sky-400"
            >
              {chip.text}
            </span>
          ))}
          {attributionLabel && (
            <span
              className={cn(
                'text-[11px] font-normal',
                attributionState === 'failed'
                  ? 'text-amber-700 dark:text-amber-400'
                  : 'text-muted-foreground/70',
              )}
              title={
                attributionState === 'failed'
                  ? (sessionAttribution?.lastRun?.failureReason ?? undefined)
                  : undefined
              }
            >
              {attributionLabel}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
