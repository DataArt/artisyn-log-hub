import { createHash } from 'crypto';
import { maxVersion } from '../../common/semver';
import {
  attributesOf,
  cappedStringAttrOf,
  costMicrosOf,
  nullableTokenCountOf,
  stringAttrOf,
  tokenCountOf,
} from '../otel-chunk';
import { OTEL_SPAN_ATTRIBUTES_MAX_BYTES } from './otel-facts.constants';

/**
 * Pure extraction of OTEL calls and spans from chunk lines (DD-8 … DD-10).
 *
 * A line is the object the hook's receiver writes to a chunk file and sends in a realtime batch:
 * `{ signal, receivedAt, resource, scope, record, hookVersion? }`. `resource` is already
 * flattened to plain strings by the receiver; `record` is the raw OTLP log record (signal `logs`)
 * or the raw OTLP span (signal `spans`, hook ≥ 2.29.0). Everything here is tolerant: an odd line
 * contributes nothing and never throws.
 */

/** The OTLP log-record body value that marks a billable API call. */
const API_REQUEST_EVENT = 'claude_code.api_request';

/** Width of `otel_calls.claude_code_version`. */
const CC_VERSION_MAX = 64;

/** Width of the `otel_spans` text columns `name`, `request_id`, `agent_id`, `query_source`. */
const SPAN_TEXT_MAX = 255;

/** Width of `otel_calls.effort` / `speed` and of the `otel_session_state` plan / seat / provider. */
const SHORT_TEXT_MAX = 64;

/** Width of the `otel_calls` skill / plugin / agent / MCP name columns. */
const NAME_TEXT_MAX = 255;

/** Width of `otel_session_state.custom_base_url`. */
const BASE_URL_MAX = 1024;

/** Width of `otel_spans.context`. */
const SPAN_CONTEXT_MAX = 32;

/** Width of `otel_spans.trace_id`; a longer id skips the span. */
const TRACE_ID_MAX = 64;

/** Width of `otel_spans.span_id` / `parent_span_id`; a longer id skips the span. */
const SPAN_ID_MAX = 32;

interface OtelLine {
  signal?: unknown;
  receivedAt?: unknown;
  resource?: unknown;
  record?: unknown;
  hookVersion?: unknown;
}

function asLine(line: unknown): OtelLine | null {
  return line && typeof line === 'object' ? line : null;
}

/**
 * Milliseconds since the epoch of an OTLP `*UnixNano` value (a digit string or a number), or
 * null when it is missing, zero (OTLP's "unset") or not a whole number.
 */
function nanosToMs(value: unknown): number | null {
  let nanos: bigint;
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value)) return null;
    nanos = BigInt(value);
  } else if (typeof value === 'number' && Number.isFinite(value)) {
    if (value < 0) return null;
    nanos = BigInt(Math.trunc(value));
  } else {
    return null;
  }
  if (nanos === 0n) return null;
  const ms = Number(nanos / 1_000_000n);
  return Number.isFinite(ms) ? ms : null;
}

