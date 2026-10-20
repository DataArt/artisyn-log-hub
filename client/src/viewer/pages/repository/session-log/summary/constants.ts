/**
 * Layout constants for the Summary tab.
 *
 * Kept as named constants rather than inline magic numbers so a component and its e2e
 * assertion (`tests/e2e/summary-tab.spec.ts`) can never drift apart.
 */

/** Max height (px) of the embedded `ContextGrowthChart` wrapper in Section 3. */
export const SUMMARY_CHART_MAX_HEIGHT_PX = 420;

/** Max height (px) of the per-prompt cost table's scroll container. */
export const PROMPT_COST_TABLE_MAX_HEIGHT_PX = 320;

/** Max characters kept in a `PromptCostRow.promptText` before truncation. */
export const PROMPT_COST_TEXT_MAX_CHARS = 80;
