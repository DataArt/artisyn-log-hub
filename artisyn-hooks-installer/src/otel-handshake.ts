// Installer-side client of the shared OTEL receiver's authenticated loopback routes (DD-9, DD-11):
// `POST /artisyn/hello` with the proof check, the `x-artisyn-auth` header builder, and the
// authenticated `session-status` and `shutdown` calls.
//
// TS twin of the same pieces of `hook/.claude/telemetry_tool/otel-register.js`
// (`sharedHandshake`, `buildAuthHeader`, `computeHelloProof`, `helloProofValid`) — the two packages
// cannot import each other; keep them identical. Node built-ins only, erasable TypeScript syntax
// only. Nothing here throws or rejects: every outcome is a resolved value.

import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';
import { ownerHash, readOrCreateToken, otelStateDir } from './user-state';

export const HELLO_PATH = '/artisyn/hello';
export const SESSION_STATUS_PATH = '/artisyn/session-status';
export const SHUTDOWN_PATH = '/artisyn/shutdown';
export const AUTH_HEADER = 'x-artisyn-auth';
const AUTH_SCHEME = 'v1';

// A live loopback receiver answers hello in milliseconds. Twin: `HELLO_TIMEOUT_MS` in otel-register.js.
export const HELLO_TIMEOUT_MS = 2000;
// Twin: `SESSION_STATUS_TIMEOUT_MS` in otel-register.js.
export const SESSION_STATUS_TIMEOUT_MS = 2000;
// Fixed idle timeout of a shared launch (DD-8). Twins: `SHARED_IDLE_TIMEOUT_MS` in
// otel-receiver.js, otel-register.js and otel-ensure-receiver.js.
export const SHARED_IDLE_TIMEOUT_MS = 600000;
// Twin: `DEFAULT_MAX_BODY_BYTES` in otel-receiver.js and otel-ensure-receiver.js.
export const DEFAULT_MAX_BODY_BYTES = 8388608;

const HEX_RE = /^[0-9a-f]+$/;

export type HandshakeOk = {
  status: 'ok';
  token: string;
  serverNonce: string;
  receiverVersion: string | null;
  contract: number | null;
  capabilities: string[];
  /** The `x-artisyn-auth` value of exactly one request with the issued (single-use) nonce. */
  authHeader: (urlPath: string, rawBody: Buffer | string) => string;
};

export type HandshakeResult =
  | HandshakeOk
  | { status: 'none' }
  | { status: 'no-token' }
  | { status: 'port-conflict'; detail: string };

export type LoopbackAnswer = { kind: 'answer'; status: number; raw: string } | { kind: 'none' };

/** `HMAC(token, "srv\n"+clientNonce+"\n"+serverNonce)` hex (DD-9). */
export function computeHelloProof(token: string, clientNonce: string, serverNonce: string): string {
  return crypto.createHmac('sha256', token).update(`srv\n${clientNonce}\n${serverNonce}`).digest('hex');
}

/** Constant-time check of a hello answer's proof. */
export function helloProofValid(token: string, clientNonce: string, answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return false;
  const { serverNonce, proof } = answer as Record<string, unknown>;
  if (typeof serverNonce !== 'string' || !serverNonce || typeof proof !== 'string' || !HEX_RE.test(proof)) return false;
  const expected = Buffer.from(computeHelloProof(token, clientNonce, serverNonce), 'hex');
  const actual = Buffer.from(proof, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/**
 * `v1 <serverNonce> <HMAC(token, "cli\n"+serverNonce+"\n"+urlPath+"\n"+sha256hex(rawBody))>`.
 * `rawBody` must be the exact wire bytes.
 */
export function buildAuthHeader(token: string, serverNonce: string, urlPath: string, rawBody: Buffer | string): string {
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const mac = crypto.createHmac('sha256', token).update(`cli\n${serverNonce}\n${urlPath}\n${bodyHash}`).digest('hex');
  return `${AUTH_SCHEME} ${serverNonce} ${mac}`;
}

/** One loopback JSON POST; never rejects. */
export function postLoopback(
  port: number,
  urlPath: string,
  body: Buffer,
  extraHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<LoopbackAnswer> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: LoopbackAnswer): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, ...extraHeaders },
      }, (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { raw += chunk; });
        res.on('error', () => finish({ kind: 'answer', status: res.statusCode ?? 0, raw: '' }));
        res.on('end', () => finish({ kind: 'answer', status: res.statusCode ?? 0, raw }));
      });
      req.on('error', () => finish({ kind: 'none' }));
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        finish({ kind: 'none' });
      });
      req.end(body);
    } catch {
      finish({ kind: 'none' });
    }
  });
}

