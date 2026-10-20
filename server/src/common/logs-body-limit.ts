/**
 * Body-size limit for the log-ingest routes, in the two shapes the code needs:
 * an express `limit` string (e.g. `'2500mb'`) and a raw byte count.
 *
 * Overridable via `LOGS_MAX_BODY_MB` so a test stand (the scenario stand pins `2`) can use a
 * small fixture value — exercising the real over/under-limit behaviour without allocating
 * a multi-GB body in a test (V8 caps a single JS string around ~512MB, well under the production
 * default).
 */
const DEFAULT_LOGS_MAX_BODY_MB = 2500;

function resolveLogsMaxBodyMb(): number {
  return Number(process.env.LOGS_MAX_BODY_MB) || DEFAULT_LOGS_MAX_BODY_MB;
}

/** Express/body-parser `limit` option, e.g. `'2500mb'`. */
export function getLogsBodyLimit(): string {
  return `${resolveLogsMaxBodyMb()}mb`;
}

/**
 * Same limit as {@link getLogsBodyLimit}, in bytes — for code that enforces the limit itself
 * (the gzip sniffer bounds both the compressed request and the inflated output with it).
 */
export function getLogsBodyLimitBytes(): number {
  return resolveLogsMaxBodyMb() * 1024 * 1024;
}
