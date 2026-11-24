/**
 * raw-http.ts — a GET to the stand that sees the bytes on the wire (2026-11-24
 * traffic-optimization, FR-11 / FR-12).
 *
 * Playwright's request context always sends `Accept-Encoding` and decodes the answer, so it can
 * neither play a client without gzip nor show whether a body was compressed twice. This helper
 * sends the user's session cookie over plain `http`, adds `Accept-Encoding` only when asked and
 * returns the undecoded body.
 */
import * as http from 'http';
import * as zlib from 'zlib';
import { expect } from '@playwright/test';
import type { ScenarioUser } from '../fixtures';

export interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body exactly as received (still gzip when `Content-Encoding: gzip`). */
  body: Buffer;
}

/** GET `path` as `user`; `acceptEncoding` undefined = no `Accept-Encoding` header at all. */
export async function rawGet(baseUrl: string, user: ScenarioUser, path: string, acceptEncoding?: string): Promise<RawResponse> {
  const base = new URL(baseUrl);
  if (base.protocol !== 'http:') throw new Error(`rawGet supports http stands only, got ${baseUrl}`);
  const { cookies } = await user.api.storageState();
  const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: base.hostname,
        port: base.port,
        path,
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...(cookie ? { Cookie: cookie } : {}),
          ...(acceptEncoding === undefined ? {} : { 'Accept-Encoding': acceptEncoding }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** True when the `Vary` header names `Accept-Encoding`. */
export function variesOnEncoding(res: RawResponse): boolean {
  const vary = res.headers.vary;
  const text = Array.isArray(vary) ? vary.join(',') : (vary ?? '');
  return text.split(',').some((v) => v.trim().toLowerCase() === 'accept-encoding');
}

/**
 * The same `/api` JSON route asked by a gzip client and by a client without `Accept-Encoding`
 * (FR-11 / FR-12): both answers carry `Vary: Accept-Encoding`; the identity one has no
 * `Content-Encoding`; the gzip one is `gzip` when `expectGzip` and identity otherwise; the decoded
 * JSON is identical apart from the server-clock fields (`generatedAt`, `serverTime`). Returns
 * the identity JSON and the size of its text.
 */
export async function expectJsonGzipPair(
  baseUrl: string,
  user: ScenarioUser,
  path: string,
  expectGzip: boolean,
): Promise<{ json: unknown; bytes: number }> {
  const gz = await rawGet(baseUrl, user, path, 'gzip, deflate, br');
  const plain = await rawGet(baseUrl, user, path);
  expect(gz.status, `${path} (gzip client): ${gz.body.toString('utf8').slice(0, 300)}`).toBe(200);
  expect(plain.status, `${path} (no Accept-Encoding)`).toBe(200);
  expect(variesOnEncoding(gz), `${path} (gzip client) Vary: ${String(gz.headers.vary)}`).toBe(true);
  expect(variesOnEncoding(plain), `${path} (no Accept-Encoding) Vary: ${String(plain.headers.vary)}`).toBe(true);
  expect(plain.headers['content-encoding'], `${path} without Accept-Encoding is identity`).toBeUndefined();
  const plainText = plain.body.toString('utf8');
  if (expectGzip) {
    expect(gz.headers['content-encoding'], `${path} (${plain.body.length} bytes) to a gzip client`).toBe('gzip');
  } else {
    expect(gz.headers['content-encoding'], `${path} (${plain.body.length} bytes) below the threshold`).toBeUndefined();
  }
  const gzText = gz.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(gz.body).toString('utf8') : gz.body.toString('utf8');
  const json: unknown = JSON.parse(plainText);
  expect(withoutClock(JSON.parse(gzText)), `${path}: decoded gzip JSON = identity JSON`).toEqual(withoutClock(json));
  return { json, bytes: plain.body.length };
}

/** Top-level fields that carry the server's clock and so differ between two requests. */
const CLOCK_FIELDS = ['generatedAt', 'serverTime'];

function withoutClock(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => !CLOCK_FIELDS.includes(k)));
}
