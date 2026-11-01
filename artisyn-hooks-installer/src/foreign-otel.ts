// A foreign (non-Artisyn) OTLP collector in the user's Claude Code config — detection, fingerprint,
// the masked per-signal summary, the proxy / keep / replace rewrite of the user-scope `env`, the
// `forward.json` backup and the `_artisynOtel` note (DD-24, FR-D1–FR-D4, FR-D11), and the
// last-repo uninstall restore (DD-27).
//
// "Foreign" = a user-scope (`~/.claude/settings.json` `env`, `otelHeadersHelper`) or process-env
// OTLP key that is not Artisyn-owned. A foreign collector is *present* when at least one signal's
// effective endpoint is foreign; header keys, certificates and `otelHeadersHelper` are part of that
// config (fingerprint, backup, summary) but do not trigger the question on their own — without a
// foreign endpoint there is nothing to forward to.
//
// Re-runs: after `proxy`/`replace` the user-scope endpoints are Artisyn's, so the view is
// reconstructed from `forward.json.original` for every key that is now ours or gone. The view —
// and so the fingerprint — then equals the one of the first run, and the stored choice is reused
// without asking (FR-D3: re-ask only when the foreign config changed).
//
// Header values never leave this module: the summary says `headers: set`, the fingerprint hashes
// them, `_artisynOtel.previous` masks them. Pure functions apart from `writeForwardFile`.
// Erasable TypeScript syntax only.

import * as crypto from 'crypto';
import { SIGNALS, SIGNAL_ENDPOINT_KEYS, SIGNAL_EXPORTER_KEYS, GENERIC_ENDPOINT_KEY, type OtelSignal } from './managed-settings';
import { OTEL_ENV_KEYS, OTEL_TRACE_ENV_KEYS } from './otel-env';
import {
  ALL_OTEL_EXPECTED_VALUES,
  OTEL_PORT_MAX,
  OTEL_PORT_MIN,
  isArtisynOwnedOtelValue,
  isOtelEndpointKey,
  isPlainObject,
} from './user-settings';
import { atomicWriteJson, stateFilePath, type ForwardMode, type StateDirOpts } from './user-state';

export type ExistingChoice = 'proxy' | 'keep' | 'replace';
export const EXISTING_CHOICES: readonly ExistingChoice[] = ['proxy', 'keep', 'replace'];

// The OTLP/HTTP path segment of each signal (`spans` travel as `traces`).
export const SIGNAL_PATHS: Record<OtelSignal, string> = { logs: 'logs', metrics: 'metrics', spans: 'traces' };
const SIGNAL_KEY_PARTS: Record<OtelSignal, string> = { logs: 'LOGS', metrics: 'METRICS', spans: 'TRACES' };

export const GENERIC_PROTOCOL_KEY = 'OTEL_EXPORTER_OTLP_PROTOCOL';
export const GENERIC_HEADERS_KEY = 'OTEL_EXPORTER_OTLP_HEADERS';
export const HEADERS_HELPER_KEY = 'otelHeadersHelper';

const signalKey = (signal: OtelSignal, suffix: string): string => `OTEL_EXPORTER_OTLP_${SIGNAL_KEY_PARTS[signal]}_${suffix}`;
const protocolKey = (signal: OtelSignal): string => signalKey(signal, 'PROTOCOL');
const headersKey = (signal: OtelSignal): string => signalKey(signal, 'HEADERS');

// Every exporter-connection key of the foreign config, saved to `forward.json.original` (FR-D4:
// endpoint, protocol, headers, compression, exporter, certificates).
const CONNECTION_SUFFIXES = ['ENDPOINT', 'PROTOCOL', 'HEADERS', 'COMPRESSION', 'CERTIFICATE', 'CLIENT_KEY', 'CLIENT_CERTIFICATE', 'TIMEOUT'];
export const FOREIGN_RELATED_KEYS: readonly string[] = [
  ...CONNECTION_SUFFIXES.map(s => `OTEL_EXPORTER_OTLP_${s}`),
  ...SIGNALS.flatMap(signal => CONNECTION_SUFFIXES.map(s => signalKey(signal, s))),
  ...SIGNALS.map(signal => SIGNAL_EXPORTER_KEYS[signal]),
];

