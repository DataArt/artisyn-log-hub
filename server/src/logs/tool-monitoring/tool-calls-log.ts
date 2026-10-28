/**
 * Tools/MCP monitoring — parser of the `tool-calls` log body (impl-plan DD-5, DD-6).
 *
 * The hook uploads one NDJSON file per session tree: one `tool_call` line per wrapped CLI call
 * plus `tool_wrap_status` lines. The server stores the parsed lines as the `logs.body` jsonb
 * array; this module turns that array into typed wrapper records.
 *
 * Tolerant by design (FR-6): unknown fields are ignored, a malformed line (not an object, not
 * JSON, missing `callId` / `tool` / a parseable `startedAt`) is skipped, a line of a higher
 * `schema` than this server understands is skipped. Text sent as `base64` is decoded; it stays
 * `utf8` when the bytes are valid UTF-8, else it is kept as base64 of the clamped bytes. Every
 * text is clamped to `CAPTURE_LIMIT_BYTES`.
 *
 * Pure: no DB, no Nest.
 */
import { CAPTURE_LIMIT_BYTES } from '@loghub/tool-monitor';
import type {
  ToolCallShell,
  ToolMonitorCapture,
} from '../../database/schema/index';

/** The newest `tool_call` / `tool_wrap_status` line schema this parser understands. */
export const TOOL_CALLS_LOG_SCHEMA = 1;

/** One wrapped CLI call as reported by the hook (`tool_call` line, DD-6). */
export interface WrapperCallRecord {
  callId: string;
  sessionId: string | null;
  tool: string;
  args: string[];
  /** Resolved path of the real tool, as the wrapper ran it. */
  real: string | null;
  cwd: string | null;
  shell: ToolCallShell | null;
  /** ISO timestamp of the call start. */
  startedAt: string;
  /** `startedAt` as epoch ms. */
  startedAtMs: number;
  /** ISO timestamp of the exit record; null when the call never wrote one (killed). */
  endedAt: string | null;
  exitCode: number | null;
  durationMs: number | null;
  bytes: { stdin: number; stdout: number; stderr: number };
  /** The consumer of stdout closed the pipe early (e.g. `| head -1`). */
  consumerClosed: boolean;
  /** Capture stopped at the limit or the tool got SIGPIPE. */
  truncated: boolean;
  capture: ToolMonitorCapture;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  /** Encoding of `stdin` / `stdout` / `stderr` after decoding (DD-9). */
  encoding: 'utf8' | 'base64';
  /** The uploader dropped the text of this call to stay under the upload cap (DD-5). */
  textDropped: boolean;
  /** At least one text field was clamped to `CAPTURE_LIMIT_BYTES` here. */
  textClamped: boolean;
}

/** The hook's wrapper status (`tool_wrap_status` line, DD-6). */
export interface WrapperStatusLine {
  hookVersion: string | null;
  os: string | null;
  preflight: {
    ok: boolean;
    reason: string | null;
    shells: { bash: boolean; powershell: boolean };
  };
  breaker: { global: boolean; tools: string[] };
  /** ISO timestamp of the report. */
  at: string;
}

export interface ParsedToolCallsLog {
  /** Wrapper calls in `startedAt` order; a repeated `callId` keeps its last line. */
  calls: WrapperCallRecord[];
  /** The latest `tool_wrap_status` line by `at`, or null when there is none. */
  status: WrapperStatusLine | null;
}

type AnyRecord = Record<string, unknown>;

function asRecord(v: unknown): AnyRecord | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as AnyRecord)
    : null;
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function asNonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asCount(v: unknown): number {
  const n = asFiniteNumber(v);
  return n !== null && n > 0 ? Math.floor(n) : 0;
}

function asIsoTs(v: unknown): { iso: string; ms: number } | null {
  const s = asString(v);
  if (s === null) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? { iso: new Date(ms).toISOString(), ms } : null;
}

