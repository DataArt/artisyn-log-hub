const DEFAULT_SESSION_POLL_INTERVAL_MS = 15_000;

/**
 * Parses the session-poll interval from a raw env string. Falls back to
 * `15_000` when `raw` is unset, non-numeric, or non-positive.
 */
export function parsePollIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SESSION_POLL_INTERVAL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_SESSION_POLL_INTERVAL_MS;
  }
  return parsed;
}

export const SESSION_POLL_INTERVAL_MS = parsePollIntervalMs(
  import.meta.env.VITE_SESSION_POLL_INTERVAL_MS,
);