// The keys `proxy`/`replace` take over so Claude Code exports to the receiver: every endpoint and
// protocol key (the receiver speaks OTLP/HTTP JSON). `replace` also drops the header keys and
// `otelHeadersHelper` — the user's collector credentials have no business at the receiver then.
const TAKEOVER_KEYS: readonly string[] = [
  GENERIC_ENDPOINT_KEY,
  GENERIC_PROTOCOL_KEY,
  ...SIGNALS.map(s => SIGNAL_ENDPOINT_KEYS[s]),
  ...SIGNALS.map(protocolKey),
];
const HEADER_KEYS: readonly string[] = [GENERIC_HEADERS_KEY, ...SIGNALS.map(headersKey)];

export function isHeaderKey(key: string): boolean {
  return key === HEADERS_HELPER_KEY || /_HEADERS$/.test(key);
}

const GENERIC_LOOPBACK_RE = /^https?:\/\/(?:127\.0\.0\.1|localhost):(\d{1,5})\/?$/;

// Artisyn ownership of one related key in one env: the shared rule of `isArtisynOwnedOtelValue`,
// plus a generic endpoint that already points at an Artisyn loopback port. A non-endpoint key
// (exporter, protocol) is ours only while a generic endpoint in the same env is ours too — next to
// a foreign generic endpoint it is the user's.
function isOwned(key: string, env: Record<string, unknown>, ownedPorts: Set<number>): boolean {
  if (key === GENERIC_ENDPOINT_KEY) {
    const match = typeof env[key] === 'string' ? GENERIC_LOOPBACK_RE.exec(env[key] as string) : null;
    if (!match) return false;
    const port = Number(match[1]);
    return (port >= OTEL_PORT_MIN && port <= OTEL_PORT_MAX) || ownedPorts.has(port);
  }
  if (!isArtisynOwnedOtelValue(key, env, ownedPorts)) return false;
  return isOtelEndpointKey(key) || env[GENERIC_ENDPOINT_KEY] === undefined || isOwned(GENERIC_ENDPOINT_KEY, env, ownedPorts);
}

// `envOrder` (optional, additive): every key name of the user `env` as it was before the takeover,
// in order — names only, never values — so the last-repo uninstall puts the restored keys back
// where they were and the file comes back byte for byte (DD-27).
export type ForwardOriginal = { env: Record<string, string>; otelHeadersHelper?: string; envOrder?: string[] };

// The keys saved to `forward.json.original` besides the foreign connection keys: every key the
// Artisyn merge writes (the telemetry switch, tool details, the export interval, the traces beta),
// so a value the user had set for their own collector — `CLAUDE_CODE_ENABLE_TELEMETRY=1` above all —
// is restored at the last uninstall instead of being removed as an Artisyn key.
const BACKED_UP_KEYS: ReadonlySet<string> = new Set([...FOREIGN_RELATED_KEYS, ...Object.keys(ALL_OTEL_EXPECTED_VALUES)]);

/** `env` with the keys named in `order` first, in that order, then every other key as it is. */
function orderedEnv(env: Record<string, unknown>, order: readonly string[] | undefined): Record<string, unknown> {
  if (!order || order.length === 0) return env;
  const out: Record<string, unknown> = {};
  for (const key of order) if (Object.prototype.hasOwnProperty.call(env, key)) out[key] = env[key];
  for (const [key, value] of Object.entries(env)) if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value;
  return out;
}
export type ForwardSignals = Partial<Record<OtelSignal, { endpoint: string; protocol: string }>>;
export type ForwardFile = {
  version: 1;
  mode: ForwardMode;
  fingerprint: string | null;
  signals: ForwardSignals;
  original: ForwardOriginal;
  savedAt: string;
};

/** A parsed `forward.json` (from `readForward`), normalised; `null` when absent or malformed. */
export function toForwardFile(parsed: Record<string, unknown> | null): ForwardFile | null {
  if (!parsed) return null;
  const mode = parsed['mode'] as ForwardMode;
  const originalRaw = isPlainObject(parsed['original']) ? parsed['original'] : {};
  const envRaw = isPlainObject(originalRaw['env']) ? originalRaw['env'] : {};
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(envRaw)) if (typeof v === 'string') env[k] = v;
  const original: ForwardOriginal = { env };
  if (typeof originalRaw['otelHeadersHelper'] === 'string') original.otelHeadersHelper = originalRaw['otelHeadersHelper'];
  if (Array.isArray(originalRaw['envOrder'])) {
    original.envOrder = (originalRaw['envOrder'] as unknown[]).filter((k): k is string => typeof k === 'string');
  }
  const signals: ForwardSignals = {};
  const signalsRaw = isPlainObject(parsed['signals']) ? parsed['signals'] : {};
  for (const signal of SIGNALS) {
    const entry = signalsRaw[signal];
    if (isPlainObject(entry) && typeof entry['endpoint'] === 'string') {
      signals[signal] = { endpoint: entry['endpoint'], protocol: typeof entry['protocol'] === 'string' ? entry['protocol'] : 'http/json' };
    }
  }
  return {
    version: 1,
    mode,
    fingerprint: typeof parsed['fingerprint'] === 'string' ? parsed['fingerprint'] : null,
    signals,
    original,
    savedAt: typeof parsed['savedAt'] === 'string' ? parsed['savedAt'] : '',
  };
}