/** The longest prefix of `buf` of at most `limit` bytes that does not split a UTF-8 sequence. */
function utf8SafeEnd(buf: Buffer, limit: number): number {
  if (buf.length <= limit) return buf.length;
  let end = limit;
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return end;
}

/**
 * `text` cut to at most `limit` UTF-8 bytes, never splitting a character.
 * `clamped` tells whether anything was cut.
 */
export function clampUtf8(
  text: string,
  limit: number = CAPTURE_LIMIT_BYTES,
): { text: string; clamped: boolean } {
  // Every UTF-16 code unit is at most 3 UTF-8 bytes: short strings need no encoding.
  if (text.length * 3 <= limit) return { text, clamped: false };
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= limit) return { text, clamped: false };
  return {
    text: buf.subarray(0, utf8SafeEnd(buf, limit)).toString('utf8'),
    clamped: true,
  };
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/** Bytes as UTF-8 text, or null when they are not valid UTF-8. */
function decodeUtf8Strict(bytes: Buffer): string | null {
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

interface DecodedTexts {
  texts: { stdin?: string; stdout?: string; stderr?: string };
  encoding: 'utf8' | 'base64';
  clamped: boolean;
}

const TEXT_FIELDS = ['stdin', 'stdout', 'stderr'] as const;

/**
 * Decodes and clamps the three text fields of a `tool_call` line. A `base64` line whose every
 * field is valid UTF-8 becomes `utf8`; otherwise all fields stay base64 (of the clamped bytes),
 * since one call has one `encoding`.
 */
function decodeTexts(line: AnyRecord): DecodedTexts {
  const raw: Partial<Record<(typeof TEXT_FIELDS)[number], string>> = {};
  for (const field of TEXT_FIELDS) {
    const v = asString(line[field]);
    if (v !== null) raw[field] = v;
  }

  if (line['encoding'] !== 'base64') {
    const texts: DecodedTexts['texts'] = {};
    let clamped = false;
    for (const field of TEXT_FIELDS) {
      const v = raw[field];
      if (v === undefined) continue;
      const c = clampUtf8(v);
      texts[field] = c.text;
      clamped ||= c.clamped;
    }
    return { texts, encoding: 'utf8', clamped };
  }

  const buffers: Partial<Record<(typeof TEXT_FIELDS)[number], Buffer>> = {};
  let clamped = false;
  for (const field of TEXT_FIELDS) {
    const v = raw[field];
    if (v === undefined) continue;
    const buf = Buffer.from(v, 'base64');
    if (buf.length > CAPTURE_LIMIT_BYTES) clamped = true;
    buffers[field] = buf;
  }

  const asText: DecodedTexts['texts'] = {};
  let allUtf8 = true;
  for (const field of TEXT_FIELDS) {
    const buf = buffers[field];
    if (buf === undefined) continue;
    const cut = buf.subarray(0, utf8SafeEnd(buf, CAPTURE_LIMIT_BYTES));
    const text = decodeUtf8Strict(cut);
    if (text === null) {
      allUtf8 = false;
      break;
    }
    asText[field] = text;
  }
  if (allUtf8) return { texts: asText, encoding: 'utf8', clamped };

  const asBase64: DecodedTexts['texts'] = {};
  for (const field of TEXT_FIELDS) {
    const buf = buffers[field];
    if (buf === undefined) continue;
    asBase64[field] = buf
      .subarray(0, Math.min(buf.length, CAPTURE_LIMIT_BYTES))
      .toString('base64');
  }
  return { texts: asBase64, encoding: 'base64', clamped };
}

/** A line of a schema newer than this parser understands is skipped. */
function isFutureSchema(line: AnyRecord): boolean {
  const schema = asFiniteNumber(line['schema']);
  return schema !== null && schema > TOOL_CALLS_LOG_SCHEMA;
}

function parseCallLine(line: AnyRecord): WrapperCallRecord | null {
  const callId = asNonEmptyString(line['callId']);
  const tool = asNonEmptyString(line['tool']);
  const started = asIsoTs(line['startedAt']);
  if (callId === null || tool === null || started === null) return null;

  const args = Array.isArray(line['args'])
    ? line['args'].filter((a): a is string => typeof a === 'string')
    : [];
  const shellRaw = line['shell'];
  const shell: ToolCallShell | null =
    shellRaw === 'bash' || shellRaw === 'powershell' ? shellRaw : null;
  const ended = asIsoTs(line['endedAt']);
  const exitCode = asFiniteNumber(line['exitCode']);
  const durationRaw = asFiniteNumber(line['durationMs']);
  const bytes = asRecord(line['bytes']);
  const textDropped = line['textDropped'] === true;
  const decoded = textDropped
    ? { texts: {}, encoding: 'utf8' as const, clamped: false }
    : decodeTexts(line);

  return {
    callId,
    sessionId: asNonEmptyString(line['sessionId']),
    tool,
    args,
    real: asNonEmptyString(line['real']),
    cwd: asNonEmptyString(line['cwd']),
    shell,
    startedAt: started.iso,
    startedAtMs: started.ms,
    endedAt: ended?.iso ?? null,
    exitCode: exitCode === null ? null : Math.trunc(exitCode),
    durationMs:
      durationRaw !== null && durationRaw >= 0 ? Math.round(durationRaw) : null,
    bytes: {
      stdin: asCount(bytes?.['stdin']),
      stdout: asCount(bytes?.['stdout']),
      stderr: asCount(bytes?.['stderr']),
    },
    consumerClosed: line['consumerClosed'] === true,
    truncated: line['truncated'] === true,
    capture: line['capture'] === 'meta' ? 'meta' : 'full',
    ...decoded.texts,
    encoding: decoded.encoding,
    textDropped,
    textClamped: decoded.clamped,
  };
}

function parseStatusLine(line: AnyRecord): WrapperStatusLine | null {
  const at = asIsoTs(line['at']);
  if (at === null) return null;
  const preflight = asRecord(line['preflight']);
  const shells = asRecord(preflight?.['shells']);
  const breaker = asRecord(line['breaker']);
  const rawTools: unknown = breaker?.['tools'];
  const breakerTools = Array.isArray(rawTools)
    ? rawTools.filter((t): t is string => typeof t === 'string' && t !== '')
    : [];
  return {
    hookVersion: asNonEmptyString(line['hookVersion']),
    os: asNonEmptyString(line['os']),
    preflight: {
      ok: preflight?.['ok'] === true,
      reason: asNonEmptyString(preflight?.['reason']),
      shells: {
        bash: shells?.['bash'] === true,
        powershell: shells?.['powershell'] === true,
      },
    },
    breaker: { global: breaker?.['global'] === true, tools: breakerTools },
    at: at.iso,
  };
}

/** A body item as an object: already parsed, or a JSON text line. */
function toLineRecord(item: unknown): AnyRecord | null {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    if (trimmed === '') return null;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return asRecord(item);
}

/**
 * Parses the `tool-calls` log body (DD-6). `lines` are the body items: parsed objects, or raw
 * JSON text lines. Never throws.
 */
export function parseToolCallsLog(
  lines: readonly unknown[],
): ParsedToolCallsLog {
  const calls = new Map<string, WrapperCallRecord>();
  let status: WrapperStatusLine | null = null;

  for (const item of lines) {
    const line = toLineRecord(item);
    if (line === null || isFutureSchema(line)) continue;
    if (line['type'] === 'tool_call') {
      const call = parseCallLine(line);
      if (call === null) continue;
      calls.delete(call.callId);
      calls.set(call.callId, call);
    } else if (line['type'] === 'tool_wrap_status') {
      const parsed = parseStatusLine(line);
      if (parsed !== null && (status === null || parsed.at >= status.at)) {
        status = parsed;
      }
    }
  }

  const ordered = [...calls.values()].sort(
    (a, b) =>
      a.startedAtMs - b.startedAtMs ||
      (a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0),
  );
  return { calls: ordered, status };
}
