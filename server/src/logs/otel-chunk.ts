import { createHash } from 'crypto';
import { maxVersion } from '../common/semver';

/**
 * OTEL chunk processing.
 *
 * The hook's receiver writes one file per inbound OTLP request and the uploader ships each as its
 * own `claude-otel` upload. Every chunk lands as one `logs_otel` row; the per-session `logs` row
 * carries only the normalized result derived from them.
 */

/** The OTLP log-record body value that marks a billable API call. */
const API_REQUEST_EVENT = 'claude_code.api_request';

/** The OTEL `service.name` Claude Code reports on its resource. */
const CLAUDE_CODE_SERVICE_NAME = 'claude-code';

/**
 * A chunk is immutable once the receiver renames it into place, so its content IS its identity.
 * Hashing the body gives a stable `chunk_key` with no protocol change and no new upload-queue
 * column, and makes re-ingest idempotent by construction: the same chunk uploaded twice produces
 * the same key and upserts over itself instead of double-counting cost.
 */
export function computeChunkKey(lines: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(lines)).digest('hex');
}

/** Read an OTLP attribute list into a plain map, unwrapping the typed value envelope. */
function attributesOf(record: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const attrs = (record as { attributes?: unknown })?.attributes;
  if (!Array.isArray(attrs)) return out;
  for (const entry of attrs) {
    const key = (entry as { key?: unknown })?.key;
    if (typeof key !== 'string') continue;
    const value = (entry as { value?: Record<string, unknown> })?.value;
    if (!value || typeof value !== 'object') continue;
    // OTLP/JSON wraps every attribute in exactly one typed field.
    const unwrapped =
      value['stringValue'] ??
      value['intValue'] ??
      value['doubleValue'] ??
      value['boolValue'];
    if (unwrapped !== undefined) out.set(key, unwrapped);
  }
  return out;
}

/**
 * Cost in integer micro-USD for one api_request record, or null when it carries none.
 *
 * `cost_usd_micros` is preferred over `cost_usd` because it is already an integer: summing micros
 * as BigInt and dividing once at the end keeps a report over thousands of chunks exact, where
 * accumulating floats would drift. `cost_usd` is only a fallback for a producer that omits micros.
 */
function costMicrosOf(attrs: Map<string, unknown>): bigint | null {
  const micros = attrs.get('cost_usd_micros');
  if (micros !== undefined && micros !== null) {
    const parsed = Number(micros);
    if (Number.isFinite(parsed)) return BigInt(Math.round(parsed));
  }
  const usd = attrs.get('cost_usd');
  if (usd !== undefined && usd !== null) {
    const parsed = Number(usd);
    if (Number.isFinite(parsed)) return BigInt(Math.round(parsed * 1_000_000));
  }
  return null;
}

/**
 * Token count of one api_request attribute, as an integer. The attribute may
 * arrive as `intValue` (often a string in OTLP/JSON), `doubleValue` or `stringValue`; anything
 * missing or non-numeric counts as 0, matching the SQL backfill's `COALESCE(..., 0)`.
 */
function tokenCountOf(attrs: Map<string, unknown>, key: string): number {
  const raw = attrs.get(key);
  if (raw === undefined || raw === null || raw === '') return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
}

/** Width of the `otel_api_calls` varchar columns. */
const CALL_TEXT_MAX = 255;

/**
 * A non-empty string attribute cut to the varchar(255) column width, or null — the same rule as
 * the backfill's `LEFT(NULLIF(..., ''), 255)`, so an oversized value never fails the upload.
 */
function stringAttrOf(attrs: Map<string, unknown>, key: string): string | null {
  const raw = attrs.get(key);
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.slice(0, CALL_TEXT_MAX);
}

/**
 * One `claude_code.api_request` record, as stored in `otel_api_calls`.
 *
 * `callKey` is the `request_id`, or `${chunkKey}:${lineIndex}` (1-based line position, same as
 * Postgres `WITH ORDINALITY` in the backfill) when the record carries none. Telemetry has no
 * cache-TTL split, so `cache_creation_tokens` lands in `cacheWrite5mTokens`; a `speed='fast'`
 * call mirrors its input/output tokens into the fast columns.
 */
export interface OtelApiCall {
  callKey: string;
  requestId: string | null;
  querySource: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  inputTokensFast: number;
  outputTokensFast: number;
  costUsdMicros: bigint | null;
}

export interface OtelChunkSummary {
  /** Total billed cost across the chunk's api_request records, in integer micro-USD. */
  costUsdMicros: bigint;
  /** How many api_request records carried a cost — 0 means the chunk is cost-free, not broken. */
  pricedRecords: number;
  recordCount: number;
  /** Earliest `receivedAt` stamped by the receiver, used to order chunks for replay. */
  receivedAt: Date | null;
  /**
   * Highest valid `resource['service.version']` over the chunk's lines whose
   * `resource['service.name']` is absent or `'claude-code'` — the OTEL fallback for the
   * session's Claude Code version. `null` when no line carries a usable one.
   */
  claudeVersion: string | null;
  /**
   * Distinct non-empty `model` attributes of the chunk's api_request log records, in first-seen
   * order — fed to `registerUnpricedModels` at ingest so an unpriced model surfaces.
   */
  models: string[];
  /** One entry per api_request log record, for `otel_api_calls`. */
  calls: OtelApiCall[];
}

