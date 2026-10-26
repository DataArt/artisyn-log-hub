import { Lightbulb } from 'lucide-react';
import type {
  RepositorySession,
  SessionAttributionAttributeDef,
  SessionAttributionValues,
} from '../../../../models/repositories';
import { cn } from '../../../lib/cn';
import { formatCost, formatLocalTimestamp } from '../../../lib/format';
import { NoPricingBadge } from '../../../components/NoPricingBadge';
import { CostReconciliation } from '../../../components/CostReconciliation';
import { HoverPopover } from '../../../components/ViewportPopover';
import { PROMPT_HIDDEN_LABEL } from '../../../lib/access-mode-copy';

/**
 * True when this row's cost is missing *because* some model of the session tree has no
 * `model_pricing` row — the only case that earns the amber `$???` marker. `totalCost == null`
 * with no reason attached still means "no stats extracted yet" and keeps rendering
 * nothing, and a genuinely free session has a real `0` cost and prints `$0.0000`.
 */
export function isSessionCostUnpriced(session: RepositorySession): boolean {
  return (
    session.costUnavailableReason === 'unknown-model' &&
    session.totalCost == null
  );
}

export interface CostThresholds {
  outlierCost: number | null;
  maxNormal: number;
}

export function computeCostThresholds(
  sessions: RepositorySession[],
): CostThresholds | null {
  const costs = sessions
    .map((s) => s.totalCost)
    .filter((c): c is number => c != null);
  if (costs.length === 0) return null;
  costs.sort((a, b) => b - a);
  const highest = costs[0];
  const second = costs[1] ?? 0;
  const outlierCost =
    costs.length >= 2 && highest > second * 2 ? highest : null;
  const normalCosts = outlierCost != null ? costs.slice(1) : costs;
  const maxNormal = normalCosts[0] ?? 0;
  return { outlierCost, maxNormal };
}

export function costColorClass(
  cost: number,
  thresholds: CostThresholds | null,
): string {
  if (!thresholds || thresholds.maxNormal === 0) return 'text-muted-foreground';
  if (thresholds.outlierCost != null && cost >= thresholds.outlierCost)
    return 'text-red-800 dark:text-red-500';
  const pct = cost / thresholds.maxNormal;
  if (pct < 0.25) return 'text-emerald-600 dark:text-emerald-400';
  if (pct < 0.75) return 'text-blue-600 dark:text-blue-400';
  return 'text-orange-500 dark:text-orange-400';
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

/**
 * One active session-list attribute filter, applied client-side over
 * the `attribution` field already embedded in each `RepositorySession` rather than a
 * server round-trip through `attr=` — mirrors how `filterByUserEmail`/`hideHookSessions` already
 * filter the in-memory list. `'isnull'`/`'unattributed'` mirror the two special buckets from the
 * server's `attr=<key>:<op>` contract without literally sending that query
 * string: `'unattributed'` means "no attribution row at all" (session-wide, no `key`); `'isnull'`
 * means "evaluated, but this attribute came back not-determined" (including an empty
 * `string[]`, per the "empty array counts as null" rule).
 */
export type AttributeFilterSelection =
  | { kind: 'value'; key: string; value: string | number | boolean }
  | { kind: 'isnull'; key: string }
  | { kind: 'unattributed' };

export function sessionMatchesAttributeFilter(
  session: Pick<RepositorySession, 'attribution'>,
  filter: AttributeFilterSelection | null | undefined,
): boolean {
  if (!filter) return true;
  if (filter.kind === 'unattributed') {
    return !session.attribution;
  }
  const raw = session.attribution?.values[filter.key];
  if (filter.kind === 'isnull') {
    return raw == null || (Array.isArray(raw) && raw.length === 0);
  }
  return Array.isArray(raw)
    ? raw.includes(filter.value as string)
    : raw === filter.value;
}

export interface FilterVisibleSessionsOptions {
  filterByUserEmail?: string;
  hideHookSessions?: boolean;
  attributeFilter?: AttributeFilterSelection | null;
}

interface VisibilityFields {
  sessionId: string;
  userEmail?: string;
  isHookService?: boolean;
  attribution?: RepositorySession['attribution'];
}

export function filterVisibleSessions<T extends VisibilityFields>(
  sessions: T[] | undefined,
  {
    filterByUserEmail,
    hideHookSessions,
    attributeFilter,
  }: FilterVisibleSessionsOptions,
): T[] {
  let list = filterByUserEmail
    ? (sessions ?? []).filter((s) => s.userEmail === filterByUserEmail)
    : (sessions ?? []);
  if (hideHookSessions) {
    list = list.filter((s) => !s.isHookService);
  }
  if (attributeFilter) {
    list = list.filter((s) =>
      sessionMatchesAttributeFilter(s, attributeFilter),
    );
  }
  return list;
}

export interface HiddenByUser {
  email: string;
  count: number;
}

/**
 * Per-user counts of the sessions `filterByUserEmail` is currently hiding, so the list can say
 * what it is withholding instead of dropping rows silently (a personal repo can legitimately
 * carry sessions from several of the owner's own API keys — each key stamps `logs.user_id` at
 * first upload and it is never re-attributed).
 *
 * `hideHookSessions` is applied first on purpose: the returned total must equal exactly what
 * lifting the user filter would reveal, otherwise the notice promises rows that the hook-service
 * filter then swallows. Empty whenever no user filter is active — there is nothing hidden to
 * report.
 */
export function hiddenUserBreakdown<T extends VisibilityFields>(
  sessions: T[] | undefined,
  {
    filterByUserEmail,
    hideHookSessions,
    attributeFilter,
  }: FilterVisibleSessionsOptions,
): HiddenByUser[] {
  if (!filterByUserEmail) return [];
  const counts = new Map<string, number>();
  for (const s of filterVisibleSessions(sessions, {
    hideHookSessions,
    attributeFilter,
  })) {
    if (!s.userEmail || s.userEmail === filterByUserEmail) continue;
    counts.set(s.userEmail, (counts.get(s.userEmail) ?? 0) + 1);
  }
  return (
    [...counts]
      .map(([email, count]) => ({ email, count }))
      // Count desc, then email asc so the order is stable across renders.
      .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email))
  );
}