/**
 * The shared-receiver hello (DD-9, DD-17). `ok` — a receiver of this OS user answered with a
 * valid proof; `none` — nothing answered; `port-conflict` — something answered but is not our
 * receiver (409, another status, non-JSON, bad proof); `no-token` — the token is unusable.
 */
export async function hello(port: number, opts: { timeoutMs?: number; homeDir?: string } = {}): Promise<HandshakeResult> {
  const homeDir = opts.homeDir || os.homedir();
  const token = readOrCreateToken({ homeDir });
  if (!token) return { status: 'no-token' };
  const clientNonce = crypto.randomBytes(16).toString('hex');
  const body = Buffer.from(JSON.stringify({ clientNonce, ownerHash: ownerHash(homeDir) }), 'utf8');
  const answer = await postLoopback(port, HELLO_PATH, body, {}, opts.timeoutMs || HELLO_TIMEOUT_MS);
  if (answer.kind === 'none') return { status: 'none' };
  if (answer.status === 409) return { status: 'port-conflict', detail: 'owner-mismatch' };
  if (answer.status !== 200) return { status: 'port-conflict', detail: `hello-status-${answer.status}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer.raw);
  } catch {
    return { status: 'port-conflict', detail: 'hello-not-json' };
  }
  if (!helloProofValid(token, clientNonce, parsed)) return { status: 'port-conflict', detail: 'bad-proof' };
  const p = parsed as Record<string, unknown>;
  const serverNonce = p['serverNonce'] as string;
  return {
    status: 'ok',
    token,
    serverNonce,
    receiverVersion: typeof p['receiverVersion'] === 'string' ? p['receiverVersion'] : null,
    contract: Number.isInteger(p['contract']) ? p['contract'] as number : null,
    capabilities: Array.isArray(p['capabilities'])
      ? (p['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : [],
    authHeader: (urlPath, rawBody) => buildAuthHeader(token, serverNonce, urlPath, rawBody),
  };
}

/** One authenticated request with a verified handshake (its nonce is spent by this call). */
export function authedPost(
  port: number,
  handshake: HandshakeOk,
  urlPath: string,
  payload: unknown,
  timeoutMs: number = SESSION_STATUS_TIMEOUT_MS,
): Promise<LoopbackAnswer> {
  const body = Buffer.from(JSON.stringify(payload === undefined ? {} : payload), 'utf8');
  return postLoopback(port, urlPath, body, { [AUTH_HEADER]: handshake.authHeader(urlPath, body) }, timeoutMs);
}

export type SessionStatus = {
  receiverVersion: string | null;
  registered: boolean;
  received: { logs: number; metrics: number; spans: number };
  firstRecordAt: string | null;
  pending: number;
  forward: 'ok' | 'degraded' | 'off';
};

export type SessionStatusResult =
  | { kind: 'ok'; status: SessionStatus }
  | { kind: 'handshake'; handshake: Exclude<HandshakeResult, HandshakeOk> }
  | { kind: 'unsupported'; detail: string; receiverVersion: string | null }
  | { kind: 'none' };

function count(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Hello + an authenticated `POST /artisyn/session-status {sessionId}` (DD-11). */
export async function sessionStatus(
  port: number,
  sessionId: string,
  opts: { timeoutMs?: number; homeDir?: string } = {},
): Promise<SessionStatusResult> {
  const timeoutMs = opts.timeoutMs || SESSION_STATUS_TIMEOUT_MS;
  const handshake = await hello(port, { timeoutMs, homeDir: opts.homeDir });
  if (handshake.status !== 'ok') return { kind: 'handshake', handshake };
  if (!handshake.capabilities.includes('session-status')) {
    return { kind: 'unsupported', detail: 'no-session-status', receiverVersion: handshake.receiverVersion };
  }
  const answer = await authedPost(port, handshake, SESSION_STATUS_PATH, { sessionId }, timeoutMs);
  if (answer.kind === 'none') return { kind: 'none' };
  if (answer.status !== 200) {
    return { kind: 'unsupported', detail: `session-status-${answer.status}`, receiverVersion: handshake.receiverVersion };
  }
  let body: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(answer.raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // an empty body reads as zero counts
  }
  const received = body['received'] && typeof body['received'] === 'object'
    ? body['received'] as Record<string, unknown>
    : {};
  return {
    kind: 'ok',
    status: {
      receiverVersion: typeof body['receiverVersion'] === 'string' ? body['receiverVersion'] : handshake.receiverVersion,
      registered: body['registered'] === true,
      received: { logs: count(received['logs']), metrics: count(received['metrics']), spans: count(received['spans']) },
      firstRecordAt: typeof body['firstRecordAt'] === 'string' ? body['firstRecordAt'] : null,
      pending: count(body['pending']),
      forward: body['forward'] === 'ok' || body['forward'] === 'degraded' ? body['forward'] : 'off',
    },
  };
}

export type ShutdownResult =
  | { kind: 'ok' }
  | { kind: 'handshake'; handshake: Exclude<HandshakeResult, HandshakeOk> }
  | { kind: 'rejected'; status: number }
  | { kind: 'none' };

/** Hello + an authenticated `POST /artisyn/shutdown {}`; the receiver flushes and exits on `200`. */
export async function shutdown(port: number, opts: { timeoutMs?: number; homeDir?: string } = {}): Promise<ShutdownResult> {
  const timeoutMs = opts.timeoutMs || HELLO_TIMEOUT_MS;
  const handshake = await hello(port, { timeoutMs, homeDir: opts.homeDir });
  if (handshake.status !== 'ok') return { kind: 'handshake', handshake };
  const answer = await authedPost(port, handshake, SHUTDOWN_PATH, {}, timeoutMs);
  if (answer.kind === 'none') return { kind: 'none' };
  return answer.status === 200 ? { kind: 'ok' } : { kind: 'rejected', status: answer.status };
}

/** The DD-7 shared launch argv (after the script path). */
export function buildSharedArgv(p: { home: string; stateDir: string; port: number; idleTimeoutMs?: number }): string[] {
  return [
    '--shared',
    '--owner-home', p.home,
    '--state-dir', p.stateDir,
    '--port', String(p.port),
    '--idle-timeout-ms', String(p.idleTimeoutMs ?? SHARED_IDLE_TIMEOUT_MS),
    '--max-body-bytes', String(DEFAULT_MAX_BODY_BYTES),
  ];
}

/** The env twins of `buildSharedArgv`. */
export function buildSharedEnv(p: { home: string; stateDir: string; port: number; idleTimeoutMs?: number }): Record<string, string> {
  return {
    ARTISYN_OTEL_SHARED: '1',
    ARTISYN_OTEL_OWNER_HOME: p.home,
    ARTISYN_OTEL_STATE_DIR: p.stateDir,
    ARTISYN_OTEL_PORT: String(p.port),
    ARTISYN_OTEL_IDLE_TIMEOUT_MS: String(p.idleTimeoutMs ?? SHARED_IDLE_TIMEOUT_MS),
    ARTISYN_OTEL_MAX_BODY_BYTES: String(DEFAULT_MAX_BODY_BYTES),
  };
}

/** Convenience: the shared state dir for `home`. */
export function sharedStateDir(home: string = os.homedir()): string {
  return otelStateDir(home);
}