const appliedMode = (stored: ForwardFile | null): boolean => !!stored && (stored.mode === 'proxy' || stored.mode === 'replace');

export type ForeignSignal = {
  signal: OtelSignal;
  endpoint: string;
  source: 'user' | 'env';
  protocol: string | null;
  headers: boolean;
  exporter: string | null;
  /** The exporter includes `otlp` — the user really exports this signal, so it is forwarded. */
  exported: boolean;
};

export type ForeignOtel = {
  /** At least one signal's effective endpoint is foreign. */
  present: boolean;
  signals: ForeignSignal[];
  /** The foreign view the fingerprint is taken over: per key, its value and source. */
  view: Record<string, { value: string; source: 'user' | 'env' }>;
  helper: string | null;
  fingerprint: string;
  /** What `proxy`/`replace` saves to `forward.json.original` and restores at the last uninstall. */
  original: ForwardOriginal;
  /** `original` comes from a stored `forward.json` (the user scope is already rewritten). */
  reconstructed: boolean;
};

export type DetectInput = {
  userSettings: Record<string, unknown>;
  processEnv: Record<string, string | undefined>;
  ownedPorts: Set<number>;
  stored: ForwardFile | null;
};

const sha256 = (value: string): string => crypto.createHash('sha256').update(value).digest('hex');

/** sha256 of a canonical JSON of the foreign view, header values replaced by their sha256 (DD-24). */
export function computeFingerprint(view: ForeignOtel['view'], helper: string | null): string {
  const canonical: Array<[string, string, string]> = Object.keys(view).sort().map(key => {
    const { value, source } = view[key];
    return [key, source, isHeaderKey(key) ? sha256(value) : value];
  });
  return sha256(JSON.stringify({ keys: canonical, helper: helper === null ? null : sha256(helper) }));
}

const stringOf = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);