export interface AttributionChip {
  key: string;
  text: string;
}

/**
 * One chip per declared attribute this session's `attribution.values`
 * carries an entry for, keyed against the repo's currently resolved definitions (so a
 * renamed/retyped attribute's label/type always matches what the server actually evaluated
 * against — `values` itself is already orphan-stripped server-side). A key
 * entirely absent from `values` (predates that attribute's definition) renders no chip at all.
 *
 * `boolean`-typed attributes only ever produce a chip when the value is literally `true` —
 * `false`/`null` render nothing, matching the client test-coverage rule ("boolean shows only
 * when true") and keeping the row from turning into a wall of negatives. Every other declared
 * type renders "Label: Not determined" for `null` (or an empty `string[]`, which counts as
 * "not determined" the same way the server's `isnull` operator treats it) — never a silent
 * skip, since the session *was* evaluated and came back with nothing for that attribute.
 */
export function buildAttributionChips(
  values: SessionAttributionValues | null | undefined,
  definitions: SessionAttributionAttributeDef[],
): AttributionChip[] {
  if (!values) return [];
  const chips: AttributionChip[] = [];
  for (const def of definitions) {
    if (!(def.key in values)) continue;
    const raw = values[def.key];
    if (def.type === 'boolean') {
      if (raw === true) chips.push({ key: def.key, text: def.label });
      continue;
    }
    if (raw == null || (Array.isArray(raw) && raw.length === 0)) {
      chips.push({ key: def.key, text: `${def.label}: Not determined` });
      continue;
    }
    const text = Array.isArray(raw) ? raw.join(', ') : String(raw);
    chips.push({ key: def.key, text: `${def.label}: ${text}` });
  }
  return chips;
}

export interface SessionItemProps {
  session: RepositorySession;
  selected: boolean;
  /** `viaAdvisorBadge` is true only when the click landed on the Advisor lightbulb
   * badge itself — callers use it to decide whether to jump straight to the Advisor
   * tab, as opposed to a normal row click which should leave the tab alone. */
  onSelect: (s: RepositorySession, viaAdvisorBadge?: boolean) => void;
  thresholds: CostThresholds | null;
  /** Resolved attribute definitions — `undefined`/`[]` renders no chips at all,
   * same as a session with no attribution row. */
  attributeDefs?: SessionAttributionAttributeDef[];
}

