/**
 * otel-lines.ts — synthetic OTEL chunk lines for the OTEL-tab scenarios (S-OTEL-01, S-COMPAT-01,
 * S-SLIFE-08; task 2026-10-30-otel-tabs-traces). No real data: every id, model, cost and time is
 * made up here, relative to a base time the scenario picks, so the lines always fall into "the
 * last 7 days" and a scenario can also build lines for a session that is running right now.
 *
 * A line is the object the hook's OTEL receiver writes to a chunk file and sends in a realtime
 * batch (`otel-receiver.js`, `server/src/logs/otel/otel-records.ts`):
 *
 *   { signal: 'logs' | 'spans', receivedAt, resource, scope, record, hookVersion? }
 *
 * `record` is the raw OTLP log record (`claude_code.api_request`) or the raw OTLP span. A hook
 * older than 2.29.0 writes no `hookVersion` field and no `spans` lines — `hookVersion: null`
 * builds exactly that shape.
 *
 * {@link otelTurn} is the one session shape every OTEL scenario uses: one user turn as an
 * `interaction` trace (two main-thread LLM calls around a Bash tool with its execution span) plus
 * a standalone `prompt_suggestion` trace, and five `api_request` records — two main calls, the
 * suggestion, a `generate_session_title` call WITHOUT a request id and a call with a
 * `query_source` the server's dictionary does not know. {@link transcriptBodies} builds the
 * matching artisyn and claude logs, whose assistant lines carry the two main request ids.
 */

/** OTLP/JSON attribute. */
export interface OtlpAttr {
  key: string;
  value: { stringValue: string } | { intValue: string } | { doubleValue: number };
}

/** One chunk / realtime line. */
export interface OtelLine {
  signal: 'logs' | 'spans';
  receivedAt: string;
  resource: Record<string, string>;
  scope: { name: string; version?: string };
  record: Record<string, unknown>;
  hookVersion?: string;
}

const CC_VERSION = '2.1.314';
const LOGS_SCOPE = { name: 'com.anthropic.claude_code.events', version: CC_VERSION };
const SPANS_SCOPE = { name: 'com.anthropic.claude_code.tracing', version: CC_VERSION };

const s = (key: string, value: string): OtlpAttr => ({ key, value: { stringValue: value } });
const i = (key: string, value: number): OtlpAttr => ({ key, value: { intValue: String(value) } });
const d = (key: string, value: number): OtlpAttr => ({ key, value: { doubleValue: value } });

/** OTLP `*UnixNano` of a Date, as the decimal string OTLP/JSON carries. */
export function nanos(at: Date): string {
  return `${BigInt(at.getTime()) * 1_000_000n}`;
}

/** `at` plus `seconds`. */
export function plus(at: Date, seconds: number): Date {
  return new Date(at.getTime() + seconds * 1000);
}

/** The 5-minute UTC floor of `at` (the server's bucket start). */
export function floor5m(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 300_000) * 300_000);
}

interface LineOptions {
  /** `hookVersion` stamped on the line; `null` = a pre-2.29.0 hook (no field). Default `2.29.0`. */
  hookVersion?: string | null;
  /** The receiver's `receivedAt`. Default: now (the chunk is written later than the event). */
  receivedAt?: Date;
}

function lineBase(opts: LineOptions): Pick<OtelLine, 'receivedAt' | 'resource'> & { hookVersion?: string } {
  const hookVersion = opts.hookVersion === undefined ? '2.29.0' : opts.hookVersion;
  return {
    receivedAt: (opts.receivedAt ?? new Date()).toISOString(),
    resource: { 'service.name': 'claude-code', 'service.version': CC_VERSION },
    ...(hookVersion === null ? {} : { hookVersion }),
  };
}