/** Detect the foreign OTEL config of the user scope and the process env (DD-24, FR-D1). Pure. */
export function detectForeignOtel(input: DetectInput): ForeignOtel {
  const userEnv: Record<string, unknown> = isPlainObject(input.userSettings['env']) ? input.userSettings['env'] : {};
  const stored = appliedMode(input.stored) ? input.stored : null;
  const view: ForeignOtel['view'] = {};

  for (const key of FOREIGN_RELATED_KEYS) {
    const userValue = stringOf(userEnv[key]);
    if (userValue !== undefined && !isOwned(key, userEnv, input.ownedPorts)) {
      view[key] = { value: userValue, source: 'user' };
      continue;
    }
    const original = stored ? stringOf(stored.original.env[key]) : undefined;
    if (original !== undefined) {
      view[key] = { value: original, source: 'user' };
      continue;
    }
    // An Artisyn value in the user scope shadows the process env for this key.
    if (Object.prototype.hasOwnProperty.call(userEnv, key)) continue;
    const envValue = stringOf(input.processEnv[key]);
    if (envValue !== undefined && !isOwned(key, input.processEnv as Record<string, unknown>, input.ownedPorts)) {
      view[key] = { value: envValue, source: 'env' };
    }
  }
  const helper = stringOf(input.userSettings[HEADERS_HELPER_KEY]) ?? stored?.original.otelHeadersHelper ?? null;

  // Per signal, the endpoint Claude Code would export to under the foreign view (per-signal key
  // before the generic one + `/v1/<signal>`). An Artisyn per-signal key wins over a foreign generic.
  const lookup = (key: string): string | null =>
    view[key]?.value ?? stringOf(userEnv[key]) ?? stringOf(input.processEnv[key]) ?? null;
  const signals: ForeignSignal[] = [];
  for (const signal of SIGNALS) {
    const perKey = SIGNAL_ENDPOINT_KEYS[signal];
    let endpoint: string | null = null;
    let source: 'user' | 'env' = 'user';
    // After an applied proxy/replace the user scope carries OUR per-signal key, written over the
    // user's generic endpoint; it must not hide that endpoint, or a second repo's install finds no
    // collector and would drop the stored choice and backup.
    const userPerKeyShadows = Object.prototype.hasOwnProperty.call(userEnv, perKey)
      && !(stored && isOwned(perKey, userEnv, input.ownedPorts));
    if (view[perKey]) {
      endpoint = view[perKey].value;
      source = view[perKey].source;
    } else if (!userPerKeyShadows && !stringOf(input.processEnv[perKey]) && view[GENERIC_ENDPOINT_KEY]) {
      endpoint = `${view[GENERIC_ENDPOINT_KEY].value.trim().replace(/\/+$/, '')}/v1/${SIGNAL_PATHS[signal]}`;
      source = view[GENERIC_ENDPOINT_KEY].source;
    }
    if (endpoint === null) continue;
    const exporter = lookup(SIGNAL_EXPORTER_KEYS[signal]);
    signals.push({
      signal,
      endpoint,
      source,
      protocol: lookup(protocolKey(signal)) ?? lookup(GENERIC_PROTOCOL_KEY),
      headers: !!(view[headersKey(signal)] || view[GENERIC_HEADERS_KEY] || helper),
      exporter,
      exported: !!exporter && exporter.split(',').some(e => e.trim().toLowerCase() === 'otlp'),
    });
  }

  // The backup: the stored one while the user scope is already rewritten, else every related key
  // of the user scope that is not an Artisyn endpoint (FR-D4: "restores the original keys exactly").
  const reconstructed = !!stored && !SIGNALS.some(s => {
    const key = SIGNAL_ENDPOINT_KEYS[s];
    return stringOf(userEnv[key]) !== undefined && !isOwned(key, userEnv, input.ownedPorts);
  }) && !(stringOf(userEnv[GENERIC_ENDPOINT_KEY]) && !isOwned(GENERIC_ENDPOINT_KEY, userEnv, input.ownedPorts));
  let original: ForwardOriginal;
  if (reconstructed && stored) {
    original = { env: { ...stored.original.env } };
    if (stored.original.otelHeadersHelper !== undefined) original.otelHeadersHelper = stored.original.otelHeadersHelper;
    if (stored.original.envOrder !== undefined) original.envOrder = [...stored.original.envOrder];
  } else {
    // In the user's own key order, so the restore can put them back where they were.
    const env: Record<string, string> = {};
    for (const key of Object.keys(userEnv)) {
      if (!BACKED_UP_KEYS.has(key)) continue;
      const value = userEnv[key];
      if (typeof value !== 'string') continue;
      if ((isOtelEndpointKey(key) || key === GENERIC_ENDPOINT_KEY) && isOwned(key, userEnv, input.ownedPorts)) continue;
      env[key] = value;
    }
    original = { env, envOrder: Object.keys(userEnv) };
    const currentHelper = stringOf(input.userSettings[HEADERS_HELPER_KEY]);
    if (currentHelper !== undefined) original.otelHeadersHelper = currentHelper;
  }

  return {
    present: signals.length > 0,
    signals,
    view,
    helper,
    fingerprint: computeFingerprint(view, helper),
    original,
    reconstructed,
  };
}

/** Protocols the receiver cannot forward to as is (FR-D6): the upstream must accept OTLP/HTTP JSON. */
export function isIncompatibleProtocol(protocol: string | null): boolean {
  const p = (protocol ?? '').trim().toLowerCase();
  return p === 'grpc' || p === 'http/protobuf';
}

/** The forwarded signals with a protocol the receiver cannot forward to (FR-D6). */
export function incompatibleSignals(foreign: ForeignOtel): ForeignSignal[] {
  return foreign.signals.filter(s => s.exported && isIncompatibleProtocol(s.protocol));
}

/** The upstream of each forwarded signal, as detected (generic endpoint + `/v1/<signal>` included). */
export function detectedForwardSignals(foreign: ForeignOtel): ForwardSignals {
  const out: ForwardSignals = {};
  for (const s of foreign.signals) {
    if (s.exported) out[s.signal] = { endpoint: s.endpoint, protocol: s.protocol ?? 'http/json' };
  }
  return out;
}

/**
 * The upstreams for an OTLP/HTTP URL the user typed for a grpc / http-protobuf collector (FR-D6):
 * the base URL (a trailing `/v1/<signal>` stripped) + `/v1/<signal>` for each forwarded signal.
 * `null` when the URL is not an absolute http(s) URL.
 */