export function SessionItem({
  session,
  selected,
  onSelect,
  thresholds,
  attributeDefs,
}: SessionItemProps) {
  const unpriced = isSessionCostUnpriced(session);
  // The cell shows the server's calculated total (main thread +
  // sub-agents + utility calls), falling back to the resolved `totalCost` when the main model
  // is unpriced but telemetry still metered a figure.
  const displayCost = session.costBreakdown.calculatedCost ?? session.totalCost;
  const attributionChips = buildAttributionChips(
    session.attribution?.values,
    attributeDefs ?? [],
  );
  return (
    <button
      data-testid="session-item"
      className={cn(
        'relative w-full border-b border-border text-left transition-colors hover:bg-accent/50',
        selected
          ? 'border-l-2 border-l-primary bg-accent py-3 pl-2.5 pr-3'
          : 'border-l-2 border-l-transparent p-3',
        // Amber tint + left rule for an unpriced row (wireframe: #fffbeb / #f59e0b).
        // The selected row keeps its primary rule and accent fill so selection stays
        // the stronger signal.
        unpriced && !selected && 'border-l-warning bg-warning/5',
      )}
      onClick={() => onSelect(session)}
    >
      {session.hasAdvisorAdvice && (
        <span
          role="button"
          aria-label="Open Advisor tab"
          className="absolute right-1.5 top-1.5"
          title="This session has cost-saving advice from the Advisor"
          onClick={(e) => {
            // Stop the row's own onClick from also firing — a plain row click
            // should select the session without forcing the tab to Advisor;
            // only a direct hit on this badge should jump there.
            e.stopPropagation();
            onSelect(session, true);
          }}
        >
          <Lightbulb
            data-testid="session-advisor-advice-badge"
            className="size-3.5 fill-yellow-200 text-yellow-400"
            aria-hidden="true"
          />
        </span>
      )}
      <p className="flex items-baseline gap-1 font-mono text-sm font-medium">
        {session.isFavorite && (
          <span className="text-[14px] leading-none" aria-label="Favorite">
            ⭐
          </span>
        )}
        {formatLocalTimestamp(session.endTime)}
        {displayCost != null && (
          <HoverPopover
            className="animate-in fade-in-0 zoom-in-95 px-3 py-2.5 text-xs"
            content={
              <CostReconciliation
                variant="compact"
                breakdown={session.costBreakdown}
              />
            }
          >
            <span
              data-testid="session-item-cost"
              className={cn(
                'ml-1 inline-flex items-baseline gap-1 cursor-help',
                costColorClass(displayCost, thresholds),
              )}
            >
              {' '}
              | {formatCost(displayCost)}
              {session.costBreakdown.mismatch && (
                <span
                  aria-label="Calculated and telemetry cost differ"
                  className="text-amber-500 dark:text-amber-400"
                >
                  ⚠
                </span>
              )}
            </span>
          </HoverPopover>
        )}
        {unpriced && (
          <span className="ml-1 flex items-baseline gap-1">
            <span className="text-muted-foreground/50">|</span>
            {/* `unpricedModels` names every unpriced model of the tree (main thread,
                sub-agents, utility calls); an older server sends none and the hint falls
                back to its id-less wording. */}
            <NoPricingBadge
              modelIds={session.costBreakdown.unpricedModels ?? []}
            />
          </span>
        )}
      </p>
      <p className="truncate text-sm text-muted-foreground">
        {truncate(session.firstPrompt ?? PROMPT_HIDDEN_LABEL, 50)}
      </p>
      <p className="mt-0.5 flex flex-wrap items-center gap-1">
        <span className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
          {session.gitBranch ?? session.sessionId}
        </span>
        {session.isHookService && (
          <span className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400">
            hook-service
          </span>
        )}
        {session.hasWorkflow && (
          <span className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-purple-500/10 text-purple-700 dark:text-purple-400">
            ⚡ Workflow
          </span>
        )}
      </p>
      {attributionChips.length > 0 && (
        <p className="mt-0.5 flex flex-wrap items-center gap-1">
          {attributionChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-block rounded px-1.5 py-0.5 font-mono text-xs bg-sky-500/10 text-sky-700 dark:text-sky-400"
            >
              {chip.text}
            </span>
          ))}
        </p>
      )}
    </button>
  );
}
