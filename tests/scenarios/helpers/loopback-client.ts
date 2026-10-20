/**
 * loopback-client.ts — JSON requests to the stand from a loopback source address of the
 * scenario's own (`127.a.b.c`, not `127.0.0.1`).
 *
 * Why: in mode B the login backoff (server/src/auth/login-backoff.service.ts) keeps a failure
 * counter per account AND per source IP, for 15 minutes, and the stand sees every Playwright
 * request as 127.0.0.1. A scenario that enters wrong passwords from 127.0.0.1 therefore delays the
 * logins of every scenario after it, and one that measures the delay schedule sees the failures
 * of every scenario before it. Sending those requests from a fresh loopback address gives the
 * scenario an IP counter nobody else touches. The stand has no TRUST_PROXY, so `req.ip` is the
 * socket peer, i.e. this address.
 *
 * The whole 127.0.0.0/8 block is loopback on Windows and Linux. macOS only configures
 * 127.0.0.1; there, add an alias first (`sudo ifconfig lo0 alias 127.0.13.7`) or the request
 * fails with EADDRNOTAVAIL.
 */
import * as http from 'http';
import { randomInt } from 'crypto';

export interface LoopbackResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Parsed JSON body, or the raw text when the body is not JSON (null when empty). */
  body: unknown;
}

export interface LoopbackClient {
  /** The source address every request of this client is bound to. */
  readonly address: string;
  post(path: string, data?: unknown): Promise<LoopbackResponse>;
  get(path: string): Promise<LoopbackResponse>;
}

/** A random loopback address that is not 127.0.0.1 (nor a network/broadcast-looking .0/.255). */
export function randomLoopbackAddress(): string {
  return `127.${randomInt(1, 255)}.${randomInt(0, 256)}.${randomInt(1, 255)}`;
}

/** A client whose requests to the stand at `baseUrl` come from `address` (default: a random one). */
export function loopbackClient(baseUrl: string, address: string = randomLoopbackAddress()): LoopbackClient {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:') throw new Error(`loopbackClient supports http stands only, got ${baseUrl}`);

  function send(method: 'GET' | 'POST', path: string, data?: unknown): Promise<LoopbackResponse> {
    const payload = data === undefined ? undefined : JSON.stringify(data);
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: base.hostname,
          port: base.port,
          path,
          method,
          localAddress: address,
          headers: {
            Accept: 'application/json',
            ...(payload === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (text += chunk));
          res.on('end', () => {
            let body: unknown = text === '' ? null : text;
            try {
              if (text !== '') body = JSON.parse(text);
            } catch {
              // not JSON — keep the text
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
          });
        },
      );
      req.on('error', (err) =>
        reject(new Error(`${method} ${path} from ${address} failed: ${err.message} (see loopback-client.ts on macOS)`)),
      );
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  return {
    address,
    post: (path, data) => send('POST', path, data ?? {}),
    get: (path) => send('GET', path),
  };
}

/** `Retry-After` of a response as a number of seconds (NaN when absent). */
export function retryAfterSeconds(res: LoopbackResponse): number {
  const raw = res.headers['retry-after'];
  return Number(Array.isArray(raw) ? raw[0] : raw);
}
