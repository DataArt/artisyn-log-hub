import { formatCost } from './format';

/**
 * User-facing texts for a session cost Log Hub cannot trust or cannot compute.
 *
 * Principle: wherever a session cost is shown, the user sees either a trusted number or
 * `$???`, with a hint that says why and what to do. The shown cost is always the one Log Hub
 * computes from its own price table (`otel-cost-selection` algorithm); the OTEL figure Claude
 * Code reports is only a cross-check.
 */

/** What an unknown cost renders as. */
export const UNKNOWN_COST_TEXT = '$???';

/**
 * The `$???` hint: which models have no price in Log Hub and how to fix it.
 * `modelIds` may be empty when the surface does not know the ids.
 */
export function noPriceHint(modelIds: readonly string[]): string {
  if (modelIds.length === 0) {
    return (
      "No price for this session's model in Log Hub, so the cost cannot be computed. " +
      'Update the model prices so that the model is there ' +
      '(Admin → Model Pricing → Fetch Anthropic prices now, or set a price).'
    );
  }
  const ids = modelIds.join(', ');
  const noun = modelIds.length === 1 ? 'model' : 'models';
  const verb = modelIds.length === 1 ? 'is' : 'are';
  return (
    `No price for ${noun} ${ids} in Log Hub, so the cost cannot be computed. ` +
    `Update the model prices so that ${ids} ${verb} there ` +
    '(Admin → Model Pricing → Fetch Anthropic prices now, or set a price).'
  );
}

/**
 * The discrepancy-icon hint (OTEL total vs the computed cost differ by 33%+): both numbers
 * and the likely causes, each with its action. The shown cost stays the computed one.
 */
export function costDiscrepancyHint(
  telemetryCost: number | null | undefined,
  calculatedCost: number | null | undefined,
): string {
  return (
    `Claude Code reported ${formatCost(telemetryCost)}, Log Hub computed ` +
    `${formatCost(calculatedCost)} from its price table. Usually Claude Code doesn't know ` +
    'this model and priced it as another one (update Claude Code), or the Log Hub price is ' +
    'outdated (check Admin → Model Pricing).'
  );
}

/**
 * The model ids a `$???` hint names: the server's list when it sent one, else the surface's
 * own fallback (e.g. the main model) — never an empty string.
 */
export function unpricedModelIds(
  serverIds: readonly string[] | null | undefined,
  fallback?: string | null,
): string[] {
  if (serverIds != null && serverIds.length > 0) return [...serverIds];
  return fallback ? [fallback] : [];
}

/**
 * The utility-call marker next to a session cost whose root has no OTEL API calls and an OTEL
 * state other than `ok` (2026-10-30 otel-shared-receiver, DD-30, `costExcludesUtilityCalls`):
 * the cost is still the Log Hub-computed one, but Claude Code's utility calls are missing from it.
 */
export const UTILITY_CALLS_MARKER_TEXT = 'excl. utility calls (no OTEL)';

/** The marker's ⓘ tooltip (wireframe `session-otel-tab-no-data.svg`). */
export const UTILITY_CALLS_MARKER_HINT =
  'Log Hub-computed cost. Claude Code utility calls are not in the transcript and are only ' +
  'visible via OTEL. Why no OTEL? Click for help.';