export function forwardSignalsFromUrl(foreign: ForeignOtel, url: string): ForwardSignals | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const base = url.trim().replace(/\/+$/, '').replace(/\/v1\/(?:logs|metrics|traces)$/, '');
  const out: ForwardSignals = {};
  for (const s of foreign.signals) {
    if (s.exported) out[s.signal] = { endpoint: `${base}/v1/${SIGNAL_PATHS[s.signal]}`, protocol: 'http/json' };
  }
  return out;
}

/** The URL with any `user:password@` and query string removed — safe to print. */
function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    return url.toString();
  } catch {
    return value;
  }
}

/** The masked per-signal summary lines (FR-D2): endpoint, protocol, `headers: set`, exporter. */
export function renderForeignSummary(foreign: ForeignOtel): string[] {
  const lines: string[] = [];
  for (const s of foreign.signals) {
    const where = s.source === 'env' ? 'environment variable' : 'user settings';
    lines.push(
      `  ${SIGNAL_PATHS[s.signal].padEnd(7)} ${displayUrl(s.endpoint)} (${where}) — protocol: ${s.protocol ?? 'not set'}, ` +
      `headers: ${s.headers ? 'set' : 'none'}, exporter: ${s.exporter ?? 'not set'}${s.exported ? '' : ' (not exported)'}`,
    );
  }
  return lines;
}

/** What the Artisyn keys add to the stream a proxied collector receives (FR-D9). */
export function streamChangesLine(traces: boolean): string {
  const keys = OTEL_ENV_KEYS(0);
  const added = [
    `OTEL_LOG_TOOL_DETAILS=${keys['OTEL_LOG_TOOL_DETAILS']} (tool details in events)`,
    `OTEL_METRIC_EXPORT_INTERVAL=${keys['OTEL_METRIC_EXPORT_INTERVAL']} ms`,
    ...(traces ? ['traces (CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1)'] : []),
  ];
  return `Log Hub adds to the exported stream: ${added.join(', ')}. Nothing is removed.`;
}

/** The value the installer writes for an Artisyn OTEL key; `undefined` for any other key. */
function artisynValueOf(key: string): string | undefined {
  return ALL_OTEL_EXPECTED_VALUES[key];
}

/**
 * The user-scope `env` and settings prepared for the Artisyn merge in `proxy`/`replace` (DD-24): the
 * foreign endpoint and protocol keys are removed (so the merge writes the receiver's), `replace`
 * also removes the header keys and `otelHeadersHelper`. Returns the endpoint keys the merge must
 * write to the receiver whatever the trace answer is — a forwarded signal keeps flowing (to the
 * receiver, which forwards and routes it) — and the keys the merge must never strip.
 */
export function prepareTakeover(
  settings: Record<string, unknown>,
  mode: 'proxy' | 'replace',
  foreign: ForeignOtel,
  port: number,
): { settings: Record<string, unknown>; extraDesired: Record<string, string>; keepKeys: Set<string> } {
  const env: Record<string, unknown> = isPlainObject(settings['env']) ? { ...settings['env'] } : {};
  const next: Record<string, unknown> = { ...settings };
  const removeKeys = mode === 'replace' ? [...TAKEOVER_KEYS, ...HEADER_KEYS] : [...TAKEOVER_KEYS];
  for (const key of removeKeys) {
    // A value equal to the one the installer writes (`http/json`) stays where it is, so a re-run
    // leaves the file byte-identical.
    if (Object.prototype.hasOwnProperty.call(foreign.original.env, key) && env[key] === foreign.original.env[key]
      && env[key] !== ALL_OTEL_EXPECTED_VALUES[key]) {
      delete env[key];
    }
  }
  if (mode === 'replace' && foreign.original.otelHeadersHelper !== undefined && next[HEADERS_HELPER_KEY] === foreign.original.otelHeadersHelper) {
    delete next[HEADERS_HELPER_KEY];
  }
  if (mode === 'proxy') {
    // A switch from `replace` to `proxy`: the collector credentials come back, so Claude Code sends
    // them to the receiver, which passes them upstream (FR-D5).
    for (const key of HEADER_KEYS) {
      const value = foreign.original.env[key];
      if (value !== undefined && !Object.prototype.hasOwnProperty.call(env, key)) env[key] = value;
    }
    if (foreign.original.otelHeadersHelper !== undefined && next[HEADERS_HELPER_KEY] === undefined) {
      next[HEADERS_HELPER_KEY] = foreign.original.otelHeadersHelper;
    }
  }
  next['env'] = env;

  const traceEndpoint = OTEL_TRACE_ENV_KEYS(port);
  const extraDesired: Record<string, string> = {};
  if (foreign.signals.some(s => s.signal === 'spans')) {
    extraDesired['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = traceEndpoint['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'];
  }
  const keepKeys = new Set<string>([...Object.keys(foreign.original.env), ...Object.keys(extraDesired)]);
  return { settings: next, extraDesired, keepKeys };
}

/** `_artisynOtel.previous`: every backed-up key, header values masked as `set` (DD-24). */
export function maskedPrevious(original: ForwardOriginal): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(original.env)) out[key] = isHeaderKey(key) ? 'set' : value;
  if (original.otelHeadersHelper !== undefined) out[HEADERS_HELPER_KEY] = original.otelHeadersHelper;
  return out;
}

