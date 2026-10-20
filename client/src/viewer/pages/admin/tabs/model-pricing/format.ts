/** Formats a USD-per-million-tokens rate for the admin model-pricing table. */
export function formatUsdPerMillion(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Web search is billed per request, not per million tokens, so it needs its own formatter —
 * at 2 decimals the $0.01 rate would round to the same string as a $/M column and read as if
 * it were one.
 */
export function formatUsdPerRequest(value: number): string {
  return `$${value.toFixed(4)}`;
}