/** A Date from an ISO string or an epoch-millisecond number, or null when it does not parse. */
function dateOf(value: unknown): Date | null {
  let ms: number;
  if (typeof value === 'string' && value.trim() !== '') {
    ms = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Date.parse(value);
  } else if (typeof value === 'number') {
    ms = value;
  } else {
    return null;
  }
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * Event time of one api_request line (DD-8): the record's `event.timestamp` attribute, else the
 * record's `timeUnixNano`, else the line's `receivedAt`. Null only when none of them parses.
 */
export function resolveOtelEventTime(line: unknown): Date | null {
  const entry = asLine(line);
  if (!entry) return null;
  const record = entry.record as { timeUnixNano?: unknown } | undefined;
  const attrs = attributesOf(record);
  const fromAttr = dateOf(attrs.get('event.timestamp'));
  if (fromAttr) return fromAttr;
  const fromRecord = nanosToMs(record?.timeUnixNano);
  if (fromRecord !== null) return new Date(fromRecord);
  return dateOf(entry.receivedAt);
}

/** JSON with object keys sorted at every level, so equal values give equal text. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v ?? null)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * Stable key of one api_request call (DD-9): the `request_id` when present, else `rec:` + sha1
 * of the canonical JSON of `{ timeUnixNano, attributes }` of the record. Realtime and chunk lines
 * are the same objects, so both channels give the same key; it never depends on the chunk.
 */
export function otelCallKey(requestId: string | null, record: unknown): string {
  if (requestId) return requestId;
  const r = (record && typeof record === 'object' ? record : {}) as {
    timeUnixNano?: unknown;
    attributes?: unknown;
  };
  const canonical = canonicalJson({
    timeUnixNano: r.timeUnixNano ?? null,
    attributes: r.attributes ?? null,
  });
  return `rec:${createHash('sha1').update(canonical).digest('hex')}`;
}

/** One `claude_code.api_request` record, as `otel_calls` stores it (before classification). */
export interface ExtractedOtelCall {
  callKey: string;
  requestId: string | null;
  querySource: string | null;
  model: string | null;
  claudeCodeVersion: string | null;
  promptId: string | null;
  agentId: string | null;
  eventTime: Date;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicros: bigint | null;
  /** `cache_creation_5m_tokens`; null when not reported (older Claude Code). */
  cacheWrite5mTokens: number | null;
  /** `cache_creation_1h_tokens`; null when not reported. */
  cacheWrite1hTokens: number | null;
  effort: string | null;
  speed: string | null;
  skillName: string | null;
  pluginName: string | null;
  agentName: string | null;
  mcpServerName: string | null;
  mcpToolName: string | null;
}

/** Resource `service.version`, cut to the column width, or null. */
function serviceVersionOf(resource: unknown): string | null {
  if (!resource || typeof resource !== 'object') return null;
  const raw = (resource as Record<string, unknown>)['service.version'];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim().slice(0, CC_VERSION_MAX);
}

/**
 * Every `signal === 'logs'` `claude_code.api_request` record of `lines` as an `otel_calls` row
 * (DD-8). One row per call key: a key repeated within the lines keeps its last occurrence, so a
 * batch never upserts the same row twice. A record with no resolvable event time is skipped.
 */
export function extractOtelCalls(lines: unknown[]): ExtractedOtelCall[] {
  const byKey = new Map<string, ExtractedOtelCall>();
  for (const line of lines) {
    const entry = asLine(line);
    if (!entry || entry.signal !== 'logs') continue;
    const record = entry.record as
      | { body?: { stringValue?: unknown } }
      | undefined;
    if (record?.body?.stringValue !== API_REQUEST_EVENT) continue;

    const eventTime = resolveOtelEventTime(entry);
    if (!eventTime) continue;

    const attrs = attributesOf(record);
    const requestId = stringAttrOf(attrs, 'request_id');
    const callKey = otelCallKey(requestId, record);
    byKey.delete(callKey);
    byKey.set(callKey, {
      callKey,
      requestId,
      querySource: stringAttrOf(attrs, 'query_source'),
      model: stringAttrOf(attrs, 'model'),
      claudeCodeVersion: serviceVersionOf(entry.resource),
      promptId:
        stringAttrOf(attrs, 'prompt.id') ?? stringAttrOf(attrs, 'prompt_id'),
      agentId: stringAttrOf(attrs, 'agent_id'),
      eventTime,
      inputTokens: tokenCountOf(attrs, 'input_tokens'),
      outputTokens: tokenCountOf(attrs, 'output_tokens'),
      cacheReadTokens: tokenCountOf(attrs, 'cache_read_tokens'),
      cacheWriteTokens: tokenCountOf(attrs, 'cache_creation_tokens'),
      costUsdMicros: costMicrosOf(attrs),
      cacheWrite5mTokens: nullableTokenCountOf(
        attrs,
        'cache_creation_5m_tokens',
      ),
      cacheWrite1hTokens: nullableTokenCountOf(
        attrs,
        'cache_creation_1h_tokens',
      ),
      effort: cappedStringAttrOf(attrs, 'effort', SHORT_TEXT_MAX),
      speed: cappedStringAttrOf(attrs, 'speed', SHORT_TEXT_MAX),
      skillName: cappedStringAttrOf(attrs, 'skill.name', NAME_TEXT_MAX),
      pluginName: cappedStringAttrOf(attrs, 'plugin.name', NAME_TEXT_MAX),
      agentName: cappedStringAttrOf(attrs, 'agent.name', NAME_TEXT_MAX),
      mcpServerName: cappedStringAttrOf(
        attrs,
        'mcp_server.name',
        NAME_TEXT_MAX,
      ),
      mcpToolName: cappedStringAttrOf(attrs, 'mcp_tool.name', NAME_TEXT_MAX),
    });
  }
  return [...byKey.values()];
}

/**
 * `ANTHROPIC_BASE_URL` as Claude Code reports it, reduced to `protocol//host[:port]pathname`
 * (DD-6): userinfo, query and fragment are dropped, a lone trailing `/` path too, and the result
 * is cut to the column width. Empty, non-string or unparsable → null.
 */
export function sanitizeOtelBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (!url.host) return null;
  const path = url.pathname === '/' ? '' : url.pathname;
  return `${url.protocol}//${url.host}${path}`.slice(0, BASE_URL_MAX);
}