/** The `_artisynOtel` note left in the user file by `proxy`/`replace` (FR-D11). */
export function buildArtisynOtelNote(
  mode: 'proxy' | 'replace',
  original: ForwardOriginal,
  backupPath: string,
  traces: boolean,
): Record<string, unknown> {
  const what = mode === 'proxy'
    ? 'Log Hub pointed the OTLP endpoints at its local receiver (127.0.0.1), which keeps forwarding everything to your collector unchanged; your header keys stay as they were.'
    : 'Log Hub replaced your OTLP collector: telemetry now goes only to its local receiver (127.0.0.1); your endpoint, protocol and header keys were removed.';
  return {
    note: `${what} ${streamChangesLine(traces)} "previous" lists the values before the change (header values masked); ` +
      'the full backup is the "backup" file. Uninstalling Log Hub from the last repository restores them.',
    mode,
    previous: maskedPrevious(original),
    backup: backupPath,
  };
}

/** Write `forward.json` (DD-4) — atomically, before the user file is touched. */
export function writeForwardFile(
  value: { mode: ForwardMode; fingerprint: string | null; signals: ForwardSignals; original: ForwardOriginal },
  opts: StateDirOpts = {},
): void {
  const file: ForwardFile = { version: 1, ...value, savedAt: new Date().toISOString() };
  atomicWriteJson(stateFilePath('forward', opts), file);
}

/**
 * The user settings with the Artisyn OTEL state taken out (last-repo uninstall, DD-27): every
 * Artisyn-owned OTEL key (judged on the env as read) removed, the `forward.json.original` keys and
 * `otelHeadersHelper` put back exactly, `_artisynOtel` dropped. The DD-21 hook entry is removed by
 * the caller. Pure; `removed` / `restored` are key names for the summary (never values).
 */
export function restoreUserOtel(
  settings: Record<string, unknown>,
  stored: ForwardFile | null,
  ownedPorts: Set<number>,
): { settings: Record<string, unknown>; removed: string[]; restored: string[] } {
  const next: Record<string, unknown> = { ...settings };
  const removed: string[] = [];
  const restored: string[] = [];
  if (isPlainObject(settings['env'])) {
    const asRead = settings['env'];
    const env: Record<string, unknown> = { ...asRead };
    for (const key of Object.keys(ALL_OTEL_EXPECTED_VALUES)) {
      if (Object.prototype.hasOwnProperty.call(asRead, key) && artisynValueOf(key) !== undefined && isOwned(key, asRead, ownedPorts)) {
        delete env[key];
        removed.push(key);
      }
    }
    let restoredEnv: Record<string, unknown> = env;
    if (appliedMode(stored)) {
      for (const [key, value] of Object.entries(stored!.original.env)) {
        env[key] = value;
        restored.push(key);
      }
      restoredEnv = orderedEnv(env, stored!.original.envOrder);
    }
    if (Object.keys(restoredEnv).length > 0) next['env'] = restoredEnv;
    else delete next['env'];
  } else if (appliedMode(stored) && Object.keys(stored!.original.env).length > 0 && settings['env'] === undefined) {
    next['env'] = { ...stored!.original.env };
    restored.push(...Object.keys(stored!.original.env));
  }
  if (appliedMode(stored) && stored!.original.otelHeadersHelper !== undefined) {
    next[HEADERS_HELPER_KEY] = stored!.original.otelHeadersHelper;
    restored.push(HEADERS_HELPER_KEY);
  }
  delete next['_artisynOtel'];
  return { settings: next, removed, restored };
}
