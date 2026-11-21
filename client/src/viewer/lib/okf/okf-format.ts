/**
 * Display formats of the OKF tab (summary line, hot files, explorer). Rules and rows:
 * `docs/knowledgebase/algorithms/okf-usage-counting.md`.
 *
 * Token counts arrive already divided by 4 on the server; nothing here converts bytes.
 */

/** Text of a value that is not known. */
const UNKNOWN = '—';

/**
 * Approximate tokens: `0` → `0`; from 1,000,000 → two decimals + `M`; from 100,000 → integer +
 * `K`; else one decimal + `K` (`3771600` → `3.77M`, `270000` → `270K`, `600` → `0.6K`).
 */
export function formatApproxTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 100_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1000).toFixed(1)}K`;
}

/**
 * Approximate KB cost in USD: `null` → `—`; `0` → `0.00`; below `0.005` → `< 0.01`; else two
 * decimals. `withSign` prefixes `$` (`$52.61`, `< $0.01`).
 */
export function formatApproxCost(v: number | null, withSign: boolean): string {
  if (v === null || !Number.isFinite(v)) return UNKNOWN;
  const sign = withSign ? '$' : '';
  if (v > 0 && v < 0.005) return `< ${sign}0.01`;
  return `${sign}${Math.max(0, v).toFixed(2)}`;
}

/** Total spend in USD: from 1000 → integer with `,` separators; else two decimals; always `$`. */
export function formatSpend(v: number): string {
  if (v >= 1000) {
    return `$${String(Math.round(v)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
  }
  return `$${v.toFixed(2)}`;
}

/**
 * KB cost as a share of the spend: `null` when either side is unknown or the spend is not
 * positive; from 10 % → integer; from 0.1 % → one decimal; below → `< 0.1 %`; zero → `0 %`.
 */
export function formatKbShare(
  cost: number | null,
  spend: number | null,
): string | null {
  if (cost === null || spend === null || !(spend > 0)) return null;
  const p = (cost / spend) * 100;
  if (!(p > 0)) return '0 %';
  if (p >= 10) return `${Math.round(p)} %`;
  if (p >= 0.1) return `${p.toFixed(1)} %`;
  return '< 0.1 %';
}