/** The account fields Claude Code reports on its records (DD-5), with the time they were seen. */
export interface ExtractedOtelAccount {
  plan: string | null;
  seatType: string | null;
  provider: string | null;
  customBaseUrl: string | null;
  /** Greatest event time among the records that carried any field. */
  eventAt: Date;
}

type AccountField = 'plan' | 'seatType' | 'provider' | 'customBaseUrl';

const ACCOUNT_KEYS: ReadonlyArray<{
  field: AccountField;
  key: string;
  read: (raw: unknown) => string | null;
}> = [
  { field: 'plan', key: 'anthropic.plan', read: shortText },
  { field: 'seatType', key: 'anthropic.seat_type', read: shortText },
  { field: 'provider', key: 'anthropic.provider', read: shortText },
  {
    field: 'customBaseUrl',
    key: 'anthropic.custom_base_url',
    read: sanitizeOtelBaseUrl,
  },
];

function shortText(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.slice(0, SHORT_TEXT_MAX);
}

/** A resource attribute by key (the receiver flattens the resource to plain values). */
function resourceAttrOf(resource: unknown, key: string): unknown {
  if (!resource || typeof resource !== 'object') return undefined;
  return (resource as Record<string, unknown>)[key];
}

/**
 * Plan, seat type, provider and custom base URL of the lines (DD-5), or null when no record
 * carries any of them. Reads `logs` `claude_code.api_request` records and `spans` lines: the
 * record / span attribute first, then the line's resource. Each field keeps the non-null value of
 * the record with the greatest event time; on a tie the later line wins. Lines without an event
 * time are skipped.
 */
export function extractOtelAccount(
  lines: unknown[],
): ExtractedOtelAccount | null {
  const best: Record<AccountField, { value: string; at: number } | null> = {
    plan: null,
    seatType: null,
    provider: null,
    customBaseUrl: null,
  };
  let eventAt: number | null = null;
  for (const line of lines) {
    const entry = asLine(line);
    if (!entry) continue;
    let attrOf: (key: string) => unknown;
    // A span has no `timeUnixNano`; its start time stands in for it so a span is not dated by
    // the later `receivedAt` and does not outrank an api_request record of the same moment.
    let spanStartMs: number | null = null;
    if (entry.signal === 'logs') {
      const record = entry.record as
        | { body?: { stringValue?: unknown } }
        | undefined;
      if (record?.body?.stringValue !== API_REQUEST_EVENT) continue;
      const attrs = attributesOf(record);
      attrOf = (key) => attrs.get(key);
    } else if (entry.signal === 'spans') {
      const span = entry.record as
        | { attributes?: unknown; startTimeUnixNano?: unknown }
        | undefined;
      if (!span || typeof span !== 'object') continue;
      const attrs = flattenSpanAttributes(span.attributes);
      attrOf = (key) => attrs[key];
      spanStartMs = nanosToMs(span.startTimeUnixNano);
    } else {
      continue;
    }
    const at = spanStartMs ?? resolveOtelEventTime(entry)?.getTime() ?? null;
    if (at === null) continue;

    let carried = false;
    for (const { field, key, read } of ACCOUNT_KEYS) {
      const value =
        read(attrOf(key)) ?? read(resourceAttrOf(entry.resource, key));
      if (value === null) continue;
      carried = true;
      const current = best[field];
      if (!current || at >= current.at) best[field] = { value, at };
    }
    if (carried && (eventAt === null || at > eventAt)) eventAt = at;
  }
  if (eventAt === null) return null;
  return {
    plan: best.plan?.value ?? null,
    seatType: best.seatType?.value ?? null,
    provider: best.provider?.value ?? null,
    customBaseUrl: best.customBaseUrl?.value ?? null,
    eventAt: new Date(eventAt),
  };
}

/** One OTLP span, as `otel_spans` stores it (before cost and rollup). */
export interface ExtractedOtelSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  startTime: Date;
  endTime: Date | null;
  requestId: string | null;
  agentId: string | null;
  querySource: string | null;
  context: string | null;
  /** Flattened attributes, or `{ _truncated: true, _bytes }` when too large. */
  attributes: Record<string, unknown>;
}

export interface ExtractedOtelSpans {
  spans: ExtractedOtelSpan[];
  /** `spans` lines skipped: missing or over-long ids, or no start time. */
  skipped: number;
}

/**
 * OTLP span attributes as a plain map. Scalar values are unwrapped from their typed envelope;
 * `arrayValue` / `kvlistValue` / `bytesValue` are kept as their raw envelope value. An attribute
 * map that is already flat (a plain object) is taken as is. First occurrence of a key wins.
 */