/**
 * Summarize one chunk. Deliberately tolerant: an unrecognised record shape contributes nothing
 * rather than throwing, because a single odd record must never fail the whole upload — the raw
 * body is stored either way, so anything missed here can be recomputed later from `logs_otel`.
 */
export function summarizeOtelChunk(
  lines: unknown[],
  chunkKey: string = computeChunkKey(lines),
): OtelChunkSummary {
  let costUsdMicros = 0n;
  let pricedRecords = 0;
  let earliest: number | null = null;
  const versions: unknown[] = [];
  const models = new Set<string>();
  const calls: OtelApiCall[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const entry = line as {
      signal?: unknown;
      receivedAt?: unknown;
      resource?: unknown;
      record?: unknown;
    };

    // The receiver already flattened resource attributes into plain strings.
    const resource = entry?.resource;
    if (resource && typeof resource === 'object') {
      const attrs = resource as Record<string, unknown>;
      const serviceName = attrs['service.name'];
      if (
        serviceName === undefined ||
        serviceName === null ||
        serviceName === CLAUDE_CODE_SERVICE_NAME
      ) {
        versions.push(attrs['service.version']);
      }
    }

    if (typeof entry?.receivedAt === 'string') {
      const ms = Date.parse(entry.receivedAt);
      if (Number.isFinite(ms) && (earliest === null || ms < earliest))
        earliest = ms;
    }

    // Cost lives only on log records; the metrics signal carries the same money aggregated per
    // export window, so counting both would double every total.
    if (entry?.signal !== 'logs') continue;

    const record = entry.record as
      | { body?: { stringValue?: unknown } }
      | undefined;
    if (record?.body?.stringValue !== API_REQUEST_EVENT) continue;

    const attrs = attributesOf(record);
    const model = attrs.get('model');
    if (typeof model === 'string' && model.trim() !== '') models.add(model);

    const micros = costMicrosOf(attrs);

    const requestId = stringAttrOf(attrs, 'request_id');
    const inputTokens = tokenCountOf(attrs, 'input_tokens');
    const outputTokens = tokenCountOf(attrs, 'output_tokens');
    const fast = attrs.get('speed') === 'fast';
    calls.push({
      // 1-based line position, matching the backfill's WITH ORDINALITY.
      callKey: requestId ?? `${chunkKey}:${i + 1}`,
      requestId,
      querySource: stringAttrOf(attrs, 'query_source'),
      model: stringAttrOf(attrs, 'model'),
      inputTokens,
      outputTokens,
      cacheReadTokens: tokenCountOf(attrs, 'cache_read_tokens'),
      cacheWrite5mTokens: tokenCountOf(attrs, 'cache_creation_tokens'),
      inputTokensFast: fast ? inputTokens : 0,
      outputTokensFast: fast ? outputTokens : 0,
      costUsdMicros: micros,
    });

    if (micros === null) continue;
    costUsdMicros += micros;
    pricedRecords++;
  }

  return {
    costUsdMicros,
    pricedRecords,
    recordCount: lines.length,
    receivedAt: earliest === null ? null : new Date(earliest),
    claudeVersion: maxVersion(versions),
    models: [...models],
    calls,
  };
}

/** The normalized per-session record stored in the `logs` row for `claude-otel`. */
export interface OtelSessionSummary {
  type: 'otel-summary';
  costUsdMicros: string;
  costUsd: number;
  chunkCount: number;
  recordCount: number;
}

/**
 * Build the normalized record from a session's aggregated chunk totals.
 *
 * `costUsdMicros` is serialised as a string because JSON cannot represent BigInt and a large
 * micro total would lose precision as a float — the exact integer is the authoritative value,
 * and `costUsd` is a convenience for display only.
 *
 * Deliberately no `pricedRecords`: that is a per-chunk figure, and `logs_otel` does not aggregate
 * it, so publishing one chunk's count as the session's would be simply wrong. Recompute it from
 * `logs_otel.body` if it is ever needed session-wide.
 */
export function buildOtelSessionSummary(totals: {
  costUsdMicros: bigint;
  chunkCount: number;
  recordCount: number;
}): OtelSessionSummary {
  return {
    type: 'otel-summary',
    costUsdMicros: totals.costUsdMicros.toString(),
    costUsd: Number(totals.costUsdMicros) / 1_000_000,
    chunkCount: totals.chunkCount,
    recordCount: totals.recordCount,
  };
}
