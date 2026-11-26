// Constants of the OTEL facts feature (2026-10-30 otel-tabs-traces): the realtime ingest route,
// the projection drain and the repository / session / team OTEL read routes. The tables live in
// migration 0078 (otel_calls, otel_spans, otel_cost_buckets, otel_session_state,
// otel_reclass_queue, logs_otel.otel_projection_version).

/** Lowest hook version with OTEL traces and the realtime channel (DD-15). */
export const OTEL_LIVE_HOOK_MIN_VERSION = '2.29.0';

/** A session counts as live / realtime while its last OTEL data is newer than this (DD-14, DD-20). */
export const OTEL_SESSION_ENDED_MS = 600_000;

/** The regular chunk upload is "delayed" when it lags realtime by more than this (DD-14). */
export const OTEL_CHUNK_DELAY_MS = 600_000;

/** Tick of the projection drain (DD-16) when `OTEL_PROJECTION_INTERVAL_MS` is unset or invalid. */
export const OTEL_PROJECTION_INTERVAL_MS = 5_000;

/**
 * `OTEL_PROJECTION_INTERVAL_MS` from the environment when it is a positive integer, else the
 * 5000 ms default. Only the contract suite sets it (to park the drain during a run, as it parks
 * the other background jobs).
 */
export function resolveOtelProjectionIntervalMs(): number {
  const raw = Number(process.env.OTEL_PROJECTION_INTERVAL_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : OTEL_PROJECTION_INTERVAL_MS;
}

/** `logs_otel` rows claimed per projection tick (DD-16). */
export const OTEL_PROJECTION_BATCH = 50;

/**
 * Current projection version stamped into `logs_otel.otel_projection_version` (DD-16).
 * v3 (2026-11-24 otel-session-tags): the projection also writes `session_tags` from the lines'
 * resource attributes. A v2 chunk differs from a v3 one only by those tags, so it is NOT
 * re-projected: the projection drain's light tag-only upgrade ({@link OTEL_PROJECTION_FULL_REQUEUE_BELOW})
 * stamps it v3 and writes tags only for the few chunks that carry a user resource key.
 */
export const OTEL_PROJECTION_VERSION = 3;

/**
 * Chunks stamped below this version (and failed ones, `-1`) are re-queued for a FULL re-projection
 * by the startup re-mark in `initializeDatabase()`. Chunks stamped from this version up to
 * {@link OTEL_PROJECTION_VERSION} − 1 only miss later additive outputs and get the light tag-only
 * upgrade of the projection drain instead. A future version bump that changes how calls, spans or
 * buckets are built must raise this to the new version (a full re-projection is a heavy migration:
 * see the `migrations-data-integrity` skill).
 */
export const OTEL_PROJECTION_FULL_REQUEUE_BELOW = 2;

/** `logs_otel` rows checked per tick by the light tag-only upgrade (most are only re-stamped in SQL). */
export const OTEL_TAG_UPGRADE_BATCH = 200;

/** Value of `logs_otel.otel_projection_version` for a chunk whose projection failed (DD-16). */
export const OTEL_PROJECTION_FAILED = -1;

/** Reclassification-queue roots handled per projection tick (DD-5, DD-16). */
export const OTEL_RECLASS_BATCH = 50;

/** Deleted roots whose OTEL rows are cleaned up per projection tick (DD-16 step 5). */
export const OTEL_CLEANUP_BATCH = 50;

/** Most `lines` one realtime batch may carry; more is a 400 (API changes). */
export const OTEL_REALTIME_MAX_LINES = 5_000;

/** Floor and default of the realtime `minIntervalMs` the server returns to the hook (DD-17). */
export const OTEL_REALTIME_MIN_INTERVAL_FLOOR_MS = 5_000;

/**
 * `OTEL_REALTIME_MIN_INTERVAL_MS` from the environment (default 5000; a value below 5000, or
 * one that is not a positive integer, counts as 5000) — DD-17.
 */
export function resolveOtelRealtimeMinIntervalMs(): number {
  const raw = Number(process.env.OTEL_REALTIME_MIN_INTERVAL_MS);
  if (!Number.isInteger(raw) || raw <= 0) {
    return OTEL_REALTIME_MIN_INTERVAL_FLOOR_MS;
  }
  return Math.max(raw, OTEL_REALTIME_MIN_INTERVAL_FLOOR_MS);
}

/** The env-resolved realtime `minIntervalMs`, read once at module load (DD-17). */
export const OTEL_REALTIME_MIN_INTERVAL_MS = resolveOtelRealtimeMinIntervalMs();

/** Longest `[from, to)` period the repository / team facts routes accept (API changes). */
export const OTEL_MAX_PERIOD_DAYS = 93;

/** Most rows of the repository facts `sessions` list, newest first (API changes). */
export const OTEL_SESSIONS_LIMIT = 200;

/** Most cost-flow rows by cost; the rest is folded into one `other` row (DD-28). */
export const OTEL_FLOWS_LIMIT = 500;

/** Serialized span `attributes` above this are replaced by `{ _truncated, _bytes }` (DD-10). */
export const OTEL_SPAN_ATTRIBUTES_MAX_BYTES = 65_536;

/** Prefix of the session route's `since=` / `cursor` value: `v1.<seq>` (DD-2). */
export const OTEL_CURSOR_PREFIX = 'v1.';

// ---------------------------------------------------------------------------
// Session tags from OTEL resource attributes (2026-11-24 otel-session-tags)
// ---------------------------------------------------------------------------

/**
 * Resource-attribute key prefixes that are NOT user tags (FR-2): Log Hub's own, Claude Code's and
 * the OTel semantic-convention resource namespaces. Any other key (dotted ones such as `team.name`
 * included) is a user tag. Prefixes are matched case-sensitively, like the keys.
 */
export const OTEL_TAG_DENY_PREFIXES: readonly string[] = [
  'artisyn.',
  'service.',
  'telemetry.',
  'host.',
  'os.',
  'process.',
  'anthropic.',
  'wsl.',
  'user.',
  'session.',
  'organization.',
  'terminal.',
  'deployment.',
  'k8s.',
  'cloud.',
  'container.',
  'device.',
  'faas.',
  'aws.',
  'gcp.',
  'azure.',
];

/** Longest tag key (after trimming); a longer key drops the pair (storage / index guard). */
export const OTEL_TAG_MAX_KEY = 64;

/** Longest tag value (after trimming); a longer value drops the pair, never truncated. */
export const OTEL_TAG_MAX_VALUE = 256;

/**
 * Most `source='otel'` tag pairs one root session keeps — a runaway guard only (first written
 * kept, later ones ignored; "show, don't limit": the session header warns when it is reached).
 */
export const OTEL_TAG_MAX_PAIRS = 500;

/**
 * A tag key is "noisy" in a session when the session has more than this many distinct values of
 * it (a volatile value such as a commit SHA put into `OTEL_RESOURCE_ATTRIBUTES`). Read-time only.
 */
export const TAG_NOISY_VALUES_PER_SESSION = 10;

// ---------------------------------------------------------------------------
// OTEL status per session (2026-10-30 otel-shared-receiver, DD-28 – DD-32)
// ---------------------------------------------------------------------------

/**
 * Reasons a hook's `otel-status` event may carry (DD-15, DD-31), in the order the hook tests
 * them. Any other value is stored as `unknown` (DD-28).
 */
export const OTEL_REASON_KEYS = [
  'receiver-down',
  'managed-disabled',
  'managed-endpoint',
  'project-only',
  'not-configured',
  'unknown',
] as const;

/** States of an `otel-status` event (DD-15), plus `unknown` for anything else (DD-28). */
export const OTEL_STATES = ['ok', 'partial', 'none', 'unknown'] as const;

/** The pseudo reason of a root with no OTEL data and no `otel-status` event (DD-29). */
export const OTEL_NO_STATUS_REASON = 'no-status';

/**
 * Values the sessions list `otelReason=` filter accepts: every reason plus `no-status`
 * (API changes). Mirrored in `client/src/viewer/pages/repository/otel/otel.constants.ts`.
 */
export const OTEL_REASON_FILTER_KEYS = [
  ...OTEL_REASON_KEYS,
  OTEL_NO_STATUS_REASON,
] as const;

/** `otel_state` values that count a root as covered by OTEL (DD-29: `ok` and `partial`). */
export const OTEL_COVERED_STATES = ['ok', 'partial'] as const;