function flattenSpanAttributes(attributes: unknown): Record<string, unknown> {
  if (
    attributes &&
    typeof attributes === 'object' &&
    !Array.isArray(attributes)
  ) {
    return { ...(attributes as Record<string, unknown>) };
  }
  const out: Record<string, unknown> = {};
  if (!Array.isArray(attributes)) return out;
  for (const entry of attributes) {
    const key = (entry as { key?: unknown })?.key;
    if (typeof key !== 'string' || key in out) continue;
    const value = (entry as { value?: Record<string, unknown> })?.value;
    if (!value || typeof value !== 'object') continue;
    const unwrapped =
      value['stringValue'] ??
      value['intValue'] ??
      value['doubleValue'] ??
      value['boolValue'] ??
      value['arrayValue'] ??
      value['kvlistValue'] ??
      value['bytesValue'];
    if (unwrapped !== undefined) out[key] = unwrapped;
  }
  return out;
}

/** A non-empty string attribute value cut to `max`, or null. */
function flatStringOf(
  attrs: Record<string, unknown>,
  key: string,
  max: number,
): string | null {
  const raw = attrs[key];
  if (typeof raw !== 'string' || raw === '') return null;
  return raw.slice(0, max);
}

/** An id field: '' / missing → null; a non-string → undefined (invalid). */
function idOf(value: unknown): string | null | undefined {
  if (value === undefined || value === null || value === '') return null;
  return typeof value === 'string' ? value : undefined;
}

/** The attributes, or the truncation marker when they serialize over the byte cap (DD-10). */
function capAttributes(
  attrs: Record<string, unknown>,
): Record<string, unknown> {
  const bytes = Buffer.byteLength(JSON.stringify(attrs), 'utf8');
  return bytes > OTEL_SPAN_ATTRIBUTES_MAX_BYTES
    ? { _truncated: true, _bytes: bytes }
    : attrs;
}

/**
 * Every `signal === 'spans'` line of `lines` as an `otel_spans` row (DD-10). A span with a missing
 * trace or span id, an id over its column width, or no start time is skipped and counted. Names,
 * request / agent ids and query sources are cut to 255, the context to 32. An unknown name or
 * attribute is kept as is. A `(traceId, spanId)` repeated within the lines keeps its last
 * occurrence.
 */
export function extractOtelSpans(lines: unknown[]): ExtractedOtelSpans {
  const byKey = new Map<string, ExtractedOtelSpan>();
  let skipped = 0;
  for (const line of lines) {
    const entry = asLine(line);
    if (!entry || entry.signal !== 'spans') continue;
    const span = entry.record as
      | {
          traceId?: unknown;
          spanId?: unknown;
          parentSpanId?: unknown;
          name?: unknown;
          startTimeUnixNano?: unknown;
          endTimeUnixNano?: unknown;
          attributes?: unknown;
        }
      | undefined;
    if (!span || typeof span !== 'object') {
      skipped++;
      continue;
    }

    const traceId = idOf(span.traceId);
    const spanId = idOf(span.spanId);
    const parentSpanId = idOf(span.parentSpanId);
    const startMs = nanosToMs(span.startTimeUnixNano);
    if (
      !traceId ||
      !spanId ||
      parentSpanId === undefined ||
      traceId.length > TRACE_ID_MAX ||
      spanId.length > SPAN_ID_MAX ||
      (parentSpanId !== null && parentSpanId.length > SPAN_ID_MAX) ||
      startMs === null
    ) {
      skipped++;
      continue;
    }
    const endMs = nanosToMs(span.endTimeUnixNano);

    const attrs = flattenSpanAttributes(span.attributes);
    const row: ExtractedOtelSpan = {
      traceId,
      spanId,
      parentSpanId,
      name:
        typeof span.name === 'string' ? span.name.slice(0, SPAN_TEXT_MAX) : '',
      startTime: new Date(startMs),
      endTime: endMs === null ? null : new Date(endMs),
      requestId: flatStringOf(attrs, 'request_id', SPAN_TEXT_MAX),
      agentId: flatStringOf(attrs, 'agent_id', SPAN_TEXT_MAX),
      querySource:
        flatStringOf(attrs, 'query_source_safe', SPAN_TEXT_MAX) ??
        flatStringOf(attrs, 'query_source', SPAN_TEXT_MAX),
      context: flatStringOf(attrs, 'llm_request.context', SPAN_CONTEXT_MAX),
      attributes: capAttributes(attrs),
    };
    const key = `${traceId}\u0000${spanId}`;
    byKey.delete(key);
    byKey.set(key, row);
  }
  return { spans: [...byKey.values()], skipped };
}

/** Highest valid `hookVersion` field over the lines (hook ≥ 2.29.0 stamps it), or null (DD-15). */
export function maxHookVersion(lines: unknown[]): string | null {
  return maxVersion(lines.map((line) => asLine(line)?.hookVersion));
}