/** One `claude_code.api_request` call. */
export interface OtelCallSpec {
  /** `null` = a record without `request_id` (the server keys it by a hash of the record). */
  requestId: string | null;
  querySource: string;
  model: string;
  /** Event time (`event.timestamp`). */
  at: Date;
  costUsd: number;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function apiRequestLine(sessionId: string, c: OtelCallSpec, opts: LineOptions = {}): OtelLine {
  const base = lineBase(opts);
  return {
    signal: 'logs',
    receivedAt: base.receivedAt,
    resource: base.resource,
    scope: LOGS_SCOPE,
    record: {
      timeUnixNano: nanos(c.at),
      observedTimeUnixNano: nanos(c.at),
      severityNumber: 9,
      body: { stringValue: 'claude_code.api_request' },
      attributes: [
        s('session.id', sessionId),
        s('event.name', 'api_request'),
        s('event.timestamp', c.at.toISOString()),
        ...(c.requestId === null ? [] : [s('request_id', c.requestId)]),
        s('query_source', c.querySource),
        s('model', c.model),
        i('input_tokens', c.input),
        i('output_tokens', c.output),
        i('cache_read_tokens', c.cacheRead ?? 0),
        i('cache_creation_tokens', c.cacheWrite ?? 0),
        d('cost_usd', c.costUsd),
        i('duration_ms', 1200),
      ],
    },
    ...(base.hookVersion === undefined ? {} : { hookVersion: base.hookVersion }),
  };
}

/** One OTLP span. */
export interface OtelSpanSpec {
  traceId: string;
  spanId: string;
  /** `null` = a root span. */
  parentSpanId: string | null;
  name: string;
  start: Date;
  /** `null` = still running (no end time yet). */
  end: Date | null;
  attrs?: Record<string, string>;
}

export function spanLine(sessionId: string, sp: OtelSpanSpec, opts: LineOptions = {}): OtelLine {
  const base = lineBase(opts);
  return {
    signal: 'spans',
    receivedAt: base.receivedAt,
    resource: base.resource,
    scope: SPANS_SCOPE,
    record: {
      traceId: sp.traceId,
      spanId: sp.spanId,
      parentSpanId: sp.parentSpanId ?? '',
      name: sp.name,
      kind: 1,
      startTimeUnixNano: nanos(sp.start),
      endTimeUnixNano: sp.end === null ? '0' : nanos(sp.end),
      attributes: [s('session.id', sessionId), ...Object.entries(sp.attrs ?? {}).map(([k, v]) => s(k, v))],
      status: { code: 0 },
    },
    ...(base.hookVersion === undefined ? {} : { hookVersion: base.hookVersion }),
  };
}

/** NDJSON of `lines`, one per row, trailing newline — the body of a `claude-otel` upload. */
export function chunkBody(lines: readonly OtelLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------
// The scenario session shape
// ---------------------------------------------------------------------------------------------

/** A `query_source` the server's dictionary (`otel-query-source-dictionary.ts`) does not know. */
export const UNKNOWN_QUERY_SOURCE = 'scn_brand_new_source';

export const MODEL_A = 'claude-scn-model-a';
export const MODEL_B = 'claude-scn-model-b';

/** Micro-USD of a USD amount, as the server stores it. */
export function micros(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export interface OtelTurn {
  /** Request ids the transcript records (the two main-thread calls). */
  transcriptRequestIds: string[];
  calls: {
    main1: OtelCallSpec;
    main2: OtelCallSpec;
    suggestion: OtelCallSpec;
    title: OtelCallSpec;
    unknown: OtelCallSpec;
  };
  spans: {
    interaction: OtelSpanSpec;
    llm1: OtelSpanSpec;
    tool: OtelSpanSpec;
    toolExec: OtelSpanSpec;
    llm2: OtelSpanSpec;
    suggestion: OtelSpanSpec;
  };
  /** Sums over the five calls, micro-USD. */
  totalMicros: number;
  hiddenMicros: number;
  /** The interaction trace's two LLM calls. */
  interactionMicros: number;
}

/**
 * One turn of a session starting at `base` (choose a 5-minute aligned time so every call lands
 * in the bucket `base`). `tag` (≤ 8 chars) makes every id unique per session.
 *
 * | Call | query_source | request id | event time | cost |
 * |---|---|---|---|---|
 * | main1 | repl_main_thread | `<tag>-req-1` | base + 3:00 | 0.0125 |
 * | main2 | repl_main_thread | `<tag>-req-2` | base + 4:30 | 0.0175 |
 * | suggestion | prompt_suggestion | `<tag>-req-3` | base + 4:50 | 0.0040 (hidden) |
 * | title | generate_session_title | — | base + 0:40 | 0.0005 (hidden) |
 * | unknown | {@link UNKNOWN_QUERY_SOURCE} | `<tag>-req-5` | base + 4:55 | 0.0015 (hidden) |
 *
 * Spans: `interaction` (0:30–5:00) → `llm_request` main1 (1:00–3:00), `tool` Bash (3:05–3:40) →
 * `tool.execution` (3:06–3:39), `llm_request` main2 (3:45–4:30); a standalone trace with the
 * `prompt_suggestion` `llm_request` (4:35–4:50).
 */
export function otelTurn(tag: string, base: Date, model: string = MODEL_A): OtelTurn {
  const req = (n: number) => `${tag}-req-${n}`;
  const trace = `${tag}trace1`;
  const calls = {
    main1: { requestId: req(1), querySource: 'repl_main_thread', model, at: plus(base, 180), costUsd: 0.0125, input: 1000, output: 200, cacheRead: 3000, cacheWrite: 1000 },
    main2: { requestId: req(2), querySource: 'repl_main_thread', model, at: plus(base, 270), costUsd: 0.0175, input: 500, output: 100, cacheRead: 4000 },
    suggestion: { requestId: req(3), querySource: 'prompt_suggestion', model, at: plus(base, 290), costUsd: 0.004, input: 2000, output: 20 },
    title: { requestId: null, querySource: 'generate_session_title', model, at: plus(base, 40), costUsd: 0.0005, input: 100, output: 10 },
    unknown: { requestId: req(5), querySource: UNKNOWN_QUERY_SOURCE, model, at: plus(base, 295), costUsd: 0.0015, input: 300, output: 30 },
  } satisfies OtelTurn['calls'];
  const spans = {
    interaction: { traceId: trace, spanId: `${tag}i1`, parentSpanId: null, name: 'claude_code.interaction', start: plus(base, 30), end: plus(base, 300), attrs: { 'user_prompt_length': '42' } },
    llm1: {
      traceId: trace, spanId: `${tag}l1`, parentSpanId: `${tag}i1`, name: 'claude_code.llm_request', start: plus(base, 60), end: plus(base, 180),
      attrs: { request_id: req(1), query_source_safe: 'repl_main_thread', 'llm_request.context': 'interaction', model },
    },
    tool: { traceId: trace, spanId: `${tag}t1`, parentSpanId: `${tag}i1`, name: 'claude_code.tool', start: plus(base, 185), end: plus(base, 220), attrs: { tool_name: 'Bash' } },
    toolExec: { traceId: trace, spanId: `${tag}x1`, parentSpanId: `${tag}t1`, name: 'claude_code.tool.execution', start: plus(base, 186), end: plus(base, 219) },
    llm2: {
      traceId: trace, spanId: `${tag}l2`, parentSpanId: `${tag}i1`, name: 'claude_code.llm_request', start: plus(base, 225), end: plus(base, 270),
      attrs: { request_id: req(2), query_source_safe: 'repl_main_thread', 'llm_request.context': 'interaction', model },
    },
    suggestion: {
      traceId: `${tag}trace2`, spanId: `${tag}l3`, parentSpanId: null, name: 'claude_code.llm_request', start: plus(base, 275), end: plus(base, 290),
      attrs: { request_id: req(3), query_source_safe: 'prompt_suggestion', 'llm_request.context': 'standalone', model },
    },
  } satisfies OtelTurn['spans'];
  const all = Object.values(calls);
  const sum = (list: OtelCallSpec[]) => list.reduce((n, c) => n + micros(c.costUsd), 0);
  return {
    transcriptRequestIds: [req(1), req(2)],
    calls,
    spans,
    totalMicros: sum(all),
    hiddenMicros: sum([calls.suggestion, calls.title, calls.unknown]),
    interactionMicros: sum([calls.main1, calls.main2]),
  };
}

/** Every call of a turn as `api_request` lines. */
export function callLines(sessionId: string, turn: OtelTurn, opts: LineOptions = {}): OtelLine[] {
  return Object.values(turn.calls).map((c) => apiRequestLine(sessionId, c, opts));
}

/** Every span of a turn as `spans` lines, parents first. */
export function spanLines(sessionId: string, turn: OtelTurn, opts: LineOptions = {}): OtelLine[] {
  return Object.values(turn.spans).map((sp) => spanLine(sessionId, sp, opts));
}

// ---------------------------------------------------------------------------------------------
// Matching transcripts
// ---------------------------------------------------------------------------------------------

export interface TranscriptSpec {
  sessionId: string;
  prompt: string;
  /** Git remote of every prompt; two entries = a second turn in the second repository. */
  repoUrls: string[];
  /** `null` = the hook reported no branch (the cost flow's "(unknown)"). */
  branch: string | null;
  at: Date;
  /**
   * Request ids of the assistant lines, one per answer. Empty = a transcript that has only the
   * user's prompt so far (no answer, no request id yet — a turn still running).
   */
  requestIds: string[];
  model?: string;
  /** `hook-status` line with this hook version (the repository's `hook_version`). */
  hookVersion?: string;
  /** An `otel-status` line (hook 2.30.0+, 2026-10-30 otel-shared-receiver DD-16) at the end of the artisyn log. */
  otelStatus?: OtelStatusSpec;
}

/** What a hook 2.30.0 reports at Stop / SessionEnd about the session's OTEL data (DD-15, DD-16). */
export interface OtelStatusSpec {
  state: 'ok' | 'partial' | 'none';
  reason: string | null;
  received?: { logs: number; metrics: number; spans: number };
  claudeVersion?: string;
  forward?: 'ok' | 'degraded' | 'off';
}

/** The `otel-status` artisyn line of a spec, timestamped `at`. */
export function otelStatusLine(sessionId: string, s: OtelStatusSpec, at: Date): object {
  const received = s.received ?? { logs: 0, metrics: 0, spans: 0 };
  const any = received.logs + received.metrics + received.spans > 0;
  return {
    type: 'otel-status',
    timestamp: at.toISOString(),
    sessionId,
    state: s.state,
    reason: s.reason,
    detail: null,
    received: { ...received, firstAt: any ? at.toISOString() : null },
    claudeVersion: s.claudeVersion ?? '2.1.300',
    forward: s.forward ?? 'off',
    hookVersion: '2.30.0',
    receiverVersion: '2.30.0',
  };
}

/** The artisyn and claude NDJSON bodies of a session whose assistant lines carry `requestIds`. */
export function transcriptBodies(t: TranscriptSpec): { artisyn: string; claude: string } {
  const artisyn: object[] = [];
  const claude: object[] = [];
  const turns = Math.max(t.repoUrls.length, 1);
  for (let n = 0; n < turns; n += 1) {
    const at = plus(t.at, n * 120);
    const git = { repo: t.repoUrls[n] ?? t.repoUrls[0], ...(t.branch === null ? {} : { branch: t.branch }) };
    const prompt = n === 0 ? t.prompt : `${t.prompt} (turn ${n + 1})`;
    artisyn.push(
      { event: 'prompt_start', timestamp: at.toISOString(), session_id: t.sessionId, prompt, git },
      { event: 'prompt_stop', timestamp: plus(at, 60).toISOString(), session_id: t.sessionId },
    );
  }
  if (t.hookVersion) {
    artisyn.push({ type: 'hook-status', hookVersion: t.hookVersion, timestamp: plus(t.at, 1).toISOString(), logTail: [], nonUploadableLogs: [], recommendations: [] });
  }
  if (t.otelStatus) {
    artisyn.push(otelStatusLine(t.sessionId, t.otelStatus, plus(t.at, turns * 120)));
  }
  if (t.requestIds.length === 0) {
    claude.push({
      type: 'user', uuid: `${t.sessionId}-u0`, sessionId: t.sessionId, timestamp: plus(t.at, 30).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: t.prompt }] },
    });
  }
  let parent: string | undefined;
  t.requestIds.forEach((requestId, n) => {
    const at = plus(t.at, 60 + n * 90);
    const u = `${t.sessionId}-u${n}`;
    const a = `${t.sessionId}-a${n}`;
    claude.push(
      {
        type: 'user', uuid: u, ...(parent ? { parentUuid: parent } : {}), sessionId: t.sessionId, timestamp: at.toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: n === 0 ? t.prompt : `continue ${n}` }] },
      },
      {
        type: 'assistant', uuid: a, parentUuid: u, sessionId: t.sessionId, requestId, timestamp: plus(at, 30).toISOString(),
        message: { id: `msg-${requestId}`, role: 'assistant', model: t.model ?? MODEL_A, usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }] },
      },
    );
    parent = a;
  });
  const nd = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  return { artisyn: nd(artisyn), claude: nd(claude) };
}
